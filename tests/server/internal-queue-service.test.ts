import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ApiError } from "../../lib/server/api";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import {
  parseInternalClaimInput,
  parseInternalSweepInput,
  parseInternalTransitionInput,
} from "../../lib/server/internal-queue-contract";
import { InternalQueueService } from "../../lib/server/internal-queue-service";
import { applyMigrations, creditTestOwner, TEST_GENERATION_BILLING, TestD1Database } from "../helpers/test-d1";

test("claim uses server-side limits, hides owner data and refreshes the job aggregate", async () => {
  const { database, queue, service } = setup();
  insertJob(database, "job-claim", "owner-secret");
  await queue.materializeItems("job-claim", TEST_GENERATION_BILLING);
  const providerItem = (await queue.listItems("job-claim"))[0];
  assert.ok(providerItem);

  assert.throws(
    () =>
      parseInternalClaimInput({
        workerId: "worker-a",
        claimRequestId: "claim-contract",
        leaseSeconds: 900,
      }),
    hasCode("INVALID_INTERNAL_QUEUE_BODY"),
  );
  assert.deepEqual(
    parseInternalClaimInput({
      workerId: "worker-a",
      claimRequestId: "claim-contract",
    }),
    {
      workerId: "worker-a",
      claimRequestId: "claim-contract",
      executionKind: "provider",
    },
  );
  assert.throws(
    () => parseInternalClaimInput({
      workerId: "worker-a",
      claimRequestId: "claim-acceptance-missing-target",
      executionKind: "acceptance",
    }),
    hasCode("INVALID_INTERNAL_QUEUE_BODY"),
  );
  assert.deepEqual(
    parseInternalClaimInput({
      workerId: "worker-a",
      claimRequestId: "claim-acceptance",
      executionKind: "acceptance",
      targetItemId: "qitem-acceptance",
    }),
    {
      workerId: "worker-a",
      claimRequestId: "claim-acceptance",
      executionKind: "acceptance",
      targetItemId: "qitem-acceptance",
    },
  );
  const acceptanceService = new InternalQueueService(queue, {
    leaseSeconds: 180,
    ownerConcurrency: 1,
    providerConcurrency: 1,
    sweepLimit: 20,
    acceptanceEnabled: true,
  });
  assert.equal(
    await acceptanceService.claim(
      "worker-acceptance",
      "claim-provider-as-acceptance",
      "acceptance",
      providerItem.id,
    ),
    null,
  );
  const claim = await service.claim("worker-a", "claim-job-claim");
  assert.ok(claim);
  assert.equal(claim.item.jobId, "job-claim");
  assert.equal(claim.item.leaseExpiresAt !== null, true);
  assert.doesNotMatch(JSON.stringify(claim), /owner-secret|providerKey|leaseOwner/u);
  assert.equal(readJob(database, "job-claim").status, "PREPROCESSING");
  database
    .prepare("UPDATE generation_jobs SET status = 'FAILED' WHERE id = ?")
    .run("job-claim");
  assert.equal((await service.heartbeat(claim.fence)).result, "applied");
  assert.equal(readJob(database, "job-claim").status, "PREPROCESSING");
});

