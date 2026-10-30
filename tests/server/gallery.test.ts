import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharpRuntime from "sharp";
import { createServer } from "vite";
import { validateGalleryWebp } from "../../lib/server/gallery-webp";
import { nodeImageSanitizer } from "../../lib/platform/node-image-sanitizer";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

const sharp = sharpRuntime as unknown as (input: { create: { width: number; height: number; channels: 3; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };

function webp(kind: "VP8L" | "VP8 " = "VP8L", width = 128, height = 96, extra: Uint8Array<ArrayBufferLike> = new Uint8Array()): Uint8Array {
  let data: Uint8Array;
  if (kind === "VP8L") {
    data = vp8lData(width, height);
  } else data = Uint8Array.from([0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8]);
  const chunks = [chunk(kind, data), ...extra.length ? [extra] : []];
  const body = Uint8Array.from(chunks.flatMap((x) => [...x]));
  return Uint8Array.from([...new TextEncoder().encode("RIFF"), body.length + 4, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...body]);
}
function chunk(kind: string, data: Uint8Array<ArrayBufferLike>): Uint8Array { const pad = data.length & 1; return Uint8Array.from([...new TextEncoder().encode(kind), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data, ...(pad ? [0] : [])]); }
function vp8x(width: number, height: number, flags = 0): Uint8Array { return chunk("VP8X", Uint8Array.from([flags, 0, 0, 0, (width - 1) & 255, ((width - 1) >> 8) & 255, (width - 1) >> 16, (height - 1) & 255, ((height - 1) >> 8) & 255, (height - 1) >> 16])); }
function vp8lData(width: number, height: number): Uint8Array {
  const w = width - 1, h = height - 1;
  return Uint8Array.from([0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3f) << 6), (h >> 2) & 0xff, (h >> 10) & 0xff]);
}

test("accepts VP8L and VP8X dimensions must match", () => {
  const direct = webp("VP8L");
  assert.deepEqual(validateGalleryWebp(direct, 1920), { width: 128, height: 96 });
  const extendedBody = Uint8Array.from([...vp8x(128, 96), ...chunk("VP8L", vp8lData(128, 96))]);
  const extended = Uint8Array.from([...new TextEncoder().encode("RIFF"), extendedBody.length + 4, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...extendedBody]);
  assert.deepEqual(validateGalleryWebp(extended, 1920), { width: 128, height: 96 });
});

test("rejects malformed, truncated, metadata, multiple images, oversize and aspect ratio", () => {
  const valid = webp();
  for (const bad of [valid.slice(0, -1), Uint8Array.from([...valid, 0]), webp("VP8L", 4000, 64), webp("VP8L", 1920, 400), Uint8Array.from([...valid.slice(0, 4), 0, 0, 0, 0, ...valid.slice(8)])]) {
    assert.throws(() => validateGalleryWebp(bad, 1920));
  }
  const metadata = webp("VP8L", 128, 96, chunk("EXIF", new Uint8Array([1])));
  assert.throws(() => validateGalleryWebp(metadata, 1920), /不允许/u);
  const image = chunk("VP8L", vp8lData(128, 96));
  const two = Uint8Array.from([...new TextEncoder().encode("RIFF"), image.length * 2 + 4, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...image, ...image]);
  assert.throws(() => validateGalleryWebp(two, 1920), /多个/u);
  const alpha = vp8lData(128, 96);
  alpha[4] |= 0x10;
  assert.throws(() => validateGalleryWebp(webpWithChunk(chunk("VP8L", alpha)), 1920), /透明/u);
  assert.throws(() => validateGalleryWebp(webpWithChunk(Uint8Array.from([...image, ...vp8x(128, 96)])), 1920), /扩展块/u);
});

test("server derives bounded gallery images from the stored source", async () => {
  const source = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#887766" } }).png().toBuffer();
  const derived = await nodeImageSanitizer.deriveGalleryImages!(new Uint8Array(source));
  assert.deepEqual(validateGalleryWebp(derived.thumb, 640), { width: 640, height: 480 });
  assert.deepEqual(validateGalleryWebp(derived.display, 1920), { width: 800, height: 600 });
});

