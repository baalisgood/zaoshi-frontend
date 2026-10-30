import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

function insertAsset(database: DatabaseSync, id: string, ownerId = "owner-1") {
  database.prepare("INSERT INTO assets (id, owner_id, kind, status, original_file_name, mime_type, byte_size, sha256, sanitization_version, storage_key, created_at, retention_expires_at) VALUES (?, ?, 'source', 'READY', 'room.png', 'image/png', 4, ?, 'canonical-image-v1', ?, datetime('now'), unixepoch() + 60)").run(id, ownerId, "a".repeat(64), `uploads/${ownerId}/${id}.png`);
}

test("0023 preserves historical truth and queues cleanup for old tombstones", async () => {
  const database = new DatabaseSync(":memory:"); applyMigrations(database, 22);
  database.prepare("INSERT INTO assets (id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key,created_at) VALUES ('asset-old','owner-1','output','DELETED','old.png','image/png',4,?,'canonical-image-v1','generated/old.png',CURRENT_TIMESTAMP)").run("a".repeat(64));
  database.prepare("INSERT INTO assets (id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key,created_at) VALUES ('asset-ready-old','owner-1','output','READY','ready.png','image/png',4,?,'canonical-image-v1','generated/ready.png',CURRENT_TIMESTAMP)").run("f".repeat(64));
  database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at) VALUES ('gallery-old','owner-1','asset-old','interior','old','v1',CURRENT_TIMESTAMP,'gallery/old/thumb.webp','gallery/old/display.webp',1,1,?,?,1,1,'REVOKED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run("b".repeat(64), "c".repeat(64));
  database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at,published_at) VALUES ('gallery-approved-old','owner-1','asset-ready-old','interior','old approved','v1',CURRENT_TIMESTAMP,'gallery/approved/thumb.webp','gallery/approved/display.webp',1,1,?,?,1,1,'APPROVED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run("d".repeat(64), "e".repeat(64));
  database.exec(await readFile(new URL("../../drizzle/0023_asset_lifecycle.sql", import.meta.url), "utf8"));
  assert.deepEqual(database.prepare("SELECT moderation_status, retention_expires_at FROM assets WHERE id='asset-old'").get(), Object.assign(Object.create(null), { moderation_status: "UNREVIEWED", retention_expires_at: null }));
  const ready = database.prepare("SELECT moderation_status, retention_expires_at FROM assets WHERE id='asset-ready-old'").get() as { moderation_status: string; retention_expires_at: number };
  assert.equal(ready.moderation_status, "UNREVIEWED"); assert.ok(ready.retention_expires_at > Math.floor(Date.now() / 1000));
  const legacyGallery = database.prepare("SELECT status, published_at, retention_expires_at FROM gallery_items WHERE id='gallery-approved-old'").get() as { status: string; published_at: string | null; retention_expires_at: number };
  assert.equal(legacyGallery.status, "PENDING"); assert.equal(legacyGallery.published_at, null); assert.ok(legacyGallery.retention_expires_at > Math.floor(Date.now() / 1000));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM object_cleanup_tasks").get()!.count, 3);
  assert.throws(() => database.prepare("UPDATE assets SET moderation_status='MAYBE' WHERE id='asset-old'").run(), /invalid asset moderation status/u);
});

test("asset deletion is tombstoned, blocks active work, and cannot be undone", () => {
  const database = new DatabaseSync(":memory:"); applyMigrations(database); insertAsset(database, "asset-active");
  database.prepare("INSERT INTO generation_jobs (id, owner_id, source_asset_id, style_preset_id, lighting_preset, preservation_mode, provider_preference, output_count, idempotency_key, request_hash) VALUES ('job-1','owner-1','asset-active','modern','noon','structure','doubao-seedream-4-5-251128',1,'idem-asset-active','hash')").run();
  database.prepare("INSERT INTO generation_job_items (id, job_id, owner_id, ordinal, status, provider_key, provider_preference, max_attempts, execution_kind) VALUES ('item-1','job-1','owner-1',0,'QUEUED','seedream','doubao-seedream-4-5-251128',2,'provider')").run();
  assert.throws(() => database.prepare("UPDATE assets SET status='DELETED' WHERE id='asset-active'").run(), /active generation/u);
  database.prepare("UPDATE generation_job_items SET status='CANCELED' WHERE id='item-1'").run();
  database.prepare("UPDATE assets SET status='DELETED', deletion_requested_at=unixepoch() WHERE id='asset-active'").run();
  assert.throws(() => database.prepare("UPDATE assets SET status='READY' WHERE id='asset-active'").run(), /cannot be restored/u);
  insertAsset(database, "asset-legacy-active");
  database.prepare("INSERT INTO generation_jobs (id, owner_id, source_asset_id, style_preset_id, lighting_preset, preservation_mode, provider_preference, output_count, idempotency_key, request_hash) VALUES ('job-legacy','owner-1','asset-legacy-active','modern','noon','structure','doubao-seedream-4-5-251128',1,'idem-asset-legacy','hash')").run();
  assert.throws(() => database.prepare("UPDATE assets SET status='DELETED' WHERE id='asset-legacy-active'").run(), /active generation/u);
});

