import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { creditCredits, getCreditSnapshot } from "../../lib/server/credit-ledger";
import {
  createD1QueuedJobIdempotently,
  type D1QueuedJobRecord,
} from "../../lib/server/queued-job-creation";
import { applyMigrations, TEST_GENERATION_BILLING, TestD1Database } from "../helpers/test-d1";

test("credits are append-only, idempotent and derived from immutable entries", async () => {
  const { database, d1 } = setup();
  const input = {
    ownerId: "owner-ledger",
    amount: 5,
    idempotencyKey: "credit:manual:test-1",
    reasonCode: "TEST_CREDIT",
    actorId: "test-admin",
    requestId: "request-credit-1",
  };
  assert.equal((await creditCredits(d1, input)).created, true);
  assert.equal((await creditCredits(d1, { ...input, requestId: "request-credit-replay" })).created, false);
  assert.deepEqual(await getCreditSnapshot(d1, input.ownerId), {
    credited: 5,
    available: 5,
    reserved: 0,
    spent: 0,
  });
  await assert.rejects(
    creditCredits(d1, { ...input, amount: 6 }),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.throws(
    () => database.prepare("UPDATE credit_ledger_entries SET amount=9").run(),
    /append-only/u,
  );
  assert.throws(
    () => database.prepare("DELETE FROM credit_ledger_entries").run(),
    /append-only/u,
  );
});

test("job creation reserves each output atomically and concurrent jobs cannot overspend", async () => {
  const { database, d1 } = setup();
  await creditCredits(d1, {
    ownerId: "owner-jobs",
    amount: 2,
    idempotencyKey: "credit:jobs:test",
    reasonCode: "TEST_CREDIT",
    actorId: "test-admin",
    requestId: "request-jobs-credit",
  });
  const first = job("job-ledger-first", "idem-ledger-first", "hash-ledger-first", 2);
  await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING);
  assert.deepEqual(await getCreditSnapshot(d1, first.ownerId), {
    credited: 2,
    available: 0,
    reserved: 2,
    spent: 0,
  });
  await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING);
  assert.equal(count(database, "credit_ledger_entries", "entry_type='RESERVE'"), 2);

  const empty = setup();
  await assert.rejects(
    createD1QueuedJobIdempotently(
      empty.d1,
      job("job-no-credit", "idem-no-credit", "hash-no-credit", 1, "owner-empty"),
      TEST_GENERATION_BILLING,
    ),
    hasCode("INSUFFICIENT_CREDITS"),
  );
  for (const table of ["generation_quota_admissions", "generation_jobs", "generation_job_items", "credit_ledger_entries"]) {
    assert.equal(count(empty.database, table), 0);
  }

  const race = setup();
  await creditCredits(race.d1, {
    ownerId: "owner-race-credit",
    amount: 1,
    idempotencyKey: "credit:race:test",
    reasonCode: "TEST_CREDIT",
    actorId: "test-admin",
    requestId: "request-race-credit",
  });
  const results = await Promise.allSettled([
    createD1QueuedJobIdempotently(race.d1, job("job-race-credit-a", "idem-race-credit-a", "hash-race-credit-a", 1, "owner-race-credit"), TEST_GENERATION_BILLING),
    createD1QueuedJobIdempotently(race.d1, job("job-race-credit-b", "idem-race-credit-b", "hash-race-credit-b", 1, "owner-race-credit"), TEST_GENERATION_BILLING),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected" && hasCode("INSUFFICIENT_CREDITS")(entry.reason)).length, 1);
  assert.equal(count(race.database, "generation_jobs"), 1);
  assert.equal(count(race.database, "credit_ledger_entries", "entry_type='RESERVE'"), 1);
});

test("committed output settles once, safe failure releases, and ambiguous work stays reserved", async () => {
  const success = setup();
  await seedReserved(success.database, "success");
  const successIds = seedAttempt(success.database, "success", "STORING");
  success.database.prepare(
    `INSERT INTO assets
      (id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,storage_key)
     VALUES ('asset-success','owner-success','output','READY','out.png','image/png',4,?,'generated/success.png')`,
  ).run("a".repeat(64));
  success.database.prepare(
    `INSERT INTO generation_output_commits
      (id,item_id,attempt_id,lease_generation,upload_request_id,asset_id,storage_key,
       prompt_template_version,mime_type,byte_size,sha256,state)
     VALUES ('commit-success',?,?,1,'upload-success','asset-success','generated/success.png',
             'test-v1','image/png',4,?,'OBJECT_STORED')`,
  ).run(successIds.itemId, successIds.attemptId, "a".repeat(64));
  success.database.prepare("UPDATE generation_job_items SET status='SUCCEEDED' WHERE id=?").run(successIds.itemId);
  success.database.prepare("UPDATE generation_output_commits SET state='COMMITTED' WHERE id='commit-success'").run();
  assert.deepEqual(await getCreditSnapshot(success.d1, "owner-success"), {
    credited: 1,
    available: 0,
    reserved: 0,
    spent: 1,
  });
  success.database.prepare("UPDATE generation_output_commits SET state='COMMITTED' WHERE id='commit-success'").run();
  assert.equal(count(success.database, "credit_ledger_entries", "entry_type='SETTLE'"), 1);

  const failed = setup();
  await seedReserved(failed.database, "failed");
  const failedIds = seedAttempt(failed.database, "failed", "FAILED");
  failed.database.prepare(
    `UPDATE generation_job_items
     SET status='FAILED', current_attempt_id=?, attempt_count=1, lease_generation=1,
         last_error_code='SAFE_TEST_FAILURE', last_error_message='safe failure',
         last_error_retryable=0, finished_at=unixepoch()
     WHERE id=?`,
  ).run(failedIds.attemptId, failedIds.itemId);
  assert.deepEqual(await getCreditSnapshot(failed.d1, "owner-failed"), {
    credited: 1,
    available: 1,
    reserved: 0,
    spent: 0,
  });
  assert.equal(count(failed.database, "generation_dead_letter_entries"), 1);
  assert.equal(count(failed.database, "credit_ledger_entries", "entry_type='RELEASE'"), 1);

  const ambiguous = setup();
  await seedReserved(ambiguous.database, "ambiguous");
  const ambiguousIds = seedAttempt(ambiguous.database, "ambiguous", "AMBIGUOUS");
  ambiguous.database.prepare(
    `UPDATE generation_job_items
     SET status='RECONCILIATION_REQUIRED', current_attempt_id=?, attempt_count=1,
         lease_generation=1, last_error_code='AMBIGUOUS_PROVIDER_OUTCOME'
     WHERE id=?`,
  ).run(ambiguousIds.attemptId, ambiguousIds.itemId);
  assert.deepEqual(await getCreditSnapshot(ambiguous.d1, "owner-ambiguous"), {
    credited: 1,
    available: 0,
    reserved: 1,
    spent: 0,
  });
});

test("legacy provider items without a reservation cannot be claimed", async () => {
  const { database, d1 } = setup();
  const record = job("job-unbilled", "idem-unbilled", "hash-unbilled", 1, "owner-unbilled");
  insertJob(database, record);
  database.prepare(
    `INSERT INTO generation_job_items
      (id,job_id,owner_id,ordinal,provider_preference,provider_key)
     VALUES ('item-unbilled',?, ?,0,?,'seedream')`,
  ).run(record.id, record.ownerId, record.providerPreference);
  assert.equal(await new D1GenerationQueue(d1).claimNextEligible({
    workerId: "worker-unbilled",
    claimRequestId: "claim-unbilled",
  }), null);
});

function setup(): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  database.exec("INSERT INTO users(id,display_name) VALUES ('owner-jobs','Jobs'),('owner-empty','Empty'),('owner-race-credit','Race')");
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}

