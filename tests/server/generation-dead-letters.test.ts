import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NodeD1Database } from "../../lib/platform/node-d1";
import { ApiError } from "../../lib/server/api";
import {
  listDeadLetters,
  parseDeadLetterLimit,
  parseDeadLetterState,
} from "../../lib/server/generation-dead-letters";
import { requeueFailedBeforeProvider } from "../../lib/server/generation-safe-requeue";
import { applyMigrations, creditTestOwner } from "../helpers/test-d1";

function code(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

function seedActiveAttempt(database: DatabaseSync, suffix: string, options: {
  executionKind?: "provider" | "acceptance";
  retryClass?: "safe-before-provider" | "not-retryable" | "attempts-exhausted";
  providerEvidence?: boolean;
  finishedAt?: number;
} = {}) {
  const jobId = `job-dlq-${suffix}`;
  const itemId = `item-dlq-${suffix}`;
  const attemptId = `attempt-dlq-${suffix}`;
  const executionKind = options.executionKind ?? "provider";
  const retryClass = options.retryClass ?? "not-retryable";
  const ownerId = `owner-${suffix}`;
  const hasCreditLedger = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credit_ledger_entries'",
  ).get());
  if (executionKind === "provider" && hasCreditLedger) creditTestOwner(database, ownerId, 1);
  database.prepare(
    `INSERT INTO generation_jobs
      (id,owner_id,source_asset_id,style_preset_id,lighting_preset,preservation_mode,
       provider_preference,output_count,idempotency_key,request_hash,status)
     VALUES (?, ?, NULL, 'modern-warm', 'noon', 'structure',
             'doubao-seedream-4-5-251128', 1, ?, ?, 'GENERATING')`,
  ).run(jobId, ownerId, `idem-${suffix}`, `hash-${suffix}`);
  database.prepare(
    `INSERT INTO generation_job_items
      (id,job_id,owner_id,ordinal,provider_preference,provider_key,execution_kind,status,
       attempt_count,max_attempts,lease_token,lease_generation,lease_owner,lease_expires_at,
       current_attempt_id)
     VALUES (?, ?, ?, 0, 'doubao-seedream-4-5-251128', ?, ?, 'QUEUED',
             1, 3, ?, 1, 'worker', unixepoch()+60, ?)`,
  ).run(itemId, jobId, ownerId, executionKind === "provider" ? "seedream" : "acceptance", executionKind, `lease-${suffix}`, attemptId);
  if (executionKind === "provider" && hasCreditLedger) {
    database.prepare(
      `INSERT INTO credit_ledger_entries
        (id,owner_id,entry_type,amount,reservation_id,job_id,item_id,idempotency_key,
         reason_code,price_version,actor_id,request_id)
       VALUES (?,?,'RESERVE',1,?,?,?,?, 'TEST_RESERVE','test-v1','test',?)`,
    ).run(
      `ledger-reserve-dlq-${suffix}`,
      ownerId,
      `billing-dlq-${suffix}`,
      jobId,
      itemId,
      `reserve:dlq:${suffix}`,
      `request-dlq-${suffix}`,
    );
  }
  database.prepare(
    `INSERT INTO generation_attempts
      (id,item_id,attempt_no,lease_token,lease_generation,state,retry_class,
       provider,model,provider_started_at)
     VALUES (?, ?, 1, ?, 1, 'PREPROCESSING', NULL, ?, ?, ?)`,
  ).run(
    attemptId,
    itemId,
    `lease-${suffix}`,
    options.providerEvidence ? "seedream" : null,
    options.providerEvidence ? "doubao-seedream-4-5-251128" : null,
    options.providerEvidence ? options.finishedAt ?? 100 : null,
  );
  database.prepare("UPDATE generation_job_items SET status='PREPROCESSING' WHERE id=?").run(itemId);
  database.prepare(
    `UPDATE generation_attempts
     SET state='FAILED', retry_class=?, error_code='TEST_FAILURE',
         error_message='private failure detail', finished_at=?
     WHERE id=?`,
  ).run(retryClass, options.finishedAt ?? 100, attemptId);
  return { jobId, itemId, attemptId };
}

