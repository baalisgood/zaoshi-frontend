import { runConsumerDaemon } from "../../lib/consumer/daemon";
import type { ConsumerHealthSnapshot } from "../../lib/consumer/health";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  ConsumerClaim,
  ConsumerControlPlane,
  ConsumerSpool,
  GenerationExecutor,
  SpoolRecord,
} from "../../lib/consumer/contracts";
import { GenerationExecutionError } from "../../lib/consumer/contracts";
import { ConsumerControlPlaneError } from "../../lib/consumer/control-plane-client";
import { createDomesticGenerationExecutor } from "../../lib/consumer/domestic-executor";
import {
  heartbeatIntervalForClaim,
  runOne,
} from "../../lib/consumer/run-one";
import type { InternalWorkSpec } from "../../lib/server/internal-queue-execution";
import type { InternalTransitionInput } from "../../lib/server/internal-queue-contract";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test("single-item consumer invokes the executor once and commits one output", async () => {
  const control = new FakeControl();
  const spool = new MemorySpool();
  const executor = new FakeExecutor();
  const result = await runOne({
    workerId: "worker-success",
    claimRequestId: "claim-success",
    control,
    executor,
    spool,
  });
  assert.deepEqual(result, {
    status: "completed",
    attemptId: "attempt-consumer-1",
    resumed: false,
  });
  assert.equal(executor.calls, 1);
  assert.equal(control.uploads, 1);
  assert.deepEqual(control.preparedSanitizationVersions, [
    "canonical-image-v1",
  ]);
  assert.equal((await spool.list()).length, 0);
  assert.deepEqual(control.events, [
    "BEGIN_PREPROCESSING",
    "BEGIN_PROVIDER_DISPATCH",
    "RECORD_PROVIDER_RESPONSE",
  ]);
});

test("single-item consumer preserves a 4K work spec through output commit", async () => {
  const control = new FakeControl();
  control.resolution = "4K";
  const executor = new FakeExecutor();
  const result = await runOne({ workerId: "worker-4k", claimRequestId: "claim-4k", control, executor, spool: new MemorySpool() });
  assert.equal(result.status, "completed");
  assert.equal(executor.preparedResolution, "4K");
  assert.equal(control.uploads, 1);
});

test("Sunburst Max dispatch failure keeps its real request ID and does not replay the attempt", async () => {
  const control = new FakeControl();
  const baseWork = control.work.bind(control);
  const source = PNG_BYTES.slice();
  new DataView(source.buffer).setUint32(16, 512);
  new DataView(source.buffer).setUint32(20, 512);
  control.work = async () => ({ ...await baseWork(), providerPreference: "gpt-image-2.5-sunburst", quality: "max", inputs: [{ role: "source", index: 0, mimeType: "image/png", byteSize: source.byteLength, sha256: digest(source), ticket: "t".repeat(64) }] });
  control.input = async () => ({ bytes: source, mimeType: "image/png", sha256: digest(source) });
  const firstClaim = control.claim.bind(control);
  control.claim = (async () => control.claims ? null : firstClaim()) as typeof control.claim;
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: { openai: { id: "openai-test", provider: "openai", apiKey: "test-only-key" } },
    fetch: (async () => { throw new Error("direct fallback forbidden"); }) as typeof fetch,
    privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60,
    overseasTransport: {
      async assertReady() {},
      fetch: (async (input, init) => {
        calls++;
        const request = new Request(input, init);
        const body = await request.formData();
        assert.equal(body.get("quality"), "max"); assert.equal(body.get("model"), "gpt-image-2.5-sunburst");
        assert.equal(body.get("size"), "2048x1536"); assert.equal(body.get("n"), "1");
        // The provider answered, but there is no usable image. Retrying could incur a second charge.
        return Response.json({ data: [] }, { headers: { "x-zaoshi-provider-request-id": "actual-sunburst-uncertain", "x-request-id": "gateway-generated" } });
      }) as typeof fetch,
    },
    sanitizer: { async sanitize() { throw new Error("no image must reach sanitation"); } },
  });
  const input = { workerId: "worker-sunburst", claimRequestId: "claim-sunburst", control, executor, spool: new MemorySpool() };
  const result = await runOne(input);
  assert.deepEqual(result, { status: "reconciliation-required", attemptId: control.claimRecord.attemptId });
  assert.deepEqual(control.events, ["BEGIN_PREPROCESSING", "BEGIN_PROVIDER_DISPATCH", "MARK_AMBIGUOUS"]);
  assert.deepEqual(control.ambiguousProviderRequestIds, ["actual-sunburst-uncertain"]);
  assert.equal(control.uploads, 0); assert.equal(calls, 1); assert.equal(control.claims, 1);
  assert.equal((await runOne(input)).status, "idle");
  assert.equal(calls, 1); assert.equal(control.claims, 1);
});

