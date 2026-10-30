import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { readAdminConsole } from "../../lib/server/admin-console";
import { applyMigrations, creditTestOwner, TEST_GENERATION_BILLING, TestD1Database } from "../helpers/test-d1";

test("materialization is idempotent and one output becomes one queue item", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-multi", outputCount: 3 });
  assert.equal(await queue.materializeItems("job-multi", TEST_GENERATION_BILLING), 3);
  assert.equal(await queue.materializeItems("job-multi", TEST_GENERATION_BILLING), 0);
  const items = await queue.listItems("job-multi");
  assert.deepEqual(items.map((item) => item.ordinal), [0, 1, 2]);
  assert.ok(items.every((item) => item.status === "QUEUED"));
  assert.ok(items.every((item) => item.providerKey === "seedream"));
});

test("terminal or validating jobs cannot be newly materialized or claimed", async () => {
  for (const status of [
    "SUCCEEDED",
    "FAILED",
    "PARTIAL_SUCCEEDED",
    "VALIDATING",
  ]) {
    const { database, queue } = setup();
    insertJob(database, { id: `job-${status.toLowerCase()}`, status });
    await assert.rejects(
      () => queue.materializeItems(`job-${status.toLowerCase()}`, TEST_GENERATION_BILLING),
      hasCode("JOB_NOT_QUEUEABLE"),
    );
  }

  const { database, queue } = setup();
  insertJob(database, { id: "job-terminal-after-materialize" });
  await queue.materializeItems("job-terminal-after-materialize", TEST_GENERATION_BILLING);
  database
    .prepare("UPDATE generation_jobs SET status = 'SUCCEEDED' WHERE id = ?")
    .run("job-terminal-after-materialize");
  assert.equal(
    await queue.claimNextEligible({
      workerId: "worker-terminal",
      claimRequestId: "claim-terminal",
    }),
    null,
  );
});

test("a suspended user cannot start queued provider work", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-suspended", ownerId: "owner-suspended" });
  await queue.materializeItems("job-suspended", TEST_GENERATION_BILLING);
  database.prepare("INSERT INTO users (id, display_name, status) VALUES (?, '暂停用户', 'SUSPENDED')").run("owner-suspended");
  assert.equal(await queue.claimNextEligible({ workerId: "worker-suspended", claimRequestId: "claim-suspended" }), null);
  database.prepare("UPDATE users SET status = 'ACTIVE' WHERE id = ?").run("owner-suspended");
  assert.ok(await queue.claimNextEligible({ workerId: "worker-active", claimRequestId: "claim-active" }));
});

test("duplicate claimers produce one lease and one attempt", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-one-winner" });
  await queue.materializeItems("job-one-winner", TEST_GENERATION_BILLING);
  const claims = await Promise.all([
    queue.claimNextEligible({ workerId: "worker-a", claimRequestId: "claim-a" }),
    queue.claimNextEligible({ workerId: "worker-b", claimRequestId: "claim-b" }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM generation_attempts")
      .get()?.count,
    1,
  );
});

test("claim request IDs recover the same fence after an acknowledgement loss", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-ack-a", ownerId: "owner-ack-a" });
  insertJob(database, { id: "job-ack-b", ownerId: "owner-ack-b" });
  await queue.materializeItems("job-ack-a", TEST_GENERATION_BILLING);
  await queue.materializeItems("job-ack-b", TEST_GENERATION_BILLING);

  const first = await queue.claimNextEligible({
    workerId: "worker-ack",
    claimRequestId: "claim-stable-operation",
    providerConcurrency: 2,
  });
  assert.ok(first);
  const replay = await queue.claimNextEligible({
    workerId: "worker-ack",
    claimRequestId: "claim-stable-operation",
    providerConcurrency: 2,
  });
  assert.deepEqual(replay, first);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM generation_attempts")
      .get()?.count,
    1,
  );
  await assert.rejects(
    () =>
      queue.claimNextEligible({
        workerId: "worker-other",
        claimRequestId: "claim-stable-operation",
        providerConcurrency: 2,
      }),
    hasCode("CLAIM_REQUEST_CONFLICT"),
  );

  const second = await queue.claimNextEligible({
    workerId: "worker-ack",
    claimRequestId: "claim-next-operation",
    providerConcurrency: 2,
  });
  assert.ok(second);
  assert.notEqual(second.item.id, first.item.id);
});

