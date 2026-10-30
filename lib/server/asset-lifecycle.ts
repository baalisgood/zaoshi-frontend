import { identityNamespace } from "./user-identity";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ensureDatabase, getD1Binding, getDb, getR2Binding } from "@/db";
import { assets, galleryItems, objectCleanupTasks } from "@/db/schema";
import { ApiError } from "./api";
import { ASSET_RETENTION_POLICY, getStorageMode, tombstoneMemoryAsset } from "./persistence";
import { revokeMemoryGalleryBySource } from "./gallery";

export { ASSET_RETENTION_POLICY };

export async function listAssetsForModeration(limit = 100) {
  if (getStorageMode() === "memory-demo") return [];
  await ensureDatabase();
  return (await getDb().select().from(assets).where(and(eq(assets.status, "READY"), inArray(assets.moderationStatus, ["UNREVIEWED", "PENDING"]))).orderBy(asc(assets.createdAt)).limit(Math.max(1, Math.min(100, Math.floor(limit))))).map((asset) => ({ id: asset.id, kind: asset.kind, fileName: asset.originalFileName, mimeType: asset.mimeType, byteSize: asset.byteSize, createdAt: asset.createdAt, moderationStatus: asset.moderationStatus, imageUrl: `/api/admin/assets/${encodeURIComponent(asset.id)}/image` }));
}

export async function getAssetForModeration(assetId: string) {
  if (getStorageMode() === "memory-demo") return null;
  await ensureDatabase();
  const [asset] = await getDb().select().from(assets).where(and(eq(assets.id, assetId), eq(assets.status, "READY"), inArray(assets.moderationStatus, ["UNREVIEWED", "PENDING"]))).limit(1);
  return asset ?? null;
}

export async function reviewAsset(input: { assetId: string; reviewerId: string; approve: boolean; reason: string; actionId: string }) {
  if (getStorageMode() === "memory-demo") throw new ApiError(503, "PERSISTENCE_REQUIRED", "内容审核需要持久化数据库。");
  await ensureDatabase();
  const d1 = getD1Binding()!;
  const decision = input.approve ? "APPROVED" : "REJECTED";
  const reasonHash = hash(JSON.stringify({ assetId: input.assetId, reviewerId: await identityNamespace(d1, input.reviewerId), decision, reason: input.reason }));
  const replay = await d1.prepare("SELECT asset_id, decision, reason_hash FROM asset_moderation_events WHERE action_id = ?").bind(input.actionId).first<{ asset_id: string; decision: string; reason_hash: string }>();
  if (replay) {
    if (replay.reason_hash !== reasonHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
    return { idempotentReplay: true, cleanupDeferred: replay.decision === "REJECTED" ? await deleteRejectedAsset(replay.asset_id, undefined, input.actionId, input.reviewerId) : false };
  }
  const asset = await d1.prepare("SELECT id, owner_id AS ownerId FROM assets WHERE id = ? AND status = 'READY' AND moderation_status IN ('UNREVIEWED','PENDING')").bind(input.assetId).first<{ id: string; ownerId: string }>();
  if (!asset) throw new ApiError(409, "INVALID_STATE", "图片不在待审核状态。");
  const stamp = Math.floor(Date.now() / 1000);
  let updated: D1Result;
  try { [updated] = await d1.batch([
    d1.prepare("UPDATE assets SET moderation_status = ?, moderated_at = ?, moderation_reason = ?, moderation_action_id = ?, retention_expires_at = CASE WHEN ? = 'REJECTED' THEN ? ELSE retention_expires_at END WHERE id = ? AND status = 'READY' AND moderation_status IN ('UNREVIEWED','PENDING')").bind(decision, stamp, input.reason, input.actionId, decision, stamp, input.assetId),
    d1.prepare("INSERT INTO asset_moderation_events (id, action_id, asset_id, reviewer_id, decision, reason_hash) SELECT ?, ?, id, ?, ?, ? FROM assets WHERE id = ? AND moderation_status = ? AND moderation_action_id = ?").bind(`asset_review_${crypto.randomUUID()}`, input.actionId, input.reviewerId, decision, reasonHash, input.assetId, decision, input.actionId),
    d1.prepare("UPDATE gallery_items SET status = 'REVOKED', revoked_at = datetime(?, 'unixepoch'), updated_at = datetime(?, 'unixepoch'), retention_expires_at = ? WHERE ? = 'REJECTED' AND source_asset_id = ? AND status IN ('PENDING','APPROVED') AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND moderation_action_id = ?)").bind(stamp, stamp, stamp, decision, input.assetId, input.assetId, input.actionId),
    d1.prepare("INSERT OR IGNORE INTO gallery_audit_events (id, action_id, gallery_id, actor_id, action, detail_hash) SELECT 'gallery_event_asset_reject_' || id || '_' || ?, 'asset-reject-gallery:' || id || ':' || ?, id, ?, 'ASSET_REJECTED', ? FROM gallery_items WHERE ? = 'REJECTED' AND source_asset_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch') AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND moderation_action_id = ?)").bind(stamp, input.actionId, input.reviewerId, reasonHash, decision, input.assetId, stamp, input.assetId, input.actionId),
    d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_thumb_' || id, 'GALLERY', id, thumb_key FROM gallery_items WHERE ? = 'REJECTED' AND source_asset_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch') AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND moderation_action_id = ?)").bind(decision, input.assetId, stamp, input.assetId, input.actionId),
    d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_display_' || id, 'GALLERY', id, display_key FROM gallery_items WHERE ? = 'REJECTED' AND source_asset_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch') AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND moderation_action_id = ?)").bind(decision, input.assetId, stamp, input.assetId, input.actionId),
  ]); } catch (error) {
    const concurrent = await d1.prepare("SELECT asset_id, decision, reason_hash FROM asset_moderation_events WHERE action_id = ?").bind(input.actionId).first<{ asset_id: string; decision: string; reason_hash: string }>();
    if (!concurrent) throw error;
    if (concurrent.reason_hash !== reasonHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
    return { idempotentReplay: true, cleanupDeferred: concurrent.decision === "REJECTED" ? await deleteRejectedAsset(concurrent.asset_id, undefined, input.actionId, input.reviewerId) : false };
  }
  if (Number(updated.meta.changes) !== 1) {
    const concurrent = await d1.prepare("SELECT asset_id, decision, reason_hash FROM asset_moderation_events WHERE action_id = ?").bind(input.actionId).first<{ asset_id: string; decision: string; reason_hash: string }>();
    if (concurrent?.reason_hash === reasonHash) return { idempotentReplay: true, cleanupDeferred: concurrent.decision === "REJECTED" ? await deleteRejectedAsset(concurrent.asset_id, undefined, input.actionId, input.reviewerId) : false };
    throw new ApiError(409, concurrent ? "ACTION_CONFLICT" : "INVALID_STATE", concurrent ? "操作编号已用于其他请求。" : "图片不在待审核状态。");
  }
  return { idempotentReplay: false, cleanupDeferred: input.approve ? false : await deleteRejectedAsset(asset.id, asset.ownerId, input.actionId, input.reviewerId) };
}