test("upload acknowledgement loss resumes from spool without invoking provider twice", async () => {
  const control = new FakeControl();
  control.loseFirstUploadAckAfterCommit = true;
  control.staleHeartbeatAfterCommit = true;
  const spool = new MemorySpool();
  const executor = new FakeExecutor();
  assert.equal(
    (
      await runOne({
        workerId: "worker-resume",
        claimRequestId: "claim-resume",
        control,
        executor,
        spool,
      })
    ).status,
    "reconciliation-required",
  );
  assert.equal(executor.calls, 1);
  assert.equal((await spool.list()).length, 1);

  const resumed = await runOne({
    workerId: "worker-resume",
    claimRequestId: "claim-new-must-not-be-used",
    control,
    executor,
    spool,
  });
  assert.deepEqual(resumed, {
    status: "completed",
    attemptId: "attempt-consumer-1",
    resumed: true,
  });
  assert.equal(executor.calls, 1);
  assert.equal(control.claims, 1);
  assert.equal(control.uploads, 1);
  assert.equal(spool.quarantined.length, 0);
});

test("targeted acceptance run ignores spool records belonging to another item", async () => {
  const control = new FakeControl();
  const spool = new MemorySpool();
  const foreign: SpoolRecord = {
    version: 1,
    executionKind: "acceptance",
    attemptId: "attempt-acceptance-foreign",
    fence: {
      itemId: "qitem-acceptance-foreign",
      leaseToken: "lease-acceptance-foreign",
      leaseGeneration: 1,
    },
    uploadRequestId: "upload-acceptance-foreign",
    providerRequestId: null,
    promptTemplateVersion: "acceptance-fixture-v1",
    sanitizationVersion: null,
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
  };
  await spool.save(foreign, PNG_BYTES);

  const result = await runOne({
    workerId: "worker-targeted",
    claimRequestId: "claim-targeted",
    control,
    executor: new FakeExecutor(),
    spool,
    expectedItemId: control.claimRecord.item.id,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.resumed, false);
  assert.equal(control.claims, 1);
  assert.deepEqual((await spool.list()).map((record) => record.attemptId), [
    foreign.attemptId,
  ]);
});

test("legacy provider spool is quarantined without another provider call", async () => {
  const control = new FakeControl();
  const spool = new MemorySpool();
  const record: SpoolRecord = {
    version: 1,
    executionKind: "provider",
    attemptId: control.claimRecord.attemptId,
    fence: control.claimRecord.fence,
    uploadRequestId: "upload-legacy-unproven",
    providerRequestId: "provider-legacy-unproven",
    promptTemplateVersion: "interior-concept-v4",
    sanitizationVersion: null,
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: digest(PNG_BYTES),
  };
  await spool.save(record, PNG_BYTES);
  const executor = new FakeExecutor();
  const result = await runOne({
    workerId: "worker-legacy-unproven",
    claimRequestId: "claim-must-not-be-used",
    control,
    executor,
    spool,
  });
  assert.equal(result.status, "reconciliation-required");
  assert.equal(control.claims, 0);
  assert.equal(executor.calls, 0);
  assert.deepEqual(control.ambiguousProviderRequestIds, [
    "provider-legacy-unproven",
  ]);
  assert.equal(spool.quarantined.length, 1);
});

test("targeted run rejects a different claimed item before any transition", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  await assert.rejects(
    runOne({
      workerId: "worker-target-conflict",
      claimRequestId: "claim-target-conflict",
      control,
      executor,
      spool: new MemorySpool(),
      expectedItemId: "qitem-authorized-canary-only",
    }),
    /CONTROL_PLANE_TARGET_CONFLICT/u,
  );
  assert.equal(control.claims, 1);
  assert.equal(control.events.length, 0);
  assert.equal(control.workCalls, 0);
  assert.equal(executor.calls, 0);
});

test("provider uncertainty is never converted into a safe retry", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.fail = true;
  const result = await runOne({
    workerId: "worker-provider-failure",
    claimRequestId: "claim-provider-failure",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "reconciliation-required");
  assert.equal(executor.calls, 1);
  assert.ok(control.events.includes("MARK_AMBIGUOUS"));
  assert.equal(control.events.includes("FAIL_BEFORE_PROVIDER"), false);
});