test("worker events are idempotent and conflicting metadata is rejected", async () => {
  const { database, queue, service } = setup();
  insertJob(database, "job-events");
  await queue.materializeItems("job-events", TEST_GENERATION_BILLING);
  const claim = await service.claim("worker-events", "claim-job-events");
  assert.ok(claim);
  const fence = claim.fence;

  assert.deepEqual(
    await service.transition({ fence, event: "BEGIN_PREPROCESSING" }),
    { result: "applied", itemStatus: "PREPROCESSING" },
  );
  assert.deepEqual(
    await service.transition({ fence, event: "BEGIN_PREPROCESSING" }),
    { result: "already_applied", itemStatus: "PREPROCESSING" },
  );

  const dispatch = {
    fence,
    event: "BEGIN_PROVIDER_DISPATCH" as const,
    providerAccountSlot: "seedream-primary",
  };
  assert.equal((await service.transition(dispatch)).result, "applied");
  const recordedDispatch = database
    .prepare(
      "SELECT provider, model, provider_account_slot AS providerAccountSlot FROM generation_attempts WHERE item_id = ?",
    )
    .get(fence.itemId);
  assert.equal(recordedDispatch?.provider, "seedream");
  assert.equal(recordedDispatch?.model, "doubao-seedream-4-5-251128");
  assert.equal(recordedDispatch?.providerAccountSlot, "seedream-primary");
  database
    .prepare("UPDATE generation_jobs SET status = 'FAILED' WHERE id = ?")
    .run("job-events");
  assert.equal((await service.transition(dispatch)).result, "already_applied");
  assert.equal(readJob(database, "job-events").status, "GENERATING");
  database
    .prepare("UPDATE generation_attempts SET model = 'corrupted-model' WHERE item_id = ?")
    .run(fence.itemId);
  assert.equal((await service.transition(dispatch)).result, "conflict");
  database
    .prepare("UPDATE generation_attempts SET model = ? WHERE item_id = ?")
    .run("doubao-seedream-4-5-251128", fence.itemId);
  assert.equal(
    (
      await service.transition({
        ...dispatch,
        providerAccountSlot: "seedream-secondary",
      })
    ).result,
    "conflict",
  );

  const responded = {
    fence,
    event: "RECORD_PROVIDER_RESPONSE" as const,
    providerRequestId: "provider-request-1",
  };
  assert.equal((await service.transition(responded)).result, "applied");
  assert.equal((await service.transition(responded)).result, "already_applied");

  const conflictingAmbiguous = {
    fence,
    event: "MARK_AMBIGUOUS" as const,
    errorCode: "OUTPUT_COMMIT_UNCERTAIN",
    errorMessage: "output commit acknowledgement was lost",
    providerRequestId: "provider-request-other",
  };
  assert.equal(
    (await service.transition(conflictingAmbiguous)).result,
    "conflict",
  );
  assert.equal(
    database
      .prepare("SELECT provider_request_id AS providerRequestId FROM generation_attempts WHERE item_id = ?")
      .get(fence.itemId)?.providerRequestId,
    "provider-request-1",
  );

  const ambiguous = {
    fence,
    event: "MARK_AMBIGUOUS" as const,
    errorCode: "OUTPUT_COMMIT_UNCERTAIN",
    errorMessage: "output commit acknowledgement was lost",
    providerRequestId: "provider-request-1",
  };
  assert.equal((await service.transition(ambiguous)).result, "applied");
  assert.equal((await service.transition(ambiguous)).result, "already_applied");
  assert.equal(readJob(database, "job-events").status, "VALIDATING");
  assert.equal((await service.heartbeat(fence)).result, "stale");
});

test("provider dispatch is derived from the frozen item and rejects corrupted routing", async () => {
  const { database, queue, service } = setup();
  insertJob(database, "job-provider-fence");
  await queue.materializeItems("job-provider-fence", TEST_GENERATION_BILLING);
  const claim = await service.claim(
    "worker-provider-fence",
    "claim-provider-fence",
  );
  assert.ok(claim);
  await service.transition({
    fence: claim.fence,
    event: "BEGIN_PREPROCESSING",
  });
  database
    .prepare("UPDATE generation_job_items SET provider_key = 'qwen' WHERE id = ?")
    .run(claim.item.id);
  assert.deepEqual(
    await service.transition({
      fence: claim.fence,
      event: "BEGIN_PROVIDER_DISPATCH",
      providerAccountSlot: "seedream-primary",
    }),
    { result: "conflict", itemStatus: "PREPROCESSING" },
  );
  const recorded = database
    .prepare("SELECT provider, model FROM generation_attempts WHERE item_id = ?")
    .get(claim.item.id);
  assert.equal(recorded?.provider, null);
  assert.equal(recorded?.model, null);
});

test("pre-provider failures retry safely and old fences cannot mutate a new attempt", async () => {
  const { database, queue, service } = setup();
  insertJob(database, "job-safe-retry");
  await queue.materializeItems("job-safe-retry", TEST_GENERATION_BILLING);
  const claim = await service.claim("worker-retry", "claim-safe-retry-first");
  assert.ok(claim);
  await service.transition({ fence: claim.fence, event: "BEGIN_PREPROCESSING" });
  const failed = {
    fence: claim.fence,
    event: "FAIL_BEFORE_PROVIDER" as const,
    errorCode: "INPUT_TEMPORARY_UNAVAILABLE",
    errorMessage: "temporary input read failure",
    errorRetryable: true,
  };
  const result = await service.transition(failed);
  assert.equal(result.result, "applied");
  assert.equal(result.itemStatus, "RETRY_WAIT");
  assert.equal((await service.transition(failed)).result, "already_applied");
  assert.equal((await service.heartbeat(claim.fence)).result, "stale");
  assert.equal(readJob(database, "job-safe-retry").status, "QUEUED");

  database
    .prepare(
      "UPDATE generation_job_items SET next_attempt_at = unixepoch() WHERE job_id = ?",
    )
    .run("job-safe-retry");
  const replacement = await service.claim("worker-replacement", "claim-safe-retry-second");
  assert.ok(replacement);
  assert.equal(replacement.fence.leaseGeneration, claim.fence.leaseGeneration + 1);
  assert.equal((await service.heartbeat(claim.fence)).result, "stale");
});

