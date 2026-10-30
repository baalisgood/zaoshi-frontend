import { createServer } from "vite";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { InternalQueueExecutionService } from "../../lib/server/internal-queue-execution";
import { TestR2Bucket } from "../helpers/test-r2";
import { DisabledModeration } from "../../lib/server/machine-moderation";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { imageModelCapabilities, imageModelValues, type ImageModel } from "../../lib/domain/image-models";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { InternalQueueService } from "../../lib/server/internal-queue-service";
import { creditCredits } from "../../lib/server/credit-ledger";
import { createD1QueuedJobIdempotently, type D1QueuedJobRecord } from "../../lib/server/queued-job-creation";
import {
  assertPrivateTestActive,
  assertPrivateTestJob,
  assertPrivateTestStoredJob,
  getPrivateTestActor,
  PRIVATE_TEST_MODELS,
  PRIVATE_TEST_OWNER,
  requirePrivateTestConfig,
  resolvePrivateTestConfig,
} from "../../lib/server/private-test";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

const now = 2_000_000_000;
const bindings = {
  ZAOSHI_PRIVATE_TEST_ENABLED: "1", AUTH_MODE: "private-test", ZAOSHI_RUNTIME: "node",
  BACKEND_PROFILE: "cn-production", TRUST_PLATFORM_IDENTITY_HEADERS: "0", GENERATION_INTERNAL_API_ENABLED: "1",
  ZAOSHI_SQLITE_PATH: "/var/lib/zaoshi/web-private-test/db/zaoshi.sqlite",
  ZAOSHI_OBJECT_ROOT: "/var/lib/zaoshi/web-private-test/objects",
  PRIVATE_TEST_EXPIRES_AT: String(now + 3600),
};

function setup(seedAccount = true) {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
  if(seedAccount)database.exec("INSERT INTO users(id,display_name) VALUES('TEST0001','private'),('other-owner','other')");
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}
function request(path: string, init?: RequestInit) { return new Request(`http://127.0.0.1:3000${path}`, { ...init, headers: { Origin: "http://127.0.0.1:3000", ...init?.headers } }); }
function job(id: string, ownerId: string, model: ImageModel = PRIVATE_TEST_MODELS[0]): D1QueuedJobRecord { return { id, ownerId, sourceAssetId: null, referenceAssetId: null, additionalReferencesJson: "[]", maskAssetId: null, depthAssetId: null, normalAssetId: null, workflowType: "self-service", purpose: "final", sourceJobId: null, promotedFromAssetId: null, resolution: imageModelCapabilities[model].supportedResolutions[0], effectiveResolution: imageModelCapabilities[model].supportedResolutions[0], aspectRatio: "1:1", quality: "draft", visualRealism: "photorealistic", lampState: "mixed", colorTemperatureKelvin: 4000, stylePresetId: "self-service", lightingPreset: "noon", preservationMode: "structure", providerPreference: model, editInstruction: null, customPrompt: "private test", outputCount: 1, advancedSettingsJson: "{}", idempotencyKey: `idem-${id}`, requestHash: `hash-${id}`, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" }; }

test("private-test loopback actor bootstraps exactly one bounded user and credit", async () => {
  const { database, d1 } = setup(false);
  const config = resolvePrivateTestConfig(bindings, now); assert.ok(config);
  assert.equal(resolvePrivateTestConfig({ ...bindings, TRUST_PLATFORM_IDENTITY_HEADERS: "1" }, now), null);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM users").get()!.count, 0);
  const actor = await getPrivateTestActor(request("/api/me"), config, d1);
  assert.equal(actor?.ownerId, PRIVATE_TEST_OWNER); assert.equal(actor?.trusted, true);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM users WHERE id=?").get(PRIVATE_TEST_OWNER)!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM credit_ledger_entries WHERE owner_id=? AND entry_type='CREDIT'").get(PRIVATE_TEST_OWNER)!.count, 1);
  assert.equal(database.prepare("SELECT amount FROM credit_ledger_entries WHERE owner_id=? AND entry_type='CREDIT'").get(PRIVATE_TEST_OWNER)!.amount, 1000);
});