test("provider execution failure keeps its request id for reconciliation", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.failWithProviderRequestId = true;
  executor.failureCode = "RATE_LIMITED";
  const result = await runOne({
    workerId: "worker-provider-request-id",
    claimRequestId: "claim-provider-request-id",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(control.ambiguousProviderRequestIds, ["provider-failed-1"]);
  assert.deepEqual(control.ambiguousErrorCodes, ["RATE_LIMITED"]);
  assert.equal(executor.calls, 1);
  assert.equal(control.events.includes("FAIL_BEFORE_PROVIDER"), false);
});

test("dispatch acknowledgement loss never calls the provider or requests a safe retry", async () => {
  const control = new FakeControl();
  control.failDispatchAck = true;
  const executor = new FakeExecutor();
  const result = await runOne({
    workerId: "worker-dispatch-ack",
    claimRequestId: "claim-dispatch-ack",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "reconciliation-required");
  assert.equal(executor.calls, 0);
  assert.equal(control.events.includes("FAIL_BEFORE_PROVIDER"), false);
});

test("preprocessing failure requests a safe retry before provider dispatch", async () => {
  const control = new FakeControl();
  control.failWork = true;
  const executor = new FakeExecutor();
  const result = await runOne({
    workerId: "worker-preprocessing-failure",
    claimRequestId: "claim-preprocessing-failure",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "safe-failure");
  assert.equal(executor.calls, 0);
  assert.ok(control.events.includes("FAIL_BEFORE_PROVIDER"));
  assert.equal(control.events.includes("BEGIN_PROVIDER_DISPATCH"), false);
});

test("executor preparation failure is safe and never starts provider dispatch", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.failPrepare = true;
  const result = await runOne({
    workerId: "worker-prepare-failure",
    claimRequestId: "claim-prepare-failure",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "safe-failure");
  assert.equal(executor.calls, 0);
  assert.ok(control.events.includes("FAIL_BEFORE_PROVIDER"));
  assert.equal(control.events.includes("BEGIN_PROVIDER_DISPATCH"), false);
});

test("slow provider execution renews the lease before the configured interval", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.delayMs = 35;
  const result = await runOne({
    workerId: "worker-heartbeat",
    claimRequestId: "claim-heartbeat",
    control,
    executor,
    spool: new MemorySpool(),
    heartbeatIntervalMs: 5,
  });
  assert.equal(result.status, "completed");
  assert.ok(control.heartbeats >= 3);
});

test("slow multi-reference downloads refresh work tickets and keep the lease alive", async () => {
  const control = new FakeControl();
  control.inputCount = 3;
  control.inputDelayMs = 18;
  const result = await runOne({
    workerId: "worker-input-heartbeat",
    claimRequestId: "claim-input-heartbeat",
    control,
    executor: new FakeExecutor(),
    spool: new MemorySpool(),
    heartbeatIntervalMs: 5,
  });
  assert.equal(result.status, "completed");
  assert.equal(control.workCalls, 3);
  assert.ok(control.heartbeats >= 6);
});

test("slow output upload keeps renewing the lease until commit", async () => {
  const control = new FakeControl();
  control.uploadDelayMs = 35;
  const result = await runOne({
    workerId: "worker-output-heartbeat",
    claimRequestId: "claim-output-heartbeat",
    control,
    executor: new FakeExecutor(),
    spool: new MemorySpool(),
    heartbeatIntervalMs: 5,
  });
  assert.equal(result.status, "completed");
  assert.ok(control.heartbeats >= 5);
});

test("resumed paid output renews through slow response recording and prepare", async () => {
  const control = new FakeControl();
  control.failFirstUploadBeforeCommit = true;
  const spool = new MemorySpool();
  const executor = new FakeExecutor();
  assert.equal(
    (
      await runOne({
        workerId: "worker-paid-output-seed",
        claimRequestId: "claim-paid-output-seed",
        control,
        executor,
        spool,
      })
    ).status,
    "reconciliation-required",
  );
  control.failFirstUploadBeforeCommit = false;
  control.responseTransitionDelayMs = 24;
  control.prepareDelayMs = 24;
  control.enforceLeaseForTest(30);
  const resumed = await runOne({
    workerId: "worker-paid-output-resume",
    claimRequestId: "claim-paid-output-resume",
    control,
    executor,
    spool,
    heartbeatIntervalMs: 5,
  });
  assert.deepEqual(resumed, {
    status: "completed",
    attemptId: "attempt-consumer-1",
    resumed: true,
  });
  assert.equal(executor.calls, 1);
  assert.equal(spool.quarantined.length, 0);
  assert.ok(control.heartbeats >= 6);
});

test("a 30 second server lease caps consumer heartbeats below one third", () => {
  const control = new FakeControl();
  const claim: ConsumerClaim = {
    ...control.claimRecord,
    item: {
      ...control.claimRecord.item,
      leaseExpiresAt: Math.floor(Date.now() / 1_000) + 30,
    },
  };
  const interval = heartbeatIntervalForClaim(claim, 45_000);
  assert.ok(interval >= 9_000);
  assert.ok(interval < 10_000);
});

test("invalid provider output preserves the provider request id for reconciliation", async () => {
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.invalidBytes = true;
  const result = await runOne({
    workerId: "worker-invalid-output",
    claimRequestId: "claim-invalid-output",
    control,
    executor,
    spool: new MemorySpool(),
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(control.ambiguousProviderRequestIds, ["provider-consumer-1"]);
});

test("spool failure preserves the provider request id for reconciliation", async () => {
  const control = new FakeControl();
  const spool = new MemorySpool();
  spool.failSave = true;
  const result = await runOne({
    workerId: "worker-spool-failure",
    claimRequestId: "claim-spool-failure",
    control,
    executor: new FakeExecutor(),
    spool,
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(control.ambiguousProviderRequestIds, ["provider-consumer-1"]);
});

test("terminally stale spool is quarantined so a later claim can run", async () => {
  const control = new FakeControl();
  control.failFirstUploadBeforeCommit = true;
  const spool = new MemorySpool();
  const executor = new FakeExecutor();
  assert.equal(
    (
      await runOne({
        workerId: "worker-stale-seed",
        claimRequestId: "claim-stale-seed",
        control,
        executor,
        spool,
      })
    ).status,
    "reconciliation-required",
  );
  control.terminalHeartbeat = true;
  assert.equal(
    (
      await runOne({
        workerId: "worker-stale-resume",
        claimRequestId: "claim-stale-resume",
        control,
        executor,
        spool,
      })
    ).status,
    "reconciliation-required",
  );
  assert.equal(spool.quarantined.length, 1);
  assert.equal((await spool.list()).length, 0);

  control.terminalHeartbeat = false;
  control.failFirstUploadBeforeCommit = false;
  assert.equal(
    (
      await runOne({
        workerId: "worker-after-stale",
        claimRequestId: "claim-after-stale",
        control,
        executor,
        spool,
      })
    ).status,
    "completed",
  );
  assert.equal(control.claims, 2);
});

test("failed corrupt-record quarantine cannot leak a lease heartbeat", async () => {
  const control = new FakeControl();
  control.failFirstUploadBeforeCommit = true;
  const spool = new MemorySpool();
  const executor = new FakeExecutor();
  await runOne({
    workerId: "worker-corrupt-seed",
    claimRequestId: "claim-corrupt-seed",
    control,
    executor,
    spool,
  });
  spool.corruptRead = true;
  spool.failQuarantine = true;
  const result = await runOne({
    workerId: "worker-corrupt-resume",
    claimRequestId: "claim-corrupt-resume",
    control,
    executor,
    spool,
    heartbeatIntervalMs: 5,
  });
  assert.equal(result.status, "reconciliation-required");
  const stoppedAt = control.heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(control.heartbeats, stoppedAt);
  assert.equal(executor.calls, 1);
});

class FakeExecutor implements GenerationExecutor {
  calls = 0;
  fail = false;
  failWithProviderRequestId = false;
  failureCode: import("../../lib/ai").AiErrorCode = "PROVIDER_ERROR";
  failPrepare = false;
  delayMs = 0;
  invalidBytes = false;
  preparedResolution: string | undefined;

  async prepare(work: InternalWorkSpec) {
    this.preparedResolution = work.resolution;
    if (this.failPrepare) throw new Error("local preparation failed");
    return {
      provider: "seedream" as const,
      model: "doubao-seedream-4-5-251128",
      accountSlotId: "seedream-test",
      execute: async () => {
        this.calls += 1;
        if (this.failWithProviderRequestId) {
          throw new GenerationExecutionError("provider-failed-1", {
            code: this.failureCode,
          });
        }
        if (this.fail) throw new Error("provider uncertain");
        if (this.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        return {
          bytes: this.invalidBytes ? Uint8Array.from([1, 2, 3]) : PNG_BYTES,
          mimeType: "image/png",
          providerRequestId: "provider-consumer-1",
          promptTemplateVersion: "interior-concept-v4",
          sanitizationVersion: "canonical-image-v1",
        };
      },
    };
  }
}

class MemorySpool implements ConsumerSpool {
  private records = new Map<string, { record: SpoolRecord; bytes: Uint8Array }>();
  readonly quarantined: Array<{ attemptId: string; reason: string }> = [];
  failSave = false;
  corruptRead = false;
  failQuarantine = false;

  async list(): Promise<SpoolRecord[]> {
    return [...this.records.values()].map((item) => item.record);
  }

  async read(record: SpoolRecord): Promise<Uint8Array> {
    if (this.corruptRead) throw new Error("corrupt spool");
    const value = this.records.get(record.attemptId);
    if (!value) throw new Error("missing spool");
    return value.bytes.slice();
  }

  async save(record: SpoolRecord, bytes: Uint8Array): Promise<void> {
    if (this.failSave) throw new Error("spool unavailable");
    this.records.set(record.attemptId, { record, bytes: bytes.slice() });
  }

  async remove(record: SpoolRecord): Promise<void> {
    this.records.delete(record.attemptId);
  }

  async quarantine(
    record: SpoolRecord,
    reason: "invalid-local-record" | "terminal-control-plane",
  ): Promise<void> {
    if (this.failQuarantine) throw new Error("quarantine unavailable");
    this.quarantined.push({ attemptId: record.attemptId, reason });
    this.records.delete(record.attemptId);
  }
}

class FakeControl implements ConsumerControlPlane {
  readonly claimRecord: ConsumerClaim = {
    item: {
      id: "qitem-consumer-1",
      jobId: "job-consumer-1",
      ordinal: 0,
      leaseExpiresAt: Math.floor(Date.now() / 1_000) + 180,
      executionKind: "provider",
    },
    attemptId: "attempt-consumer-1",
    fence: {
      itemId: "qitem-consumer-1",
      leaseToken: "lease-consumer-1",
      leaseGeneration: 1,
    },
  };
  readonly events: string[] = [];
  claims = 0;
  uploads = 0;
  workCalls = 0;
  heartbeats = 0;
  readonly ambiguousProviderRequestIds: Array<string | null> = [];
  readonly ambiguousErrorCodes: string[] = [];
  readonly preparedSanitizationVersions: Array<string | null> = [];
  failFirstUploadBeforeCommit = false;
  loseFirstUploadAckAfterCommit = false;
  staleHeartbeatAfterCommit = false;
  committed = false;
  failDispatchAck = false;
  failWork = false;
  terminalHeartbeat = false;
  inputCount = 1;
  inputDelayMs = 0;
  uploadDelayMs = 0;
  responseTransitionDelayMs = 0;
  prepareDelayMs = 0;
  resolution: InternalWorkSpec["resolution"] = "2K";
  private leaseDurationMs = 0;
  private leaseDeadlineMs = 0;

  async claimJob(): Promise<ConsumerClaim> {
    return this.claimRecord;
  }

  async claim(): Promise<ConsumerClaim> {
    this.claims += 1;
    if (this.leaseDurationMs > 0) {
      this.leaseDeadlineMs = Date.now() + this.leaseDurationMs;
    }
    return this.claimJob();
  }

  async heartbeat(): Promise<"applied"> {
    this.heartbeats += 1;
    this.assertTestLease();
    if (this.terminalHeartbeat || (this.committed && this.staleHeartbeatAfterCommit)) {
      throw new ConsumerControlPlaneError(409, "QUEUE_FENCE_STALE");
    }
    if (this.leaseDurationMs > 0) {
      this.leaseDeadlineMs = Date.now() + this.leaseDurationMs;
    }
    return "applied";
  }

  async transition(input: InternalTransitionInput): Promise<"applied"> {
    if (
      input.event === "RECORD_PROVIDER_RESPONSE" &&
      this.responseTransitionDelayMs > 0
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.responseTransitionDelayMs),
      );
      this.assertTestLease();
    }
    this.events.push(input.event);
    if (input.event === "MARK_AMBIGUOUS") {
      this.ambiguousProviderRequestIds.push(input.providerRequestId);
      this.ambiguousErrorCodes.push(input.errorCode);
    }
    if (this.failDispatchAck && input.event === "BEGIN_PROVIDER_DISPATCH") {
      throw new Error("dispatch ack lost");
    }
    return "applied";
  }

  async work(): Promise<InternalWorkSpec> {
    this.workCalls += 1;
    if (this.failWork) throw new Error("preprocessing failed");
    return {
      version: 1,
      executionKind: "provider",
      itemId: this.claimRecord.item.id,
      attemptId: this.claimRecord.attemptId,
      outputOrdinal: 0,
      totalOutputs: 1,
      providerPreference: "doubao-seedream-4-5-251128",
      workflowType: "advanced",
      purpose: "final",
      resolution: this.resolution,
      aspectRatio: "4:3",
      quality: "standard",
      visualRealism: "photorealistic",
      stylePresetId: "modern-minimalist",
      lightingPreset: "noon",
      lampState: "mixed",
      colorTemperatureKelvin: 4000,
      renovationScope: "restyle",
      promotedFromPreview: false,
      editInstruction: null,
      customPrompt: null,
      advancedSettings: {
        version: 1,
        geometryFidelity: "balanced",
        cameraPolicy: "locked",
        furnishingDensity: "balanced",
        materialExpression: "natural",
        lightingContrast: "balanced",
      },
      outputCount: 1,
      inputs: Array.from({ length: this.inputCount }, (_, index) => ({
        role: index === 0 ? "source" : "reference",
        index,
        mimeType: "image/png",
        byteSize: PNG_BYTES.byteLength,
        sha256: digest(PNG_BYTES),
        ticket: `input-ticket-${this.workCalls}-${index}`,
      })),
    };
  }

  async input(): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }> {
    if (this.inputDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.inputDelayMs));
    }
    return { bytes: PNG_BYTES, mimeType: "image/png", sha256: digest(PNG_BYTES) };
  }

  async prepareOutput(
    input: Parameters<ConsumerControlPlane["prepareOutput"]>[0],
  ): Promise<{ commitId: string; ticket: string | null }> {
    this.preparedSanitizationVersions.push(input.sanitizationVersion);
    if (this.prepareDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.prepareDelayMs));
      this.assertTestLease();
    }
    return {
      commitId: "ocommit-consumer-1",
      ticket: this.committed ? null : "output-ticket",
    };
  }

  async uploadOutput(): Promise<"applied"> {
    this.uploads += 1;
    if (this.uploadDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.uploadDelayMs));
    }
    if (this.failFirstUploadBeforeCommit && this.uploads === 1) {
      throw new Error("ack lost");
    }
    this.committed = true;
    if (this.loseFirstUploadAckAfterCommit && this.uploads === 1) {
      throw new Error("ack lost after commit");
    }
    return "applied";
  }

  enforceLeaseForTest(durationMs: number): void {
    this.leaseDurationMs = durationMs;
    this.leaseDeadlineMs = Date.now() + durationMs;
  }

  private assertTestLease(): void {
    if (this.leaseDurationMs > 0 && Date.now() > this.leaseDeadlineMs) {
      throw new ConsumerControlPlaneError(409, "QUEUE_FENCE_STALE");
    }
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}


