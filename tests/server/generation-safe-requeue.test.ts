import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NodeD1Database } from "../../lib/platform/node-d1";
import { ApiError } from "../../lib/server/api";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import {
  parseSafeRequeueInput,
  requeueFailedBeforeProvider,
} from "../../lib/server/generation-safe-requeue";
import { applyMigrations, creditTestOwner } from "../helpers/test-d1";

function code(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

function seedSafeFailure(database: DatabaseSync, suffix: string, options: {
  executionKind?: "provider" | "acceptance";
  attemptCount?: number;
  maxAttempts?: number;
} = {}) {
  const jobId = `job-${suffix}`;
  const itemId = `item-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const executionKind = options.executionKind ?? "provider";
  const attemptCount = options.attemptCount ?? 1;
  const maxAttempts = options.maxAttempts ?? 3;
  const ownerId = `owner-${suffix}`;
  if (executionKind === "provider") {
    creditTestOwner(database, ownerId, 1);
  }
  database.prepare(
    `INSERT INTO generation_jobs
      (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
       preservation_mode, provider_preference, output_count, idempotency_key,
       request_hash, status, error_code, error_message, error_retryable)
     VALUES (?, ?, NULL, 'modern-warm', 'noon', 'structure',
             'doubao-seedream-4-5-251128', 1, ?, ?, 'FAILED',
             'SAFE_TEST_FAILURE', 'safe failure', 0)`,
  ).run(jobId, ownerId, `idem-${suffix}`, `hash-${suffix}`);
  database.prepare(
    `INSERT INTO generation_job_items
      (id, job_id, owner_id, ordinal, provider_preference, provider_key,
       execution_kind, status, attempt_count, max_attempts, lease_generation)
     VALUES (?, ?, ?, 0, 'doubao-seedream-4-5-251128', ?, ?, 'QUEUED', ?, ?, 1)`,
  ).run(
    itemId,
    jobId,
    ownerId,
    executionKind === "provider" ? "seedream" : "acceptance",
    executionKind,
    attemptCount,
    maxAttempts,
  );
  if (executionKind === "provider") {
    database.prepare(
      `INSERT INTO credit_ledger_entries
        (id, owner_id, entry_type, amount, reservation_id, job_id, item_id,
         idempotency_key, reason_code, price_version, actor_id, request_id)
       VALUES (?, ?, 'RESERVE', 1, ?, ?, ?, ?, 'TEST_RESERVE', 'test-v1', 'test', ?)`,
    ).run(
      `ledger-reserve-${suffix}`,
      ownerId,
      `billing-${suffix}`,
      jobId,
      itemId,
      `reserve:test:${suffix}`,
      `test:${suffix}`,
    );
  }
  database.prepare(
    `INSERT INTO generation_attempts
      (id, item_id, attempt_no, lease_token, lease_generation, state,
       retry_class, error_code, error_message, finished_at)
     VALUES (?, ?, ?, ?, 1, 'FAILED', 'not-retryable',
             'SAFE_TEST_FAILURE', 'safe failure', unixepoch())`,
  ).run(attemptId, itemId, attemptCount, `lease-${suffix}`);
  database.prepare(
    `UPDATE generation_job_items
     SET status='FAILED', current_attempt_id=?, last_error_code='SAFE_TEST_FAILURE',
         last_error_message='safe failure', last_error_retryable=0, finished_at=unixepoch()
     WHERE id=?`,
  ).run(attemptId, itemId);
  return { jobId, itemId, attemptId };
}

function input(itemId: string, actionId = "safe-requeue-0001") {
  return {
    itemId,
    action: "REQUEUE_BEFORE_PROVIDER" as const,
    actionId,
    actorId: "chatgpt:hashed-admin",
    requestId: `request-${actionId}`,
  };
}

test("safe admin requeue preserves evidence and the normal claim creates the next attempt", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  const seeded = seedSafeFailure(database, "happy");
  const d1 = new NodeD1Database(database);

  const first = await requeueFailedBeforeProvider(input(seeded.itemId), d1);
  assert.equal(first.idempotentReplay, false);
  assert.deepEqual(
    { ...database.prepare(
      `SELECT status, attempt_count AS attemptCount, max_attempts AS maxAttempts,
              lease_generation AS leaseGeneration, current_attempt_id AS currentAttemptId,
              last_error_code AS errorCode, heartbeat_at AS heartbeatAt
       FROM generation_job_items WHERE id=?`,
    ).get(seeded.itemId) },
    {
      status: "QUEUED",
      attemptCount: 1,
      maxAttempts: 3,
      leaseGeneration: 2,
      currentAttemptId: seeded.attemptId,
      errorCode: null,
      heartbeatAt: null,
    },
  );
  assert.deepEqual(
    { ...database.prepare("SELECT state, retry_class AS retryClass, error_code AS errorCode FROM generation_attempts WHERE id=?").get(seeded.attemptId) },
    { state: "FAILED", retryClass: "not-retryable", errorCode: "SAFE_TEST_FAILURE" },
  );
  assert.equal(database.prepare("SELECT status FROM generation_jobs WHERE id=?").get(seeded.jobId)?.status, "QUEUED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_queue_admin_actions").get()?.count, 1);
  assert.equal(
    database.prepare("SELECT billing_reservation_id AS value FROM generation_job_items WHERE id=?").get(seeded.itemId)?.value,
    "billing_requeue_safe-requeue-0001",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credit_ledger_entries WHERE entry_type='RESERVE'").get()?.count,
    2,
  );

  const replay = await requeueFailedBeforeProvider({ ...input(seeded.itemId), requestId: "request-replay" }, d1);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_queue_admin_actions").get()?.count, 1);
  await assert.rejects(
    requeueFailedBeforeProvider({ ...input(seeded.itemId), actorId: "chatgpt:other-admin" }, d1),
    code("IDEMPOTENCY_CONFLICT"),
  );
  const other = seedSafeFailure(database, "other");
  await assert.rejects(
    requeueFailedBeforeProvider(input(other.itemId), d1),
    code("IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    requeueFailedBeforeProvider(input(seeded.itemId, "safe-requeue-0002"), d1),
    code("SAFE_REQUEUE_NOT_ALLOWED"),
  );

  const claim = await new D1GenerationQueue(d1).claimNextEligible({
    workerId: "worker-safe-test",
    claimRequestId: "claim-safe-requeue-test",
    leaseSeconds: 60,
  });
  assert.ok(claim);
  assert.equal(claim.item.attemptCount, 2);
  assert.notEqual(claim.attemptId, seeded.attemptId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE item_id=?").get(seeded.itemId)?.count, 2);
});

test("safe requeue rolls back when the released credit was reserved elsewhere", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  const seeded = seedSafeFailure(database, "no-credit");
  database.prepare(
    `INSERT INTO generation_jobs
      (id,owner_id,source_asset_id,style_preset_id,lighting_preset,preservation_mode,
       provider_preference,output_count,idempotency_key,request_hash,status)
     VALUES ('job-credit-consumer','owner-no-credit',NULL,'self-service','noon','structure',
             'doubao-seedream-4-5-251128',1,'idem-credit-consumer','hash-credit-consumer','QUEUED')`,
  ).run();
  database.prepare(
    `INSERT INTO generation_job_items
      (id,job_id,owner_id,ordinal,provider_preference,provider_key)
     VALUES ('item-credit-consumer','job-credit-consumer','owner-no-credit',0,
             'doubao-seedream-4-5-251128','seedream')`,
  ).run();
  database.prepare(
    `INSERT INTO credit_ledger_entries
      (id,owner_id,entry_type,amount,reservation_id,job_id,item_id,idempotency_key,
       reason_code,price_version,actor_id,request_id)
     VALUES ('ledger-credit-consumer','owner-no-credit','RESERVE',1,'billing-credit-consumer',
             'job-credit-consumer','item-credit-consumer','reserve:credit-consumer',
             'TEST_RESERVE','test-v1','test','request-credit-consumer')`,
  ).run();

  await assert.rejects(
    requeueFailedBeforeProvider(
      input(seeded.itemId, "safe-requeue-no-credit"),
      new NodeD1Database(database),
    ),
    code("INSUFFICIENT_CREDITS"),
  );
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(seeded.itemId)?.status, "FAILED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_queue_admin_actions").get()?.count, 0);
});

test("safe requeue rejects provider evidence, budget exhaustion, acceptance and prior actions", async () => {
  const cases: Array<{
    suffix: string;
    setup: (database: DatabaseSync, seeded: ReturnType<typeof seedSafeFailure>) => void;
  }> = [
    { suffix: "budget", setup: (database, seeded) => database.prepare("UPDATE generation_job_items SET attempt_count=max_attempts WHERE id=?").run(seeded.itemId) },
    { suffix: "dispatch", setup: (database, seeded) => database.prepare("UPDATE generation_attempts SET provider_started_at=unixepoch(), provider='seedream', model='doubao-seedream-4-5-251128' WHERE id=?").run(seeded.attemptId) },
    { suffix: "request", setup: (database, seeded) => database.prepare("UPDATE generation_attempts SET provider_request_id='provider-request' WHERE id=?").run(seeded.attemptId) },
    { suffix: "active", setup: (database, seeded) => database.prepare("UPDATE generation_job_items SET status='PREPROCESSING' WHERE id=?").run(seeded.itemId) },
    { suffix: "lease", setup: (database, seeded) => database.prepare("UPDATE generation_job_items SET lease_token='live-lease', lease_owner='worker', lease_expires_at=unixepoch()+60 WHERE id=?").run(seeded.itemId) },
    { suffix: "fence-mismatch", setup: (database, seeded) => database.prepare("UPDATE generation_attempts SET lease_generation=0 WHERE id=?").run(seeded.attemptId) },
    { suffix: "error-mismatch", setup: (database, seeded) => database.prepare("UPDATE generation_job_items SET last_error_message='different' WHERE id=?").run(seeded.itemId) },
    { suffix: "history", setup: (database, seeded) => database.prepare(
      `INSERT INTO generation_attempts
        (id,item_id,attempt_no,lease_token,lease_generation,state,provider,
         model,retry_class,provider_started_at,finished_at)
       VALUES ('attempt-history-old',?,0,'lease-history-old',0,'FAILED','seedream',
               'doubao-seedream-4-5-251128','ambiguous-after-provider',unixepoch(),unixepoch())`,
    ).run(seeded.itemId) },
    { suffix: "commit", setup: (database, seeded) => database.prepare(
      `INSERT INTO generation_output_commits
        (id,item_id,attempt_id,lease_generation,upload_request_id,asset_id,
         storage_key,prompt_template_version,mime_type,byte_size,sha256,state)
       VALUES ('commit-danger',?,?,1,'upload-danger','asset-danger','danger/result.png',
               'test-v1','image/png',4,?,'PREPARED')`,
    ).run(seeded.itemId, seeded.attemptId, "a".repeat(64)) },
    { suffix: "job-output", setup: (database, seeded) => {
      database.prepare(
        `INSERT INTO assets
          (id,owner_id,kind,original_file_name,mime_type,byte_size,sha256,storage_key)
         VALUES ('asset-job-output','owner-job-output','output','result.png','image/png',4,?,'jobs/job-output/result.png')`,
      ).run("b".repeat(64));
      database.prepare(
        "INSERT INTO generation_job_outputs (job_id,asset_id,ordinal) VALUES (?, 'asset-job-output', 0)",
      ).run(seeded.jobId);
    } },
    { suffix: "reconciliation", setup: (database, seeded) => {
      database.prepare("UPDATE generation_job_items SET status='RECONCILIATION_REQUIRED' WHERE id=?").run(seeded.itemId);
    } },
  ];
  for (const scenario of cases) {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    applyMigrations(database);
    const seeded = seedSafeFailure(database, scenario.suffix);
    scenario.setup(database, seeded);
    await assert.rejects(
      requeueFailedBeforeProvider(input(seeded.itemId, `safe-${scenario.suffix}-0001`), new NodeD1Database(database)),
      code("SAFE_REQUEUE_NOT_ALLOWED"),
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_queue_admin_actions").get()?.count, 0);
  }

  const acceptanceDb = new DatabaseSync(":memory:");
  acceptanceDb.exec("PRAGMA foreign_keys=ON");
  applyMigrations(acceptanceDb);
  const acceptance = seedSafeFailure(acceptanceDb, "acceptance", { executionKind: "acceptance" });
  await assert.rejects(
    requeueFailedBeforeProvider(input(acceptance.itemId, "safe-acceptance-0001"), new NodeD1Database(acceptanceDb)),
    code("SAFE_REQUEUE_NOT_ALLOWED"),
  );
});

test("safe requeue input is closed and admin actions are immutable", async () => {
  assert.deepEqual(parseSafeRequeueInput({
    itemId: "item-safe",
    action: "REQUEUE_BEFORE_PROVIDER",
    actionId: "safe-action-0001",
  }), {
    itemId: "item-safe",
    action: "REQUEUE_BEFORE_PROVIDER",
    actionId: "safe-action-0001",
  });
  assert.throws(() => parseSafeRequeueInput({ itemId: "item-safe", action: "RETRY", actionId: "safe-action-0001" }), code("INVALID_FIELD"));
  assert.throws(() => parseSafeRequeueInput({ itemId: "item-safe", action: "REQUEUE_BEFORE_PROVIDER", actionId: "safe-action-0001", maxAttempts: 99 }), code("INVALID_FIELD"));

  const route = readFileSync("app/api/admin/generation/requeue/route.ts", "utf8");
  assert.match(route, /assertReconciliationAdmin\(request, actor, readRuntimeBindings\(\)\)/u);
  assert.match(route, /assertSameOriginMutation\(request\)/u);
  assert.match(route, /readJsonBody\(request, 8 \* 1024\)/u);
  assert.doesNotMatch(route, /fetch\(|providerPreference|providerRequestId|MARK_SUCCEEDED|REFUND/u);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  const seeded = seedSafeFailure(database, "immutable");
  await requeueFailedBeforeProvider(input(seeded.itemId, "safe-immutable-0001"), new NodeD1Database(database));
  assert.throws(() => database.prepare("UPDATE generation_queue_admin_actions SET actor_id='changed'").run(), /append-only/u);
  assert.throws(() => database.prepare("DELETE FROM generation_queue_admin_actions").run(), /append-only/u);
  assert.throws(() => database.prepare(
    `INSERT OR REPLACE INTO generation_queue_admin_actions
      SELECT * FROM generation_queue_admin_actions WHERE action_id='safe-immutable-0001'`,
  ).run(), /(already exists|not safe to requeue)/u);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("safe requeue rolls back the action and item when job aggregation fails", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  const seeded = seedSafeFailure(database, "rollback");
  database.exec(`CREATE TRIGGER fail_safe_requeue_aggregate
    BEFORE UPDATE ON generation_jobs
    WHEN NEW.id = 'job-rollback'
    BEGIN SELECT RAISE(ABORT, 'simulated aggregate failure'); END;`);
  await assert.rejects(
    requeueFailedBeforeProvider(input(seeded.itemId, "safe-rollback-0001"), new NodeD1Database(database)),
    /simulated aggregate failure/u,
  );
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(seeded.itemId)?.status, "FAILED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_queue_admin_actions").get()?.count, 0);
});
