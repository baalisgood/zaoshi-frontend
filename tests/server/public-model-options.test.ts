import { parseGenerationWorkSpec } from "../../lib/domain/generation-work";
import { DisabledModeration } from "../../lib/server/machine-moderation";
import { InternalQueueExecutionService } from "../../lib/server/internal-queue-execution";
import { InternalQueueService } from "../../lib/server/internal-queue-service";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { BARE_SHELL_INSTRUCTION } from "../../lib/domain/bare-shell";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { publicModelOptions, resolvePublicModelOption } from "../../lib/domain/public-model-options";
import { quoteGenerationPrice, PUBLIC_MODEL_PRICE_VERSION } from "../../lib/server/generation-pricing";
import { secretHash } from "../../lib/server/auth-session";
import { LEGAL_VERSION } from "../../lib/domain/legal";
import { parseCreateJobInput, isCompatibleReplayHash } from "../../lib/server/job-contract";
import { createD1QueuedJobIdempotently } from "../../lib/server/queued-job-creation";
import { applyMigrations, creditTestOwner, TestD1Database, TEST_GENERATION_BILLING } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

async function fixture() {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
  const d1 = new TestD1Database(database) as unknown as D1Database, bucket = new TestR2Bucket(), now = Math.floor(Date.now() / 1000);
  database.exec("INSERT INTO users(id,display_name) VALUES('synthetic-route-owner','Synthetic')");
  database.prepare("INSERT INTO auth_email_credentials(email,user_id,password_hash,verified_at) VALUES('synthetic@example.com','synthetic-route-owner','not-a-login-password',?)").run(now);
  database.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,last_seen_at) VALUES(?,'synthetic-route-owner',?,?)").run(secretHash("s".repeat(32), "synthetic-session"), now + 3600, now);
  for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES('synthetic-route-owner',?,?,?)").run(document, LEGAL_VERSION, now);
  creditTestOwner(database, "synthetic-route-owner", 100000);
  const key = Symbol.for("zaoshi.test.cloudflare.bindings"), scope = globalThis as typeof globalThis & { [key]?: Record<string, unknown> }, bindings = scope[key] ??= {};
  Object.assign(bindings, { DB: d1, ASSETS_BUCKET: bucket, AUTH_MODE: "email", SESSION_SECRET: "s".repeat(32), AUTH_IDENTITY_PEPPER: "p".repeat(32), BACKEND_PROFILE: "cn-production", PUBLIC_IMAGE_GENERATION_ENABLED: "1", GENERATION_INTERNAL_API_ENABLED: "1", OVERSEAS_RELAY_ENABLED: "1", DASHSCOPE_API_KEY: "synthetic-only", DASHSCOPE_WORKSPACE_ID: "synthetic", TENCENT_MODERATION_ENABLED: "0", WECHAT_PAY_ENABLED: "0" });
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  const oldFlag = process.env.PUBLIC_IMAGE_GENERATION_ENABLED, oldFetch = globalThis.fetch; process.env.PUBLIC_IMAGE_GENERATION_ENABLED = "1";
  globalThis.fetch = async () => { throw Error("No provider/payment/SMTP call is allowed in this fixture"); };
  const request = (path: string, body?: unknown, authenticated = true) => new Request(`https://example.test${path}`, { method: body ? "POST" : "GET", headers: { origin: "https://example.test", "content-type": "application/json", ...(authenticated ? { cookie: "__Host-zaoshi_session=synthetic-session" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const modules = {
    prices: await server.ssrLoadModule("/app/api/prices/route.ts") as typeof import("../../app/api/prices/route"),
    jobs: await server.ssrLoadModule("/app/api/jobs/route.ts") as typeof import("../../app/api/jobs/route"),
    quote: await server.ssrLoadModule("/app/api/jobs/quote/route.ts") as typeof import("../../app/api/jobs/quote/route"),
    finalizeQuote: await server.ssrLoadModule("/app/api/jobs/[id]/quote/route.ts") as typeof import("../../app/api/jobs/[id]/quote/route"),
    finalize: await server.ssrLoadModule("/app/api/jobs/[id]/finalize/route.ts") as typeof import("../../app/api/jobs/[id]/finalize/route"),
    templates: await server.ssrLoadModule("/lib/server/templates.ts") as typeof import("../../lib/server/templates"),
    me: await server.ssrLoadModule("/app/api/me/route.ts") as typeof import("../../app/api/me/route"),
  };
  const me = await (await modules.me.GET(request("/api/me"))).json() as { draftScope: string };
  const snapshot = () => ["generation_jobs", "generation_job_items", "generation_quota_admissions", "credit_ledger_entries"].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { database, d1, bucket, request, modules, snapshot, draftScope: me.draftScope, async close() { globalThis.fetch = oldFetch; if (oldFlag === undefined) delete process.env.PUBLIC_IMAGE_GENERATION_ENABLED; else process.env.PUBLIC_IMAGE_GENERATION_ENABLED = oldFlag; await server.close(); for (const field of Object.keys(bindings)) delete bindings[field]; database.close(); } };
}

const ratios = ["1:1", "4:3", "3:2", "16:9", "9:16"];
test("six options resolve ten branches; actual tuple pricing matches the existing calculator for every ratio/input/output and preview keeps the tuple", () => {
  assert.equal(publicModelOptions.length, 6);
  const legacy = parseCreateJobInput({ workflowType:"self-service",purpose:"final",providerPreference:"qwen-image-3.0",resolution:"2K",quality:"standard",aspectRatio:"4:3",outputCount:1,customPrompt:"synthetic room",idempotencyKey:"legacy-fixed-key" });
  assert.equal(legacy.requestHash,"d3ed38e8a3319e9ce5cd9fecc5119959306607a11a86eee4d5dc50f10050f446");
  const selected = parseCreateJobInput({ workflowType:"self-service",purpose:"final",optionId:"sunburst-medium-2k",providerPreference:"gpt-image-2.5-sunburst",resolution:"2K",quality:"medium",customPrompt:"synthetic room",outputCount:1,idempotencyKey:"new-fixed-key" });
  assert.equal(isCompatibleReplayHash(selected, selected.preSpaceTypeRequestHash),false);
  let branches = 0;
  for (const option of publicModelOptions) for (const resolution of option.resolutions) {
    branches++;
    const tuple = resolvePublicModelOption(option.id, resolution)!;
    for (const aspectRatio of ratios) for (let inputImageCount = 0; inputImageCount <= (tuple.model.startsWith("gemini") ? 14 : 10); inputImageCount++) for (let outputCount = 1; outputCount <= 4; outputCount++) {
      const input = { optionId: option.id, modelId: tuple.model, quality: tuple.quality, requestedResolution: resolution, purpose: "final", aspectRatio, inputImageCount, outputCount };
      const quote = quoteGenerationPrice(input, { production: true });
      const old = quoteGenerationPrice({ ...input, optionId: undefined }, { production: true });
      assert.equal(quote.priceVersion, PUBLIC_MODEL_PRICE_VERSION);
      assert.equal(quote.amountPerItem, old.amountPerItem); assert.equal(quote.totalCredits, old.totalCredits);
      const preview = quoteGenerationPrice({ ...input, purpose: "preview" }, { production: true });
      assert.equal(preview.effectiveResolution, resolution); assert.equal(preview.quality, tuple.quality); assert.equal(preview.outputCount, 1); assert.equal(preview.totalCredits, quote.amountPerItem);
    }
  }
  assert.equal(branches, 10);
  assert.equal(resolvePublicModelOption("gemini-lite-flash-a", "1K")?.model, "gemini-3.1-flash-lite-image");
  assert.equal(resolvePublicModelOption("gemini-lite-flash-a", "2K")?.model, "gemini-3.1-flash-image");
  for (const quality of ["low", "high", "draft", "standard"]) assert.throws(() => quoteGenerationPrice({ optionId: "sunburst-medium-2k", modelId: "gpt-image-2.5-sunburst", quality, requestedResolution: "2K", purpose: "preview", inputImageCount: 0, outputCount: 1 }, { production: true }));
});

test("real public quote/create routes freeze actual work and equal Flare tuples bill equally; forged calls do not write", async () => {
  const f = await fixture();
  try {
    let flarePrice: number | undefined;
    for (const id of ["flare-low-2k", "flare-low-flex", "sunburst-medium-2k"]) {
      const tuple = resolvePublicModelOption(id, "2K")!;
      const input = { optionId: id, modelId: tuple.model, resolution: "2K", quality: tuple.quality, purpose: id.startsWith("sunburst") ? "preview" : "final", inputImageCount: 0, outputCount: 1, aspectRatio: "4:3" };
      const response = await f.modules.quote.POST(f.request("/api/jobs/quote", { ...input, privateTest: true, billingMode: "private-test-reservation" })); assert.equal(response.status, 200); const { quote } = await response.json() as { quote: { priceVersion: string; totalCredits: number; privateTestOnly?: boolean; billingMode?: string } };
      assert.ok(quote.totalCredits > 1); assert.equal(quote.privateTestOnly, undefined); assert.equal(quote.billingMode, undefined);
      if (id.startsWith("flare")) { if (flarePrice !== undefined) assert.equal(quote.totalCredits, flarePrice); flarePrice = quote.totalCredits; }
      const body = { ...input, privateTest: true, billingMode: "private-test-reservation", workflowType: "self-service", providerPreference: tuple.model, customPrompt: "synthetic room", idempotencyKey: `new-option-${id}`, draftScope: f.draftScope, expectedPriceVersion: quote.priceVersion, expectedTotalCredits: quote.totalCredits };
      const beforeSpoof = f.snapshot();
      const spoof = await f.modules.jobs.POST(f.request("/api/jobs", { ...body, expectedPriceVersion: "private-test-overseas-reservation-v1-20260930", expectedTotalCredits: 1 }));
      assert.equal(spoof.status, 409); assert.deepEqual(f.snapshot(), beforeSpoof);
      const created = await f.modules.jobs.POST(f.request("/api/jobs", body)); const data = await created.json() as { job?: { id: string }; error?: unknown }; assert.equal(created.status, 202, JSON.stringify(data));
      const stored = f.database.prepare("SELECT provider_preference,effective_resolution,quality FROM generation_jobs WHERE id=?").get(data.job!.id)!;
      assert.equal(stored.provider_preference, tuple.model); assert.equal(stored.effective_resolution, "2K"); assert.equal(stored.quality, tuple.quality);
      const ledger = f.database.prepare("SELECT amount,price_version FROM credit_ledger_entries WHERE job_id=? AND entry_type='RESERVE'").get(data.job!.id)!; assert.equal(ledger.price_version, PUBLIC_MODEL_PRICE_VERSION); assert.equal(Math.abs(Number(ledger.amount)), quote.totalCredits);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='CREDIT'").get()?.n, 1);
      const before = JSON.stringify(f.snapshot()); const replay = await f.modules.jobs.POST(f.request("/api/jobs", body)); assert.equal(replay.status, 202); assert.equal(JSON.stringify(f.snapshot()), before);
    }
    const before = JSON.stringify(f.snapshot());
    for (const patch of [{ optionId: "bad" }, { quality: "high" }, { providerPreference: "gpt-image-2", modelId: "gpt-image-2" }, { resolution: "4K" }]) {
      const body = { optionId: "sunburst-medium-2k", providerPreference: "gpt-image-2.5-sunburst", modelId: "gpt-image-2.5-sunburst", quality: "medium", resolution: "2K", purpose: "final", outputCount: 1, inputImageCount: 0, aspectRatio: "4:3", workflowType: "self-service", customPrompt: "synthetic", idempotencyKey: `spoof-${JSON.stringify(patch)}`, draftScope: f.draftScope, ...patch };
      assert.equal((await f.modules.quote.POST(f.request("/api/jobs/quote", body))).status, 400);
      assert.equal((await f.modules.jobs.POST(f.request("/api/jobs", body))).status, 400);
    }
    assert.equal(JSON.stringify(f.snapshot()), before);
  } finally { await f.close(); }
});

test("server templates round-trip option identity across resolution and strip only existing private share fields", async () => {
  const f = await fixture(); try {
    for (const option of publicModelOptions) for (const resolution of option.resolutions) {
      const tuple = resolvePublicModelOption(option.id, resolution)!;
      const parsed = f.modules.templates.parseTemplateInput({ workflowType: "self-service", name: `${option.id}-${resolution}`, config: { templateVersion: 1, optionId: option.id, providerPreference: tuple.model, resolution, quality: tuple.quality, customPrompt: "synthetic private brief" } });
      const saved = await f.modules.templates.saveTemplate("synthetic-route-owner", parsed), share = await f.modules.templates.createShare(saved.id, "synthetic-route-owner");
      const shared = await f.modules.templates.getSharedTemplate(share.token); assert.equal(shared?.config.optionId, option.id); assert.equal(shared?.config.providerPreference, tuple.model); assert.equal(shared?.config.customPrompt, undefined);
    }
  } finally { await f.close(); }
});

test("a no-tier accepted historical request replays before the new public-product requirement; its fresh equivalent is refused", async () => {
  const f = await fixture();
  try {
    const body = { workflowType: "self-service", purpose: "final", providerPreference: "qwen-image-3.0", resolution: "2K", quality: "standard", customPrompt: "synthetic room", outputCount: 1, idempotencyKey: "historical-key-no-tier", draftScope: f.draftScope };
    const parsed = parseCreateJobInput(body); await createD1QueuedJobIdempotently(f.d1, { ...parsed, id: "historical-job", ownerId: "synthetic-route-owner", additionalReferencesJson: "[]", advancedSettingsJson: JSON.stringify(parsed.advancedSettings), sourceJobId: null, promotedFromAssetId: null, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" }, TEST_GENERATION_BILLING);
    const before = f.snapshot(); const response = await f.modules.jobs.POST(f.request("/api/jobs", body)); assert.equal(response.status, 202); assert.equal((await response.json() as { idempotentReplay: boolean }).idempotentReplay, true); assert.deepEqual(f.snapshot(), before);
    const fresh = await f.modules.jobs.POST(f.request("/api/jobs", { ...body, idempotencyKey: "fresh-retired-no-tier" })); assert.equal(fresh.status, 400); assert.equal((await fresh.json() as { error: { code: string } }).error.code, "INVALID_PUBLIC_MODEL_OPTION"); assert.deepEqual(f.snapshot(), before);
  } finally { await f.close(); }
});

test("legacy no-tier finalize hash replays without new output work or ledger writes", async () => {
  const f = await fixture();
  try {
    f.database.exec("INSERT INTO generation_jobs(id,owner_id,workflow_type,purpose,style_preset_id,lighting_preset,preservation_mode,provider_preference,output_count,idempotency_key,request_hash,status) VALUES('historical-preview','synthetic-route-owner','self-service','preview','self-service','noon','structure','qwen-image-3.0',1,'historical-preview-key','historical-preview-hash','SUCCEEDED')");
    f.database.exec("INSERT INTO assets(id,owner_id,kind,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key) VALUES('historical-output','synthetic-route-owner','output','synthetic.png','image/png',1,'synthetic-sha','canonical-image-v1','historical-output')");
    const legacy = { previewId: "historical-preview", selectedOutputAssetId: "historical-output", resolution: "2K", quality: "standard", outputCount: 1 };
    const input = parseCreateJobInput({ workflowType: "self-service", purpose: "final", providerPreference: "qwen-image-3.0", sourceAssetId: "historical-output", resolution: "2K", quality: "standard", customPrompt: "synthetic room", outputCount: 1, idempotencyKey: "legacy-finalize-replay" });
    await createD1QueuedJobIdempotently(f.d1, { ...input, id: "historical-final", ownerId: "synthetic-route-owner", sourceJobId: "historical-preview", promotedFromAssetId: "historical-output", requestHash: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), additionalReferencesJson: "[]", advancedSettingsJson: JSON.stringify(input.advancedSettings), createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" }, TEST_GENERATION_BILLING);
    const before = f.snapshot();
    const response = await f.modules.finalize.POST(f.request("/api/jobs/historical-preview/finalize", { selectedOutputAssetId: legacy.selectedOutputAssetId, resolution: legacy.resolution, quality: legacy.quality, outputCount: legacy.outputCount, idempotencyKey: input.idempotencyKey }), { params: Promise.resolve({ id: legacy.previewId }) });
    assert.equal(response.status, 202); assert.equal((await response.json() as { idempotentReplay: boolean }).idempotentReplay, true); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM generation_attempts").get()?.n, 0);
  } finally { await f.close(); }
});

test("actual finalize quote/create require explicit option for a legacy preview and preserve it in immutable billing and replay", async () => {
  const f = await fixture();
  try {
    const bytes = new Uint8Array(readFileSync("public/icon-192.png"));
    f.database.exec("INSERT INTO generation_jobs(id,owner_id,workflow_type,purpose,style_preset_id,lighting_preset,preservation_mode,provider_preference,output_count,idempotency_key,request_hash,status,resolution,effective_resolution,quality) VALUES('legacy-preview','synthetic-route-owner','self-service','preview','self-service','noon','structure','openai',1,'legacy-preview-key','old-hash','SUCCEEDED','2K','1K','draft')");
    f.database.prepare("INSERT INTO assets(id,owner_id,kind,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key) VALUES('legacy-output','synthetic-route-owner','output','synthetic.png','image/png',? ,?,'canonical-image-v1','synthetic-output')").run(bytes.byteLength, createHash("sha256").update(bytes).digest("hex"));
    f.database.exec("INSERT INTO generation_job_outputs(job_id,asset_id,ordinal) VALUES('legacy-preview','legacy-output',0)"); await f.bucket.put("synthetic-output", bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: { assetId: "legacy-output", sha256: createHash("sha256").update(bytes).digest("hex"), kind: "output", sanitizationVersion: "canonical-image-v1" } });
    const params = { params: Promise.resolve({ id: "legacy-preview" }) }, body = { selectedOutputAssetId: "legacy-output", resolution: "2K", quality: "low", outputCount: 1, idempotencyKey: "explicit-finalize-key" };
    const before = f.snapshot(); assert.equal((await f.modules.finalizeQuote.POST(f.request("/api/jobs/legacy-preview/quote", body), params)).status, 400); assert.equal((await f.modules.finalize.POST(f.request("/api/jobs/legacy-preview/finalize", body), params)).status, 400); assert.deepEqual(f.snapshot(), before);
    const selected = { ...body, optionId: "flare-low-2k", providerPreference: "gpt-image-2.5-flare" };
    const quoteResponse = await f.modules.finalizeQuote.POST(f.request("/api/jobs/legacy-preview/quote", selected), params); assert.equal(quoteResponse.status, 200); const { quote } = await quoteResponse.json() as { quote: { priceVersion: string; totalCredits: number } };
    const createBody = { ...selected, expectedPriceVersion: quote.priceVersion, expectedTotalCredits: quote.totalCredits };
    const created = await f.modules.finalize.POST(f.request("/api/jobs/legacy-preview/finalize", createBody), params); const result = await created.json() as { job: {  providerPreference: string } }; assert.equal(created.status, 202, JSON.stringify(result)); assert.equal(result.job.providerPreference, selected.providerPreference);
    const accepted = f.snapshot(); assert.equal((await f.modules.finalize.POST(f.request("/api/jobs/legacy-preview/finalize", createBody), params)).status, 202); assert.deepEqual(f.snapshot(), accepted);
    assert.equal((await f.modules.finalize.POST(f.request("/api/jobs/legacy-preview/finalize", { ...createBody, optionId: "sunburst-medium-2k", providerPreference: "gpt-image-2.5-sunburst", quality: "medium" }), params)).status, 409); assert.deepEqual(f.snapshot(), accepted);
  } finally { await f.close(); }
});

test("every selected tuple creates unchanged v1 durable work with exact model, quality, resolution and provider key", async () => {
  for (const option of publicModelOptions) for (const resolution of option.resolutions) for (const purpose of ["preview", "final"] as const) {
    const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); applyMigrations(db); db.exec("INSERT INTO users(id,display_name) VALUES('synthetic-work-owner','Synthetic')"); creditTestOwner(db, "synthetic-work-owner", 100000);
    const d1 = new TestD1Database(db) as unknown as D1Database;
    try {
      const tuple = resolvePublicModelOption(option.id, resolution)!;
      const input = parseCreateJobInput({ workflowType: "self-service", optionId: option.id, providerPreference: tuple.model, resolution, quality: tuple.quality, purpose, customPrompt: "synthetic room", outputCount: 1, idempotencyKey: `work-${option.id}-${resolution}-${purpose}` });
      const quote = quoteGenerationPrice({ optionId: option.id, modelId: tuple.model, requestedResolution: resolution, quality: tuple.quality, purpose, inputImageCount: 0, outputCount: 1 }, { production: true });
      await createD1QueuedJobIdempotently(d1, { ...input, id: `job-${option.id}-${resolution}-${purpose}`, ownerId: "synthetic-work-owner", additionalReferencesJson: "[]", advancedSettingsJson: JSON.stringify(input.advancedSettings), sourceJobId: null, promotedFromAssetId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { priceVersion: quote.priceVersion, amountPerItem: quote.amountPerItem });
      const queue = new D1GenerationQueue(d1), service = new InternalQueueService(queue, { leaseSeconds: 180, ownerConcurrency: 1, providerConcurrency: 1, sweepLimit: 50 });
      const execution = new InternalQueueExecutionService(d1, new TestR2Bucket(), { audience: "synthetic", secret: "synthetic-ticket-secret-longer-than-thirty-two-characters", ttlSeconds: 240 }, queue, false, null, new DisabledModeration(d1));
      const claim = await service.claim("synthetic-worker", `claim-${option.id}-${resolution}-${purpose}`); assert.ok(claim); await service.transition({ fence: claim.fence, event: "BEGIN_PREPROCESSING" });
      const work = await execution.createWork(claim.fence); assert.equal(work.version, 1); assert.equal(work.providerPreference, tuple.model); assert.equal(work.quality, tuple.quality); assert.equal(work.resolution, resolution); assert.equal("optionId" in work, false); assert.deepEqual(parseGenerationWorkSpec(work), work);
      assert.equal(db.prepare("SELECT provider_key FROM generation_job_items").get()?.provider_key, tuple.model.startsWith("gpt") ? "openai" : "google");
    } finally { db.close(); }
  }
});

test("actual source/reference/control assets determine the billed count; bare-shell sends one input and duplicate assets fail before writes", async () => {
  const f = await fixture(); try {
    const bytes = new Uint8Array(readFileSync("public/icon-192.png")), sha = createHash("sha256").update(bytes).digest("hex");
    for (const kind of ["source", "reference", "depth", "normal"] as const) {
      f.database.prepare("INSERT INTO assets(id,owner_id,kind,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key) VALUES(?,'synthetic-route-owner',?,'synthetic.png','image/png',?,?,'canonical-image-v1',?)").run(`synthetic-${kind}`,kind,bytes.length,sha,`synthetic-${kind}`);
      await f.bucket.put(`synthetic-${kind}`, bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: { assetId: `synthetic-${kind}`,sha256:sha,kind,sanitizationVersion:"canonical-image-v1" } });
    }
    const base = { workflowType:"advanced",purpose:"final",optionId:"gemini-flash",providerPreference:"gemini-3.1-flash-image",quality:"auto",resolution:"2K",aspectRatio:"4:3",outputCount:1,sourceAssetId:"synthetic-source",lightingPreset:"noon",preservationMode:"structure",draftScope:f.draftScope };
    for (const bare of [false,true]) {
      const inputImageCount = bare ? 1 : 4;
      const response = await f.modules.quote.POST(f.request("/api/jobs/quote",{optionId:base.optionId,modelId:base.providerPreference,quality:base.quality,resolution:base.resolution,purpose:"final",aspectRatio:base.aspectRatio,inputImageCount,outputCount:1}));
      assert.equal(response.status,200); const {quote}=await response.json() as {quote:{totalCredits:number;priceVersion:string}};
      const body={...base,...(bare?{editInstruction:BARE_SHELL_INSTRUCTION}:{referenceAssetId:"synthetic-reference",depthAssetId:"synthetic-depth",normalAssetId:"synthetic-normal"}),inputImageCount:999,idempotencyKey:`asset-route-${bare}`,expectedPriceVersion:quote.priceVersion,expectedTotalCredits:quote.totalCredits};
      const created=await f.modules.jobs.POST(f.request("/api/jobs",body));const data=await created.json() as {job?:{id:string}};assert.equal(created.status,202,JSON.stringify(data));
      const ledger=f.database.prepare("SELECT amount FROM credit_ledger_entries WHERE job_id=? AND entry_type='RESERVE'").get(data.job!.id)!;assert.equal(Math.abs(Number(ledger.amount)),quote.totalCredits);
    }
    const before=f.snapshot();const duplicate=await f.modules.jobs.POST(f.request("/api/jobs",{...base,referenceAssetId:base.sourceAssetId,idempotencyKey:"duplicate-asset-route"}));assert.equal(duplicate.status,400);assert.deepEqual(f.snapshot(),before);
  } finally {await f.close();}
});

test("trusted private runtime keeps raw direct qualities and gives the six-option UI the original private reservation instead of public pricing", async () => {
  const f = await fixture(), oldAuthMode = process.env.AUTH_MODE;
  try {
    const key=Symbol.for("zaoshi.test.cloudflare.bindings"), bindings=(globalThis as typeof globalThis & {[key]?:Record<string,unknown>})[key]!;
    Object.assign(bindings,{AUTH_MODE:"private-test",ZAOSHI_PRIVATE_TEST_ENABLED:"1",ZAOSHI_RUNTIME:"node",TRUST_PLATFORM_IDENTITY_HEADERS:"0",ZAOSHI_SQLITE_PATH:"/var/lib/zaoshi/web-private-test/db/zaoshi.sqlite",ZAOSHI_OBJECT_ROOT:"/var/lib/zaoshi/web-private-test/objects",PRIVATE_TEST_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600)});
    process.env.AUTH_MODE="private-test";
    for(const selected of [false,true]) {
      const body={...(selected?{optionId:"sunburst-medium-2k"}:{}),modelId:selected?"gpt-image-2.5-sunburst":"gpt-image-2",quality:selected?"medium":"high",resolution:selected?"2K":"1K",purpose:"final",inputImageCount:1,outputCount:1,aspectRatio:"4:3"};
      const response=await f.modules.quote.POST(new Request("http://127.0.0.1:3000/api/jobs/quote",{method:"POST",headers:{origin:"http://127.0.0.1:3000","content-type":"application/json"},body:JSON.stringify(body)}));
      const result=await response.json() as {quote?:{amountPerItem:number;totalCredits:number;privateTestOnly:boolean;quality:string}};assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.quote?.amountPerItem,1);assert.equal(result.quote?.totalCredits,1);assert.equal(result.quote?.privateTestOnly,true);assert.equal(result.quote?.quality,body.quality);
    }
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM generation_jobs").get()?.n,0);assert.equal(f.database.prepare("SELECT COUNT(*) n FROM generation_attempts").get()?.n,0);
  } finally {if(oldAuthMode===undefined)delete process.env.AUTH_MODE;else process.env.AUTH_MODE=oldAuthMode;await f.close();}
});