for (const heartbeatFails of [false, true]) {
  test(`daemon refreshes long work health and preserves heartbeat failure=${heartbeatFails}`, async () => {
    const controller = new AbortController();
    const control = new FakeControl();
    const snapshots: ConsumerHealthSnapshot[] = [];
    const spool = new MemorySpool();
    const executor = new FakeExecutor();
    executor.delayMs = 65;
    let clock = Date.now();
    let executing = false;
    const prepare = executor.prepare.bind(executor);
    executor.prepare = async (work) => {
      const prepared = await prepare(work);
      return { ...prepared, execute: async () => {
        executing = true;
        if (heartbeatFails) control.terminalHeartbeat = true;
        return prepared.execute();
      } };
    };
    const heartbeat = control.heartbeat.bind(control);
    control.heartbeat = async () => {
      if (executing) clock += 30_000;
      return heartbeat();
    };
    await runConsumerDaemon({
      workerId: "worker-health", control: Object.assign(control, { async sweep() { return { retried: 0, failed: 0, reconciliationRequired: 1 }; } }),
      executor, spool: Object.assign(spool, { async maintainQuarantine() { return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 }; } }),
      health: { async write(snapshot) { snapshots.push(snapshot); } }, heartbeatIntervalMs: 5,
      idleBackoff: { minMs: 1, maxMs: 1 }, errorBackoff: { minMs: 1, maxMs: 1 }, reconciliationBackoffMs: 1, sweepIntervalMs: 30_000, busyBurstLimit: 1,
      quarantine: { retentionMs: 1, maxEntries: 1, maxBytes: 1 }, signal: controller.signal, now: () => clock,
      async delay() { controller.abort(); },
    });
    assert.equal(executor.calls, 1);
    assert.ok(control.heartbeats >= 6);
    const observed = snapshots.filter((snapshot) => snapshot.state !== "draining" && snapshot.state !== "stopped");
    assert.equal(observed.at(-1)?.state, heartbeatFails ? "degraded" : "ready");
    if (heartbeatFails) {
      const failureIndex = observed.findIndex((snapshot) => snapshot.counters.controlPlaneFailures > 0);
      assert.ok(failureIndex >= 0);
      assert.ok(observed.slice(failureIndex).every((snapshot) => snapshot.state === "degraded"));
      assert.equal(observed.at(-1)?.counters.reconciliationRequired, 2);
    } else {
      assert.ok(clock - new Date(observed[0].updatedAt).getTime() >= 120_000);
      assert.equal(new Date(observed.at(-1)!.lastSuccessAt!).getTime(), clock);
      assert.ok(observed.filter((snapshot) => snapshot.state === "ready").length >= 6);
    }
    const heartbeatCount = control.heartbeats;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(control.heartbeats, heartbeatCount);
  });
}

