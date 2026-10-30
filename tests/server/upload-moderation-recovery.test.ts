import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import sharpRuntime from "sharp";
const sharp = sharpRuntime as unknown as (input: { create: { width: number; height: number; channels: 3; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };
import { LEGAL_VERSION } from "../../lib/domain/legal";
import { hashIdentifier } from "../../lib/server/actor";
import { nodeImageSanitizer } from "../../lib/platform/node-image-sanitizer";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

const bindingKey = Symbol.for("zaoshi.test.cloudflare.bindings");
const owner = `chatgpt:${hashIdentifier("moderation-upload-actor")}`;
const draftScope = hashIdentifier(`draft:${owner}`);
const config = { TENCENT_MODERATION_ENABLED: "1", TENCENT_MODERATION_SECRET_ID: "synthetic-id", TENCENT_MODERATION_SECRET_KEY: "synthetic-key", TENCENT_MODERATION_REGION: "ap-guangzhou", TENCENT_MODERATION_BIZ_TYPE: "synthetic-policy" };
const assetId = (key: string) => `asset_${createHash("sha256").update(`${owner}\0${key}`).digest("hex")}`;
function upload(bytes: Uint8Array, key: string) {
  const form = new FormData(); form.append("file", new File([Uint8Array.from(bytes).buffer], "room.png", { type: "image/png" })); form.append("kind", "source");
  return new Request("http://localhost/api/assets", { method: "POST", headers: { "Idempotency-Key": key, "X-Zaoshi-Draft-Scope": draftScope, "oai-authenticated-user-id": "moderation-upload-actor" }, body: form });
}

async function fixture(run: (context: { route: typeof import("../../app/api/assets/route"); database: DatabaseSync; bucket: TestR2Bucket; bindings: Record<string, unknown>; bytes: Uint8Array }) => Promise<void>) {
  const database = new DatabaseSync(":memory:"); applyMigrations(database);
  database.prepare("INSERT INTO users (id,display_name) VALUES (?,?)").run(owner,"Synthetic uploader");
  for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances (user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(owner,document,LEGAL_VERSION,Math.floor(Date.now()/1000));
  const bucket = new TestR2Bucket();
  const scope = globalThis as typeof globalThis & { [bindingKey]?: Record<string, unknown> }; const bindings = scope[bindingKey] ??= {};
  Object.assign(bindings, { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1", ZAOSHI_IMAGE_SANITIZER: nodeImageSanitizer });
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  const transport = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ Response: { Suggestion: "Pass", RequestId: "synthetic-request" } });
    const route = await server.ssrLoadModule("/app/api/assets/route.ts") as typeof import("../../app/api/assets/route");
    const bytes = new Uint8Array(await sharp({ create: { width: 80, height: 80, channels: 3, background: "#887766" } }).png().toBuffer());
    await run({ route, database, bucket, bindings, bytes });
  } finally { globalThis.fetch = transport; await server.close(); for (const key of Object.keys(bindings)) delete bindings[key]; database.close(); }
}

test("missing moderation configuration returns original 503 without objects or PENDING rows, including repeated keys", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  bindings.TENCENT_MODERATION_ENABLED="1";
  for (let i = 0; i < 2; i++) {
    const response = await route.POST(upload(bytes, "missing-config-key"));
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "MODERATION_UNAVAILABLE");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get()?.n, 0); assert.equal(bucket.objects.size, 0);
  }
}));

