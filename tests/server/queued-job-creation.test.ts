import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertD1QueuedJobItems,
  createD1QueuedJobIdempotently,
  type D1QueuedJobRecord,
} from "../../lib/server/queued-job-creation";
import { getCreditSnapshot } from "../../lib/server/credit-ledger";
import { PRIVATE_TEST_OWNER } from "../../lib/server/private-test";
import { applyMigrations, creditTestOwner, TEST_GENERATION_BILLING, TestD1Database } from "../helpers/test-d1";

test("job and all requested queue items are created in one batch", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ outputCount: 4 });
  const result = await createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING);

  assert.deepEqual(result, {
    jobId: record.id,
    requestHash: record.requestHash,
    created: true,
  });
  assert.equal(count(database, "generation_jobs"), 1);
  assert.equal(count(database, "generation_job_items"), 4);
  assert.deepEqual(
    database
      .prepare(
        `SELECT ordinal, provider_preference, provider_key
         FROM generation_job_items ORDER BY ordinal`,
      )
      .all()
      .map((row) => ({ ...row })),
    [0, 1, 2, 3].map((ordinal) => ({
      ordinal,
      provider_preference: record.providerPreference,
      provider_key: "seedream",
    })),
  );
});

test("retired floorplan rejects new jobs and promotions without writes, but preserves historical replays", async () => {
  const { database, d1 } = setup();
  const tables = ["generation_jobs", "generation_job_items", "generation_quota_admissions", "credit_ledger_entries"];
  const snapshot = () => tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const floorplan = queuedJob({ workflowType: "floorplan", stylePresetId: "floorplan", customPrompt: null });
  const empty = snapshot();
  for (const record of [floorplan, { ...floorplan, sourceJobId: "historical-preview", promotedFromAssetId: "historical-output" }]) {
    await assert.rejects(createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING), (error: unknown) => hasCode("WORKFLOW_RETIRED")(error) && (error as { status: number }).status === 410);
    assert.deepEqual(snapshot(), empty);
  }

  // Seed a valid old queue row without using the retired creation path.
  await createD1QueuedJobIdempotently(d1, queuedJob(), TEST_GENERATION_BILLING);
  database.prepare("UPDATE generation_jobs SET workflow_type = 'floorplan', style_preset_id = 'floorplan', custom_prompt = NULL WHERE id = ?").run(floorplan.id);
  const historical = snapshot();
  assert.deepEqual(await createD1QueuedJobIdempotently(d1, floorplan, TEST_GENERATION_BILLING), { jobId: floorplan.id, requestHash: floorplan.requestHash, created: false });
  assert.deepEqual(await createD1QueuedJobIdempotently(d1, { ...floorplan, requestHash: "changed-request" }, TEST_GENERATION_BILLING), { jobId: floorplan.id, requestHash: floorplan.requestHash, created: false });
  await assert.rejects(createD1QueuedJobIdempotently(d1, { ...floorplan, ownerId: "another-owner" }, TEST_GENERATION_BILLING), hasCode("WORKFLOW_RETIRED"));
  await assert.rejects(createD1QueuedJobIdempotently(d1, { ...floorplan, idempotencyKey: "new-key" }, TEST_GENERATION_BILLING), hasCode("WORKFLOW_RETIRED"));
  assert.deepEqual(snapshot(), historical);
  database.close();
});

test("concept scheme ID is stored with its queued job", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ workflowType: "concept", stylePresetId: "modern-minimalist", designSchemeId: "modern-minimalist-02-v1", customPrompt: null });
  await createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING);
  assert.equal(database.prepare("SELECT design_scheme_id FROM generation_jobs WHERE id = ?").get(record.id)?.design_scheme_id, record.designSchemeId);
});