test("daemon proceeds to a separate task after provider timeout without latching degraded", async () => {
  const controller = new AbortController();
  const control = new FakeControl();
  const executor = new FakeExecutor();
  executor.failWithProviderRequestId = true;
  executor.failureCode = "PROVIDER_TIMEOUT";
  const prepare = executor.prepare.bind(executor);
  let preparations = 0;
  executor.prepare = async (work) => { executor.failWithProviderRequestId = preparations++ === 0; return prepare(work); };
  const snapshots: ConsumerHealthSnapshot[] = [];
  await runConsumerDaemon({
    workerId: "worker-next", control: Object.assign(control, { async sweep() { return { retried: 0, failed: 0, reconciliationRequired: 0 }; } }), executor,
    spool: Object.assign(new MemorySpool(), { async maintainQuarantine() { return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 }; } }),
    health: { async write(snapshot) { snapshots.push(snapshot); } }, heartbeatIntervalMs: 5,
    idleBackoff: { minMs: 1, maxMs: 1 }, errorBackoff: { minMs: 1, maxMs: 1 }, reconciliationBackoffMs: 1, sweepIntervalMs: 30_000, busyBurstLimit: 1,
    quarantine: { retentionMs: 1, maxEntries: 1, maxBytes: 1 }, signal: controller.signal,
    async delay() { if (preparations >= 2) controller.abort(); },
  });
  assert.equal(executor.calls, 2);
  assert.equal(control.claims, 2);
  assert.equal(control.uploads, 1);
  assert.deepEqual(control.ambiguousErrorCodes, ["PROVIDER_TIMEOUT"]);
  assert.equal(snapshots.at(-1)?.counters.reconciliationRequired, 1);
  assert.equal(snapshots.at(-1)?.counters.completed, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.state !== "degraded"));
});