test("claim uses owner and provider concurrency guards and rejects stale fences", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-a", ownerId: "owner-a", provider: "doubao-seedream-5-0-pro-260628" });
  insertJob(database, { id: "job-b", ownerId: "owner-a", provider: "qwen-image-3.0-pro" });
  insertJob(database, { id: "job-c", ownerId: "owner-c", provider: "doubao-seedream-4-5-251128" });
  await queue.materializeItems("job-a", TEST_GENERATION_BILLING);
  await queue.materializeItems("job-b", TEST_GENERATION_BILLING);
  await queue.materializeItems("job-c", TEST_GENERATION_BILLING);

  const first = await queue.claimNextEligible({ workerId: "worker-1", claimRequestId: "claim-first" });
  assert.ok(first);
  assert.equal(first.item.jobId, "job-a");
  await assert.rejects(
    () => queue.transition(first.fence, "LEASED", "RETRY_WAIT"),
    /USE_SCHEDULE_SAFE_RETRY/u,
  );
  await assert.rejects(
    () => queue.transition(first.fence, "LEASED", "FAILED"),
    /USE_SCHEDULE_SAFE_RETRY/u,
  );
  assert.equal(await queue.heartbeat({ ...first.fence, leaseToken: "stale-token" }), false);
  assert.equal(
    await queue.transition(
      { ...first.fence, leaseToken: "stale-token" },
      "LEASED",
      "PREPROCESSING",
    ),
    false,
  );
  assert.equal(await queue.heartbeat(first.fence), true);

  // job-b is blocked by the owner limit and job-c by the provider limit.
  assert.equal(await queue.claimNextEligible({ workerId: "worker-2", claimRequestId: "claim-blocked", ownerConcurrency: 1 }), null);

  assert.equal(await queue.transition(first.fence, "LEASED", "PREPROCESSING"), true);
  assert.equal(await queue.transition(first.fence, "PREPROCESSING", "SUBMITTING"), true);
  assert.equal(
    await queue.transition(first.fence, "SUBMITTING", "PERSISTING", {
      providerRequestId: "request-safe-to-log",
    }),
    true,
  );
  assert.equal(await queue.transition(first.fence, "PERSISTING", "SUCCEEDED"), true);
  assert.equal(await queue.heartbeat(first.fence), false);

  const second = await queue.claimNextEligible({ workerId: "worker-2", claimRequestId: "claim-second" });
  assert.ok(second);
  assert.equal(second.item.jobId, "job-b");
});