async function seedReserved(database: DatabaseSync, suffix: string): Promise<void> {
  const { d1 } = { d1: new TestD1Database(database) as unknown as D1Database };
  await creditCredits(d1, {
    ownerId: `owner-${suffix}`,
    amount: 1,
    idempotencyKey: `credit:${suffix}:test`,
    reasonCode: "TEST_CREDIT",
    actorId: "test-admin",
    requestId: `request-credit-${suffix}`,
  });
  const record = job(`job-${suffix}`, `idem-${suffix}`, `hash-${suffix}`, 1, `owner-${suffix}`);
  insertJob(database, record);
  database.prepare(
    `INSERT INTO generation_job_items
      (id,job_id,owner_id,ordinal,provider_preference,provider_key)
     VALUES (?, ?, ?, 0, ?, 'seedream')`,
  ).run(`item-${suffix}`, record.id, record.ownerId, record.providerPreference);
  database.prepare(
    `INSERT INTO credit_ledger_entries
      (id,owner_id,entry_type,amount,reservation_id,job_id,item_id,idempotency_key,
       reason_code,price_version,actor_id,request_id)
     VALUES (?,?,'RESERVE',1,?,?,?,?, 'TEST_RESERVE','test-v1','test',?)`,
  ).run(
    `ledger-reserve-${suffix}`,
    record.ownerId,
    `billing-${suffix}`,
    record.id,
    `item-${suffix}`,
    `reserve:${suffix}:test`,
    `request-reserve-${suffix}`,
  );
}