test("daemon does not report recovery when heartbeat and safe-failure acknowledgement both fail", async () => {
  const controller = new AbortController();
  const control = new FakeControl();
  control.heartbeat = async () => { throw new Error("CONTROL_PLANE_UNAVAILABLE"); };
  const transition = control.transition.bind(control);
  control.transition = async (input) => { if (input.event === "FAIL_BEFORE_PROVIDER") throw new Error("CONTROL_PLANE_UNAVAILABLE"); return transition(input); };
  const snapshots: ConsumerHealthSnapshot[] = [];
  await runConsumerDaemon({
    workerId: "worker-safe-fault", control: Object.assign(control, { async sweep() { return { retried: 0, failed: 0, reconciliationRequired: 0 }; } }), executor: new FakeExecutor(),
    spool: Object.assign(new MemorySpool(), { async maintainQuarantine() { return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 }; } }),
    health: { async write(snapshot) { snapshots.push(snapshot); } }, heartbeatIntervalMs: 5,
    idleBackoff: { minMs: 1, maxMs: 1 }, errorBackoff: { minMs: 1, maxMs: 1 }, reconciliationBackoffMs: 1, sweepIntervalMs: 30_000, busyBurstLimit: 1,
    quarantine: { retentionMs: 1, maxEntries: 1, maxBytes: 1 }, signal: controller.signal,
    async delay() { controller.abort(); },
  });
  const failureIndex = snapshots.findIndex((snapshot) => snapshot.state === "degraded");
  assert.ok(failureIndex >= 0);
  assert.ok(snapshots.slice(failureIndex).every((snapshot) => snapshot.state !== "ready"));
  assert.equal(snapshots.at(-1)?.lastErrorCode, "CONTROL_PLANE_UNAVAILABLE");
  assert.equal(snapshots.at(-1)?.counters.safeFailures, 1);
});