test("sweep retries pre-provider crashes but never resubmits ambiguous provider work", async () => {
  const { database, queue, service } = setup();
  insertJob(database, "job-a-before", "owner-before", "doubao-seedream-4-5-251128");
  insertJob(database, "job-z-after", "owner-after", "qwen-image-2.0-pro");
  await queue.materializeItems("job-a-before", TEST_GENERATION_BILLING);
  await queue.materializeItems("job-z-after", TEST_GENERATION_BILLING);

  const before = await service.claim("worker-before", "claim-sweep-before");
  assert.ok(before);
  await service.transition({ fence: before.fence, event: "BEGIN_PREPROCESSING" });
  database
    .prepare(
      "UPDATE generation_job_items SET lease_expires_at = unixepoch() - 1 WHERE id = ?",
    )
    .run(before.item.id);

  const after = await service.claim("worker-after", "claim-sweep-after");
  assert.ok(after);
  await service.transition({ fence: after.fence, event: "BEGIN_PREPROCESSING" });
  await service.transition({
    fence: after.fence,
    event: "BEGIN_PROVIDER_DISPATCH",
    providerAccountSlot: "seedream-primary",
  });
  database
    .prepare(
      "UPDATE generation_job_items SET lease_expires_at = unixepoch() - 1 WHERE id = ?",
    )
    .run(after.item.id);

  assert.deepEqual(await service.sweep(), {
    retried: 1,
    failed: 0,
    reconciliationRequired: 1,
  });
  assert.equal((await queue.listItems("job-a-before"))[0]?.status, "RETRY_WAIT");
  assert.equal(
    (await queue.listItems("job-z-after"))[0]?.status,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(readJob(database, "job-a-before").status, "QUEUED");
  assert.equal(readJob(database, "job-z-after").status, "VALIDATING");
});

test("sweep contract permits only a provider-wide sweep or one targeted acceptance item", () => {
  assert.deepEqual(parseInternalSweepInput({}), { executionKind: "provider" });
  assert.deepEqual(
    parseInternalSweepInput({
      executionKind: "acceptance",
      targetItemId: "qitem_job_acceptance_contract_0",
    }),
    {
      executionKind: "acceptance",
      targetItemId: "qitem_job_acceptance_contract_0",
    },
  );
  for (const invalid of [
    { targetItemId: "qitem_job_acceptance_contract_0" },
    { executionKind: "provider", targetItemId: "qitem_job_provider_0" },
    { executionKind: "acceptance" },
    { executionKind: "acceptance", targetItemId: "bad item" },
  ]) {
    assert.throws(() => parseInternalSweepInput(invalid));
  }
});

test("transition contracts reject arbitrary states and incomplete provider events", () => {
  const fence = {
    itemId: "qitem_job_contract_0",
    leaseToken: "lease-token-contract",
    leaseGeneration: 1,
  };
  assert.throws(
    () =>
      parseInternalTransitionInput({
        ...fence,
        event: "SUCCEEDED",
      }),
    hasCode("INVALID_FIELD"),
  );
  assert.throws(
    () =>
      parseInternalTransitionInput({
        ...fence,
        event: "BEGIN_PROVIDER_DISPATCH",
        provider: "seedream",
        providerAccountSlot: "seedream-primary",
      }),
    hasCode("INVALID_INTERNAL_QUEUE_BODY"),
  );
  assert.throws(
    () =>
      parseInternalTransitionInput({
        ...fence,
        event: "BEGIN_PROVIDER_DISPATCH",
      }),
    hasCode("INVALID_INTERNAL_QUEUE_BODY"),
  );
  assert.throws(
    () =>
      parseInternalTransitionInput({
        ...fence,
        event: "BEGIN_PROVIDER_DISPATCH",
        providerAccountSlot: "contains spaces",
      }),
    hasCode("INVALID_FIELD"),
  );
});

function setup(): {
  database: DatabaseSync;
  queue: D1GenerationQueue;
  service: InternalQueueService;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const queue = new D1GenerationQueue(
    new TestD1Database(database) as unknown as D1Database,
  );
  return {
    database,
    queue,
    service: new InternalQueueService(queue, {
      leaseSeconds: 180,
      ownerConcurrency: 1,
      providerConcurrency: 1,
      sweepLimit: 50,
    }),
  };
}

function insertJob(
  database: DatabaseSync,
  id: string,
  ownerId = `owner-${id}`,
  provider = "doubao-seedream-4-5-251128",
): void {
  creditTestOwner(database, ownerId);
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
         preservation_mode, provider_preference, output_count,
         idempotency_key, request_hash, status)
       VALUES (?, ?, NULL, 'self-service', 'noon', 'structure', ?, 1, ?, ?, 'QUEUED')`,
    )
    .run(id, ownerId, provider, `key-${id}`, `hash-${id}`);
}

function readJob(database: DatabaseSync, id: string) {
  return database
    .prepare(
      "SELECT status, completed_output_count AS completedOutputCount FROM generation_jobs WHERE id = ?",
    )
    .get(id) as { status: string; completedOutputCount: number };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}
