import type { GenerationQueueItemStatus } from "@/db/schema";
import {
  imageModelProvider,
  isImageModel,
} from "@/lib/domain/image-models";
import {
  D1GenerationQueue,
  type ClaimedQueueItem,
  type QueueFence,
  type QueueFenceSnapshot,
  type TransitionDetails,
} from "./generation-queue";
import type { InternalTransitionInput } from "./internal-queue-contract";
import type { InternalQueueExecutionService } from "./internal-queue-execution";
import { ApiError } from "./api";
import { assertPrivateTestActive, assertPrivateTestQueueItem, PRIVATE_TEST_MODELS, PRIVATE_TEST_OWNER, type PrivateTestConfig } from "./private-test";

export type InternalQueueMutationResult =
  | "applied"
  | "already_applied"
  | "stale"
  | "conflict";

export type InternalQueueServiceOptions = {
  leaseSeconds: number;
  ownerConcurrency: number;
  providerConcurrency: number;
  sweepLimit: number;
  acceptanceEnabled?: boolean;
};

export class InternalQueueService {
  constructor(
    private readonly queue: D1GenerationQueue,
    private readonly options: InternalQueueServiceOptions,
    private readonly execution?: InternalQueueExecutionService,
    private readonly privateTest?: { d1: D1Database; config: PrivateTestConfig } | null,
  ) {}

  async claim(
    workerId: string,
    claimRequestId: string,
    executionKind: "provider" | "acceptance" = "provider",
    targetItemId?: string,
  ): Promise<ReturnType<typeof serializeClaim> | null> {
    if (executionKind === "acceptance" && !this.options.acceptanceEnabled) {
      throw new ApiError(
        404,
        "QUEUE_ACCEPTANCE_DISABLED",
        "没有找到这个接口。",
      );
    }
    if (executionKind === "provider" && this.privateTest) { assertPrivateTestActive(this.privateTest.config); }
    const claim = await this.queue.claimNextEligible({
      workerId,
      claimRequestId,
      leaseSeconds: this.options.leaseSeconds,
      ownerConcurrency: this.options.ownerConcurrency,
      providerConcurrency: this.options.providerConcurrency,
      executionKind,
      ...(targetItemId === undefined ? {} : { targetItemId }),
      ...(this.privateTest ? { privateTest: { ownerId: PRIVATE_TEST_OWNER, models: PRIVATE_TEST_MODELS } } : {}),
    });
    return claim ? serializeClaim(claim) : null;
  }

  async heartbeat(fence: QueueFence): Promise<{
    result: InternalQueueMutationResult;
  }> {
    const before = await this.queue.inspectFence(fence);
    this.requireAcceptanceEnabled(before);
    if (await this.queue.heartbeat(fence, this.options.leaseSeconds)) {
      return { result: "applied" };
    }
    const snapshot = await this.queue.inspectFence(fence);
    return {
      result: isSameAttempt(snapshot, fence)
        ? snapshot?.leaseValid
          ? "conflict"
          : "stale"
        : "stale",
    };
  }