test("daemon keeps a control failure across legacy spool quarantine until a successful claim", async () => {
  const controller = new AbortController();
  const control = new FakeControl();
  control.heartbeat = async () => { throw new Error("CONTROL_PLANE_UNAVAILABLE"); };
  const transition = control.transition.bind(control);
  control.transition = async (input) => {
    if (input.event === "FAIL_BEFORE_PROVIDER" || input.event === "MARK_AMBIGUOUS") throw new Error("CONTROL_PLANE_UNAVAILABLE");
    return transition(input);
  };
  const spool = new MemorySpool();
  const snapshots: ConsumerHealthSnapshot[] = [];
  let rounds = 0;
  let recoveryBoundary = 0;
  await runConsumerDaemon({
    workerId: "worker-cross-round", control: Object.assign(control, { async sweep() { return { retried: 0, failed: 0, reconciliationRequired: 0 }; } }), executor: new FakeExecutor(),
    spool: Object.assign(spool, { async maintainQuarantine() { return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 }; } }),
    health: { async write(snapshot) { snapshots.push(snapshot); } }, heartbeatIntervalMs: 5,
    idleBackoff: { minMs: 1, maxMs: 1 }, errorBackoff: { minMs: 1, maxMs: 1 }, reconciliationBackoffMs: 1, sweepIntervalMs: 30_000, busyBurstLimit: 1,
    quarantine: { retentionMs: 1, maxEntries: 1, maxBytes: 1 }, signal: controller.signal,
    async delay() {
      rounds += 1;
      if (rounds === 1) {
        await spool.save({ version: 1, executionKind: "provider", attemptId: "legacy-attempt", fence: control.claimRecord.fence, uploadRequestId: "legacy-upload", providerRequestId: null, promptTemplateVersion: "legacy", mimeType: "image/png", byteSize: PNG_BYTES.byteLength, sha256: digest(PNG_BYTES), sanitizationVersion: null }, PNG_BYTES);
      } else if (rounds === 2) {
        assert.equal(snapshots.at(-1)?.state, "degraded");
        assert.equal(snapshots.at(-1)?.lastErrorCode, "CONTROL_PLANE_UNAVAILABLE");
        assert.equal(control.claims, 1);
        recoveryBoundary = snapshots.length;
        control.claim = async () => { control.claims += 1; return null as unknown as ConsumerClaim; };
      } else controller.abort();
    },
  });
  const failureIndex = snapshots.findIndex((snapshot) => snapshot.state === "degraded");
  assert.ok(failureIndex >= 0 && recoveryBoundary > failureIndex);
  assert.ok(snapshots.slice(failureIndex, recoveryBoundary).every((snapshot) => snapshot.state === "degraded"));
  assert.ok(snapshots.slice(recoveryBoundary).some((snapshot) => snapshot.state === "ready" && snapshot.lastErrorCode === null));
  assert.equal(control.claims, 2);
  assert.equal(spool.quarantined.length, 1);
  assert.equal(snapshots.at(-1)?.counters.safeFailures, 1);
  assert.equal(snapshots.at(-1)?.counters.reconciliationRequired, 1);
});