test("moderation transport and review errors stay truthful; pending replay never reruns audit or promotes bytes", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("synthetic timeout"); };
  const failed = await route.POST(upload(bytes, "timeout-upload-key"));
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error.code, "MODERATION_UNAVAILABLE");
  assert.equal(database.prepare("SELECT status FROM assets WHERE id=?").get(assetId("timeout-upload-key"))?.status, "PENDING");
  const replay = await route.POST(upload(bytes, "timeout-upload-key"));
  assert.equal(replay.status, 409); assert.equal((await replay.json()).error.code, "UPLOAD_IN_PROGRESS"); assert.equal(calls, 1); assert.equal(bucket.objects.size, 1);
  const changed = new Uint8Array(await sharp({ create: { width: 80, height: 80, channels: 3, background: "#112233" } }).png().toBuffer());
  const mismatch = await route.POST(upload(changed, "timeout-upload-key")); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "UPLOAD_IDEMPOTENCY_CONFLICT");
  for (const decision of ["Review", "Block"] as const) {
    globalThis.fetch = async () => Response.json({ Response: { Suggestion: decision, RequestId: `synthetic-${decision}` } });
    const response = await route.POST(upload(bytes, `${decision}-upload-key`)); assert.equal(response.status, 422); assert.equal((await response.json()).error.code, decision === "Review" ? "CONTENT_REVIEW_REQUIRED" : "CONTENT_BLOCKED");
  }
}));

test("concurrent PENDING upload returns conflict until audited winner is READY; replay preserves exact ID and integrity errors", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config);
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; }); let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  globalThis.fetch = async () => { start(); await waiting; return Response.json({ Response: { Suggestion: "Pass", RequestId: "synthetic-concurrent" } }); };
  const first = route.POST(upload(bytes, "concurrent-audit-key")); await Promise.race([started, first.then(async response => { throw Error(`audit never started: ${response.status} ${await response.text()}`); })]);
  const second = await route.POST(upload(bytes, "concurrent-audit-key")); assert.equal(second.status, 409); assert.equal((await second.json()).error.code, "UPLOAD_IN_PROGRESS");
  finish(); assert.equal((await first).status, 201);
  const replay = await route.POST(upload(bytes, "concurrent-audit-key")); assert.equal(replay.status, 200); assert.equal((await replay.json()).asset.id, assetId("concurrent-audit-key")); assert.equal(bucket.objects.size, 1);
  const key = String(database.prepare("SELECT storage_key FROM assets").get()?.storage_key); bucket.objects.get(key)!.bytes = Uint8Array.of(1, 2, 3);
  const broken = await route.POST(upload(bytes, "concurrent-audit-key")); assert.equal(broken.status, 409); assert.equal((await broken.json()).error.code, "ASSET_INTEGRITY_FAILED");
  bucket.objects.clear(); const missing = await route.POST(upload(bytes, "concurrent-audit-key")); assert.equal(missing.status, 410);
}));

test("concurrent different bytes with the same key preserve 409 conflict and only the audited winner", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config);
  const changed = new Uint8Array(await sharp({ create: { width: 80, height: 80, channels: 3, background: "#112233" } }).png().toBuffer());
  const put = bucket.put.bind(bucket); let entrants = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  bucket.put = async (...args: Parameters<TestR2Bucket["put"]>) => { if (++entrants === 2) release(); await barrier; return put(...args); };
  const responses = await Promise.all([route.POST(upload(bytes, "different-bytes-race")), route.POST(upload(changed, "different-bytes-race"))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const conflict = responses.find(response => response.status === 409)!; assert.equal((await conflict.json()).error.code, "UPLOAD_IDEMPOTENCY_CONFLICT");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get()?.n, 1); assert.equal(bucket.objects.size, 1);
}));