test("private-test actor rejects non-loopback origin", async () => {
  const { d1 } = setup();
  const config = resolvePrivateTestConfig(bindings, now); assert.ok(config);
  await assert.rejects(getPrivateTestActor(new Request("http://localhost:3000/api/me"), config, d1), hasCode("NOT_FOUND"));
});

test("private-test policy keeps model capability resolutions and permits only 1–4 outputs", () => {
  const actor = { ownerId: PRIVATE_TEST_OWNER, setCookie: null, trusted: true, user: { authenticated: true, displayName: "test", role: "USER" as const } };
  assert.deepEqual(PRIVATE_TEST_MODELS, imageModelValues);
  for (const model of PRIVATE_TEST_MODELS) {
    for (const resolution of ["0.5K", "1K", "2K", "4K"]) {
      const input = { providerPreference: model, purpose: "final", effectiveResolution: resolution, outputCount: 1 };
      const stored = { owner_id: PRIVATE_TEST_OWNER, provider_preference: model, purpose: "final", effective_resolution: resolution, output_count: 1, mask_asset_id: null, depth_asset_id: null, normal_asset_id: null, source_job_id: null, promoted_from_asset_id: null };
      if ((imageModelCapabilities[model].supportedResolutions as readonly string[]).includes(resolution)) {
        assert.doesNotThrow(() => assertPrivateTestJob(actor, input));
        assert.doesNotThrow(() => assertPrivateTestStoredJob(stored));
      } else {
        assert.throws(() => assertPrivateTestJob(actor, input), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));
        assert.throws(() => assertPrivateTestStoredJob(stored), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));
      }
    }
  }
  const input = { providerPreference: "doubao-seedream-4-5-251128", purpose: "final", effectiveResolution: "4K", outputCount: 1 };
  const stored = { owner_id: PRIVATE_TEST_OWNER, provider_preference: input.providerPreference, purpose: "final", effective_resolution: "4K", output_count: 1, mask_asset_id: null, depth_asset_id: null, normal_asset_id: null, source_job_id: null, promoted_from_asset_id: null };
  assert.throws(() => assertPrivateTestJob(actor, { ...input, providerPreference: "unknown-model" }), hasCode("PRIVATE_TEST_MODEL_FORBIDDEN"));
  assert.throws(() => assertPrivateTestStoredJob({ ...stored, provider_preference: "unknown-model" }), hasCode("PRIVATE_TEST_MODEL_FORBIDDEN"));
  assert.throws(() => assertPrivateTestJob({ ...actor, ownerId: "other-owner" }, input), hasCode("CANARY_ACCESS_REQUIRED"));
  assert.throws(() => assertPrivateTestStoredJob({ ...stored, owner_id: "other-owner" }), hasCode("PRIVATE_TEST_OWNER_CONFLICT"));
  for (const outputCount of [1, 2, 4]) { assert.doesNotThrow(() => assertPrivateTestJob(actor, { ...input, outputCount })); assert.doesNotThrow(() => assertPrivateTestStoredJob({ ...stored, output_count: outputCount })); }
  for (const outputCount of [0, 5, 1.5]) { assert.throws(() => assertPrivateTestJob(actor, { ...input, outputCount }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN")); assert.throws(() => assertPrivateTestStoredJob({ ...stored, output_count: outputCount }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN")); }
  assert.throws(() => assertPrivateTestJob(actor, { ...input, purpose: "preview", outputCount: 2 }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));
  assert.throws(() => assertPrivateTestStoredJob({ ...stored, purpose: "preview", output_count: 2 }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));
  assert.throws(() => assertPrivateTestJob(actor, { ...input, maskAssetId: "mask" }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));

  assert.doesNotThrow(() => assertPrivateTestStoredJob({ ...stored, depth_asset_id: "asset_depth", normal_asset_id: "asset_normal" }));
  assert.throws(() => assertPrivateTestStoredJob({ ...stored, mask_asset_id: "asset_mask" }), hasCode("PRIVATE_TEST_SPEC_FORBIDDEN"));
  assert.throws(() => assertPrivateTestStoredJob({ ...stored, source_job_id: "preview" }), hasCode("PRIVATE_TEST_FINALIZE_FORBIDDEN"));
});