test("private-test jobs fund their own reservation atomically without giving regular users free credits", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ id: "job-private-credit", ownerId: PRIVATE_TEST_OWNER, idempotencyKey: "idem-private-credit", requestHash: "hash-private-credit" });
  const billing = { amountPerItem: 160, priceVersion: "test-v1" };
  const expectation = { expectedPriceVersion: billing.priceVersion, expectedTotalCredits: 160 };
  const policy = { privateTestAutoCredit: true, requirePriceExpectation: true, maxPendingOutputs: 1 };

  await assert.rejects(createD1QueuedJobIdempotently(d1, record, billing, policy), hasCode("PRICE_QUOTE_REQUIRED"));
  await assert.rejects(createD1QueuedJobIdempotently(d1, record, billing, policy, { ...expectation, expectedTotalCredits: 159 }), hasCode("PRICE_VERSION_CHANGED"));
  assert.equal((await getCreditSnapshot(d1, PRIVATE_TEST_OWNER)).credited, 0);

  assert.equal((await createD1QueuedJobIdempotently(d1, record, billing, policy, expectation)).created, true);
  assert.deepEqual(await getCreditSnapshot(d1, PRIVATE_TEST_OWNER), { credited: 160, available: 0, reserved: 160, spent: 0 });
  assert.equal((await createD1QueuedJobIdempotently(d1, record, billing, policy, expectation)).created, false);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM credit_ledger_entries WHERE owner_id = ? AND entry_type = 'CREDIT'").get(PRIVATE_TEST_OWNER)?.n), 1);

  const blocked = queuedJob({ ...record, id: "job-private-blocked", idempotencyKey: "idem-private-blocked", requestHash: "hash-private-blocked" });
  assert.equal((await createD1QueuedJobIdempotently(d1, blocked, billing, policy, expectation)).created, true);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM credit_ledger_entries WHERE owner_id = ? AND entry_type = 'CREDIT'").get(PRIVATE_TEST_OWNER)?.n), 2);
  await assert.rejects(createD1QueuedJobIdempotently(d1, queuedJob({ ownerId: "owner-not-private" }), billing, policy, expectation), hasCode("PRIVATE_TEST_ACCOUNT_CONFLICT"));
});

test("four-output private job reserves four items with one total credit and replays once", async () => {
  const { database, d1 } = setup();
  database.prepare("INSERT INTO user_generation_limits (owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled) VALUES (?, 20, 1, 1, 1)").run(PRIVATE_TEST_OWNER);
  const billing = { amountPerItem: 160, priceVersion: "test-v1" };
  const policy = { privateTestAutoCredit: true, privateTestDailyUnlimited: true, requirePriceExpectation: true, maxPendingOutputs: 1, maxAttempts: 1 };
  const expectation = { expectedPriceVersion: billing.priceVersion, expectedTotalCredits: 640 };
  const record = queuedJob({ id: "job-private-four", ownerId: PRIVATE_TEST_OWNER, outputCount: 4, idempotencyKey: "idem-private-four", requestHash: "hash-private-four" });
  assert.equal((await createD1QueuedJobIdempotently(d1, record, billing, policy, expectation)).created, true);
  assert.equal((await createD1QueuedJobIdempotently(d1, record, billing, policy, expectation)).created, false);
  assert.deepEqual(await getCreditSnapshot(d1, PRIVATE_TEST_OWNER), { credited: 640, available: 0, reserved: 640, spent: 0 });
  assert.deepEqual(database.prepare("SELECT amount FROM credit_ledger_entries WHERE owner_id=? AND entry_type='CREDIT'").all(PRIVATE_TEST_OWNER).map((row) => row.amount), [640]);
  assert.deepEqual(database.prepare("SELECT amount FROM credit_ledger_entries WHERE job_id=? AND entry_type='RESERVE'").all(record.id).map((row) => row.amount), [160, 160, 160, 160]);
  assert.equal(database.prepare("SELECT pending_limit_snapshot FROM generation_quota_admissions WHERE job_id=?").get(record.id)?.pending_limit_snapshot, 4);
  assert.deepEqual(database.prepare("SELECT ordinal, max_attempts FROM generation_job_items WHERE job_id=? ORDER BY ordinal").all(record.id).map((row) => ({ ...row })), [0, 1, 2, 3].map((ordinal) => ({ ordinal, max_attempts: 1 })));
  assert.deepEqual(await createD1QueuedJobIdempotently(d1, queuedJob({ ...record, id: "changed-count", outputCount: 2, requestHash: "different-count" }), billing, policy, { ...expectation, expectedTotalCredits: 320 }), { jobId: record.id, requestHash: record.requestHash, created: false });
  await assert.rejects(createD1QueuedJobIdempotently(d1, queuedJob({ ...record, id: "blocked-fifth", idempotencyKey: "blocked-fifth", requestHash: "blocked-fifth", outputCount: 1 }), billing, policy, { ...expectation, expectedTotalCredits: 160 }), hasCode("GENERATION_LIMIT_REACHED"));
  assert.equal(count(database, "generation_jobs"), 1);
});