function finishItem(database: DatabaseSync, itemId: string, finishedAt = 100) {
  database.prepare(
    `UPDATE generation_job_items
     SET status='FAILED', last_error_code='TEST_FAILURE',
         last_error_message='private failure detail', last_error_retryable=0,
         lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, finished_at=?
     WHERE id=?`,
  ).run(finishedAt, itemId);
}

test("0016 records only provider failures that are safe from provider ambiguity", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);

  const safe = seedActiveAttempt(database, "safe");
  finishItem(database, safe.itemId, 101);
  assert.deepEqual(
    { ...database.prepare(
      `SELECT item_id AS itemId, attempt_id AS attemptId, classification,
              reason_code AS reasonCode, retry_class AS retryClass,
              attempt_no AS attemptNo, attempt_count AS attemptCount, max_attempts AS maxAttempts
       FROM generation_dead_letter_entries WHERE item_id=?`,
    ).get(safe.itemId) },
    {
      itemId: safe.itemId,
      attemptId: safe.attemptId,
      classification: "SAFE_BEFORE_PROVIDER_FAILURE",
      reasonCode: "TEST_FAILURE",
      retryClass: "not-retryable",
      attemptNo: 1,
      attemptCount: 1,
      maxAttempts: 3,
    },
  );

  const acceptance = seedActiveAttempt(database, "acceptance", { executionKind: "acceptance" });
  finishItem(database, acceptance.itemId, 102);
  const providerEvidence = seedActiveAttempt(database, "provider-evidence", { providerEvidence: true });
  assert.throws(
    () => finishItem(database, providerEvidence.itemId, 103),
    /provider failed item must create a generation dead letter/u,
  );

  const historicalEvidence = seedActiveAttempt(database, "historical-provider-evidence");
  database.prepare(
    `UPDATE generation_attempts SET attempt_no=2 WHERE id=?`,
  ).run(historicalEvidence.attemptId);
  database.prepare(
    `UPDATE generation_job_items SET attempt_count=2 WHERE id=?`,
  ).run(historicalEvidence.itemId);
  database.prepare(
    `INSERT INTO generation_attempts
      (id,item_id,attempt_no,lease_token,lease_generation,state,retry_class,error_code,
       provider,model,provider_started_at,finished_at)
     VALUES (?, ?, 1, 'old-lease', 0, 'FAILED', 'not-retryable', 'OLD_PROVIDER_FAILURE',
             'seedream', 'doubao-seedream-4-5-251128', 90, 91)`,
  ).run("attempt-dlq-historical-provider-evidence-old", historicalEvidence.itemId);
  assert.throws(
    () => finishItem(database, historicalEvidence.itemId, 104),
    /provider failed item must create a generation dead letter/u,
  );

  const unclassified = seedActiveAttempt(database, "unclassified");
  database.prepare("UPDATE generation_attempts SET retry_class=NULL WHERE id=?").run(unclassified.attemptId);
  assert.throws(
    () => finishItem(database, unclassified.itemId, 105),
    /provider failed item must create a generation dead letter/u,
  );
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(unclassified.itemId)?.status, "PREPROCESSING");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries WHERE item_id=?").get(historicalEvidence.itemId)?.count, 0);

  database.prepare("UPDATE generation_job_items SET status='RECONCILIATION_REQUIRED' WHERE id=?").run(providerEvidence.itemId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_cases WHERE item_id=?").get(providerEvidence.itemId)?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries WHERE item_id=?").get(providerEvidence.itemId)?.count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0016 refuses to migrate an unclassified provider failure", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database, 15);
  const unclassified = seedActiveAttempt(database, "migration-unclassified", { finishedAt: 211 });
  database.prepare("UPDATE generation_attempts SET retry_class=NULL WHERE id=?").run(unclassified.attemptId);
  finishItem(database, unclassified.itemId, 211);
  assert.throws(
    () => database.exec(readFileSync("drizzle/0016_generation_dead_letters.sql", "utf8")),
    /unclassified provider failed item blocks dead letter migration/u,
  );
});