async function deleteRejectedAsset(assetId: string, knownOwnerId: string | undefined, reviewActionId: string, reviewerId: string): Promise<boolean> {
  const ownerId = knownOwnerId ?? (await getD1Binding()!.prepare("SELECT owner_id FROM assets WHERE id = ?").bind(assetId).first<{ owner_id: string }>())?.owner_id;
  if (!ownerId) return false;
  try { await requestOwnedAssetDeletion(ownerId, assetId, { actionId: `moderation-delete:${reviewActionId}`, source: "MODERATION_REJECT", actorId: reviewerId }); return false; }
  catch (error) { if (error instanceof ApiError && error.code === "ASSET_IN_ACTIVE_JOB") return true; throw error; }
}

type DeletionSource = "USER_REQUEST" | "MODERATION_REJECT" | "RETENTION_EXPIRY";

export async function requestOwnedAssetDeletion(ownerId: string, assetId: string, action: { actionId: string; source: DeletionSource; actorId: string }): Promise<boolean> {
  if (getStorageMode() === "memory-demo") {
    const deleted = tombstoneMemoryAsset(ownerId, assetId);
    if (deleted && action.source !== "RETENTION_EXPIRY") await revokeMemoryGalleryBySource(ownerId, assetId);
    return deleted;
  }
  await ensureDatabase();
  const d1 = getD1Binding();
  if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "数据库尚未配置。");
  const detailHash = hash(JSON.stringify({ assetId, actorId: await identityNamespace(d1, action.actorId), source: action.source }));
  const replay = await d1.prepare("SELECT detail_hash FROM asset_deletion_events WHERE action_id = ?").bind(action.actionId).first<{ detail_hash: string }>();
  if (replay) {
    if (replay.detail_hash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
    return true;
  }
  const asset = await d1.prepare("SELECT id, status FROM assets WHERE id = ? AND owner_id = ?").bind(assetId, ownerId).first<{ id: string; status: string }>();
  if (!asset) return false;
  if (asset.status === "DELETED") return true;
  if (asset.status !== "READY") throw new ApiError(409, "ASSET_NOT_READY", "图片尚未完成，暂时不能删除。");
  const stamp = Math.floor(Date.now() / 1000);
  try {
    const [deleted] = await d1.batch([
      d1.prepare("UPDATE assets SET status = 'DELETED', deleted_at = datetime(?, 'unixepoch'), deletion_requested_at = ?, deletion_action_id = ? WHERE id = ? AND owner_id = ? AND status = 'READY'").bind(stamp, stamp, action.actionId, assetId, ownerId),
      d1.prepare("INSERT INTO asset_deletion_events (id, action_id, asset_id, actor_id, source, detail_hash) SELECT ?, ?, id, ?, ?, ? FROM assets WHERE id = ? AND owner_id = ? AND status = 'DELETED' AND deletion_action_id = ?").bind(`asset_delete_${crypto.randomUUID()}`, action.actionId, action.actorId, action.source, detailHash, assetId, ownerId, action.actionId),
      d1.prepare("UPDATE gallery_items SET status = 'REVOKED', revoked_at = datetime(?, 'unixepoch'), updated_at = datetime(?, 'unixepoch') WHERE ? <> 'RETENTION_EXPIRY' AND source_asset_id = ? AND owner_id = ? AND status IN ('PENDING','APPROVED') AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND status = 'DELETED' AND deletion_action_id = ?)").bind(stamp, stamp, action.source, assetId, ownerId, assetId, action.actionId),
      d1.prepare("INSERT OR IGNORE INTO gallery_audit_events (id, action_id, gallery_id, actor_id, action, detail_hash) SELECT 'gallery_event_source_delete_' || id || '_' || ?, 'source-delete:' || id || ':' || ?, id, ?, 'SOURCE_DELETED', ? FROM gallery_items WHERE source_asset_id = ? AND owner_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch')").bind(stamp, stamp, action.actorId, hash(`SOURCE_DELETED:${assetId}:${stamp}`), assetId, ownerId, stamp),
      d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_asset_' || id, 'ASSET', id, storage_key FROM assets WHERE id = ? AND owner_id = ? AND status = 'DELETED' AND deletion_requested_at = ?").bind(assetId, ownerId, stamp),
      d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_thumb_' || id, 'GALLERY', id, thumb_key FROM gallery_items WHERE source_asset_id = ? AND owner_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch')").bind(assetId, ownerId, stamp),
      d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_display_' || id, 'GALLERY', id, display_key FROM gallery_items WHERE source_asset_id = ? AND owner_id = ? AND status = 'REVOKED' AND revoked_at = datetime(?, 'unixepoch')").bind(assetId, ownerId, stamp),
    ]);
    if (Number(deleted.meta.changes) === 1) return true;
    const concurrent = await d1.prepare("SELECT detail_hash FROM asset_deletion_events WHERE action_id = ?").bind(action.actionId).first<{ detail_hash: string }>();
    if (concurrent?.detail_hash === detailHash) return true;
    if (concurrent) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
    return false;
  } catch (error) {
    if (/active generation/u.test(error instanceof Error ? error.message : String(error))) {
      throw new ApiError(409, "ASSET_IN_ACTIVE_JOB", "图片正在用于生成任务，请等待任务结束后再删除。");
    }
    const concurrent = await d1.prepare("SELECT detail_hash FROM asset_deletion_events WHERE action_id = ?").bind(action.actionId).first<{ detail_hash: string }>().catch(() => null);
    if (concurrent?.detail_hash === detailHash) return true;
    if (concurrent) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
    throw error;
  }
}