test("expired private-test runtime retains only fenced recovery, never new paid work", () => {
  assert.ok(requirePrivateTestConfig(bindings, now));
  const recovery = requirePrivateTestConfig(bindings, now + 3600);
  assert.ok(recovery);
  assert.throws(() => assertPrivateTestActive(recovery, now + 3600), hasCode("PRIVATE_TEST_EXPIRED"));
  assert.equal(resolvePrivateTestConfig(bindings, now + 3600), null);
  assert.throws(() => requirePrivateTestConfig({ ...bindings, ZAOSHI_PRIVATE_TEST_ENABLED: "0" }, now), hasCode("PRIVATE_TEST_EXPIRED"));
  assert.equal(requirePrivateTestConfig({ AUTH_MODE: "wechat" }, now), null);
});

test("expired private-test service rejects new claims while keeping recovery configuration", async () => {
  const { d1 } = setup();
  await creditCredits(d1, { ownerId: PRIVATE_TEST_OWNER, amount: 10, idempotencyKey: "credit-expiry", reasonCode: "TEST", actorId: "test", requestId: "expiry-test" });
  await createD1QueuedJobIdempotently(d1, job("job-expiry", PRIVATE_TEST_OWNER), { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1 });
  const queue = new D1GenerationQueue(d1);
  const existing = await queue.claimNextEligible({ workerId: "private-worker", claimRequestId: "before-expiry", privateTest: { ownerId: PRIVATE_TEST_OWNER, models: PRIVATE_TEST_MODELS } });
  assert.ok(existing);
  const config = { expiresAt: Math.floor(Date.now() / 1000) - 1 };
  const service = new InternalQueueService(queue, { leaseSeconds: 180, ownerConcurrency: 1, providerConcurrency: 1, sweepLimit: 10 }, undefined, { d1, config });
  await assert.rejects(service.claim("private-worker", "expired-claim"), hasCode("PRIVATE_TEST_EXPIRED"));
  assert.equal((await service.heartbeat(existing.fence)).result, "applied");
});

