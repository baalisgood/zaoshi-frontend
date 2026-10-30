import { LEGAL_VERSION } from "../../lib/domain/legal";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import sharpRuntime from "sharp";
import { hashIdentifier } from "../../lib/server/actor";
import { nodeImageSanitizer } from "../../lib/platform/node-image-sanitizer";
import { imageModelValues } from "../../lib/domain/image-models";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

const bindingKey = Symbol.for("zaoshi.test.cloudflare.bindings");
const sharp = sharpRuntime as unknown as (input: { create: { width: number; height: number; channels: 3; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };
const draftScope = hashIdentifier(`draft:chatgpt:${hashIdentifier("upload-test-actor")}`);

function request(bytes: Uint8Array, key: string, actor = "upload-test-actor", scope = draftScope) {
  const form = new FormData();
  form.append("file", new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], "room.png", { type: "image/png" }));
  form.append("kind", "source");
  return new Request("http://localhost/api/assets", { method: "POST", headers: { "Idempotency-Key": key, "X-Zaoshi-Draft-Scope": scope, "oai-authenticated-user-id": actor }, body: form });
}

test("dotted upload idempotency replays one asset and rejects changed bytes", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const bucket = new TestR2Bucket();
  const scope = globalThis as typeof globalThis & { [bindingKey]?: Record<string, unknown> };
  const bindings = scope[bindingKey] ??= {};
  Object.assign(bindings, { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1", ZAOSHI_IMAGE_SANITIZER: nodeImageSanitizer });
  for (const actor of ["upload-test-actor", "upload-test-actor-b"]) {
    const owner = `chatgpt:${hashIdentifier(actor)}`;
    database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(owner, "Synthetic uploader");
    for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(owner, document, LEGAL_VERSION, Math.floor(Date.now()/1000));
  }
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/assets/route.ts") as typeof import("../../app/api/assets/route");
    const firstBytes = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#887766" } }).png().toBuffer());
    const changedBytes = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#112233" } }).png().toBuffer());
    const key = "draft-upload-key-1:gpt-image-2.5-flare";
    const first = await route.POST(request(firstBytes, key));
    assert.equal(first.status, 201);
    const firstId = ((await first.json()) as { asset: { id: string } }).asset.id;
    const replay = await route.POST(request(firstBytes, key));
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { asset: { id: string } }).asset.id, firstId);
    const conflict = await route.POST(request(changedBytes, key));
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, "UPLOAD_IDEMPOTENCY_CONFLICT");
  } finally { await server.close(); for (const key of Object.keys(bindings)) delete bindings[key]; database.close(); }
});

test("concurrent same-key uploads keep one readable winner", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const bucket = new TestR2Bucket();
  const scope = globalThis as typeof globalThis & { [bindingKey]?: Record<string, unknown> };
  const bindings = scope[bindingKey] ??= {};
  Object.assign(bindings, { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1", ZAOSHI_IMAGE_SANITIZER: nodeImageSanitizer });
  for (const actor of ["upload-test-actor", "upload-test-actor-b"]) {
    const owner = `chatgpt:${hashIdentifier(actor)}`;
    database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(owner, "Synthetic uploader");
    for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(owner, document, LEGAL_VERSION, Math.floor(Date.now()/1000));
  }
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/assets/route.ts") as typeof import("../../app/api/assets/route");
    const bytes = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#887766" } }).png().toBuffer());
    const responses = await Promise.all([route.POST(request(bytes, "concurrent-upload-key:qwen-image-3.0")), route.POST(request(bytes, "concurrent-upload-key:qwen-image-3.0"))]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    const ids = await Promise.all(responses.map(async (response) => ((await response.json()) as { asset: { id: string } }).asset.id));
    assert.equal(ids[0], ids[1]);
  } finally { await server.close(); for (const key of Object.keys(bindings)) delete bindings[key]; database.close(); }
});

test("upload draft scope rejects a foreign actor before storing bytes", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const bucket = new TestR2Bucket();
  const scope = globalThis as typeof globalThis & { [bindingKey]?: Record<string, unknown> };
  const bindings = scope[bindingKey] ??= {};
  Object.assign(bindings, { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1", ZAOSHI_IMAGE_SANITIZER: nodeImageSanitizer });
  for (const actor of ["upload-test-actor", "upload-test-actor-b"]) {
    const owner = `chatgpt:${hashIdentifier(actor)}`;
    database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(owner, "Synthetic uploader");
    for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(owner, document, LEGAL_VERSION, Math.floor(Date.now()/1000));
  }
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/assets/route.ts") as typeof import("../../app/api/assets/route");
    const bytes = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#887766" } }).png().toBuffer());
    const key = "owner-upload-key:qwen-image-3.0-pro";
    const foreign = await route.POST(request(bytes, key, "upload-test-actor-b", draftScope));
    assert.equal(foreign.status, 409);
    assert.equal(((await foreign.json()) as { error: { code: string } }).error.code, "DRAFT_SCOPE_MISMATCH");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0);
    assert.equal(bucket.objects.size, 0);
    const own = await route.POST(request(bytes, key));
    assert.equal(own.status, 201);
    const other = await route.POST(request(bytes, key, "upload-test-actor-b", hashIdentifier(`draft:chatgpt:${hashIdentifier("upload-test-actor-b")}`)));
    assert.equal(other.status, 201);
    assert.notEqual(((await own.json()) as { asset: { id: string } }).asset.id, ((await other.json()) as { asset: { id: string } }).asset.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 2);
    assert.equal(bucket.objects.size, 2);
  } finally { await server.close(); for (const key of Object.keys(bindings)) delete bindings[key]; database.close(); }
});

test("upload keys accept model variants and preserve length and character limits", async (t) => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const bucket = new TestR2Bucket();
  const scope = globalThis as typeof globalThis & { [bindingKey]?: Record<string, unknown> };
  const bindings = scope[bindingKey] ??= {};
  Object.assign(bindings, { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1", ZAOSHI_IMAGE_SANITIZER: nodeImageSanitizer });
  for (const actor of ["upload-test-actor", "upload-test-actor-b"]) {
    const owner = `chatgpt:${hashIdentifier(actor)}`;
    database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(owner, "Synthetic uploader");
    for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(owner, document, LEGAL_VERSION, Math.floor(Date.now()/1000));
  }
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/assets/route.ts") as typeof import("../../app/api/assets/route");
    const bytes = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#887766" } }).png().toBuffer());
    for (const key of ["a".repeat(7), "a".repeat(129), "invalid key", "invalid/key", "invalid\\key", "invalid%key", "invalid-é-key"]) {
      const response = await route.POST(request(bytes, key));
      assert.equal(response.status, 400, key);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_IDEMPOTENCY_KEY", key);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0, key);
      assert.equal(bucket.objects.size, 0, key);
    }
    for (const variant of ["raw", ...imageModelValues]) {
      await t.test(variant, async () => {
        const key = `00000000-0000-4000-8000-000000000001:${variant}`;
        const response = await route.POST(request(bytes, key));
        assert.equal(response.status, 201);
        assert.equal(((await response.json()) as { asset: { id: string } }).asset.id, `asset_${hashIdentifier(`chatgpt:${hashIdentifier("upload-test-actor")}\0${key}`)}`);
      });
    }
    for (const key of ["aA0:_-.a", `${"a".repeat(127)}.`]) assert.equal((await route.POST(request(bytes, key))).status, 201, key);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, imageModelValues.length + 3);
    assert.equal(bucket.objects.size, imageModelValues.length + 3);
  } finally { await server.close(); for (const key of Object.keys(bindings)) delete bindings[key]; database.close(); }
});