type CleanupResult = { processed: number; succeeded: number; retried: number; blocked: number };
let cleanupRun: Promise<CleanupResult> | null = null;

export function processObjectCleanup(limit = 25): Promise<CleanupResult> {
  if (cleanupRun) return cleanupRun;
  // ponytail: the CVM Web process is single-instance under flock; use one in-process cleanup lock until the storage tier becomes multi-node.
  cleanupRun = processObjectCleanupBatch(limit).finally(() => { cleanupRun = null; });
  return cleanupRun;
}

async function processObjectCleanupBatch(limit: number): Promise<CleanupResult> {
  if (getStorageMode() === "memory-demo") return { processed: 0, succeeded: 0, retried: 0, blocked: 0 };
  await ensureDatabase();
  const bucket = getR2Binding();
  const d1 = getD1Binding();
  if (!bucket || !d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "对象存储尚未配置。");
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await getDb().select().from(objectCleanupTasks).where(and(inArray(objectCleanupTasks.status, ["PENDING", "RETRY"]), lte(objectCleanupTasks.nextAttemptAt, Math.floor(Date.now() / 1000)))).orderBy(asc(objectCleanupTasks.createdAt)).limit(bounded);
  let succeeded = 0;
  let retried = 0;
  let blocked = 0;
  for (const row of rows) {
    try {
      await bucket.delete(row.objectKey);
      const stamp = Math.floor(Date.now() / 1000);
      await d1.batch([
        d1.prepare("UPDATE object_cleanup_tasks SET status = 'SUCCEEDED', attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('PENDING','RETRY')").bind(stamp, stamp, row.id),
        d1.prepare("UPDATE assets SET purged_at = ? WHERE id = ? AND status = 'DELETED' AND ? = 'ASSET'").bind(stamp, row.sourceId, row.sourceType),
      ]);
      succeeded += 1;
    } catch {
      const attempt = row.attemptCount + 1;
      const next = Math.floor(Date.now() / 1000) + Math.min(86_400, 60 * 2 ** Math.min(attempt, 10));
      const status = attempt >= 8 ? "BLOCKED" : "RETRY";
      await d1.prepare("UPDATE object_cleanup_tasks SET status = ?, attempt_count = attempt_count + 1, next_attempt_at = ?, last_error_code = 'OBJECT_DELETE_FAILED', updated_at = unixepoch() WHERE id = ? AND status IN ('PENDING','RETRY')").bind(status, next, row.id).run();
      if (status === "BLOCKED") blocked += 1; else retried += 1;
    }
  }
  return { processed: rows.length, succeeded, retried, blocked };
}