test("two-output private job quotes and reserves both independent items", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ id: "private-two", ownerId: PRIVATE_TEST_OWNER, idempotencyKey: "private-two", requestHash: "private-two", outputCount: 2 });
  const billing = { amountPerItem: 160, priceVersion: "test-v1" };
  await createD1QueuedJobIdempotently(d1, record, billing, { privateTestAutoCredit: true, requirePriceExpectation: true }, { expectedPriceVersion: "test-v1", expectedTotalCredits: 320 });
  assert.deepEqual(await getCreditSnapshot(d1, PRIVATE_TEST_OWNER), { credited: 320, available: 0, reserved: 320, spent: 0 });
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM generation_job_items WHERE job_id=?").get(record.id)?.n, 2);
});

test("all owners bypass the daily limit; pending, quote and account gates remain", async () => {
  const { database, d1 } = setup();
  const dayStart = "2026-09-10T16:00:00.000Z";
  database.prepare("INSERT INTO user_generation_limits (owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled) VALUES (?, 20, 1, 1, 1)").run(PRIVATE_TEST_OWNER);
  const seed = database.prepare("INSERT INTO generation_quota_admissions (id, job_id, owner_id, idempotency_key, request_hash, day_start, units, daily_limit_snapshot, pending_limit_snapshot) VALUES (?, ?, ?, ?, ?, ?, 4, 20, 1)");
  for (let i = 0; i < 251; i++) seed.run(`old-${i}`, `old-job-${i}`, PRIVATE_TEST_OWNER, `old-key-${i}`, `old-hash-${i}`, dayStart);
  const policy = { dayStart, privateTestDailyUnlimited: true, privateTestAutoCredit: true, requirePriceExpectation: true, maxPendingOutputs: 1 };
  const expectation = { expectedPriceVersion: "test-v1", expectedTotalCredits: 1 };
  const job = (suffix: string) => queuedJob({ id: `private-${suffix}`, ownerId: PRIVATE_TEST_OWNER, idempotencyKey: `private-key-${suffix}`, requestHash: `private-hash-${suffix}` });
  const rows = () => ({ jobs: count(database, "generation_jobs"), items: count(database, "generation_job_items"), credit: Number(database.prepare("SELECT COUNT(*) AS n FROM credit_ledger_entries WHERE owner_id = ? AND entry_type = 'CREDIT'").get(PRIVATE_TEST_OWNER)?.n), admissions: Number(database.prepare("SELECT COUNT(*) AS n FROM generation_quota_admissions WHERE owner_id = ?").get(PRIVATE_TEST_OWNER)?.n) });

  await assert.rejects(createD1QueuedJobIdempotently(d1, job("bad-price"), TEST_GENERATION_BILLING, policy, { ...expectation, expectedTotalCredits: 2 }), hasCode("PRICE_VERSION_CHANGED"));
  await assert.rejects(createD1QueuedJobIdempotently(d1, queuedJob({ ownerId: "owner-atomic-create" }), TEST_GENERATION_BILLING, policy, expectation), hasCode("PRIVATE_TEST_ACCOUNT_CONFLICT"));
  await assert.rejects(createD1QueuedJobIdempotently(d1, queuedJob({ ownerId: PRIVATE_TEST_OWNER, outputCount: 5 }), TEST_GENERATION_BILLING, policy, { ...expectation, expectedTotalCredits: 5 }), hasCode("INVALID_OUTPUT_COUNT"));
  assert.deepEqual(rows(), { jobs: 0, items: 0, credit: 0, admissions: 251 });

  const first = job("first");
  assert.equal((await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING, policy, expectation)).created, true);
  assert.equal((await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING, policy, expectation)).created, false);
  for (const suffix of ["second", "third", "fourth"]) await createD1QueuedJobIdempotently(d1, job(suffix), TEST_GENERATION_BILLING, policy, expectation);
  await assert.rejects(createD1QueuedJobIdempotently(d1, job("pending"), TEST_GENERATION_BILLING, policy, expectation), hasCode("GENERATION_LIMIT_REACHED"));
  assert.deepEqual(rows(), { jobs: 4, items: 4, credit: 4, admissions: 255 });

  database.prepare("UPDATE generation_job_items SET status = 'SUCCEEDED'").run();
  database.prepare("UPDATE user_generation_limits SET enabled = 0 WHERE owner_id = ?").run(PRIVATE_TEST_OWNER);
  await assert.rejects(createD1QueuedJobIdempotently(d1, job("disabled"), TEST_GENERATION_BILLING, policy, expectation), hasCode("GENERATION_LIMIT_REACHED"));
  database.prepare("UPDATE user_generation_limits SET enabled = 1 WHERE owner_id = ?").run(PRIVATE_TEST_OWNER);
  assert.deepEqual(rows(), { jobs: 4, items: 4, credit: 4, admissions: 255 });
  assert.equal((await createD1QueuedJobIdempotently(d1, job("next"), TEST_GENERATION_BILLING, policy, expectation)).created, true);
  assert.deepEqual(rows(), { jobs: 5, items: 5, credit: 5, admissions: 256 });

  database.prepare("UPDATE generation_job_items SET status = 'SUCCEEDED'").run();
  for (const suffix of ["fill-one", "fill-two", "fill-three"]) await createD1QueuedJobIdempotently(d1, job(suffix), TEST_GENERATION_BILLING, policy, expectation);
  const concurrent = await Promise.allSettled(["left", "right"].map((suffix) => createD1QueuedJobIdempotently(d1, job(suffix), TEST_GENERATION_BILLING, policy, expectation)));
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected" && hasCode("GENERATION_LIMIT_REACHED")(result.reason)).length, 1);
  assert.deepEqual(rows(), { jobs: 9, items: 9, credit: 9, admissions: 260 });

  database.prepare("INSERT INTO generation_quota_admissions (id, job_id, owner_id, idempotency_key, request_hash, day_start, units, daily_limit_snapshot, pending_limit_snapshot) VALUES ('regular-old', 'regular-old-job', 'owner-atomic-create', 'regular-old-key', 'regular-old-hash', ?, 1, 1, 4)").run(dayStart);
  assert.equal((await createD1QueuedJobIdempotently(d1, queuedJob({ id: "regular-over-limit", idempotencyKey: "regular-over-limit", requestHash: "regular-over-limit" }), TEST_GENERATION_BILLING, { dayStart, dailyOutputLimit: 1, maxPendingOutputs: 4 })).created, true);
});