test("bounded mock backlog reaches configured queue limits and drains safely", async (t) => {
  const startedAt = performance.now();
  const { database, queue } = setup();
  const d1 = new TestD1Database(database) as unknown as D1Database;
  const ownerCount = 32;
  const jobsPerOwner = 4;
  const totalItems = ownerCount * jobsPerOwner;
  const retryItemId = "qitem_load-job-00-00_0";
  const expiredItemId = "qitem_load-job-00-01_0";

  for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
    const ownerId = `load-owner-${String(ownerIndex).padStart(2, "0")}`;
    database.prepare(
      `INSERT INTO user_generation_limits
       (owner_id, daily_output_limit, max_pending_outputs,
        active_concurrency_limit, enabled)
       VALUES (?, 1000, 100, ?, 1)`,
    ).run(ownerId, ownerIndex === 0 ? 1 : 2);

    for (let jobIndex = 0; jobIndex < jobsPerOwner; jobIndex += 1) {
      const suffix = `${String(ownerIndex).padStart(2, "0")}-${String(jobIndex).padStart(2, "0")}`;
      const jobId = `load-job-${suffix}`;
      insertJob(database, {
        id: jobId,
        ownerId,
        provider: (ownerIndex * jobsPerOwner + jobIndex) % 2 === 0
          ? "doubao-seedream-4-5-251128"
          : "qwen-image-2.0-pro",
      });
      await queue.materializeItems(jobId, TEST_GENERATION_BILLING);
    }
  }

  const bindings = {
    GENERATION_INTERNAL_API_ENABLED: "1",
    ZAOSHI_CONSUMER_HEALTH: async () => ({ status: "ready", snapshot: null }),
  };
  const readMonitor = async () => (await readAdminConsole(
    new Request("https://zaoshi.example/api/admin/console?view=overview"),
    d1,
    bindings,
  )) as { queue: { metrics: Record<string, number | null> } };
  assert.equal((await readMonitor()).queue.metrics.dueCandidates, totalItems);

  const seenFences = new Set<string>();
  const seenAttempts = new Set<string>();
  const seenLeaseTokens = new Set<string>();
  const providerPeaks = new Map<string, number>();
  let restrictedOwnerPeak = 0;
  let regularOwnerPeak = 0;
  let completed = 0;
  let round = 0;

  while (completed < totalItems) {
    round += 1;
    assert.ok(round <= 100, "mock backlog did not drain within the bounded rounds");
    const claimed = (await Promise.all(
      Array.from({ length: 16 }, (_, workerIndex) => queue.claimNextEligible({
        workerId: `mock-worker-${round}-${workerIndex}`,
        claimRequestId: `mock-claim-${round}-${workerIndex}`,
        ownerConcurrency: 2,
        providerConcurrency: 3,
      })),
    )).filter((claim) => claim !== null);
    assert.ok(claimed.length > 0, "mock backlog stalled before it drained");

    const itemIds = new Set<string>();
    const ownerCounts = new Map<string, number>();
    const providerCounts = new Map<string, number>();
    for (const claim of claimed) {
      assert.equal(itemIds.has(claim.item.id), false);
      itemIds.add(claim.item.id);
      assert.equal(seenAttempts.has(claim.attemptId), false);
      seenAttempts.add(claim.attemptId);
      assert.equal(seenLeaseTokens.has(claim.fence.leaseToken), false);
      seenLeaseTokens.add(claim.fence.leaseToken);
      const fence = `${claim.item.id}:${claim.fence.leaseGeneration}`;
      assert.equal(seenFences.has(fence), false);
      seenFences.add(fence);

      const ownerActive = (ownerCounts.get(claim.item.ownerId) ?? 0) + 1;
      const providerActive = (providerCounts.get(claim.item.providerKey) ?? 0) + 1;
      ownerCounts.set(claim.item.ownerId, ownerActive);
      providerCounts.set(claim.item.providerKey, providerActive);
      assert.ok(ownerActive <= (claim.item.ownerId === "load-owner-00" ? 1 : 2));
      assert.ok(providerActive <= 3);
      if (claim.item.ownerId === "load-owner-00") {
        restrictedOwnerPeak = Math.max(restrictedOwnerPeak, ownerActive);
      } else {
        regularOwnerPeak = Math.max(regularOwnerPeak, ownerActive);
      }
      providerPeaks.set(
        claim.item.providerKey,
        Math.max(providerPeaks.get(claim.item.providerKey) ?? 0, providerActive),
      );
    }

    if (round === 1) {
      assert.ok(claimed.some((claim) => claim.item.ownerId !== "load-owner-00"));
      assert.ok(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM generation_job_items WHERE owner_id = ? AND status = 'QUEUED'",
      ).get("load-owner-00")?.count ?? 0) > 0);
    }

    for (const claim of claimed) {
      if (claim.item.id === retryItemId && claim.item.attemptCount === 1) {
        assert.equal(await queue.transition(claim.fence, "LEASED", "PREPROCESSING"), true);
        assert.equal(await queue.scheduleSafeRetry(
          claim.fence,
          "PREPROCESSING",
          {
            errorCode: "MOCK_PRE_PROVIDER_RETRY",
            errorMessage: "mock retry",
            errorRetryable: true,
          },
          0,
        ), "retry");
        continue;
      }

      if (claim.item.id === expiredItemId && claim.item.attemptCount === 1) {
        assert.equal(await queue.transition(claim.fence, "LEASED", "PREPROCESSING"), true);
        database.prepare(
          "UPDATE generation_job_items SET lease_expires_at = unixepoch() - 1 WHERE id = ?",
        ).run(claim.item.id);
        assert.deepEqual(await queue.recoverExpiredLeases(1, () => 0), {
          retried: 1,
          failed: 0,
          reconciliationRequired: 0,
        });
        continue;
      }

      assert.equal(await queue.transition(claim.fence, "LEASED", "PREPROCESSING"), true);
      assert.equal(await queue.transition(claim.fence, "PREPROCESSING", "SUBMITTING", {
        provider: claim.item.providerKey,
        model: claim.item.providerPreference,
      }), true);
      assert.equal(await queue.transition(claim.fence, "SUBMITTING", "PERSISTING", {
        providerRequestId: `mock-${claim.item.id}`,
      }), true);
      assert.equal(await queue.transition(claim.fence, "PERSISTING", "SUCCEEDED"), true);
    }

    completed = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM generation_job_items WHERE status = 'SUCCEEDED'",
    ).get()?.count ?? 0);
  }

  assert.equal(restrictedOwnerPeak, 1);
  assert.equal(regularOwnerPeak, 2);
  assert.equal(providerPeaks.get("seedream"), 3);
  assert.equal(providerPeaks.get("qwen"), 3);
  assert.equal(seenFences.size, totalItems + 2);
  assert.equal(seenAttempts.size, totalItems + 2);
  assert.equal(seenLeaseTokens.size, totalItems + 2);
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM generation_attempts",
  ).get()?.count ?? 0), totalItems + 2);
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM generation_attempts WHERE state = 'AMBIGUOUS'",
  ).get()?.count ?? 0), 0);
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM generation_reconciliation_cases",
  ).get()?.count ?? 0), 0);
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM generation_dead_letter_entries",
  ).get()?.count ?? 0), 0);
  const ownerTotals = database.prepare(
    "SELECT owner_id, COUNT(*) AS count FROM generation_job_items WHERE status = 'SUCCEEDED' GROUP BY owner_id",
  ).all() as Array<{ owner_id: string; count: number }>;
  assert.equal(ownerTotals.length, ownerCount);
  assert.ok(ownerTotals.every((row) => Number(row.count) === jobsPerOwner));

  const end = await readMonitor();
  assert.equal(end.queue.metrics.dueCandidates, 0);
  assert.equal(end.queue.metrics.successesLastHour, totalItems);
  assert.equal(end.queue.metrics.failuresLastHour, 2);
  assert.equal(end.queue.metrics.openReconciliation, 0);
  assert.equal(end.queue.metrics.unprocessedDeadLetters, 0);
  const elapsedMs = performance.now() - startedAt;
  t.diagnostic(`mock queue: ${totalItems} items in ${elapsedMs.toFixed(0)}ms (${(totalItems / (elapsedMs / 1000)).toFixed(1)} items/s, observation only)`);
});