test("gallery review and revoke atomically retain cleanup work and replay safely", async () => {
  const database = new DatabaseSync(":memory:"); applyMigrations(database);
  const bucket = new TestR2Bucket();
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")] = { DB: new TestD1Database(database), ASSETS_BUCKET: bucket, BACKEND_PROFILE: "sites-demo" };
  const previousRuntime = process.env.ZAOSHI_RUNTIME; process.env.ZAOSHI_RUNTIME = "node";
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  const image = webp();
  try {
    const gallery = await server.ssrLoadModule("/lib/server/gallery.ts") as typeof import("../../lib/server/gallery");
    const lifecycle = await server.ssrLoadModule("/lib/server/asset-lifecycle.ts") as typeof import("../../lib/server/asset-lifecycle");
    for (const suffix of ["reject", "revoke", "public"] as const) {
      database.prepare("INSERT INTO assets (id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key,moderation_status) VALUES (?, 'owner-1','output','READY','room.webp','image/webp',?,?,?,?,'APPROVED')").run(`asset-${suffix}`, image.byteLength, "a".repeat(64), "canonical-image-v1", `generated/${suffix}.webp`);
      database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,published_at,updated_at) VALUES (?, 'owner-1',?,'interior','test','v1',datetime('now'),?,?,?,?,?,?,128,96,?,datetime('now'),?,datetime('now'))").run(`gallery-${suffix}`, `asset-${suffix}`, `gallery/${suffix}/thumb.webp`, `gallery/${suffix}/display.webp`, image.byteLength, image.byteLength, sha256(image), sha256(image), suffix === "reject" ? "PENDING" : "APPROVED", suffix === "reject" ? null : new Date().toISOString());
      for (const variant of ["thumb", "display"] as const) await bucket.put(`gallery/${suffix}/${variant}.webp`, image, { httpMetadata: { contentType: "image/webp" }, customMetadata: { galleryId: `gallery-${suffix}`, variant, sha256: sha256(image) } });
    }
    await Promise.all([
      gallery.reviewGallery("gallery-reject", "admin-1", false, "不公开", "gallery-review-1"),
      gallery.reviewGallery("gallery-reject", "admin-1", false, "不公开", "gallery-review-1"),
    ]);
    assert.equal((database.prepare("SELECT status FROM gallery_items WHERE id='gallery-reject'").get() as { status: string }).status, "REJECTED");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM gallery_audit_events WHERE action_id='gallery-review-1'").get()!.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM object_cleanup_tasks WHERE source_id='gallery-reject'").get()!.count, 2);
    await assert.rejects(gallery.reviewGallery("gallery-reject", "admin-1", false, "另一理由", "gallery-review-1"), /操作编号/u);

    await Promise.all([
      gallery.revokeGallery("owner-1", "gallery-revoke", "gallery-revoke-1"),
      gallery.revokeGallery("owner-1", "gallery-revoke", "gallery-revoke-1"),
    ]);
    assert.equal((database.prepare("SELECT status FROM gallery_items WHERE id='gallery-revoke'").get() as { status: string }).status, "REVOKED");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM object_cleanup_tasks WHERE source_id='gallery-revoke'").get()!.count, 2);

    await lifecycle.requestOwnedAssetDeletion("owner-1", "asset-public", { actionId: "retention-asset-public", source: "RETENTION_EXPIRY", actorId: "system:retention" });
    assert.equal((database.prepare("SELECT status FROM gallery_items WHERE id='gallery-public'").get() as { status: string }).status, "APPROVED");
    assert.deepEqual((await gallery.listPublicGallery({ limit: 30 })).items, []);
    assert.equal(await gallery.getGalleryImage("gallery-public", "display"), null);
    bucket.objects.get("gallery/public/display.webp")!.bytes = new Uint8Array([1]);
    assert.equal(await gallery.getGalleryImage("gallery-public", "display"), null);
  } finally {
    await server.close();
    if (previousRuntime === undefined) delete process.env.ZAOSHI_RUNTIME; else process.env.ZAOSHI_RUNTIME = previousRuntime;
  }
});

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function webpWithChunk(body: Uint8Array): Uint8Array {
  return Uint8Array.from([...new TextEncoder().encode("RIFF"), body.length + 4, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...body]);
}

test("gallery publication keeps review, pagination and storage boundaries explicit", async () => {
  const [service, home, adminImage, publicImage] = await Promise.all([
    readFile(new URL("../../lib/server/gallery.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/home/HomePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/gallery/[id]/image/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/gallery/[id]/image/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(service, /INSERT INTO gallery_items[\s\S]*COUNT\(\*\)[\s\S]*status IN \('PENDING', 'APPROVED'\)[\s\S]*< 5/u);
  assert.match(service, /verifyGalleryDerivatives\(row\)[\s\S]*status: approve \? "APPROVED" : "REJECTED"/u);
  assert.match(service, /eq\(generationJobs\.purpose, "final"\)/u);
  assert.doesNotMatch(service, /eq\(generationJobOutputs\.purpose/u);
  assert.match(service, /object_cleanup_tasks[\s\S]*Promise\.allSettled/u);
  assert.match(service, /deriveGalleryImages\(await getAssetBytes\(source\)\)/u);
  assert.match(service, /gallery_audit_events/u);
  assert.match(service, /getGalleryReviewImage[\s\S]*row\.status !== "PENDING"/u);
  assert.match(service, /return \{ items: \[\], nextCursor: null, hasCommunity: false, source: "demo"/u);
  assert.match(service, /getGalleryImage\(_rowId: string, _variant: "thumb" \| "display"\).*return null/u);
  assert.doesNotMatch(service, /function publicItem[^{]*\{[^}]*ownerId|function publicItem[^{]*\{[^}]*Sha256/u);
  assert.match(adminImage, /GALLERY_DEVELOPER_CURATED/u);
  assert.match(publicImage, /Cache-Control": "no-store"/u);
  assert.match(publicImage, /Content-Length/u);
  assert.match(publicImage, /Content-Security-Policy": "sandbox"/u);
  assert.match(home, /造室精选.*摄影参考与造室风格示例.*非客户案例/u);
  assert.doesNotMatch(home, /社区精选作品|用户授权并经审核|创作者选择公开/u);
  assert.match(home, /hasCommunityRef\.current = result\.hasCommunity/u);
  assert.match(home, /reset && result\.items\.length === 0/u);
  assert.match(home, /loadingMoreRef/u);
  assert.match(home, /new Set\(old\.map/u);
});