test("idempotent replay and concurrent duplicate do not create another job or items", async () => {
  const { database, d1 } = setup();
  const first = queuedJob({ id: "job-first", outputCount: 2 });
  const duplicate = queuedJob({ id: "job-duplicate", outputCount: 2 });

  const [left, right] = await Promise.all([
    createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING),
    createD1QueuedJobIdempotently(d1, duplicate, TEST_GENERATION_BILLING),
  ]);
  const created = [left, right].find((entry) => entry.created);
  const replay = [left, right].find((entry) => !entry.created);
  assert.ok(created);
  assert.ok(replay);
  assert.equal(replay.jobId, created.jobId);
  assert.equal(count(database, "generation_jobs"), 1);
  assert.equal(count(database, "generation_job_items"), 2);
});

test("concurrent calls with the exact same job id remain an idempotent replay", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ outputCount: 2 });

  const settled = await Promise.allSettled([
    createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING),
    createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING),
  ]);
  assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);
  const results = settled.map((entry) => {
    assert.equal(entry.status, "fulfilled");
    return entry.value;
  });
  assert.equal(results.filter((entry) => entry.created).length, 1);
  assert.equal(results.filter((entry) => !entry.created).length, 1);
  assert.equal(count(database, "generation_jobs"), 1);
  assert.equal(count(database, "generation_job_items"), 2);
});

test("idempotent replay keeps the originally reserved price after a price-table change", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ outputCount: 2 });
  await createD1QueuedJobIdempotently(d1, record, TEST_GENERATION_BILLING, { requirePriceExpectation: true }, { expectedPriceVersion: TEST_GENERATION_BILLING.priceVersion, expectedTotalCredits: TEST_GENERATION_BILLING.amountPerItem * 2 });
  const replay = await createD1QueuedJobIdempotently(d1, record, { amountPerItem: 999, priceVersion: "future-price-v2" }, { requirePriceExpectation: true });

  assert.equal(replay.created, false);
  assert.deepEqual(
    database.prepare("SELECT amount, price_version FROM credit_ledger_entries WHERE entry_type='RESERVE' ORDER BY item_id").all().map((row) => ({ ...row })),
    [0, 1].map(() => ({ amount: TEST_GENERATION_BILLING.amountPerItem, price_version: TEST_GENERATION_BILLING.priceVersion })),
  );
});