  async transition(input: InternalTransitionInput): Promise<{
    result: InternalQueueMutationResult;
    itemStatus?: GenerationQueueItemStatus;
  }> {
    const before = await this.queue.inspectFence(input.fence);
    this.requireAcceptanceEnabled(before);
    if (input.event === "FAIL_BEFORE_PROVIDER") {
      return this.failBeforeProvider(input);
    }
    if (isAcceptanceEvent(input.event)) {
      if (!this.options.acceptanceEnabled) {
        throw new ApiError(
          404,
          "QUEUE_ACCEPTANCE_DISABLED",
          "没有找到这个接口。",
        );
      }
      if (before?.executionKind !== "acceptance") {
        return { result: "conflict", ...(before ? { itemStatus: before.itemStatus } : {}) };
      }
    }
    if (isProviderEvent(input.event) && before?.executionKind !== "provider") {
      return { result: "conflict", ...(before ? { itemStatus: before.itemStatus } : {}) };
    }
    if (
      input.event === "BEGIN_PROVIDER_DISPATCH" &&
      isSameAttempt(before, input.fence) &&
      !hasAuthoritativeProvider(before)
    ) {
      return { result: "conflict", itemStatus: before.itemStatus };
    }
    if (input.event === "BEGIN_PROVIDER_DISPATCH" && this.privateTest) {
      assertPrivateTestActive(this.privateTest.config);
      await assertPrivateTestQueueItem(this.privateTest.d1, input.fence.itemId);
    }
    const plan = transitionPlan(input, before);
    const prior = classifyPriorResult(before, input.fence, plan, input);
    if (prior) {
      if (prior.result === "already_applied" && before) {
        await this.queue.refreshJobAggregate(before.jobId);
      }
      return prior;
    }

    const applied = await this.queue.transition(
      input.fence,
      plan.from[0] === before?.itemStatus
        ? plan.from[0]
        : plan.from[1] ?? plan.from[0],
      plan.to,
      plan.details,
    );
    if (applied) return { result: "applied", itemStatus: plan.to };

    const after = await this.queue.inspectFence(input.fence);
    const recovered = classifyPriorResult(after, input.fence, plan, input);
    if (recovered?.result === "already_applied" && after) {
      await this.queue.refreshJobAggregate(after.jobId);
    }
    return recovered ?? {
      result: "conflict",
      ...(after ? { itemStatus: after.itemStatus } : {}),
    };
  }

  async sweep(
    executionKind: "provider" | "acceptance" = "provider",
    targetAcceptanceItemId?: string,
  ): Promise<{
    retried: number;
    failed: number;
    reconciliationRequired: number;
    outputsRecovered?: number;
    outputReconciliationRequired?: number;
  }> {
    if (
      (executionKind === "acceptance") !==
      (targetAcceptanceItemId !== undefined)
    ) {
      throw new ApiError(
        400,
        "QUEUE_SWEEP_SCOPE_INVALID",
        "任务恢复范围不正确。",
      );
    }
    if (executionKind === "acceptance" && !this.options.acceptanceEnabled) {
      throw new ApiError(404, "QUEUE_ACCEPTANCE_DISABLED", "没有找到这个接口。");
    }
    const outputSummary = this.execution
      ? await this.execution.recoverStoredOutputs(
          this.options.sweepLimit,
          executionKind,
          targetAcceptanceItemId,
        )
      : null;
    const queueSummary = await this.queue.recoverExpiredLeases(
      this.options.sweepLimit,
      Math.random,
      executionKind,
      targetAcceptanceItemId,
    );
    return {
      ...queueSummary,
      ...(outputSummary
        ? {
            outputsRecovered: outputSummary.recovered,
            outputReconciliationRequired:
              outputSummary.reconciliationRequired,
          }
        : {}),
    };
  }

  private async failBeforeProvider(
    input: Extract<InternalTransitionInput, { event: "FAIL_BEFORE_PROVIDER" }>,
  ): Promise<{
    result: InternalQueueMutationResult;
    itemStatus?: GenerationQueueItemStatus;
  }> {
    const before = await this.queue.inspectFence(input.fence);
    if (!isSameAttempt(before, input.fence)) return { result: "stale" };
    if (
      (before.itemStatus === "RETRY_WAIT" || before.itemStatus === "FAILED") &&
      before.errorCode === input.errorCode &&
      before.errorMessage === input.errorMessage
    ) {
      await this.queue.refreshJobAggregate(before.jobId);
      return { result: "already_applied", itemStatus: before.itemStatus };
    }
    if (
      before.itemStatus !== "LEASED" &&
      before.itemStatus !== "PREPROCESSING"
    ) {
      return { result: "conflict", itemStatus: before.itemStatus };
    }
    if (!before.leaseValid || before.itemLeaseToken !== input.fence.leaseToken) {
      return { result: "stale", itemStatus: before.itemStatus };
    }
    const result = await this.queue.scheduleSafeRetry(
      input.fence,
      before.itemStatus,
      {
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        errorRetryable: input.errorRetryable,
      },
    );
    if (result === "retry") return { result: "applied", itemStatus: "RETRY_WAIT" };
    if (result === "failed") return { result: "applied", itemStatus: "FAILED" };

    const after = await this.queue.inspectFence(input.fence);
    if (
      isSameAttempt(after, input.fence) &&
      (after.itemStatus === "RETRY_WAIT" || after.itemStatus === "FAILED") &&
      after.errorCode === input.errorCode &&
      after.errorMessage === input.errorMessage
    ) {
      await this.queue.refreshJobAggregate(after.jobId);
      return { result: "already_applied", itemStatus: after.itemStatus };
    }
    return { result: "stale", ...(after ? { itemStatus: after.itemStatus } : {}) };
  }