test('three pool slots execute together and shutdown waits for all outputs to commit',async()=>{
 const {runConsumerPool}=await import('../../lib/consumer/pool');
 const stop=new AbortController();let active=0,peak=0,entered=0;let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const controls=Array.from({length:3},()=>new FakeControl());
 const spools=Array.from({length:3},()=>new MemorySpool());
 const reports:ConsumerHealthSnapshot[]=[];
 const slots=controls.map((control,index)=>{
  const original=control.claim.bind(control);control.claim=(async()=>control.claims?null:original()) as typeof control.claim;
  const executor:GenerationExecutor={async prepare(work){const prepared=await new FakeExecutor().prepare(work);return {...prepared,execute:async()=>{active++;entered++;peak=Math.max(peak,active);if(entered===3){stop.abort();release();}await gate;try{return await prepared.execute();}finally{active--;}}};}};
  return {workerId:`pool-test-${index}`,control:Object.assign(control,{async sweep(){return {retried:0,failed:0,reconciliationRequired:0};}}),executor,
   spool:Object.assign(spools[index],{async maintainQuarantine(){return {inspected:0,removed:0,retained:0,retainedBytes:0};}}),heartbeatIntervalMs:8000,idleBackoff:{minMs:1000,maxMs:15000},errorBackoff:{minMs:2000,maxMs:30000},reconciliationBackoffMs:30000,sweepIntervalMs:30000,busyBurstLimit:8,quarantine:{retentionMs:604800000,maxEntries:100,maxBytes:1073741824}};
 });
 const timeout=setTimeout(()=>{stop.abort();release();},2000);
 try{await runConsumerPool(slots,{async write(s){reports.push(structuredClone(s));}},stop.signal);}finally{clearTimeout(timeout);}
 assert.equal(peak,3);assert.deepEqual(controls.map(c=>c.uploads),[1,1,1]);assert.deepEqual(controls.map(c=>c.claims),[1,1,1]);
 assert.deepEqual(await Promise.all(spools.map(s=>s.list())),[[],[],[]]);assert.equal(reports.at(-1)?.state,'stopped');assert.equal(reports.at(-1)?.counters.completed,3);
});