test("a new job cannot reserve a price different from the confirmed quote", async () => {
  const { database, d1 } = setup();
  await assert.rejects(
    createD1QueuedJobIdempotently(d1, queuedJob(), TEST_GENERATION_BILLING, { requirePriceExpectation: true }),
    hasCode("PRICE_QUOTE_REQUIRED"),
  );
  await assert.rejects(
    createD1QueuedJobIdempotently(d1, queuedJob(), TEST_GENERATION_BILLING, { requirePriceExpectation: true }, { expectedPriceVersion: "stale-price", expectedTotalCredits: 1 }),
    hasCode("PRICE_VERSION_CHANGED"),
  );
  assert.equal(count(database, "generation_jobs"), 0);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS value FROM credit_ledger_entries").get()?.value), 1);
});

test("same idempotency key with a different request does not write new rows", async () => {
  const { database, d1 } = setup();
  const first = queuedJob({ id: "job-original", outputCount: 1 });
  await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING);
  const conflict = await createD1QueuedJobIdempotently(
    d1,
    queuedJob({ id: "job-conflict", requestHash: "different-hash", outputCount: 4 }),
    TEST_GENERATION_BILLING,
  );

  assert.equal(conflict.created, false);
  assert.equal(conflict.jobId, first.id);
  assert.equal(conflict.requestHash, first.requestHash);
  assert.equal(count(database, "generation_jobs"), 1);
  assert.equal(count(database, "generation_job_items"), 1);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS value FROM generation_quota_admissions").get()?.value), 1);
});

test("daily counters are informational and an idempotent replay never consumes twice", async () => {
  const { database, d1 } = setup();
  const first = queuedJob({ id: "job-quota-first", idempotencyKey: "idem-quota-first", requestHash: "hash-quota-first", outputCount: 2 });
  await createD1QueuedJobIdempotently(d1, first, TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 2, maxPendingOutputs: 4 });
  const replay = await createD1QueuedJobIdempotently(d1, { ...first, id: "job-quota-replay" }, TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 2, maxPendingOutputs: 4 });
  assert.equal(replay.created, false);
  await createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-quota-second", idempotencyKey: "idem-quota-second", requestHash: "hash-quota-second" }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 2, maxPendingOutputs: 4 });
  assert.equal(count(database, "generation_jobs"), 2);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS value FROM generation_quota_admissions").get()?.value), 2);
});

test("pending quota is released by terminal items while daily admission remains consumed", async () => {
  const { database, d1 } = setup();
  await createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-pending-first", idempotencyKey: "idem-pending-first", requestHash: "hash-pending-first", outputCount: 2 }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 4, maxPendingOutputs: 2 });
  await assert.rejects(
    createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-pending-blocked", idempotencyKey: "idem-pending-blocked", requestHash: "hash-pending-blocked" }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 4, maxPendingOutputs: 2 }),
    hasCode("GENERATION_LIMIT_REACHED"),
  );
  database.prepare("UPDATE generation_job_items SET status='SUCCEEDED'").run();
  await createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-pending-next", idempotencyKey: "idem-pending-next", requestHash: "hash-pending-next", outputCount: 2 }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 4, maxPendingOutputs: 2 });
  assert.equal(count(database, "generation_jobs"), 2);
  assert.equal(Number(database.prepare("SELECT SUM(units) AS value FROM generation_quota_admissions").get()?.value), 4);
});