test("0016 backfills current failures and historical safe requeues without changing queue state", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database, 15);
  const current = seedActiveAttempt(database, "backfill-current", { finishedAt: 201 });
  finishItem(database, current.itemId, 201);
  const historical = seedActiveAttempt(database, "backfill-action", { finishedAt: 202 });
  finishItem(database, historical.itemId, 202);
  database.prepare(
    `INSERT INTO generation_queue_admin_actions
      (id,action_id,item_id,attempt_id,job_id,action,actor_id,request_id,from_status,to_status,
       from_attempt_no,from_attempt_count,reason_code)
     VALUES ('queue-admin-backfill','backfill-action-0001',?,?,?,'REQUEUE_BEFORE_PROVIDER',
             'admin','request','FAILED','QUEUED',1,1,'SAFE_BEFORE_PROVIDER')`,
  ).run(historical.itemId, historical.attemptId, historical.jobId);
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(historical.itemId)?.status, "QUEUED");

  const laterAmbiguous = seedActiveAttempt(database, "backfill-later-ambiguous", { finishedAt: 203 });
  finishItem(database, laterAmbiguous.itemId, 203);
  database.prepare(
    `INSERT INTO generation_queue_admin_actions
      (id,action_id,item_id,attempt_id,job_id,action,actor_id,request_id,from_status,to_status,
       from_attempt_no,from_attempt_count,reason_code)
     VALUES ('queue-admin-later-ambiguous','backfill-later-ambiguous-0001',?,?,?,'REQUEUE_BEFORE_PROVIDER',
             'admin','request','FAILED','QUEUED',1,1,'SAFE_BEFORE_PROVIDER')`,
  ).run(laterAmbiguous.itemId, laterAmbiguous.attemptId, laterAmbiguous.jobId);
  database.prepare("UPDATE generation_job_items SET status='QUEUED' WHERE id=?").run(laterAmbiguous.itemId);
  database.prepare(
    `INSERT INTO generation_attempts
      (id,item_id,attempt_no,lease_token,lease_generation,state,retry_class,error_code,
       provider,model,provider_request_id,provider_started_at,finished_at)
     VALUES ('attempt-dlq-backfill-later-ambiguous-2',?,2,'lease-ambiguous-2',2,
             'AMBIGUOUS','ambiguous-after-provider','AMBIGUOUS_PROVIDER_OUTCOME',
             'seedream','doubao-seedream-4-5-251128','provider-request-2',204,205)`,
  ).run(laterAmbiguous.itemId);
  database.prepare(
    `UPDATE generation_job_items
     SET status='RECONCILIATION_REQUIRED', attempt_count=2,
         current_attempt_id='attempt-dlq-backfill-later-ambiguous-2',
         last_error_code='AMBIGUOUS_PROVIDER_OUTCOME', finished_at=205
     WHERE id=?`,
  ).run(laterAmbiguous.itemId);

  const laterOutput = seedActiveAttempt(database, "backfill-later-output", { finishedAt: 206 });
  finishItem(database, laterOutput.itemId, 206);
  database.prepare(
    `INSERT INTO generation_queue_admin_actions
      (id,action_id,item_id,attempt_id,job_id,action,actor_id,request_id,from_status,to_status,
       from_attempt_no,from_attempt_count,reason_code)
     VALUES ('queue-admin-later-output','backfill-later-output-0001',?,?,?,'REQUEUE_BEFORE_PROVIDER',
             'admin','request','FAILED','QUEUED',1,1,'SAFE_BEFORE_PROVIDER')`,
  ).run(laterOutput.itemId, laterOutput.attemptId, laterOutput.jobId);
  database.prepare("UPDATE generation_job_items SET status='QUEUED' WHERE id=?").run(laterOutput.itemId);
  database.prepare(
    `INSERT INTO generation_output_commits
      (id,item_id,attempt_id,lease_generation,upload_request_id,asset_id,storage_key,
       prompt_template_version,mime_type,byte_size,sha256,state)
     VALUES ('commit-dlq-backfill-later-output',?,?,1,'upload-later-output',
             'asset-later-output','jobs/later-output.png','test-v1','image/png',4,?,'PREPARED')`,
  ).run(laterOutput.itemId, laterOutput.attemptId, "c".repeat(64));

  database.exec(readFileSync("drizzle/0016_generation_dead_letters.sql", "utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries").get()?.count, 4);
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(current.itemId)?.status, "FAILED");
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(historical.itemId)?.status, "QUEUED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries WHERE attempt_id=?").get(laterAmbiguous.attemptId)?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries WHERE attempt_id='attempt-dlq-backfill-later-ambiguous-2'").get()?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_dead_letter_entries WHERE attempt_id=?").get(laterOutput.attemptId)?.count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("dead letters are append-only and safe requeue derives the resolved view", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  const seeded = seedActiveAttempt(database, "resolved", { finishedAt: 301 });
  finishItem(database, seeded.itemId, 301);
  const d1 = new NodeD1Database(database);

  const open = await listDeadLetters({ state: "OPEN", limit: 10 }, d1);
  assert.equal(open.items.length, 1);
  await requeueFailedBeforeProvider({
    itemId: seeded.itemId,
    action: "REQUEUE_BEFORE_PROVIDER",
    actionId: "dead-letter-requeue-0001",
    actorId: "chatgpt:admin",
    requestId: "request-dead-letter-requeue",
  }, d1);
  assert.equal((await listDeadLetters({ state: "OPEN", limit: 10 }, d1)).items.length, 0);
  const resolved = await listDeadLetters({ state: "RESOLVED", limit: 10 }, d1);
  assert.equal(resolved.items.length, 1);
  assert.equal(resolved.items[0]?.state, "RESOLVED");
  assert.equal(Object.hasOwn(resolved.items[0] ?? {}, "ownerId"), false);
  assert.equal(Object.hasOwn(resolved.items[0] ?? {}, "errorMessage"), false);
  assert.equal(Object.hasOwn(resolved.items[0] ?? {}, "providerRequestId"), false);
  assert.throws(() => database.prepare("UPDATE generation_dead_letter_entries SET reason_code='changed'").run(), /append-only/u);
  assert.throws(() => database.prepare("DELETE FROM generation_dead_letter_entries").run(), /append-only/u);
  assert.throws(() => database.prepare(
    "INSERT OR REPLACE INTO generation_dead_letter_entries SELECT * FROM generation_dead_letter_entries",
  ).run(), /(already exists|invalid generation dead letter insert)/u);
});

