import { createHash } from "node:crypto";
import { validateGeneratedImage } from "@/lib/server/files";
import { MAX_INTERNAL_OUTPUT_BYTES } from "@/lib/server/internal-queue-contract";
import {
  imageModelProvider,
  isImageModel,
} from "@/lib/domain/image-models";
import type {
  ConsumerClaim,
  ConsumerControlPlane,
  ConsumerSpool,
  DownloadedInput,
  GenerationExecutor,
  SpoolRecord,
} from "./contracts";
import { GenerationExecutionError } from "./contracts";
import { ConsumerControlPlaneError } from "./control-plane-client";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;
const TERMINAL_CONTROL_CODES = new Set([
  "QUEUE_FENCE_STALE",
  "QUEUE_STATE_CONFLICT",
  "OUTPUT_COMMIT_CONFLICT",
  "PROVIDER_RESPONSE_CONFLICT",
  "OUTPUT_STORAGE_CONFLICT",
]);

export type RunOneResult =
  | { status: "idle" }
  | { status: "completed"; attemptId: string; resumed: boolean }
  | { status: "safe-failure"; attemptId: string }
  | { status: "moderation-pending" | "moderation-rejected"; attemptId: string }
  | { status: "reconciliation-required"; attemptId: string };

export async function runOne(input: {
  workerId: string;
  claimRequestId: string;
  control: ConsumerControlPlane;
  executor: GenerationExecutor;
  spool: ConsumerSpool;
  heartbeatIntervalMs?: number;
  expectedItemId?: string;
}): Promise<RunOneResult> {
  const pending = (await input.spool.list()).find(
    (record) =>
      input.expectedItemId === undefined ||
      record.fence.itemId === input.expectedItemId,
  );
  if (pending) {
    return resumeOutput(
      input.control,
      input.spool,
      pending,
      true,
      input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
  }

  const claim = await input.control.claim(input.workerId, input.claimRequestId);
  if (!claim) return { status: "idle" };
  if (
    input.expectedItemId !== undefined &&
    claim.item.id !== input.expectedItemId
  ) {
    throw new Error("CONTROL_PLANE_TARGET_CONFLICT");
  }
  const heartbeatIntervalMs = heartbeatIntervalForClaim(
    claim,
    input.heartbeatIntervalMs,
  );
  let dispatchRequested = false;
  let lifecycleHeartbeat: ReturnType<typeof startLeaseHeartbeat> | null = null;
  try {
    requireApplied(
      await input.control.transition({
        fence: claim.fence,
        event: "BEGIN_PREPROCESSING",
      }),
    );
    lifecycleHeartbeat = startLeaseHeartbeat(
      input.control,
      claim.fence,
      heartbeatIntervalMs,
    );
    const work = await input.control.work(claim.fence);
    if (
      work.attemptId !== claim.attemptId ||
      work.itemId !== claim.item.id ||
      work.outputCount !== 1
    ) {
      throw new Error("CONTROL_PLANE_WORK_CONFLICT");
    }
    const downloaded: DownloadedInput[] = [];
    for (const [inputIndex, originalExpected] of work.inputs.entries()) {
      requireApplied(await input.control.heartbeat(claim.fence));
      const refreshedWork =
        inputIndex === 0 ? work : await input.control.work(claim.fence);
      assertSameWork(work, refreshedWork);
      const expected = refreshedWork.inputs[inputIndex];
      if (!expected || expected.index !== originalExpected.index) {
        throw new Error("CONTROL_PLANE_WORK_CONFLICT");
      }
      const actual = await input.control.input(claim.fence, expected.ticket);
      if (
        actual.mimeType !== expected.mimeType ||
        actual.bytes.byteLength !== expected.byteSize ||
        actual.sha256 !== expected.sha256 ||
        digest(actual.bytes) !== expected.sha256
      ) {
        throw new Error("INPUT_INTEGRITY_CONFLICT");
      }
      downloaded.push({
        role: expected.role,
        index: expected.index,
        mimeType: actual.mimeType,
        bytes: actual.bytes,
      });
    }
    requireApplied(await input.control.heartbeat(claim.fence));
    const prepared = await input.executor.prepare(work, downloaded);
    if (!preparedMatchesWork(work, prepared)) {
      throw new Error("EXECUTOR_PREPARATION_CONFLICT");
    }
    // From this point onward an acknowledgement loss is ambiguous: the
    // control plane may already have fenced the attempt for provider dispatch.
    dispatchRequested = true;
    requireApplied(
      await input.control.transition({
        fence: claim.fence,
        ...(work.executionKind === "acceptance"
          ? { event: "BEGIN_ACCEPTANCE_EXECUTION" as const }
          : {
              event: "BEGIN_PROVIDER_DISPATCH" as const,
              providerAccountSlot: prepared.accountSlotId,
            }),
      }),
    );

    let output;
    try {
      output = await prepared.execute();
    } catch (error) {
      await lifecycleHeartbeat.stop();
      await markAmbiguous(
        input.control,
        claim,
        error instanceof GenerationExecutionError
          ? error.code
          : "PROVIDER_RESULT_UNCERTAIN",
        error instanceof GenerationExecutionError
          ? error.providerRequestId
          : null,
      );
      return { status: "reconciliation-required", attemptId: claim.attemptId };
    }
    const providerRequestId = validProviderRequestId(output.providerRequestId)
      ? output.providerRequestId
      : null;
    if (output.providerRequestId !== null && providerRequestId === null) {
      await lifecycleHeartbeat.stop();
      await markAmbiguous(
        input.control,
        claim,
        "PROVIDER_REQUEST_ID_INVALID",
      );
      return { status: "reconciliation-required", attemptId: claim.attemptId };
    }
    let validated;
    try {
      if (
        (work.executionKind === "provider" &&
          output.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) ||
        (work.executionKind === "acceptance" &&
          output.sanitizationVersion !== null)
      ) {
        throw new Error("OUTPUT_SANITIZATION_UNPROVEN");
      }
      validated = validateGeneratedImage(output.bytes, output.mimeType);
      if (validated.bytes.byteLength > MAX_INTERNAL_OUTPUT_BYTES) {
        throw new Error("OUTPUT_TOO_LARGE");
      }
    } catch {
      await lifecycleHeartbeat.stop();
      await markAmbiguous(
        input.control,
        claim,
        "PROVIDER_OUTPUT_INVALID",
        providerRequestId,
      );
      return { status: "reconciliation-required", attemptId: claim.attemptId };
    }
    const record: SpoolRecord = {
      version: 1,
      executionKind: work.executionKind,
      attemptId: claim.attemptId,
      fence: claim.fence,
      uploadRequestId: `upload_${crypto.randomUUID()}`,
      providerRequestId,
      promptTemplateVersion: output.promptTemplateVersion,
      mimeType: validated.mimeType,
      byteSize: validated.bytes.byteLength,
      sha256: validated.sha256,
      sanitizationVersion: output.sanitizationVersion,
    };
    try {
      await input.spool.save(record, validated.bytes);
    } catch {
      await lifecycleHeartbeat.stop();
      await markAmbiguous(
        input.control,
        claim,
        "OUTPUT_SPOOL_FAILED",
        providerRequestId,
      );
      return { status: "reconciliation-required", attemptId: claim.attemptId };
    }
    try {
      requireApplied(await input.control.heartbeat(claim.fence));
    } catch {
      await lifecycleHeartbeat.stop();
      await markAmbiguous(
        input.control,
        claim,
        "LEASE_HEARTBEAT_UNCERTAIN",
        providerRequestId,
      );
      return { status: "reconciliation-required", attemptId: claim.attemptId };
    }
    const outputHeartbeat = lifecycleHeartbeat;
    lifecycleHeartbeat = null;
    return await resumeOutput(
      input.control,
      input.spool,
      record,
      false,
      heartbeatIntervalMs,
      outputHeartbeat,
    );
  } catch {
    await lifecycleHeartbeat?.stop();
    if (dispatchRequested) {
      return {
        status: "reconciliation-required",
        attemptId: claim.attemptId,
      };
    }
    await input.control
      .transition({
        fence: claim.fence,
        event: "FAIL_BEFORE_PROVIDER",
        errorCode: "CONSUMER_PREPROCESSING_FAILED",
        errorMessage: "Consumer failed before provider dispatch",
        errorRetryable: true,
      })
      .catch(() => undefined);
    return { status: "safe-failure", attemptId: claim.attemptId };
  }
}

function assertSameWork(
  original: Awaited<ReturnType<ConsumerControlPlane["work"]>>,
  refreshed: Awaited<ReturnType<ConsumerControlPlane["work"]>>,
): void {
  const withoutTickets = (work: typeof original) => ({
    ...work,
    inputs: work.inputs.map((entry) => ({
      role: entry.role,
      index: entry.index,
      mimeType: entry.mimeType,
      byteSize: entry.byteSize,
      sha256: entry.sha256,
    })),
  });
  if (
    JSON.stringify(withoutTickets(original)) !==
    JSON.stringify(withoutTickets(refreshed))
  ) {
    throw new Error("CONTROL_PLANE_WORK_CONFLICT");
  }
}

async function resumeOutput(
  control: ConsumerControlPlane,
  spool: ConsumerSpool,
  record: SpoolRecord,
  resumed: boolean,
  heartbeatIntervalMs: number,
  existingHeartbeat: LeaseHeartbeat | null = null,
): Promise<RunOneResult> {
  if (
    record.executionKind === "provider" &&
    record.sanitizationVersion !== IMAGE_SANITIZATION_VERSION
  ) {
    await markAmbiguous(
      control,
      { attemptId: record.attemptId, fence: record.fence },
      "OUTPUT_SANITIZATION_UNPROVEN",
      record.providerRequestId,
    );
    await spool.quarantine(record, "invalid-local-record").catch(() => undefined);
    return {
      status: "reconciliation-required",
      attemptId: record.attemptId,
    };
  }
  let heartbeat = existingHeartbeat;
  if (!heartbeat) {
    try {
      requireApplied(await control.heartbeat(record.fence));
      heartbeat = startLeaseHeartbeat(
        control,
        record.fence,
        heartbeatIntervalMs,
      );
    } catch {
      // A committed output deliberately has no active lease. Continue only
      // with the idempotent commit probe; never upload without a live lease.
    }
  }
  let prepared: { commitId: string; ticket: string | null; result?: "rejected" };
  const declaration = { fence:record.fence,uploadRequestId:record.uploadRequestId,providerRequestId:record.providerRequestId,promptTemplateVersion:record.promptTemplateVersion,mimeType:record.mimeType,byteSize:record.byteSize,sha256:record.sha256,sanitizationVersion:record.sanitizationVersion };
  const recordResponse = () => control.transition({fence:record.fence,...(record.executionKind === "acceptance" ? {event:"RECORD_ACCEPTANCE_RESULT" as const} : {event:"RECORD_PROVIDER_RESPONSE" as const,providerRequestId:record.providerRequestId})});
  try {
    if(resumed){
      try {prepared=await control.prepareOutput(declaration);}
      catch {requireApplied(await recordResponse());prepared=await control.prepareOutput(declaration);}
    } else {requireApplied(await recordResponse());prepared=await control.prepareOutput(declaration);}
  } catch (error) {
    await heartbeat?.stop();
    if (isTerminalControlError(error)) {
      await spool.quarantine(record, "terminal-control-plane");
    }
    return {
      status: "reconciliation-required",
      attemptId: record.attemptId,
    };
  }
  // A committed replay is authoritative even though a successful item no
  // longer has an active lease. This is the ACK-loss recovery path.
  if (!prepared.ticket) {
    await heartbeat?.stop();
    await spool.remove(record);
    return prepared.result === "rejected" ? {status:"moderation-rejected",attemptId:record.attemptId} : { status: "completed", attemptId: record.attemptId, resumed };
  }
  if (!heartbeat) {
    try {
      requireApplied(await control.heartbeat(record.fence));
      heartbeat = startLeaseHeartbeat(
        control,
        record.fence,
        heartbeatIntervalMs,
      );
    } catch (error) {
      if (isTerminalControlError(error)) {
        await spool.quarantine(record, "terminal-control-plane");
      }
      return {
        status: "reconciliation-required",
        attemptId: record.attemptId,
      };
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = await spool.read(record);
  } catch {
    await heartbeat.stop();
    await markAmbiguous(
      control,
      { attemptId: record.attemptId, fence: record.fence },
      "OUTPUT_SPOOL_INTEGRITY",
      record.providerRequestId,
    );
    await spool.quarantine(record, "invalid-local-record").catch(() => undefined);
    return {
      status: "reconciliation-required",
      attemptId: record.attemptId,
    };
  }
  if (bytes.byteLength !== record.byteSize || digest(bytes) !== record.sha256) {
    await heartbeat.stop();
    await markAmbiguous(
      control,
      { attemptId: record.attemptId, fence: record.fence },
      "OUTPUT_SPOOL_INTEGRITY",
      record.providerRequestId,
    );
    await spool.quarantine(record, "invalid-local-record").catch(() => undefined);
    return {
      status: "reconciliation-required",
      attemptId: record.attemptId,
    };
  }
  try {
    requireApplied(await control.heartbeat(record.fence));
    const publication = await control.uploadOutput(
        record.fence,
        prepared.ticket,
        record.mimeType,
        bytes,
      );
    if(publication === "moderation_pending")return {status:"moderation-pending",attemptId:record.attemptId};
    if(publication === "rejected"){await spool.remove(record);return {status:"moderation-rejected",attemptId:record.attemptId};}
    requireApplied(publication);
    await spool.remove(record);
    return { status: "completed", attemptId: record.attemptId, resumed };
  } catch (error) {
    // The provider has already been invoked. Keep the output for a later
    // idempotent upload retry; never call the executor again from this path.
    if (isTerminalControlError(error)) {
      await spool.quarantine(record, "terminal-control-plane");
    }
    return {
      status: "reconciliation-required",
      attemptId: record.attemptId,
    };
  } finally {
    await heartbeat.stop();
  }
}

async function markAmbiguous(
  control: ConsumerControlPlane,
  claim: Pick<ConsumerClaim, "attemptId" | "fence">,
  code: string,
  providerRequestId: string | null = null,
): Promise<void> {
  await control
    .transition({
      fence: claim.fence,
      event: "MARK_AMBIGUOUS",
      errorCode: code,
      errorMessage: "Provider work requires operator reconciliation",
      providerRequestId,
    })
    .catch(() => undefined);
}

function validProviderRequestId(value: string | null): boolean {
  return value === null || (value.length >= 1 && value.length <= 200);
}

function preparedMatchesWork(
  work: Awaited<ReturnType<ConsumerControlPlane["work"]>>,
  prepared: Awaited<ReturnType<GenerationExecutor["prepare"]>>,
): boolean {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(prepared.accountSlotId)) return false;
  if (work.executionKind === "acceptance") {
    return (
      work.providerPreference === "acceptance-fixture-v1" &&
      prepared.provider === "acceptance" &&
      prepared.model === "acceptance-fixture-v1" &&
      prepared.accountSlotId === "acceptance-fixture"
    );
  }
  return (
    isImageModel(work.providerPreference) &&
    prepared.model === work.providerPreference &&
    prepared.provider === imageModelProvider(work.providerPreference)
  );
}

function isTerminalControlError(error: unknown): boolean {
  return (
    error instanceof ConsumerControlPlaneError &&
    (error.status === 409 || error.status === 410) &&
    TERMINAL_CONTROL_CODES.has(error.code)
  );
}

function startLeaseHeartbeat(
  control: ConsumerControlPlane,
  fence: ConsumerClaim["fence"],
  intervalMs: number,
): LeaseHeartbeat {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5 || intervalMs > 120_000) {
    throw new Error("INVALID_HEARTBEAT_INTERVAL");
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = control
        .heartbeat(fence)
        .then(requireApplied)
        .catch(() => undefined)
        .then(schedule);
    }, intervalMs);
    timer.unref?.();
  };
  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
  schedule();
  return {
    stop,
    async confirmAndStop() {
      await stop();
      try {
        requireApplied(await control.heartbeat(fence));
        return true;
      } catch {
        return false;
      }
    },
  };
}

type LeaseHeartbeat = {
  stop(): Promise<void>;
  confirmAndStop(): Promise<boolean>;
};

export function heartbeatIntervalForClaim(
  claim: ConsumerClaim,
  requestedIntervalMs?: number,
): number {
  if (!Number.isSafeInteger(claim.item.leaseExpiresAt)) {
    throw new Error("INVALID_CLAIM_LEASE_EXPIRY");
  }
  const remainingMs = claim.item.leaseExpiresAt * 1_000 - Date.now();
  if (remainingMs <= 0) throw new Error("CLAIM_LEASE_EXPIRED");
  const safeMaximum = Math.max(5, Math.floor(remainingMs / 3));
  return Math.min(
    requestedIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    safeMaximum,
  );
}

function requireApplied(value: "applied" | "already_applied"): void {
  if (value !== "applied" && value !== "already_applied") {
    throw new Error("CONTROL_PLANE_MUTATION_REJECTED");
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