test("deleted assets cannot be submitted to the public gallery and audit history is immutable", () => {
  const database = new DatabaseSync(":memory:"); applyMigrations(database); insertAsset(database, "asset-deleted");
  database.prepare("UPDATE assets SET status='DELETED' WHERE id='asset-deleted'").run();
  assert.throws(() => database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at) VALUES ('gallery-1','owner-1','asset-deleted','interior','test','v1',datetime('now'),'thumb','display',1,1,?, ?,1,1,'PENDING',datetime('now'),datetime('now'))").run("b".repeat(64), "c".repeat(64)), /source must be/u);
  insertAsset(database, "asset-ready");
  assert.throws(() => database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at) VALUES ('gallery-unreviewed','owner-1','asset-ready','interior','test','v1',datetime('now'),'thumb0','display0',1,1,?, ?,1,1,'PENDING',datetime('now'),datetime('now'))").run("b".repeat(64), "c".repeat(64)), /approved ready/u);
  database.prepare("UPDATE assets SET moderation_status='APPROVED', moderated_at=unixepoch() WHERE id='asset-ready'").run();
  database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at) VALUES ('gallery-2','owner-1','asset-ready','interior','test','v1',datetime('now'),'thumb2','display2',1,1,?, ?,1,1,'PENDING',datetime('now'),datetime('now'))").run("b".repeat(64), "c".repeat(64));
  database.prepare("INSERT INTO gallery_audit_events (id,action_id,gallery_id,actor_id,action,detail_hash) VALUES ('event-1','action-1','gallery-2','admin-1','APPROVE',?)").run("d".repeat(64));
  assert.throws(() => database.prepare("DELETE FROM gallery_audit_events WHERE id='event-1'").run(), /append-only/u);
  assert.throws(() => database.prepare("UPDATE gallery_audit_events SET action='REJECT' WHERE id='event-1'").run(), /append-only/u);
  database.prepare("INSERT INTO asset_moderation_events (id,action_id,asset_id,reviewer_id,decision,reason_hash) VALUES ('review-1','review-action-1','asset-ready','admin-1','APPROVED',?)").run("e".repeat(64));
  assert.throws(() => database.prepare("DELETE FROM asset_moderation_events WHERE id='review-1'").run(), /append-only/u);
  assert.throws(() => database.prepare("UPDATE asset_moderation_events SET decision='REJECTED' WHERE id='review-1'").run(), /append-only/u);
  database.prepare("INSERT INTO asset_deletion_events (id,action_id,asset_id,actor_id,source,detail_hash) VALUES ('delete-1','delete-action-1','asset-ready','owner-1','USER_REQUEST',?)").run("f".repeat(64));
  assert.throws(() => database.prepare("DELETE FROM asset_deletion_events WHERE id='delete-1'").run(), /append-only/u);
  assert.throws(() => database.prepare("UPDATE asset_deletion_events SET source='RETENTION_EXPIRY' WHERE id='delete-1'").run(), /append-only/u);
  database.prepare("INSERT INTO asset_maintenance_events (id,action_id,actor_id,action,detail_hash,request_id) VALUES ('maintenance-1','maintenance-action-1','admin-1','RETRY_BLOCKED_CLEANUP',?,'request-1')").run("a".repeat(64));
  assert.throws(() => database.prepare("DELETE FROM asset_maintenance_events WHERE id='maintenance-1'").run(), /append-only/u);
  assert.throws(() => database.prepare("UPDATE asset_maintenance_events SET actor_id='admin-2' WHERE id='maintenance-1'").run(), /append-only/u);
});

