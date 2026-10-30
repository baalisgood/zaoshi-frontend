import type {
  GenerationAttemptState,
  GenerationQueueItemStatus,
  JobStatus,
} from "@/db/schema";

export type LeaseExpiryDecision =
  | "ignore"
  | "retry"
  | "fail"
  | "reconcile";

export type RetrySafety =
  | "safe-before-provider"
  | "ambiguous-after-provider"
  | "not-retryable";

export type QueueItemSnapshot = {
  status: GenerationQueueItemStatus;
  attemptCount: number;
  maxAttempts: number;
};

export const activeQueueItemStatuses = [
  "LEASED",
  "PREPROCESSING",
  "SUBMITTING",
  "PERSISTING",
] as const satisfies readonly GenerationQueueItemStatus[];

export const terminalQueueItemStatuses = [
  "SUCCEEDED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
  "CANCELED",
] as const satisfies readonly GenerationQueueItemStatus[];

const transitions: Record<GenerationQueueItemStatus, readonly GenerationQueueItemStatus[]> = {
  QUEUED: ["LEASED", "CANCELED"],
  LEASED: ["PREPROCESSING", "RETRY_WAIT", "FAILED", "CANCELED"],
  PREPROCESSING: ["SUBMITTING", "RETRY_WAIT", "FAILED", "CANCELED"],
  SUBMITTING: ["PERSISTING", "RECONCILIATION_REQUIRED"],
  PERSISTING: ["SUCCEEDED", "RECONCILIATION_REQUIRED"],
  RETRY_WAIT: ["LEASED", "FAILED", "CANCELED"],
  SUCCEEDED: [],
  FAILED: [],
  RECONCILIATION_REQUIRED: [],
  CANCELED: [],
};

export function canTransitionQueueItem(
  from: GenerationQueueItemStatus,
  to: GenerationQueueItemStatus,
): boolean {
  return transitions[from].includes(to);
}

export function assertQueueItemTransition(
  from: GenerationQueueItemStatus,
  to: GenerationQueueItemStatus,
): void {
  if (!canTransitionQueueItem(from, to)) {
    throw new Error(`INVALID_QUEUE_TRANSITION:${from}->${to}`);
  }
}

export function isActiveQueueItemStatus(
  status: GenerationQueueItemStatus,
): boolean {
  return (activeQueueItemStatuses as readonly GenerationQueueItemStatus[]).includes(status);
}

export function isTerminalQueueItemStatus(
  status: GenerationQueueItemStatus,
): boolean {
  return (terminalQueueItemStatuses as readonly GenerationQueueItemStatus[]).includes(status);
}

/**
 * Automatic retries stop as soon as a request may have reached a billable
 * provider operation. Those outcomes require reconciliation, not a resend.
 */
export function classifyRetrySafety(
  status: GenerationQueueItemStatus,
  retryable: boolean,
): RetrySafety {
  if (!retryable) return "not-retryable";
  if (status === "LEASED" || status === "PREPROCESSING") {
    return "safe-before-provider";
  }
  if (status === "SUBMITTING" || status === "PERSISTING") {
    return "ambiguous-after-provider";
  }
  return "not-retryable";
}

export function decideExpiredLease(
  item: QueueItemSnapshot,
): LeaseExpiryDecision {
  if (!isActiveQueueItemStatus(item.status)) return "ignore";
  if (item.status === "SUBMITTING" || item.status === "PERSISTING") {
    return "reconcile";
  }
  return item.attemptCount >= item.maxAttempts ? "fail" : "retry";
}

/** Full-jitter exponential backoff: 15s, 60s, then capped at 300s. */
export function retryDelaySeconds(
  attemptNo: number,
  random = Math.random(),
): number {
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw new Error("INVALID_QUEUE_ATTEMPT");
  }
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error("INVALID_QUEUE_JITTER");
  }
  const cap = attemptNo === 1 ? 15 : attemptNo === 2 ? 60 : 300;
  return Math.floor(cap * random);
}

export function attemptStateForItemStatus(
  status: GenerationQueueItemStatus,
): GenerationAttemptState {
  switch (status) {
    case "LEASED":
      return "STARTED";
    case "PREPROCESSING":
      return "PREPROCESSING";
    case "SUBMITTING":
      return "PROVIDER_DISPATCHING";
    case "PERSISTING":
      return "STORING";
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "RECONCILIATION_REQUIRED":
      return "AMBIGUOUS";
    case "QUEUED":
    case "RETRY_WAIT":
    case "FAILED":
    case "CANCELED":
      return "FAILED";
  }
}

export function aggregateQueueItems(
  statuses: readonly GenerationQueueItemStatus[],
): JobStatus {
  if (statuses.length === 0) return "QUEUED";
  if (statuses.every((status) => status === "SUCCEEDED")) return "SUCCEEDED";

  // An unresolved provider outcome must never look like an ordinary failure:
  // callers could otherwise resubmit or settle credits before reconciliation.
  if (statuses.some((status) => status === "RECONCILIATION_REQUIRED")) {
    return "VALIDATING";
  }

  const terminal = statuses.every(isTerminalQueueItemStatus);
  const successes = statuses.filter((status) => status === "SUCCEEDED").length;
  if (terminal) {
    if (successes > 0) return "PARTIAL_SUCCEEDED";
    if (statuses.every((status) => status === "CANCELED")) return "CANCELED";
    return "FAILED";
  }

  if (statuses.some((status) => status === "PERSISTING")) return "VALIDATING";
  if (statuses.some((status) => status === "SUBMITTING")) return "GENERATING";
  if (
    statuses.some(
      (status) => status === "LEASED" || status === "PREPROCESSING",
    )
  ) {
    return "PREPROCESSING";
  }
  return "QUEUED";
}