test("safe pre-provider failure retries once and then honors its attempt budget", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-retry" });
  await queue.materializeItems("job-retry", TEST_GENERATION_BILLING);
  database.exec(
    "UPDATE generation_job_items SET max_attempts = 2 WHERE job_id = 'job-retry'",
  );

  const first = await queue.claimNextEligible({ workerId: "worker-retry", claimRequestId: "claim-retry-first" });
  assert.ok(first);
  assert.equal(await queue.transition(first.fence, "LEASED", "PREPROCESSING"), true);
  assert.equal(
    await queue.scheduleSafeRetry(
      first.fence,
      "PREPROCESSING",
      { errorCode: "R2_TEMPORARY", errorMessage: "temporary", errorRetryable: true },
      0,
    ),
    "retry",
  );

  const second = await queue.claimNextEligible({ workerId: "worker-retry", claimRequestId: "claim-retry-second" });
  assert.ok(second);
  assert.equal(second.item.attemptCount, 2);
  assert.equal(
    await queue.scheduleSafeRetry(
      second.fence,
      "LEASED",
      { errorCode: "R2_TEMPORARY", errorMessage: "temporary", errorRetryable: true },
      0,
    ),
    "failed",
  );
  assert.equal((await queue.listItems("job-retry"))[0]?.status, "FAILED");
});