test("dead letter list keyset pagination and API surface stay closed and read-only", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  for (const [suffix, openedAt] of [["a", 401], ["b", 402], ["c", 402]] as const) {
    const seeded = seedActiveAttempt(database, suffix, { finishedAt: openedAt });
    finishItem(database, seeded.itemId, openedAt);
  }
  const d1 = new NodeD1Database(database);
  const first = await listDeadLetters({ state: "OPEN", limit: 2 }, d1);
  assert.deepEqual(first.items.map((item) => item.id), ["dead_attempt-dlq-c", "dead_attempt-dlq-b"]);
  assert.ok(first.nextCursor);
  const second = await listDeadLetters({ state: "OPEN", limit: 2, cursor: first.nextCursor }, d1);
  assert.deepEqual(second.items.map((item) => item.id), ["dead_attempt-dlq-a"]);
  await assert.rejects(
    listDeadLetters({ state: "RESOLVED", limit: 2, cursor: first.nextCursor }, d1),
    code("INVALID_CURSOR"),
  );
  assert.equal(parseDeadLetterState(null), "OPEN");
  assert.equal(parseDeadLetterState("RESOLVED"), "RESOLVED");
  assert.throws(() => parseDeadLetterState("ALL"), code("INVALID_FIELD"));
  assert.equal(parseDeadLetterLimit("100"), 100);
  assert.throws(() => parseDeadLetterLimit("0"), code("INVALID_FIELD"));

  const route = readFileSync("app/api/admin/generation/dead-letters/route.ts", "utf8");
  assert.match(route, /assertReconciliationAdmin\(request, actor, readRuntimeBindings\(\)\)/u);
  assert.match(route, /export async function GET/u);
  assert.doesNotMatch(route, /export async function POST|fetch\(|REQUEUE|MARK_SUCCEEDED|REFUND/u);
  const page = readFileSync("app/admin/generation/dead-letters/page.tsx", "utf8");
  assert.match(page, /本页不提供重试或手工成功/u);
  assert.match(page, /status === "loading"/u);
  assert.match(page, /status === "error"/u);
  assert.match(page, /items\.length === 0/u);
});