  private requireAcceptanceEnabled(
    snapshot: QueueFenceSnapshot | null,
  ): void {
    if (snapshot?.executionKind === "acceptance" && !this.options.acceptanceEnabled) {
      throw new ApiError(
        404,
        "QUEUE_ACCEPTANCE_DISABLED",
        "没有找到这个接口。",
      );
    }
  }
}

type TransitionPlan = {
  from: readonly GenerationQueueItemStatus[];
  to: GenerationQueueItemStatus;
  alreadyStatuses: readonly GenerationQueueItemStatus[];
  details: TransitionDetails;
};

function transitionPlan(
  input: Exclude<InternalTransitionInput, { event: "FAIL_BEFORE_PROVIDER" }>,
  snapshot: QueueFenceSnapshot | null,
): TransitionPlan {
  switch (input.event) {
    case "BEGIN_PREPROCESSING":
      return {
        from: ["LEASED"],
        to: "PREPROCESSING",
        alreadyStatuses: ["PREPROCESSING", "SUBMITTING", "PERSISTING", "SUCCEEDED"],
        details: {},
      };
    case "BEGIN_PROVIDER_DISPATCH":
      return {
        from: ["PREPROCESSING"],
        to: "SUBMITTING",
        alreadyStatuses: ["SUBMITTING", "PERSISTING", "RECONCILIATION_REQUIRED", "SUCCEEDED"],
        details: {
          provider: snapshot?.providerKey ?? null,
          model: snapshot?.providerPreference ?? null,
          providerAccountSlot: input.providerAccountSlot,
        },
      };
    case "BEGIN_ACCEPTANCE_EXECUTION":
      return {
        from: ["PREPROCESSING"],
        to: "SUBMITTING",
        alreadyStatuses: ["SUBMITTING", "PERSISTING", "RECONCILIATION_REQUIRED", "SUCCEEDED"],
        details: {
          provider: "acceptance",
          model: "acceptance-fixture-v1",
          providerAccountSlot: "acceptance-fixture",
        },
      };
    case "RECORD_PROVIDER_RESPONSE":
      return {
        from: ["SUBMITTING"],
        to: "PERSISTING",
        alreadyStatuses: ["PERSISTING", "RECONCILIATION_REQUIRED", "SUCCEEDED"],
        details: { providerRequestId: input.providerRequestId },
      };
    case "RECORD_ACCEPTANCE_RESULT":
      return {
        from: ["SUBMITTING"],
        to: "PERSISTING",
        alreadyStatuses: ["PERSISTING", "RECONCILIATION_REQUIRED", "SUCCEEDED"],
        details: { providerRequestId: null },
      };
    case "MARK_AMBIGUOUS":
      return {
        from: ["SUBMITTING", "PERSISTING"],
        to: "RECONCILIATION_REQUIRED",
        alreadyStatuses: ["RECONCILIATION_REQUIRED"],
        details: {
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          providerRequestId: input.providerRequestId,
          errorRetryable: false,
        },
      };
  }
}