test("concurrent submissions cannot oversell one user's pending quota", async () => {
  const { database, d1 } = setup();
  const attempts = await Promise.allSettled([
    createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-race-left", idempotencyKey: "idem-race-left", requestHash: "hash-race-left", outputCount: 2 }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 2, maxPendingOutputs: 2 }),
    createD1QueuedJobIdempotently(d1, queuedJob({ id: "job-race-right", idempotencyKey: "idem-race-right", requestHash: "hash-race-right", outputCount: 2 }), TEST_GENERATION_BILLING, { dayStart: "2026-09-10T16:00:00.000Z", dailyOutputLimit: 2, maxPendingOutputs: 2 }),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected" && hasCode("GENERATION_LIMIT_REACHED")(entry.reason)).length, 1);
  assert.equal(count(database, "generation_jobs"), 1);
  assert.equal(Number(database.prepare("SELECT SUM(units) AS value FROM generation_quota_admissions").get()?.value), 2);
});

test("a failed item insert rolls back the job and every earlier item", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  database.exec("INSERT INTO users(id,display_name) VALUES ('owner-atomic-create','owner'),('TEST0001','private')");
  creditTestOwner(database, "owner-atomic-create");
  const d1 = new TestD1Database(database, (_statement, index) => {
    if (index === 2) throw new Error("simulated second item failure");
  }) as unknown as D1Database;

  await assert.rejects(
    createD1QueuedJobIdempotently(d1, queuedJob({ outputCount: 3 }), TEST_GENERATION_BILLING),
    /simulated second item failure/u,
  );
  assert.equal(count(database, "generation_jobs"), 0);
  assert.equal(count(database, "generation_job_items"), 0);
});

test("invalid provider and output count fail before any write", async () => {
  const { database, d1 } = setup();
  await assert.rejects(
    createD1QueuedJobIdempotently(d1, {
      ...queuedJob(),
      providerPreference: "openai",
    }, TEST_GENERATION_BILLING),
    hasCode("UNSUPPORTED_QUEUE_PROVIDER"),
  );
  await assert.rejects(
    createD1QueuedJobIdempotently(d1, queuedJob({ outputCount: 5 }), TEST_GENERATION_BILLING),
    hasCode("INVALID_OUTPUT_COUNT"),
  );
  assert.equal(count(database, "generation_jobs"), 0);
});

test("historical or corrupted item sets fail closed and are never repaired by replay", async () => {
  const { database, d1 } = setup();
  const record = queuedJob({ outputCount: 2 });
  insertBareJob(database, record);

  await assert.rejects(
    createD1QueuedJobIdempotently(d1, {
      ...record,
      id: "job-replay-must-not-repair",
    }, TEST_GENERATION_BILLING),
    hasCode("QUEUE_ITEMS_INCONSISTENT"),
  );
  assert.equal(count(database, "generation_job_items"), 0);

  database
    .prepare(
      `INSERT INTO generation_job_items
        (id, job_id, owner_id, ordinal, provider_preference, provider_key)
       VALUES (?, ?, ?, 0, ?, 'qwen')`,
    )
    .run("qitem_corrupt", record.id, record.ownerId, record.providerPreference);
  await assert.rejects(
    assertD1QueuedJobItems(d1, record),
    hasCode("QUEUE_ITEMS_INCONSISTENT"),
  );
});

function setup(): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  database.exec("INSERT INTO users(id,display_name) VALUES ('owner-atomic-create','owner'),('TEST0001','private')");
  creditTestOwner(database, "owner-atomic-create");
  return {
    database,
    d1: new TestD1Database(database) as unknown as D1Database,
  };
}

function queuedJob(
  overrides: Partial<D1QueuedJobRecord> = {},
): D1QueuedJobRecord {
  return {
    id: "job-atomic-create",
    ownerId: "owner-atomic-create",
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
    quality: "standard",
    visualRealism: "photorealistic",
    lampState: "mixed",
    colorTemperatureKelvin: 4000,
    stylePresetId: "self-service",
    lightingPreset: "noon",
    preservationMode: "structure",
    providerPreference: "doubao-seedream-5-0-pro-260628",
    editInstruction: null,
    customPrompt: "test prompt",
    outputCount: 1,
    advancedSettingsJson: "{}",
    idempotencyKey: "idem-atomic-create",
    requestHash: "hash-atomic-create",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function insertBareJob(
  database: DatabaseSync,
  record: D1QueuedJobRecord,
): void {
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
         preservation_mode, provider_preference, output_count,
         idempotency_key, request_hash, status)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')`,
    )
    .run(
      record.id,
      record.ownerId,
      record.stylePresetId,
      record.lightingPreset,
      record.preservationMode,
      record.providerPreference,
      record.outputCount,
      record.idempotencyKey,
      record.requestHash,
    );
}

function count(database: DatabaseSync, table: string): number {
  const allowed = new Set(["generation_jobs", "generation_job_items"]);
  if (!allowed.has(table)) throw new Error("invalid table");
  return Number(
    (database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
      value: number;
    }).value,
  );
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}