export async function retryBlockedObjectCleanup(input: { actionId: string; actorId: string; requestId: string }): Promise<{ reset: number; idempotentReplay: boolean }> {
  if (getStorageMode() === "memory-demo") return { reset: 0, idempotentReplay: false };
  await ensureDatabase();
  const d1 = getD1Binding()!;
  const detailHash = hash(JSON.stringify({ action: "RETRY_BLOCKED_CLEANUP" }));
  const eventId = `asset_maintenance_${crypto.randomUUID()}`;
  const [inserted, reset] = await d1.batch([
    d1.prepare("INSERT OR IGNORE INTO asset_maintenance_events (id, action_id, actor_id, action, detail_hash, request_id) VALUES (?, ?, ?, 'RETRY_BLOCKED_CLEANUP', ?, ?)").bind(eventId, input.actionId, input.actorId, detailHash, input.requestId),
    d1.prepare("UPDATE object_cleanup_tasks SET status = 'RETRY', next_attempt_at = unixepoch(), last_error_code = 'ADMIN_RETRY', updated_at = unixepoch() WHERE status = 'BLOCKED' AND EXISTS (SELECT 1 FROM asset_maintenance_events WHERE id = ?)").bind(eventId),
  ]);
  const replay = await d1.prepare("SELECT actor_id, detail_hash FROM asset_maintenance_events WHERE action_id = ?").bind(input.actionId).first<{ actor_id: string; detail_hash: string }>();
  if (!replay || replay.actor_id !== input.actorId || replay.detail_hash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。");
  return { reset: Number(reset.meta.changes), idempotentReplay: Number(inserted.meta.changes) === 0 };
}

export async function sweepExpiredAssets(limit = 100): Promise<{ scanned: number; deleted: number; blocked: number }> {
  if (getStorageMode() === "memory-demo") return { scanned: 0, deleted: 0, blocked: 0 };
  await ensureDatabase();
  const d1 = getD1Binding()!;
  const rows = (await d1.prepare("SELECT id, owner_id AS ownerId, moderation_status AS moderationStatus, moderation_action_id AS moderationActionId FROM assets WHERE status = 'READY' AND retention_expires_at IS NOT NULL AND retention_expires_at <= ? ORDER BY retention_expires_at LIMIT ?").bind(Math.floor(Date.now() / 1000), Math.max(1, Math.min(500, Math.floor(limit)))).all<{ id: string; ownerId: string; moderationStatus: string; moderationActionId: string | null }>()).results ?? [];
  let deleted = 0;
  let blocked = 0;
  for (const row of rows) {
    const rejected = row.moderationStatus === "REJECTED" && row.moderationActionId;
    const reviewer = rejected ? await d1.prepare("SELECT reviewer_id FROM asset_moderation_events WHERE action_id = ?").bind(row.moderationActionId).first<{ reviewer_id: string }>() : null;
    try { if (await requestOwnedAssetDeletion(row.ownerId, row.id, { actionId: rejected ? `moderation-delete:${row.moderationActionId}` : `retention:${row.id}`, source: rejected ? "MODERATION_REJECT" : "RETENTION_EXPIRY", actorId: reviewer?.reviewer_id ?? "system:retention" })) deleted += 1; }
    catch (error) { if (error instanceof ApiError && error.code === "ASSET_IN_ACTIVE_JOB") blocked += 1; else throw error; }
  }
  return { scanned: rows.length, deleted, blocked };
}

export async function sweepExpiredGallery(limit = 100): Promise<{ scanned: number; expired: number }> {
  if (getStorageMode() === "memory-demo") return { scanned: 0, expired: 0 };
  await ensureDatabase();
  const d1 = getD1Binding()!;
  const rows = await getDb().select().from(galleryItems).where(and(inArray(galleryItems.status, ["PENDING", "APPROVED"]), sql`${galleryItems.retentionExpiresAt} IS NOT NULL`, lte(galleryItems.retentionExpiresAt, Math.floor(Date.now() / 1000)))).orderBy(asc(galleryItems.retentionExpiresAt)).limit(Math.max(1, Math.min(500, Math.floor(limit))));
  let expired = 0;
  for (const row of rows) {
    const stamp = Math.floor(Date.now() / 1000), nextStatus = row.status === "PENDING" ? "REJECTED" : "REVOKED";
    const [result] = await d1.batch([
      d1.prepare("UPDATE gallery_items SET status = ?, rejected_at = CASE WHEN ? = 'REJECTED' THEN datetime(?, 'unixepoch') ELSE rejected_at END, revoked_at = CASE WHEN ? = 'REVOKED' THEN datetime(?, 'unixepoch') ELSE revoked_at END, updated_at = datetime(?, 'unixepoch') WHERE id = ? AND status = ? AND retention_expires_at <= ?").bind(nextStatus, nextStatus, stamp, nextStatus, stamp, stamp, row.id, row.status, stamp),
      d1.prepare("INSERT OR IGNORE INTO gallery_audit_events (id, action_id, gallery_id, actor_id, action, detail_hash) SELECT ?, ?, id, 'system:retention', 'EXPIRE', ? FROM gallery_items WHERE id = ? AND status = ? AND updated_at = datetime(?, 'unixepoch')").bind(`gallery_event_expire_${row.id}_${row.retentionExpiresAt}`, `expire:${row.id}:${row.retentionExpiresAt}`, hash(`EXPIRE:${row.id}:${row.retentionExpiresAt}`), row.id, nextStatus, stamp),
      d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_thumb_' || id, 'GALLERY', id, thumb_key FROM gallery_items WHERE id = ? AND status = ? AND updated_at = datetime(?, 'unixepoch')").bind(row.id, nextStatus, stamp),
      d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT 'cleanup_gallery_display_' || id, 'GALLERY', id, display_key FROM gallery_items WHERE id = ? AND status = ? AND updated_at = datetime(?, 'unixepoch')").bind(row.id, nextStatus, stamp),
    ]);
    if (Number(result.meta.changes) === 1) expired += 1;
  }
  return { scanned: rows.length, expired };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export async function getAssetLifecycleSummary() {
  if (getStorageMode() === "memory-demo") return { pendingModeration: 0, expiringAssets: 0, expiringGallery: 0, pendingCleanup: 0, retryCleanup: 0, blockedCleanup: 0 };
  await ensureDatabase();
  const row = await getD1Binding()!.prepare("SELECT (SELECT COUNT(*) FROM assets WHERE status = 'READY' AND moderation_status IN ('UNREVIEWED','PENDING')) AS pending_moderation, (SELECT COUNT(*) FROM assets WHERE status = 'READY' AND retention_expires_at IS NOT NULL AND retention_expires_at <= unixepoch()) AS expiring_assets, (SELECT COUNT(*) FROM gallery_items WHERE status IN ('PENDING','APPROVED') AND retention_expires_at IS NOT NULL AND retention_expires_at <= unixepoch()) AS expiring_gallery, (SELECT COUNT(*) FROM object_cleanup_tasks WHERE status = 'PENDING') AS pending_cleanup, (SELECT COUNT(*) FROM object_cleanup_tasks WHERE status = 'RETRY') AS retry_cleanup, (SELECT COUNT(*) FROM object_cleanup_tasks WHERE status = 'BLOCKED') AS blocked_cleanup").first<Record<string, number>>();
  return { pendingModeration: Number(row?.pending_moderation ?? 0), expiringAssets: Number(row?.expiring_assets ?? 0), expiringGallery: Number(row?.expiring_gallery ?? 0), pendingCleanup: Number(row?.pending_cleanup ?? 0), retryCleanup: Number(row?.retry_cleanup ?? 0), blockedCleanup: Number(row?.blocked_cleanup ?? 0) };
}