function classifyPriorResult(
  snapshot: QueueFenceSnapshot | null,
  fence: QueueFence,
  plan: TransitionPlan,
  input: Exclude<InternalTransitionInput, { event: "FAIL_BEFORE_PROVIDER" }>,
): {
  result: InternalQueueMutationResult;
  itemStatus?: GenerationQueueItemStatus;
} | null {
  if (!isSameAttempt(snapshot, fence)) return { result: "stale" };
  if (plan.alreadyStatuses.includes(snapshot.itemStatus)) {
    return metadataMatches(snapshot, input, plan)
      ? { result: "already_applied", itemStatus: snapshot.itemStatus }
      : { result: "conflict", itemStatus: snapshot.itemStatus };
  }
  if (!plan.from.includes(snapshot.itemStatus)) {
    return { result: "conflict", itemStatus: snapshot.itemStatus };
  }
  if (!snapshot.leaseValid || snapshot.itemLeaseToken !== fence.leaseToken) {
    return { result: "stale", itemStatus: snapshot.itemStatus };
  }
  return null;
}

function metadataMatches(
  snapshot: QueueFenceSnapshot,
  input: Exclude<InternalTransitionInput, { event: "FAIL_BEFORE_PROVIDER" }>,
  plan: TransitionPlan,
): boolean {
  switch (input.event) {
    case "BEGIN_PREPROCESSING":
      return true;
    case "BEGIN_PROVIDER_DISPATCH":
      return (
        snapshot.provider === plan.details.provider &&
        snapshot.model === plan.details.model &&
        snapshot.providerAccountSlot === input.providerAccountSlot
      );
    case "BEGIN_ACCEPTANCE_EXECUTION":
      return (
        snapshot.provider === "acceptance" &&
        snapshot.model === "acceptance-fixture-v1" &&
        snapshot.providerAccountSlot === "acceptance-fixture"
      );
    case "RECORD_PROVIDER_RESPONSE":
      return snapshot.providerRequestId === input.providerRequestId;
    case "RECORD_ACCEPTANCE_RESULT":
      return snapshot.providerRequestId === null;
    case "MARK_AMBIGUOUS":
      return (
        snapshot.errorCode === input.errorCode &&
        snapshot.errorMessage === input.errorMessage &&
        (input.providerRequestId === null ||
          snapshot.providerRequestId === input.providerRequestId)
      );
  }
}

function hasAuthoritativeProvider(snapshot: QueueFenceSnapshot): boolean {
  return (
    isImageModel(snapshot.providerPreference) &&
    imageModelProvider(snapshot.providerPreference) ===
      snapshot.providerKey
  );
}

function isAcceptanceEvent(event: InternalTransitionInput["event"]): boolean {
  return (
    event === "BEGIN_ACCEPTANCE_EXECUTION" ||
    event === "RECORD_ACCEPTANCE_RESULT"
  );
}

function isProviderEvent(event: InternalTransitionInput["event"]): boolean {
  return (
    event === "BEGIN_PROVIDER_DISPATCH" ||
    event === "RECORD_PROVIDER_RESPONSE"
  );
}

function isSameAttempt(
  snapshot: QueueFenceSnapshot | null,
  fence: QueueFence,
): snapshot is QueueFenceSnapshot {
  return Boolean(
    snapshot &&
      snapshot.leaseGeneration === fence.leaseGeneration &&
      snapshot.attemptLeaseGeneration === fence.leaseGeneration &&
      snapshot.attemptLeaseToken === fence.leaseToken,
  );
}

function serializeClaim(claim: ClaimedQueueItem) {
  if (!Number.isSafeInteger(claim.item.leaseExpiresAt)) {
    throw new Error("CLAIM_LEASE_EXPIRY_MISSING");
  }
  return {
    item: {
      id: claim.item.id,
      jobId: claim.item.jobId,
      ordinal: claim.item.ordinal,
      providerPreference: claim.item.providerPreference,
      status: claim.item.status,
      attemptCount: claim.item.attemptCount,
      maxAttempts: claim.item.maxAttempts,
      leaseExpiresAt: claim.item.leaseExpiresAt as number,
      executionKind: claim.item.executionKind,
    },
    attemptId: claim.attemptId,
    fence: claim.fence,
  };
}