test("tombstones and rejected records are not promoted; draft scope remains an owner boundary", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config);
  const first = await route.POST(upload(bytes, "tombstone-upload-key")); assert.equal(first.status, 201);
  database.prepare("UPDATE assets SET status='DELETED' WHERE id=?").run(assetId("tombstone-upload-key"));
  assert.equal((await route.POST(upload(bytes, "tombstone-upload-key"))).status, 410); assert.equal(bucket.objects.size, 1);
  assert.equal((await route.POST(upload(bytes, "rejected-upload-key"))).status, 201);
  database.prepare("UPDATE assets SET moderation_status='REJECTED' WHERE id=?").run(assetId("rejected-upload-key"));
  assert.equal((await route.POST(upload(bytes, "rejected-upload-key"))).status, 410);
  const foreign = upload(bytes, "foreign-upload-key"); foreign.headers.set("oai-authenticated-user-id", "foreign-actor");
  const foreignOwner = `chatgpt:${hashIdentifier("foreign-actor")}`; database.prepare("INSERT INTO users (id,display_name) VALUES (?,?)").run(foreignOwner, "Foreign synthetic");
  for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances (user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(foreignOwner,document,LEGAL_VERSION,Math.floor(Date.now()/1000));
  const response = await route.POST(foreign); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "DRAFT_SCOPE_MISMATCH"); assert.equal(bucket.objects.size, 2);
}));

test("object write failures retain original error and leave no database asset", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config); bucket.put = async () => { throw Error("synthetic storage failure"); };
  const response = await route.POST(upload(bytes, "object-write-failure")); assert.equal(response.status, 500); assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get()?.n, 0); assert.equal(bucket.objects.size, 0);
}));

test("identical concurrent uploads before insertion return in-progress conflict while winner is still auditing", async () => fixture(async ({ route, database, bucket, bindings, bytes }) => {
  Object.assign(bindings, config);
  const put = bucket.put.bind(bucket); let entrants = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  bucket.put = async (...args: Parameters<TestR2Bucket["put"]>) => { if (++entrants === 2) release(); await barrier; return put(...args); };
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  globalThis.fetch = async () => { await waiting; return Response.json({ Response: { Suggestion: "Pass", RequestId: "synthetic-insert-race" } }); };
  const attempts = [route.POST(upload(bytes, "identical-insert-race")), route.POST(upload(bytes, "identical-insert-race"))];
  const pending = await Promise.race(attempts); assert.equal(pending.status, 409); assert.equal((await pending.clone().json()).error.code, "UPLOAD_IN_PROGRESS");
  finish(); const responses = await Promise.all(attempts); assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get()?.n, 1); assert.equal(bucket.objects.size, 1);
  assert.equal((await route.POST(upload(bytes, "identical-insert-race"))).status, 200);
}));

test("recovery database read failure cannot replace the original moderation 503", async () => fixture(async ({ route, bindings, bytes }) => {
  Object.assign(bindings, config);
  const d1 = bindings.DB as TestD1Database; const prepare = d1.prepare.bind(d1);
  globalThis.fetch = async () => {
    d1.prepare = (sql: string) => { if (/^select/iu.test(sql) && sql.includes('"assets"')) throw Error("synthetic recovery read failure"); return prepare(sql); };
    throw Error("synthetic moderation timeout");
  };
  const response = await route.POST(upload(bytes, "recovery-read-failure"));
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "MODERATION_UNAVAILABLE");
}));


test("disabled uploads are READY UNREVIEWED without external calls/evidence; repeat is stable", async()=>fixture(async({route,database,bucket,bindings,bytes})=>{
 bindings.TENCENT_MODERATION_ENABLED="0";let calls=0;globalThis.fetch=async()=>{calls++;throw Error("external audit forbidden");};
 const created=await route.POST(upload(bytes,"optional-audit-upload"));assert.equal(created.status,201);const repeated=await route.POST(upload(bytes,"optional-audit-upload"));assert.equal(repeated.status,200);
 const row=database.prepare("SELECT status,moderation_status,moderated_at,moderation_mode FROM assets").get();assert.equal(row?.status,"READY");assert.equal(row?.moderation_status,"UNREVIEWED");assert.equal(row?.moderated_at,null);assert.equal(row?.moderation_mode,"disabled");assert.equal(calls,0);assert.equal(bucket.objects.size,1);assert.equal(database.prepare("SELECT COUNT(*) n FROM asset_moderation_evidence").get()?.n,0);
}));