test("public admission checks active verified email atomically without changing rejected ledgers", async () => {
  const {database,d1}=setup(); const record=queuedJob();
  const tables=["generation_jobs","generation_job_items","generation_quota_admissions","credit_ledger_entries"];
  const snapshot=()=>tables.map(table=>database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before=snapshot();
  await assert.rejects(createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,{requireActiveVerifiedIdentity:true}));assert.deepEqual(snapshot(),before);
  database.prepare("INSERT INTO users(id,display_name) VALUES (?, 'email') ON CONFLICT(id) DO NOTHING").run(record.ownerId);
  database.prepare("INSERT INTO auth_email_credentials(email,user_id,password_hash,verified_at) VALUES ('verified@example.test',?,'test-only-hash',unixepoch())").run(record.ownerId);
  database.prepare("UPDATE users SET status='SUSPENDED' WHERE id=?").run(record.ownerId);
  await assert.rejects(createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,{requireActiveVerifiedIdentity:true}));assert.deepEqual(snapshot(),before);
  database.prepare("UPDATE users SET status='ACTIVE' WHERE id=?").run(record.ownerId);
  const accepted=await createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,{requireActiveVerifiedIdentity:true});assert.equal(accepted.created,true);
  const replay=await createD1QueuedJobIdempotently(d1,record,{amountPerItem:9999,priceVersion:'new-budget'},{requireActiveVerifiedIdentity:true},{expectedPriceVersion:'forged',expectedTotalCredits:1});assert.equal(replay.created,false);
});

test("public overseas new work is refused before writes, while accepted historical receipts preserve original reservation",async()=>{
 const {database,d1}=setup();
 const record=queuedJob({providerPreference:"gpt-image-2",resolution:"1K",effectiveResolution:"1K",quality:"low"});
 const tables=["generation_jobs","generation_job_items","generation_quota_admissions","credit_ledger_entries"];
 const snapshot=()=>tables.map(table=>database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());const before=snapshot();
 await assert.rejects(createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING),hasCode("OVERSEAS_MODEL_UNAVAILABLE"));assert.deepEqual(snapshot(),before);
 const accepted=queuedJob({ownerId:PRIVATE_TEST_OWNER,providerPreference:"gpt-image-2",resolution:"1K",effectiveResolution:"1K",quality:"low",id:"job_overseas_private",idempotencyKey:"overseas-private"});
 await createD1QueuedJobIdempotently(d1,accepted,TEST_GENERATION_BILLING,{allowPrivateTestOverseas:true,privateTestAutoCredit:true});
 const frozen=snapshot();const replay=await createD1QueuedJobIdempotently(d1,accepted,{amountPerItem:9999,priceVersion:"new"});assert.equal(replay.created,false);assert.deepEqual(snapshot(),frozen);
 await assert.rejects(createD1QueuedJobIdempotently(d1,{...record,id:"foreign",idempotencyKey:"other-private"},TEST_GENERATION_BILLING,{allowPrivateTestOverseas:true}),hasCode("OVERSEAS_MODEL_UNAVAILABLE"));
});

test("public admission atomically accepts only active verified email or the explicitly enabled website WeChat identity",async()=>{
 const {database,d1}=setup(),record=queuedJob();
 database.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_app_id,subject_hash) VALUES('wechat-current',?,'wechat','current-site','subject')").run(record.ownerId);
 const tables=["generation_jobs","generation_job_items","generation_quota_admissions","credit_ledger_entries"],snapshot=()=>tables.map(t=>database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());const before=snapshot();
 for(const policy of [{requireActiveVerifiedIdentity:true},{requireActiveVerifiedIdentity:true,wechatAppId:"wrong-site"}]){await assert.rejects(createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,policy));assert.deepEqual(snapshot(),before);}
 database.prepare("UPDATE users SET status='SUSPENDED' WHERE id=?").run(record.ownerId);await assert.rejects(createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,{requireActiveVerifiedIdentity:true,wechatAppId:"current-site"}));assert.deepEqual(snapshot(),before);
 database.prepare("UPDATE users SET status='ACTIVE' WHERE id=?").run(record.ownerId);assert.equal((await createD1QueuedJobIdempotently(d1,record,TEST_GENERATION_BILLING,{requireActiveVerifiedIdentity:true,wechatAppId:"current-site"})).created,true);assert.equal(database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='RESERVE'").get()!.n,1);assert.equal(database.prepare("SELECT COUNT(*) n FROM auth_email_credentials").get()!.n,0);database.close();
});
