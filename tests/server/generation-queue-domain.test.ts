import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateQueueItems,
  assertQueueItemTransition,
  classifyRetrySafety,
  decideExpiredLease,
  retryDelaySeconds,
} from "../../lib/domain/generation-queue";

test("queue transitions reject stale or impossible state movement", () => {
  assert.doesNotThrow(() => assertQueueItemTransition("QUEUED", "LEASED"));
  assert.doesNotThrow(() => assertQueueItemTransition("SUBMITTING", "PERSISTING"));
  assert.doesNotThrow(() => assertQueueItemTransition("PERSISTING", "SUCCEEDED"));
  assert.throws(
    () => assertQueueItemTransition("SUCCEEDED", "LEASED"),
    /INVALID_QUEUE_TRANSITION/u,
  );
  assert.throws(
    () => assertQueueItemTransition("PREPROCESSING", "SUCCEEDED"),
    /INVALID_QUEUE_TRANSITION/u,
  );
  assert.throws(
    () => assertQueueItemTransition("SUBMITTING", "CANCELED"),
    /INVALID_QUEUE_TRANSITION/u,
  );
  assert.throws(
    () => assertQueueItemTransition("SUBMITTING", "FAILED"),
    /INVALID_QUEUE_TRANSITION/u,
  );
  assert.throws(
    () => assertQueueItemTransition("PERSISTING", "FAILED"),
    /INVALID_QUEUE_TRANSITION/u,
  );
});

test("automatic retry stops after a request may have reached the provider", () => {
  assert.equal(
    classifyRetrySafety("PREPROCESSING", true),
    "safe-before-provider",
  );
  assert.equal(
    classifyRetrySafety("SUBMITTING", true),
    "ambiguous-after-provider",
  );
  assert.equal(
    classifyRetrySafety("PERSISTING", true),
    "ambiguous-after-provider",
  );
  assert.equal(classifyRetrySafety("PREPROCESSING", false), "not-retryable");
});

test("expired lease recovery distinguishes safe retry, exhaustion, and ambiguity", () => {
  assert.equal(
    decideExpiredLease({ status: "PREPROCESSING", attemptCount: 1, maxAttempts: 3 }),
    "retry",
  );
  assert.equal(
    decideExpiredLease({ status: "PREPROCESSING", attemptCount: 3, maxAttempts: 3 }),
    "fail",
  );
  assert.equal(
    decideExpiredLease({ status: "SUBMITTING", attemptCount: 1, maxAttempts: 3 }),
    "reconcile",
  );
  assert.equal(
    decideExpiredLease({ status: "PERSISTING", attemptCount: 1, maxAttempts: 3 }),
    "reconcile",
  );
  assert.equal(
    decideExpiredLease({ status: "SUCCEEDED", attemptCount: 1, maxAttempts: 3 }),
    "ignore",
  );
});

test("retry backoff uses bounded full jitter", () => {
  assert.equal(retryDelaySeconds(1, 0), 0);
  assert.equal(retryDelaySeconds(1, 0.999), 14);
  assert.equal(retryDelaySeconds(2, 0.999), 59);
  assert.equal(retryDelaySeconds(3, 0.999), 299);
  assert.equal(retryDelaySeconds(20, 0.5), 150);
  assert.throws(() => retryDelaySeconds(0, 0.5), /INVALID_QUEUE_ATTEMPT/u);
  assert.throws(() => retryDelaySeconds(1, 1), /INVALID_QUEUE_JITTER/u);
});

test("item states aggregate into the existing public job status contract", () => {
  assert.equal(aggregateQueueItems([]), "QUEUED");
  assert.equal(aggregateQueueItems(["QUEUED", "RETRY_WAIT"]), "QUEUED");
  assert.equal(aggregateQueueItems(["PREPROCESSING", "QUEUED"]), "PREPROCESSING");
  assert.equal(aggregateQueueItems(["SUBMITTING", "QUEUED"]), "GENERATING");
  assert.equal(aggregateQueueItems(["PERSISTING", "SUCCEEDED"]), "VALIDATING");
  assert.equal(aggregateQueueItems(["SUCCEEDED", "SUCCEEDED"]), "SUCCEEDED");
  assert.equal(aggregateQueueItems(["SUCCEEDED", "FAILED"]), "PARTIAL_SUCCEEDED");
  assert.equal(
    aggregateQueueItems(["FAILED", "RECONCILIATION_REQUIRED"]),
    "VALIDATING",
  );
  assert.equal(
    aggregateQueueItems(["SUCCEEDED", "RECONCILIATION_REQUIRED"]),
    "VALIDATING",
  );
  assert.equal(aggregateQueueItems(["CANCELED", "CANCELED"]), "CANCELED");
});