test("private-test isolates reconciliation while new jobs retain single pending and fixed owner", async () => {
  const { database, d1 } = setup();
  for (const owner of [PRIVATE_TEST_OWNER, "other-owner"]) await creditCredits(d1, { ownerId: owner, amount: 10, idempotencyKey: `credit-${owner}`, reasonCode: "TEST", actorId: "test", requestId: `request-${owner}` });
  await createD1QueuedJobIdempotently(d1, job("job-other", "other-owner"), { amountPerItem: 1, priceVersion: "test-v1" });
  await createD1QueuedJobIdempotently(d1, job("job-private", PRIVATE_TEST_OWNER), { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1 });
  assert.equal(database.prepare("SELECT max_attempts FROM generation_job_items WHERE job_id='job-private'").get()!.max_attempts, 1);
  const queue = new D1GenerationQueue(d1);
  const claim = await queue.claimNextEligible({ workerId: "private-worker", claimRequestId: "private-claim", privateTest: { ownerId: PRIVATE_TEST_OWNER, models: PRIVATE_TEST_MODELS } });
  assert.equal(claim?.item.ownerId, PRIVATE_TEST_OWNER);
  assert.equal(await queue.transition(claim!.fence, "LEASED", "PREPROCESSING"), true);
  assert.equal(await queue.transition(claim!.fence, "PREPROCESSING", "SUBMITTING"), true);
  assert.equal(await queue.transition(claim!.fence, "SUBMITTING", "RECONCILIATION_REQUIRED", { errorCode: "PROVIDER_TIMEOUT", errorMessage: "mock timeout" }), true);
  const oldAttempt = database.prepare("SELECT * FROM generation_attempts WHERE id=?").get(claim!.attemptId);
  assert.equal(oldAttempt!.state, "AMBIGUOUS");
  const before = database.prepare("SELECT * FROM generation_reconciliation_cases").all();
  assert.equal(before.length, 1);
  assert.equal(before[0].state, "OPEN");
  const policy = { maxAttempts: 1, maxPendingOutputs: 1 };
  const next = job("job-private-next", PRIVATE_TEST_OWNER);
  assert.equal((await createD1QueuedJobIdempotently(d1, next, { amountPerItem: 1, priceVersion: "test-v1" }, policy)).created, true);
  await assert.rejects(createD1QueuedJobIdempotently(d1, job("job-private-blocked", PRIVATE_TEST_OWNER), { amountPerItem: 1, priceVersion: "test-v1" }, policy), hasCode("GENERATION_LIMIT_REACHED"));
  assert.equal((await createD1QueuedJobIdempotently(d1, job("job-private", PRIVATE_TEST_OWNER), { amountPerItem: 1, priceVersion: "test-v1" }, policy)).created, false);
  const service = new InternalQueueService(queue, { leaseSeconds: 180, ownerConcurrency: 1, providerConcurrency: 1, sweepLimit: 10 }, undefined, { d1, config: { expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  const nextClaim = await service.claim("private-worker-2", "private-claim-2");
  assert.equal(nextClaim?.item.jobId, next.id);
  assert.ok(nextClaim);
  await service.transition({ fence: nextClaim.fence, event: "BEGIN_PREPROCESSING" });
  const execution = new InternalQueueExecutionService(d1, new TestR2Bucket(), { audience: "test", secret: "s".repeat(40), ttlSeconds: 240 }, queue, false, { expiresAt: Math.floor(Date.now() / 1000) + 3600 }, new DisabledModeration(d1));
  assert.equal((await execution.createWork(nextClaim.fence)).itemId, nextClaim.item.id);
  await service.transition({ fence: nextClaim.fence, event: "BEGIN_PROVIDER_DISPATCH", providerAccountSlot: "mock-seedream" });
  await service.transition({ fence: nextClaim.fence, event: "RECORD_PROVIDER_RESPONSE", providerRequestId: "mock-new-request" });
  const bytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
  const prepared = await execution.prepareOutput({ fence: nextClaim.fence, uploadRequestId: "mock-upload", providerRequestId: "mock-new-request", promptTemplateVersion: "test-v1", sanitizationVersion: "canonical-image-v1", mimeType: "image/png", byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.ok(prepared.ticket);
  assert.equal((await execution.uploadOutput(nextClaim.fence, prepared.ticket, bytes, "image/png")).result, "applied");
  assert.equal((await execution.uploadOutput(nextClaim.fence, prepared.ticket, bytes, "image/png")).result, "already_applied");
  assert.equal(database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE job_id=? AND entry_type='SETTLE'").get(next.id)!.n, 1);
  await service.sweep();
  assert.equal((await service.transition({ fence: claim!.fence, event: "BEGIN_PREPROCESSING" })).result, "conflict");
  assert.deepEqual(database.prepare("SELECT * FROM generation_attempts WHERE id=?").get(claim!.attemptId), oldAttempt);
  assert.equal(await service.claim("private-worker-3", "private-claim-3"), null);
  assert.deepEqual(database.prepare("SELECT * FROM generation_reconciliation_cases").all(), before);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE job_id='job-private' AND entry_type='RESERVE'").get()!.n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM generation_attempts WHERE item_id=?").get(claim!.item.id)!.n, 1);

});

test("private four-output job continues its queued items after one item requires reconciliation", async () => {
  const { database, d1 } = setup();
  await creditCredits(d1, { ownerId: PRIVATE_TEST_OWNER, amount: 4, idempotencyKey: "credit-four", reasonCode: "TEST", actorId: "test", requestId: "four" });
  const record = { ...job("job-four", PRIVATE_TEST_OWNER), outputCount: 4 };
  await createD1QueuedJobIdempotently(d1, record, { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1 });
  const queue = new D1GenerationQueue(d1);
  const options = (workerId: string) => ({ workerId, claimRequestId: workerId, privateTest: { ownerId: PRIVATE_TEST_OWNER, models: PRIVATE_TEST_MODELS } });
  const first = await queue.claimNextEligible(options("first"));
  assert.equal(first?.item.ordinal, 0);
  assert.equal(await queue.claimNextEligible(options("parallel")), null);
  assert.equal(await queue.transition(first!.fence, "LEASED", "PREPROCESSING"), true);
  assert.equal(await queue.transition(first!.fence, "PREPROCESSING", "SUBMITTING"), true);
  assert.equal(await queue.transition(first!.fence, "SUBMITTING", "RECONCILIATION_REQUIRED", { errorCode: "PROVIDER_TIMEOUT" }), true);
  const oldAttempt = database.prepare("SELECT * FROM generation_attempts WHERE item_id=?").get(first!.item.id);
  assert.equal(database.prepare("SELECT status FROM generation_jobs WHERE id=?").get(record.id)?.status, "VALIDATING");
  assert.equal(await queue.claimNextEligible({ workerId: "ordinary", claimRequestId: "ordinary" }), null);
  const second = await queue.claimNextEligible(options("second"));
  assert.equal(second?.item.ordinal, 1);
  assert.equal(await queue.claimNextEligible(options("parallel-two")), null);
  assert.equal(await queue.transition(second!.fence, "LEASED", "PREPROCESSING"), true);
  assert.equal(await queue.transition(second!.fence, "PREPROCESSING", "SUBMITTING"), true);
  assert.equal(await queue.transition(second!.fence, "SUBMITTING", "PERSISTING", { providerRequestId: "second-response" }), true);
  assert.equal(await queue.transition(second!.fence, "PERSISTING", "SUCCEEDED"), true);
  const third = await queue.claimNextEligible(options("third"));
  assert.equal(third?.item.ordinal, 2);
  assert.equal(await queue.scheduleSafeRetry(third!.fence, "LEASED", { errorCode: "INPUT_UNAVAILABLE", errorMessage: "input unavailable", errorRetryable: false }, 0), "failed");
  const fourth = await queue.claimNextEligible(options("fourth"));
  assert.equal(fourth?.item.ordinal, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM generation_attempts WHERE item_id=?").get(first!.item.id)?.n, 1);
  assert.deepEqual(database.prepare("SELECT * FROM generation_attempts WHERE item_id=?").get(first!.item.id), oldAttempt);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM generation_reconciliation_cases WHERE state='OPEN'").get()?.n, 1);
});

function hasCode(code: string) { return (error: unknown) => error instanceof Error && "code" in error && error.code === code; }

for (const model of PRIVATE_TEST_MODELS) {
  test(`private-test SQLite claim preserves selected ${model}`, async () => {
    const { database, d1 } = setup();
    await creditCredits(d1, { ownerId: PRIVATE_TEST_OWNER, amount: 10, idempotencyKey: "credit-six", reasonCode: "TEST", actorId: "test", requestId: "six-models" });
    await createD1QueuedJobIdempotently(d1, job("job-six", PRIVATE_TEST_OWNER, model), { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1, allowPrivateTestOverseas: true });
    const queue = new D1GenerationQueue(d1);
    assert.equal(await queue.claimNextEligible({ workerId: "worker", claimRequestId: "empty", privateTest: { ownerId: PRIVATE_TEST_OWNER, models: [] } }), null);
    assert.equal(await queue.claimNextEligible({ workerId: "worker", claimRequestId: "wrong-owner", privateTest: { ownerId: "other-owner", models: PRIVATE_TEST_MODELS } }), null);
    assert.equal(await queue.claimNextEligible({ workerId: "worker", claimRequestId: "unknown", privateTest: { ownerId: PRIVATE_TEST_OWNER, models: ["unknown-model"] } }), null);
    const claim = await queue.claimNextEligible({ workerId: "worker", claimRequestId: "six", privateTest: { ownerId: PRIVATE_TEST_OWNER, models: PRIVATE_TEST_MODELS } });
    assert.ok(claim);
    assert.equal(claim.item.providerPreference, model);
    assert.equal(claim.item.maxAttempts, 1);
    assert.equal(database.prepare("SELECT provider_preference FROM generation_jobs WHERE id='job-six'").get()!.provider_preference, model);
    database.close();
  });
}


test("owner Drizzle queries derive reconciliation from existing items and preserve ordinary quota", async () => {
  const { database, d1 } = setup();
  database.exec("INSERT INTO users(id,display_name) VALUES('owner-query','query'),('owner-regular-batch','regular')");
  const owner = "owner-query";
  database.prepare("INSERT INTO user_generation_limits(owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled) VALUES (?,2,1,1,1)").run(owner);
  await creditCredits(d1, { ownerId: owner, amount: 10, idempotencyKey: "credit-query", reasonCode: "TEST", actorId: "test", requestId: "query" });
  const policy = { maxAttempts: 1, maxPendingOutputs: 1, dailyOutputLimit: 2 };
  await createD1QueuedJobIdempotently(d1, { ...job("query-old", owner), advancedSettingsJson: JSON.stringify({ version: 1, geometryFidelity: "balanced", cameraPolicy: "locked", furnishingDensity: "balanced", materialExpression: "natural", lightingContrast: "balanced" }) }, { amountPerItem: 1, priceVersion: "test-v1" }, policy);
  const queue = new D1GenerationQueue(d1);
  const claim = await queue.claimNextEligible({ workerId: "query", claimRequestId: "query" });
  assert.ok(claim);
  await queue.transition(claim.fence, "LEASED", "PREPROCESSING");
  await queue.transition(claim.fence, "PREPROCESSING", "SUBMITTING");
  await queue.transition(claim.fence, "SUBMITTING", "RECONCILIATION_REQUIRED", { errorCode: "PROVIDER_TIMEOUT" });
  const batchOwner = "owner-regular-batch";
  database.prepare("INSERT INTO user_generation_limits(owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled) VALUES (?,20,2,1,1)").run(batchOwner);
  await creditCredits(d1, { ownerId: batchOwner, amount: 2, idempotencyKey: "credit-batch", reasonCode: "TEST", actorId: "test", requestId: "batch" });
  await createD1QueuedJobIdempotently(d1, { ...job("query-batch", batchOwner), outputCount: 2 }, { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1 });
  const batchClaim = await queue.claimNextEligible({ workerId: "batch", claimRequestId: "batch" });
  assert.equal(batchClaim?.item.jobId, "query-batch");
  await queue.transition(batchClaim!.fence, "LEASED", "PREPROCESSING");
  await queue.transition(batchClaim!.fence, "PREPROCESSING", "SUBMITTING");
  await queue.transition(batchClaim!.fence, "SUBMITTING", "RECONCILIATION_REQUIRED", { errorCode: "PROVIDER_TIMEOUT" });
  assert.equal(await queue.claimNextEligible({ workerId: "ordinary-after-recon", claimRequestId: "ordinary-after-recon" }), null);
  const bindingKey = Symbol.for("zaoshi.test.cloudflare.bindings");
  Reflect.set(globalThis, bindingKey, { DB: d1, ASSETS_BUCKET: new TestR2Bucket(), BACKEND_PROFILE: "cn-production" });
  const root = process.cwd();
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true, ws: false }, resolve: { alias: { "@": root, "cloudflare:workers": resolve(root, "tests/helpers/cloudflare-workers.ts") } } });
  try {
    const persistence = await server.ssrLoadModule("/lib/server/persistence.ts");
    const serializer = await server.ssrLoadModule("/lib/server/serializers.ts");
    const quota = await server.ssrLoadModule("/lib/server/generation-quota.ts");
    const old = await persistence.getJob("query-old", owner);
    assert.equal(old.status, "VALIDATING");
    assert.equal(old.reconciliationRequired, true);
    assert.equal(old.hasPendingOutputs, false);
    const ordinaryMixed = await persistence.getJob("query-batch", batchOwner);
    assert.equal(ordinaryMixed.reconciliationRequired, true);
    assert.equal(ordinaryMixed.hasPendingOutputs, true);
    assert.equal(serializer.serializeJob(old, []).reconciliationRequired, true);
    assert.equal(serializer.serializeJob(old, []).hasPendingOutputs, false);
    assert.equal((await persistence.listJobsWithOutputs(owner, { workflowType: "self-service", limit: 20 })).items[0].job.reconciliationRequired, true);
    assert.equal(await persistence.getJob("query-old", "other-owner"), null);
    assert.equal((await persistence.listJobsWithOutputs("other-owner", { workflowType: "self-service", limit: 20 })).items.length, 0);
    const before = await quota.getGenerationQuotaSnapshot(owner);
    assert.deepEqual([before.pending, before.usedToday, before.remainingToday], [0, 1, null]);
    database.prepare("INSERT INTO user_generation_limits(owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled) VALUES (?,20,1,1,1)").run(PRIVATE_TEST_OWNER);
    assert.equal((await quota.getGenerationQuotaSnapshot(PRIVATE_TEST_OWNER, true)).pendingLimit, 4);
    assert.equal((await quota.getGenerationQuotaSnapshot(owner)).pendingLimit, 1);
    await createD1QueuedJobIdempotently(d1, job("query-new", owner), { amountPerItem: 1, priceVersion: "test-v1" }, policy);
    database.prepare("UPDATE generation_jobs SET status='VALIDATING' WHERE id='query-new'").run();
    assert.equal((await persistence.getJob("query-new", owner)).hasPendingOutputs, true);
    assert.equal((await persistence.getJob("query-new", owner)).reconciliationRequired, false);
    const after = await quota.getGenerationQuotaSnapshot(owner);
    assert.deepEqual([after.pending, after.usedToday, after.remainingToday], [1, 2, null]);
    await assert.rejects(createD1QueuedJobIdempotently(d1, job("query-blocked", owner), { amountPerItem: 1, priceVersion: "test-v1" }, policy), hasCode("GENERATION_LIMIT_REACHED"));
  } finally {
    await server.close();
    database.close();
    Reflect.deleteProperty(globalThis, bindingKey);
  }
});

test("legacy or migrated suspended private account refuses bootstrap with every table unchanged",async()=>{
 for(const id of ['user_web_private_test',PRIVATE_TEST_OWNER]){
  const {database,d1}=setup(false);database.prepare("INSERT INTO users(id,display_name,status) VALUES(?,'retired','SUSPENDED')").run(id);database.prepare("INSERT INTO user_generation_limits(owner_id,enabled) VALUES(?,0)").run(id);
  const tables=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));const snapshot=()=>tables.map(table=>JSON.stringify(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));const before=snapshot();
  await assert.rejects(getPrivateTestActor(request('/api/me'),{expiresAt:now+3600},d1),hasCode('PRIVATE_TEST_ACCOUNT_CONFLICT'));assert.deepEqual(snapshot(),before);database.close();
 }
});
test("private bootstrap atomic credit guard rejects suspension between precheck and batch",async()=>{
 const {database}=setup(false);database.exec("INSERT INTO users(id,display_name) VALUES('TEST0001','private');INSERT INTO user_generation_limits(owner_id,daily_output_limit,max_pending_outputs,active_concurrency_limit,enabled) VALUES('TEST0001',20,1,1,1)");
 const beforeCredit=database.prepare('SELECT COUNT(*) n FROM credit_ledger_entries').get()?.n;let changed=false;
 const d1=new TestD1Database(database,()=>{if(!changed){changed=true;database.exec("UPDATE users SET status='SUSPENDED' WHERE id='TEST0001'");}}) as unknown as D1Database;
 await assert.rejects(getPrivateTestActor(request('/api/me'),{expiresAt:now+3600},d1),hasCode('PRIVATE_TEST_ACCOUNT_CONFLICT'));assert.equal(changed,true);assert.equal(database.prepare('SELECT COUNT(*) n FROM credit_ledger_entries').get()?.n,beforeCredit);assert.equal(database.prepare('SELECT COUNT(*) n FROM user_generation_limits').get()?.n,1);database.close();
});