test("explicitly non-retryable pre-provider failures stop immediately", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-non-retryable" });
  await queue.materializeItems("job-non-retryable", TEST_GENERATION_BILLING);
  const claim = await queue.claimNextEligible({ workerId: "worker-stop", claimRequestId: "claim-stop" });
  assert.ok(claim);
  assert.equal(
    await queue.scheduleSafeRetry(
      claim.fence,
      "LEASED",
      { errorCode: "INVALID_INPUT", errorMessage: "invalid", errorRetryable: false },
      0,
    ),
    "failed",
  );
  assert.equal(
    (await queue.listItems("job-non-retryable"))[0]?.status,
    "FAILED",
  );
});

test("expired leases retry before submission but require reconciliation afterwards", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-a-before", ownerId: "before", provider: "doubao-seedream-5-0-260128" });
  insertJob(database, { id: "job-z-after", ownerId: "after", provider: "qwen-image-2.0-pro" });
  await queue.materializeItems("job-a-before", TEST_GENERATION_BILLING);
  await queue.materializeItems("job-z-after", TEST_GENERATION_BILLING);

  const before = await queue.claimNextEligible({ workerId: "worker-before", claimRequestId: "claim-before" });
  assert.ok(before);
  assert.equal(before.item.jobId, "job-a-before");
  database
    .prepare(
      "UPDATE generation_job_items SET status = 'PREPROCESSING', lease_expires_at = unixepoch() - 1 WHERE id = ?",
    )
    .run(before.item.id);

  const after = await queue.claimNextEligible({
    workerId: "worker-after",
    claimRequestId: "claim-after",
    providerConcurrency: 2,
  });
  assert.ok(after);
  assert.equal(after.item.jobId, "job-z-after");
  database
    .prepare(
      "UPDATE generation_job_items SET status = 'SUBMITTING', lease_expires_at = unixepoch() - 1 WHERE id = ?",
    )
    .run(after.item.id);

  const recovered = await queue.recoverExpiredLeases(10, () => 0);
  assert.deepEqual(recovered, {
    retried: 1,
    failed: 0,
    reconciliationRequired: 1,
  });
  assert.equal((await queue.listItems("job-a-before"))[0]?.status, "RETRY_WAIT");
  assert.equal(
    (await queue.listItems("job-z-after"))[0]?.status,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal(
    database
      .prepare("SELECT state FROM generation_attempts WHERE item_id = ?")
      .get(after.item.id)?.state,
    "AMBIGUOUS",
  );
});

test("job aggregation is repaired from current item truth", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-aggregate", outputCount: 3 });
  await queue.materializeItems("job-aggregate", TEST_GENERATION_BILLING);
  database.exec(
    `UPDATE generation_job_items
     SET status = CASE ordinal
       WHEN 0 THEN 'SUCCEEDED'
       WHEN 1 THEN 'FAILED'
       ELSE 'CANCELED'
     END
     WHERE job_id = 'job-aggregate'`,
  );
  assert.deepEqual(await queue.refreshJobAggregate("job-aggregate"), {
    status: "PARTIAL_SUCCEEDED",
    completedOutputCount: 1,
  });

  database.exec(
    "UPDATE generation_job_items SET status = 'CANCELED' WHERE job_id = 'job-aggregate'",
  );
  assert.deepEqual(await queue.refreshJobAggregate("job-aggregate"), {
    status: "CANCELED",
    completedOutputCount: 0,
  });

  database.exec(
    "UPDATE generation_job_items SET status = 'SUCCEEDED' WHERE job_id = 'job-aggregate'",
  );
  assert.deepEqual(await queue.refreshJobAggregate("job-aggregate"), {
    status: "SUCCEEDED",
    completedOutputCount: 3,
  });
});