function seedAttempt(database: DatabaseSync, suffix: string, state: string) {
  const itemId = `item-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  database.prepare(
    `INSERT INTO generation_attempts
      (id,item_id,attempt_no,lease_token,lease_generation,state,retry_class,error_code,error_message)
     VALUES (?,?,1,?,1,?,'not-retryable','SAFE_TEST_FAILURE','safe failure')`,
  ).run(attemptId, itemId, `lease-${suffix}`, state);
  database.prepare(
    `UPDATE generation_job_items
     SET current_attempt_id=?, attempt_count=1, lease_generation=1
     WHERE id=?`,
  ).run(attemptId, itemId);
  return { itemId, attemptId };
}

function insertJob(database: DatabaseSync, record: D1QueuedJobRecord): void {
  database.prepare(
    `INSERT INTO generation_jobs
      (id,owner_id,source_asset_id,style_preset_id,lighting_preset,preservation_mode,
       provider_preference,output_count,idempotency_key,request_hash,status)
     VALUES (?,?,NULL,'self-service','noon','structure',?,1,?,?,'QUEUED')`,
  ).run(record.id, record.ownerId, record.providerPreference, record.idempotencyKey, record.requestHash);
}

function job(
  id: string,
  idempotencyKey: string,
  requestHash: string,
  outputCount: number,
  ownerId = "owner-jobs",
): D1QueuedJobRecord {
  return {
    id,
    ownerId,
    sourceAssetId: null,
    referenceAssetId: null,
    additionalReferencesJson: "[]",
    maskAssetId: null,
    depthAssetId: null,
    normalAssetId: null,
    workflowType: "self-service",
    purpose: "preview",
    sourceJobId: null,
    promotedFromAssetId: null,
    resolution: "2K",
    effectiveResolution: "2K",
    aspectRatio: "4:3",
    quality: "draft",
    visualRealism: "conceptual",
    lampState: "off",
    colorTemperatureKelvin: 4000,
    stylePresetId: "self-service",
    lightingPreset: "noon",
    preservationMode: "structure",
    providerPreference: "doubao-seedream-4-5-251128",
    editInstruction: null,
    customPrompt: "test",
    outputCount,
    advancedSettingsJson: "{}",
    idempotencyKey,
    requestHash,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

function count(database: DatabaseSync, table: string, where = "1=1"): number {
  return Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`).get()?.value);
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}