test("asset review service approves, rejects, defers active deletion and replays safely", async () => {
  const database = new DatabaseSync(":memory:"); applyMigrations(database);
  const bindings = { DB: new TestD1Database(database), ASSETS_BUCKET: new TestR2Bucket(), BACKEND_PROFILE: "sites-demo" };
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")] = bindings;
  const previousRuntime = process.env.ZAOSHI_RUNTIME; process.env.ZAOSHI_RUNTIME = "node";
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const lifecycle = await server.ssrLoadModule("/lib/server/asset-lifecycle.ts") as typeof import("../../lib/server/asset-lifecycle");
    insertAsset(database, "asset-approve");
    const approved = await lifecycle.reviewAsset({ assetId: "asset-approve", reviewerId: "admin-1", approve: true, reason: "", actionId: "review-approve-1" });
    assert.deepEqual(approved, { idempotentReplay: false, cleanupDeferred: false });
    assert.equal((database.prepare("SELECT moderation_status FROM assets WHERE id='asset-approve'").get() as { moderation_status: string }).moderation_status, "APPROVED");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_moderation_events WHERE asset_id='asset-approve'").get()!.count, 1);
    assert.equal((await lifecycle.reviewAsset({ assetId: "asset-approve", reviewerId: "admin-1", approve: true, reason: "", actionId: "review-approve-1" })).idempotentReplay, true);
    await assert.rejects(lifecycle.reviewAsset({ assetId: "asset-approve", reviewerId: "admin-1", approve: false, reason: "changed", actionId: "review-approve-1" }), /操作编号/u);

    insertAsset(database, "asset-reject");
    database.prepare("UPDATE assets SET moderation_status='APPROVED' WHERE id='asset-reject'").run();
    database.prepare("INSERT INTO gallery_items (id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at) VALUES ('gallery-reject','owner-1','asset-reject','interior','test','v1',datetime('now'),'gallery/reject/thumb.webp','gallery/reject/display.webp',1,1,?,?,1,1,'PENDING',datetime('now'),datetime('now'))").run("b".repeat(64), "c".repeat(64));
    database.prepare("UPDATE assets SET moderation_status='PENDING' WHERE id='asset-reject'").run();
    const rejected = await lifecycle.reviewAsset({ assetId: "asset-reject", reviewerId: "admin-2", approve: false, reason: "不合规", actionId: "review-reject-1" });
    assert.deepEqual(rejected, { idempotentReplay: false, cleanupDeferred: false });
    assert.equal((database.prepare("SELECT status FROM assets WHERE id='asset-reject'").get() as { status: string }).status, "DELETED");
    assert.equal((database.prepare("SELECT status FROM gallery_items WHERE id='gallery-reject'").get() as { status: string }).status, "REVOKED");
    assert.equal((database.prepare("SELECT actor_id FROM asset_deletion_events WHERE asset_id='asset-reject'").get() as { actor_id: string }).actor_id, "admin-2");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM object_cleanup_tasks WHERE source_id IN ('asset-reject','gallery-reject')").get()!.count, 3);

    insertAsset(database, "asset-active-review");
    database.prepare("INSERT INTO generation_jobs (id,owner_id,source_asset_id,style_preset_id,lighting_preset,preservation_mode,provider_preference,output_count,idempotency_key,request_hash) VALUES ('job-active-review','owner-1','asset-active-review','modern','noon','structure','doubao-seedream-4-5-251128',1,'active-review','hash')").run();
    database.prepare("INSERT INTO generation_job_items (id,job_id,owner_id,ordinal,status,provider_key,provider_preference,max_attempts,execution_kind) VALUES ('item-active-review','job-active-review','owner-1',0,'QUEUED','seedream','doubao-seedream-4-5-251128',2,'provider')").run();
    const deferred = await lifecycle.reviewAsset({ assetId: "asset-active-review", reviewerId: "admin-3", approve: false, reason: "不合规", actionId: "review-active-1" });
    assert.equal(deferred.cleanupDeferred, true);
    assert.equal((database.prepare("SELECT status, moderation_status FROM assets WHERE id='asset-active-review'").get() as { status: string; moderation_status: string }).status, "READY");
    database.prepare("UPDATE generation_job_items SET status='CANCELED' WHERE id='item-active-review'").run();
    const swept = await lifecycle.sweepExpiredAssets(10);
    assert.equal(swept.deleted, 1);
    assert.equal((database.prepare("SELECT actor_id FROM asset_deletion_events WHERE asset_id='asset-active-review'").get() as { actor_id: string }).actor_id, "admin-3");

    database.prepare("INSERT INTO object_cleanup_tasks (id,source_type,source_id,object_key,status) VALUES ('blocked-1','ASSET','asset-approve','blocked/1','BLOCKED')").run();
    assert.deepEqual(await lifecycle.retryBlockedObjectCleanup({ actionId: "retry-blocked-1", actorId: "admin-1", requestId: "request-1" }), { reset: 1, idempotentReplay: false });
    database.prepare("INSERT INTO object_cleanup_tasks (id,source_type,source_id,object_key,status) VALUES ('blocked-2','ASSET','asset-approve','blocked/2','BLOCKED')").run();
    assert.deepEqual(await lifecycle.retryBlockedObjectCleanup({ actionId: "retry-blocked-1", actorId: "admin-1", requestId: "request-2" }), { reset: 0, idempotentReplay: true });
    assert.equal((database.prepare("SELECT status FROM object_cleanup_tasks WHERE id='blocked-2'").get() as { status: string }).status, "BLOCKED");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_maintenance_events").get()!.count, 1);
  } finally {
    await server.close();
    if (previousRuntime === undefined) delete process.env.ZAOSHI_RUNTIME; else process.env.ZAOSHI_RUNTIME = previousRuntime;
  }
});