test("job aggregation exposes deterministic provider, request, error and timing metadata", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-public-success" });
  await queue.materializeItems("job-public-success", TEST_GENERATION_BILLING);
  const claim = await queue.claimNextEligible({
    workerId: "worker-public-success",
    claimRequestId: "claim-public-success",
  });
  assert.ok(claim);
  assert.equal(
    database
      .prepare("SELECT started_at IS NOT NULL AS started FROM generation_jobs WHERE id = ?")
      .get("job-public-success")?.started,
    1,
  );
  assert.equal(
    await queue.transition(claim.fence, "LEASED", "PREPROCESSING"),
    true,
  );
  assert.equal(
    await queue.transition(claim.fence, "PREPROCESSING", "SUBMITTING", {
      provider: "seedream",
      model: "doubao-seedream-5-0-pro-260628",
    }),
    true,
  );
  assert.equal(
    await queue.transition(claim.fence, "SUBMITTING", "PERSISTING", {
      providerRequestId: "provider-public-success",
    }),
    true,
  );
  assert.equal(
    await queue.transition(claim.fence, "PERSISTING", "SUCCEEDED"),
    true,
  );
  assert.deepEqual(
    { ...database
      .prepare(
        `SELECT status, provider, model,
                provider_request_id AS providerRequestId,
                error_code AS errorCode,
                finished_at IS NOT NULL AS finished
         FROM generation_jobs WHERE id = ?`,
      )
      .get("job-public-success") },
    {
      status: "SUCCEEDED",
      provider: "seedream",
      model: "doubao-seedream-5-0-pro-260628",
      providerRequestId: "provider-public-success",
      errorCode: null,
      finished: 1,
    },
  );

  insertJob(database, { id: "job-public-failure" });
  await queue.materializeItems("job-public-failure", TEST_GENERATION_BILLING);
  database.exec(
    "UPDATE generation_job_items SET max_attempts = 1 WHERE job_id = 'job-public-failure'",
  );
  const failedClaim = await queue.claimNextEligible({
    workerId: "worker-public-failure",
    claimRequestId: "claim-public-failure",
  });
  assert.ok(failedClaim);
  assert.equal(
    await queue.scheduleSafeRetry(
      failedClaim.fence,
      "LEASED",
      {
        errorCode: "INPUT_UNAVAILABLE",
        errorMessage: "input unavailable",
        errorRetryable: false,
      },
      0,
    ),
    "failed",
  );
  assert.deepEqual(
    { ...database
      .prepare(
        `SELECT status, error_code AS errorCode, error_message AS errorMessage,
                error_retryable AS errorRetryable,
                finished_at IS NOT NULL AS finished
         FROM generation_jobs WHERE id = ?`,
      )
      .get("job-public-failure") },
    {
      status: "FAILED",
      errorCode: "INPUT_UNAVAILABLE",
      errorMessage: "input unavailable",
      errorRetryable: 0,
      finished: 1,
    },
  );
});

