import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations } from "../helpers/test-d1";

function seedAttempt(database: DatabaseSync, suffix: string, executionKind = "provider") {
  const jobId = `job-${suffix}`;
  const itemId = `item-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  database.prepare(
    `INSERT INTO generation_jobs
      (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
       preservation_mode, provider_preference, output_count, idempotency_key, request_hash)
     VALUES (?, ?, NULL, 'modern-warm', 'noon', 'structure',
             'doubao-seedream-4-5-251128', 1, ?, ?)`,
  ).run(jobId, `owner-${suffix}`, `idem-${suffix}`, `hash-${suffix}`);
  database.prepare(
    `INSERT INTO generation_job_items
      (id, job_id, owner_id, ordinal, provider_preference, provider_key,
       execution_kind, status, attempt_count, lease_generation, current_attempt_id)
     VALUES (?, ?, ?, 0, 'doubao-seedream-4-5-251128', ?, ?, 'SUBMITTING', 1, 1, ?)`,
  ).run(itemId, jobId, `owner-${suffix}`, executionKind === "provider" ? "seedream" : "acceptance", executionKind, attemptId);
  database.prepare(
    `INSERT INTO generation_attempts
      (id, item_id, attempt_no, lease_token, lease_generation, state,
       provider, model, provider_request_id)
     VALUES (?, ?, 1, ?, 1, 'PROVIDER_DISPATCHING', ?, ?, ?)`,
  ).run(attemptId, itemId, `lease-${suffix}`, executionKind === "provider" ? "seedream" : "acceptance", executionKind === "provider" ? "doubao-seedream-4-5-251128" : "acceptance-fixture-v1", `request-${suffix}`);
  return { jobId, itemId, attemptId };
}

test("0014 materializes provider reconciliation cases and append-only audit", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);

  const provider = seedAttempt(database, "provider");
  database.prepare(
    `UPDATE generation_job_items
     SET status='RECONCILIATION_REQUIRED', last_error_code='AMBIGUOUS_PROVIDER_OUTCOME'
     WHERE id=?`,
  ).run(provider.itemId);
  const row = database.prepare(
    `SELECT item_id AS itemId, attempt_id AS attemptId, job_id AS jobId,
            state, reason_code AS reasonCode, provider_request_id AS providerRequestId
     FROM generation_reconciliation_cases WHERE item_id=?`,
  ).get(provider.itemId);
  assert.deepEqual({ ...row }, {
    itemId: provider.itemId,
    attemptId: provider.attemptId,
    jobId: provider.jobId,
    state: "OPEN",
    reasonCode: "AMBIGUOUS_PROVIDER_OUTCOME",
    providerRequestId: "request-provider",
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_events").get()?.count, 1);
  assert.throws(() => database.prepare("UPDATE generation_reconciliation_events SET note='changed'").run(), /append-only/u);
  assert.throws(() => database.prepare("DELETE FROM generation_reconciliation_events").run(), /append-only/u);
  assert.throws(() => database.prepare(
    `INSERT OR REPLACE INTO generation_reconciliation_events
      (id, case_id, action_id, action, actor_id) VALUES
      ('event_open_attempt-provider', 'recon_attempt-provider', 'system-open-attempt-provider', 'FORGED', 'attacker')`,
  ).run(), /already exists/u);
  assert.throws(() => database.prepare(
    "UPDATE generation_reconciliation_cases SET state='CLOSED', resolution='FORGED' WHERE item_id=?",
  ).run(provider.itemId), /invalid reconciliation case update/u);

  database.prepare("UPDATE generation_job_items SET status='SUCCEEDED' WHERE id=?").run(provider.itemId);
  assert.equal(database.prepare("SELECT state FROM generation_reconciliation_cases WHERE item_id=?").get(provider.itemId)?.state, "OPEN");
  database.prepare(
    `INSERT INTO assets
      (id, owner_id, kind, original_file_name, mime_type, byte_size, sha256, storage_key)
     VALUES (?, 'owner-provider', 'output', 'result.png', 'image/png', 4, ?, ?)`,
  ).run("asset-provider", "a".repeat(64), "jobs/job-provider/result.png");
  database.prepare(
    `INSERT INTO generation_output_commits
      (id, item_id, attempt_id, lease_generation, upload_request_id, asset_id,
       storage_key, prompt_template_version, mime_type, byte_size, sha256, state)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'test-v1', 'image/png', 4, ?, 'OBJECT_STORED')`,
  ).run("commit-provider", provider.itemId, provider.attemptId, "upload-provider", "asset-provider", "jobs/job-provider/result.png", "a".repeat(64));
  database.prepare("UPDATE generation_output_commits SET state='COMMITTED' WHERE id='commit-provider'").run();
  assert.deepEqual(
    { ...database.prepare("SELECT state, resolution, version FROM generation_reconciliation_cases WHERE item_id=?").get(provider.itemId) },
    { state: "CLOSED", resolution: "OUTPUT_COMMIT_RECOVERED", version: 2 },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_events").get()?.count, 2);

  const acceptance = seedAttempt(database, "acceptance", "acceptance");
  database.prepare("UPDATE generation_job_items SET status='RECONCILIATION_REQUIRED' WHERE id=?").run(acceptance.itemId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_cases WHERE item_id=?").get(acceptance.itemId)?.count, 0);
  assert.throws(() => database.prepare(
    `INSERT INTO generation_reconciliation_cases
      (id, item_id, attempt_id, job_id, reason_code)
     VALUES ('recon-forged', ?, ?, ?, 'FORGED')`,
  ).run(acceptance.itemId, acceptance.attemptId, acceptance.jobId), /invalid reconciliation case insert/u);
  const submitting = seedAttempt(database, "submitting");
  assert.throws(() => database.prepare(
    `INSERT INTO generation_reconciliation_cases
      (id, item_id, attempt_id, job_id, reason_code)
     VALUES ('recon-submitting-forged', ?, ?, ?, 'FORGED')`,
  ).run(submitting.itemId, submitting.attemptId, submitting.jobId), /invalid reconciliation case insert/u);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0014 backfills existing provider reconciliation without changing queue state", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database, 13);
  const existing = seedAttempt(database, "backfill");
  database.prepare("UPDATE generation_job_items SET status='RECONCILIATION_REQUIRED', last_error_code='AMBIGUOUS_PROVIDER_OUTCOME' WHERE id=?").run(existing.itemId);
  database.exec(readFileSync("drizzle/0014_generation_reconciliation.sql", "utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_cases WHERE item_id=?").get(existing.itemId)?.count, 1);
  assert.equal(database.prepare("SELECT status FROM generation_job_items WHERE id=?").get(existing.itemId)?.status, "RECONCILIATION_REQUIRED");
});

test("0014 does not interfere with an ordinary committed provider output", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const ordinary = seedAttempt(database, "ordinary");
  database.prepare("UPDATE generation_job_items SET status='SUCCEEDED' WHERE id=?").run(ordinary.itemId);
  database.prepare(
    `INSERT INTO assets
      (id, owner_id, kind, original_file_name, mime_type, byte_size, sha256, storage_key)
     VALUES ('asset-ordinary', 'owner-ordinary', 'output', 'result.png', 'image/png', 4, ?, 'jobs/job-ordinary/result.png')`,
  ).run("b".repeat(64));
  database.prepare(
    `INSERT INTO generation_output_commits
      (id, item_id, attempt_id, lease_generation, upload_request_id, asset_id,
       storage_key, prompt_template_version, mime_type, byte_size, sha256, state)
     VALUES ('commit-ordinary', ?, ?, 1, 'upload-ordinary', 'asset-ordinary',
             'jobs/job-ordinary/result.png', 'test-v1', 'image/png', 4, ?, 'OBJECT_STORED')`,
  ).run(ordinary.itemId, ordinary.attemptId, "b".repeat(64));
  assert.doesNotThrow(() => database.prepare("UPDATE generation_output_commits SET state='COMMITTED' WHERE id='commit-ordinary'").run());
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_events").get()?.count, 0);
});

test("0014 rejects a NULL-resolution close even with matching committed output", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const provider = seedAttempt(database, "null-close");
  database.prepare("UPDATE generation_job_items SET status='RECONCILIATION_REQUIRED' WHERE id=?").run(provider.itemId);
  database.prepare("UPDATE generation_job_items SET status='SUCCEEDED' WHERE id=?").run(provider.itemId);
  database.prepare(
    `INSERT INTO assets
      (id, owner_id, kind, original_file_name, mime_type, byte_size, sha256, storage_key)
     VALUES ('asset-null-close', 'owner-null-close', 'output', 'result.png', 'image/png', 4, ?, 'jobs/job-null-close/result.png')`,
  ).run("c".repeat(64));
  database.prepare(
    `INSERT INTO generation_output_commits
      (id, item_id, attempt_id, lease_generation, upload_request_id, asset_id,
       storage_key, prompt_template_version, mime_type, byte_size, sha256, state)
     VALUES ('commit-null-close', ?, ?, 1, 'upload-null-close', 'asset-null-close',
             'jobs/job-null-close/result.png', 'test-v1', 'image/png', 4, ?, 'COMMITTED')`,
  ).run(provider.itemId, provider.attemptId, "c".repeat(64));
  assert.throws(() => database.prepare(
    "UPDATE generation_reconciliation_cases SET state='CLOSED', resolution=NULL, version=2, resolved_at=unixepoch() WHERE item_id=?",
  ).run(provider.itemId), /invalid reconciliation case update/u);
});