test("asset lifecycle routes keep identity, origin, retention and durable cleanup explicit", async () => {
  const [assetRoute, adminRoute, adminImageRoute, lifecycle, persistence, gallery, galleryRoute, dialog, library, serializer, generationView, nodeRuntime, nodeLifecycle] = await Promise.all([
    readFile(new URL("../../app/api/assets/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/assets/lifecycle/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/assets/[id]/image/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/asset-lifecycle.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/persistence.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/gallery.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/gallery/submissions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/gallery/GallerySubmissionDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/library/AssetLibrary.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/serializers.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/studio/GenerationView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../lib/platform/node-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/platform/node-lifecycle-maintenance.ts", import.meta.url), "utf8"),
  ]);
  assert.match(assetRoute, /DELETE[\s\S]*assertSameOriginMutation[\s\S]*authenticated[\s\S]*requestOwnedAssetDeletion[\s\S]*idempotency-key/u);
  assert.match(adminRoute, /assertSiteAdmin[\s\S]*assertSameOriginMutation/u);
  assert.doesNotMatch(adminRoute, /body\.action === "sweep"|body\.action === "cleanup"/u);
  assert.match(adminRoute, /body\.action === "retryBlocked"/u);
  assert.doesNotMatch(adminRoute, /reviewAsset/u);
  assert.match(adminImageRoute, /HUMAN_REVIEW_DISABLED/u);
  assert.match(lifecycle, /object_cleanup_tasks[\s\S]*OBJECT_DELETE_FAILED/u);
  assert.match(persistence, /uploadsDays:\s*30[\s\S]*outputsDays:\s*90/u);
  assert.match(gallery, /sourceReady[\s\S]*moderationStatus !== "APPROVED"/u);
  assert.match(gallery, /getGalleryImage[\s\S]*readVerifiedGalleryDerivative/u);
  assert.match(lifecycle, /retryBlockedObjectCleanup[\s\S]*asset_maintenance_events[\s\S]*actionId/u);
  assert.match(lifecycle, /action\.source !== "RETENTION_EXPIRY"[\s\S]*revokeMemoryGalleryBySource/u);
  assert.match(galleryRoute, /GALLERY_DEVELOPER_CURATED/u);
  assert.doesNotMatch(dialog, /canvas|toBlob|FormData/u);
  assert.match(library, /const usable = asset\.moderationStatus !== "REJECTED"/u);
  assert.match(serializer, /moderationStatus: asset\.moderationStatus/u);
  assert.match(generationView, /moderationStatus !== "REJECTED"/u);
  assert.doesNotMatch(generationView, /等待内容审核/u);
  assert.match(nodeRuntime, /cn-production[\s\S]*ZAOSHI_LIFECYCLE_MAINTENANCE_ENABLED=1[\s\S]*runLifecycleMaintenance/u);
  assert.match(nodeLifecycle, /purgeExpiredAnalytics[\s\S]*sweepExpiredGallery[\s\S]*processObjectCleanup/u);
});