test("multi-output aggregation keeps first-provider metadata and the first terminal error", async () => {
  const { database, queue } = setup();
  insertJob(database, { id: "job-public-partial", outputCount: 2 });
  await queue.materializeItems("job-public-partial", TEST_GENERATION_BILLING);
  const succeeded = await queue.claimNextEligible({
    workerId: "worker-partial-success",
    claimRequestId: "claim-partial-success",
  });
  assert.ok(succeeded);
  await queue.transition(succeeded.fence, "LEASED", "PREPROCESSING");
  await queue.transition(succeeded.fence, "PREPROCESSING", "SUBMITTING", {
    provider: "seedream",
    model: "doubao-seedream-5-0-pro-260628",
  });
  await queue.transition(succeeded.fence, "SUBMITTING", "PERSISTING", {
    providerRequestId: "provider-partial-first",
  });
  await queue.transition(succeeded.fence, "PERSISTING", "SUCCEEDED");

  const failed = await queue.claimNextEligible({
    workerId: "worker-partial-failure",
    claimRequestId: "claim-partial-failure",
  });
  assert.ok(failed);
  database
    .prepare("UPDATE generation_job_items SET max_attempts = 1 WHERE id = ?")
    .run(failed.item.id);
  assert.equal(
    await queue.scheduleSafeRetry(
      failed.fence,
      "LEASED",
      {
        errorCode: "SECOND_OUTPUT_FAILED",
        errorMessage: "second output failed",
        errorRetryable: false,
      },
      0,
    ),
    "failed",
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT status, completed_output_count AS completedOutputCount,
                  provider, model, provider_request_id AS providerRequestId,
                  error_code AS errorCode, finished_at IS NOT NULL AS finished
           FROM generation_jobs WHERE id = ?`,
        )
        .get("job-public-partial"),
    },
    {
      status: "PARTIAL_SUCCEEDED",
      completedOutputCount: 1,
      provider: "seedream",
      model: "doubao-seedream-5-0-pro-260628",
      providerRequestId: "provider-partial-first",
      errorCode: "SECOND_OUTPUT_FAILED",
      finished: 1,
    },
  );
});

test("item, attempt and job aggregate roll back together when aggregation fails", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  let failAggregate = false;
  const d1 = new TestD1Database(database, (statement) => {
    if (
      failAggregate &&
      /UPDATE generation_jobs\s+SET completed_output_count/u.test(
        statement.sqlText(),
      )
    ) {
      throw new Error("simulated aggregate failure");
    }
  }) as unknown as D1Database;
  const queue = new D1GenerationQueue(d1);
  insertJob(database, { id: "job-atomic-aggregate" });
  await queue.materializeItems("job-atomic-aggregate", TEST_GENERATION_BILLING);
  const claim = await queue.claimNextEligible({
    workerId: "worker-atomic",
    claimRequestId: "claim-atomic",
  });
  assert.ok(claim);
  assert.equal(
    await queue.transition(claim.fence, "LEASED", "PREPROCESSING"),
    true,
  );

  failAggregate = true;
  await assert.rejects(
    () =>
      queue.transition(claim.fence, "PREPROCESSING", "SUBMITTING", {
        provider: "seedream",
        model: "doubao-seedream-4-5-251128",
      }),
    /simulated aggregate failure/u,
  );
  assert.equal(
    database
      .prepare("SELECT status FROM generation_job_items WHERE job_id = ?")
      .get("job-atomic-aggregate")?.status,
    "PREPROCESSING",
  );
  assert.equal(
    database
      .prepare("SELECT state FROM generation_attempts WHERE item_id = ?")
      .get(claim.item.id)?.state,
    "PREPROCESSING",
  );
  assert.equal(
    database
      .prepare("SELECT status FROM generation_jobs WHERE id = ?")
      .get("job-atomic-aggregate")?.status,
    "PREPROCESSING",
  );
});

test("claim, safe retry and sweep also roll back when aggregation fails", async () => {
  {
    const { database, queue, setFailAggregate } = setupWithAggregateFault();
    insertJob(database, { id: "job-atomic-claim" });
    await queue.materializeItems("job-atomic-claim", TEST_GENERATION_BILLING);
    setFailAggregate(true);
    await assert.rejects(
      () =>
        queue.claimNextEligible({
          workerId: "worker-atomic-claim",
          claimRequestId: "claim-atomic-claim",
        }),
      /simulated aggregate failure/u,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM generation_job_items WHERE job_id = ?")
        .get("job-atomic-claim")?.status,
      "QUEUED",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM generation_attempts")
        .get()?.count,
      0,
    );
  }

  {
    const { database, queue, setFailAggregate } = setupWithAggregateFault();
    insertJob(database, { id: "job-atomic-retry" });
    await queue.materializeItems("job-atomic-retry", TEST_GENERATION_BILLING);
    const claim = await queue.claimNextEligible({
      workerId: "worker-atomic-retry",
      claimRequestId: "claim-atomic-retry",
    });
    assert.ok(claim);
    await queue.transition(claim.fence, "LEASED", "PREPROCESSING");
    setFailAggregate(true);
    await assert.rejects(
      () =>
        queue.scheduleSafeRetry(
          claim.fence,
          "PREPROCESSING",
          {
            errorCode: "TEST_RETRY",
            errorMessage: "retry should roll back",
            errorRetryable: true,
          },
          0,
        ),
      /simulated aggregate failure/u,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM generation_job_items WHERE job_id = ?")
        .get("job-atomic-retry")?.status,
      "PREPROCESSING",
    );
    assert.equal(
      database
        .prepare("SELECT state FROM generation_attempts WHERE item_id = ?")
        .get(claim.item.id)?.state,
      "PREPROCESSING",
    );
  }

  {
    const { database, queue, setFailAggregate } = setupWithAggregateFault();
    insertJob(database, { id: "job-atomic-sweep" });
    await queue.materializeItems("job-atomic-sweep", TEST_GENERATION_BILLING);
    const claim = await queue.claimNextEligible({
      workerId: "worker-atomic-sweep",
      claimRequestId: "claim-atomic-sweep",
    });
    assert.ok(claim);
    database
      .prepare(
        "UPDATE generation_job_items SET lease_expires_at = unixepoch() - 1 WHERE id = ?",
      )
      .run(claim.item.id);
    setFailAggregate(true);
    await assert.rejects(
      () => queue.recoverExpiredLeases(1, () => 0),
      /simulated aggregate failure/u,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM generation_job_items WHERE id = ?")
        .get(claim.item.id)?.status,
      "LEASED",
    );
    assert.equal(
      database
        .prepare("SELECT state FROM generation_attempts WHERE item_id = ?")
        .get(claim.item.id)?.state,
      "STARTED",
    );
  }
});

function setup(): { database: DatabaseSync; queue: D1GenerationQueue } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const d1 = new TestD1Database(database) as unknown as D1Database;
  return { database, queue: new D1GenerationQueue(d1) };
}

function setupWithAggregateFault(): {
  database: DatabaseSync;
  queue: D1GenerationQueue;
  setFailAggregate: (value: boolean) => void;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  let failAggregate = false;
  const d1 = new TestD1Database(database, (statement) => {
    if (
      failAggregate &&
      /UPDATE generation_jobs\s+SET completed_output_count/u.test(
        statement.sqlText(),
      )
    ) {
      throw new Error("simulated aggregate failure");
    }
  }) as unknown as D1Database;
  return {
    database,
    queue: new D1GenerationQueue(d1),
    setFailAggregate: (value) => {
      failAggregate = value;
    },
  };
}

function insertJob(
  database: DatabaseSync,
  options: {
    id: string;
    ownerId?: string;
    provider?: string;
    outputCount?: number;
    status?: string;
  },
): void {
  const ownerId = options.ownerId ?? `owner-${options.id}`;
  creditTestOwner(database, ownerId);
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
         preservation_mode, provider_preference, output_count,
         idempotency_key, request_hash, status)
       VALUES (?, ?, NULL, 'self-service', 'noon', 'structure', ?, ?, ?, ?, ?)`,
    )
    .run(
      options.id,
      ownerId,
      options.provider ?? "doubao-seedream-5-0-pro-260628",
      options.outputCount ?? 1,
      `key-${options.id}`,
      `hash-${options.id}`,
      options.status ?? "QUEUED",
    );
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}
