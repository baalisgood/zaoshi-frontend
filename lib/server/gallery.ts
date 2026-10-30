import { identityNamespace } from "./user-identity";
import { and, desc, eq, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { galleryAuditEvents, galleryItems, generationJobOutputs, generationJobs, type GalleryCategory } from "@/db/schema";
import { getD1Binding, getDb, ensureDatabase, getR2Binding } from "@/db";
import { ASSET_RETENTION_POLICY, getStorageMode, getAsset, getAssetBytes, type PersistedAsset } from "@/lib/server/persistence";
import { ApiError, requireEnum } from "@/lib/server/api";
import { getRequestActor, type RequestActor } from "@/lib/server/actor";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { validateGalleryWebp } from "@/lib/server/gallery-webp";
import { isSiteAdmin } from "@/lib/server/admin";
import { IMAGE_SANITIZATION_VERSION, type ImageSanitizer } from "@/lib/platform/image-sanitizer";

export const GALLERY_CONSENT_VERSION = "2026-08-28-v1";
const categories = ["interior", "landscape", "architecture"] as const;
const statuses = ["PENDING", "APPROVED", "REJECTED", "REVOKED"] as const;
type GalleryRow = typeof galleryItems.$inferSelect;
type GalleryMemory = { rows: Map<string, GalleryRow>; blobs: Map<string, Uint8Array>; actions: Map<string, string> };
const MEMORY_KEY = Symbol.for("designer.memory-demo.gallery");

function memory(): GalleryMemory { const root = globalThis as typeof globalThis & { [MEMORY_KEY]?: GalleryMemory }; return root[MEMORY_KEY] ??= { rows: new Map(), blobs: new Map(), actions: new Map() }; }
function now() { return new Date().toISOString(); }
function id() { return `gallery_${crypto.randomUUID()}`; }
function storage() { return getStorageMode(); }
function bind(name: string): unknown { return readRuntimeBindings()[name]; }

export function assertGalleryMutation(request: Request, actor: RequestActor): void {
  if (!actor.user.authenticated || actor.trusted !== true) throw new ApiError(401, "AUTH_REQUIRED", "请先完成登录。");
  const origin = request.headers.get("origin");
  const expected = new URL(request.url); if (!origin || origin !== expected.origin || (expected.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(expected.hostname))) throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。");
}
export function assertGalleryIdentity(_request: Request, actor: RequestActor): void { if (!actor.user.authenticated || actor.trusted !== true) throw new ApiError(401, "AUTH_REQUIRED", "请先完成登录。"); }
export function isGalleryAdmin(actor: RequestActor): boolean {
  if (isSiteAdmin(actor, readRuntimeBindings())) return true;
  const email = actor.user.email?.trim().toLowerCase(); if (!email) return false;
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
  const allow = String(bind("GALLERY_ADMIN_EMAILS") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => validEmail.test(x));
  if (!validEmail.test(email)) return false;
  return allow.includes(email);
}
export function assertGalleryAdmin(request: Request, actor: RequestActor, write = false): void { if (write) assertGalleryMutation(request, actor); else assertGalleryIdentity(request, actor); if (!isGalleryAdmin(actor)) throw new ApiError(403, "ADMIN_FORBIDDEN", "没有图库审核权限。"); }

export type GalleryCursor = { v: 1; category: GalleryCategory | null; publishedAt: string; id: string };
export function encodeGalleryCursor(cursor: GalleryCursor): string { return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
export function decodeGalleryCursor(raw: string, category: GalleryCategory | null): GalleryCursor {
  try { const text = atob(raw.replaceAll("-", "+").replaceAll("_", "/")); const value = JSON.parse(text) as Partial<GalleryCursor>; if (value.v !== 1 || value.category !== category || typeof value.publishedAt !== "string" || typeof value.id !== "string") throw new Error(); return value as GalleryCursor; } catch { throw new ApiError(400, "INVALID_CURSOR", "分页游标无效。"); }
}
function publicItem(row: GalleryRow) { return { id: row.id, title: row.title, note: row.note, category: row.category, ...(row.promptConsentAt && row.publicPrompt ? { prompt: row.publicPrompt } : {}), publishedAt: row.publishedAt, width: row.width, height: row.height, thumbUrl: `/api/gallery/${encodeURIComponent(row.id)}/image?variant=thumb`, displayUrl: `/api/gallery/${encodeURIComponent(row.id)}/image?variant=display` }; }
export function serializePublicGalleryItem(row: GalleryRow) { return publicItem(row); }
export function serializeOwnerGalleryItem(row: GalleryRow) { return { id: row.id, title: row.title, note: row.note, category: row.category, status: row.status, submittedAt: row.submittedAt, publishedAt: row.publishedAt, reviewedAt: row.reviewedAt, reviewNote: row.reviewNote, width: row.width, height: row.height, sourceAssetId: row.sourceAssetId }; }
export function serializeAdminGalleryItem(row: GalleryRow) { return { id: row.id, category: row.category, title: row.title, note: row.note, publicPrompt: row.publicPrompt, status: row.status, submittedAt: row.submittedAt, reviewedAt: row.reviewedAt, publishedAt: row.publishedAt, rejectedAt: row.rejectedAt, revokedAt: row.revokedAt, updatedAt: row.updatedAt, reviewNote: row.reviewNote, width: row.width, height: row.height, thumbUrl: `/api/admin/gallery/${encodeURIComponent(row.id)}/image?variant=thumb`, displayUrl: `/api/admin/gallery/${encodeURIComponent(row.id)}/image?variant=display` }; }

export async function listPublicGallery(options: { category?: GalleryCategory; limit: number; cursor?: GalleryCursor }) {
  void options;
  return { items: [], nextCursor: null, hasCommunity: false, source: "demo" as const };
}

export function parseGalleryCategory(value: unknown): GalleryCategory { return requireEnum(value, "category", categories); }
export function parseGalleryLimit(value: string | null): number { const n = Number(value ?? "30"); if (!/^\d{1,2}$/u.test(value ?? "30") || !Number.isInteger(n) || n < 1 || n > 50) throw new ApiError(400, "INVALID_FIELD", "limit 必须是1到50之间的整数。"); return n; }

function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
async function sourceReady(ownerId: string, sourceId: string): Promise<PersistedAsset> { const asset = await getAsset(sourceId, ownerId); if (!asset || asset.kind !== "output") throw new ApiError(422, "INVALID_SOURCE", "只能投稿已完成的生成作品。"); if (asset.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) throw new ApiError(409, "ASSET_SANITIZATION_REQUIRED", "历史作品需要重新生成后才能投稿。"); if (asset.moderationStatus !== "APPROVED") throw new ApiError(409, "ASSET_REVIEW_REQUIRED", "作品通过内容审核后才能申请公开展示。"); if (storage() === "memory-demo") return asset; await ensureDatabase(); const [linked] = await getDb().select({ id: generationJobs.id }).from(generationJobOutputs).innerJoin(generationJobs, eq(generationJobs.id, generationJobOutputs.jobId)).where(and(eq(generationJobOutputs.assetId, sourceId), eq(generationJobs.ownerId, ownerId), eq(generationJobs.purpose, "final"), or(eq(generationJobs.status, "SUCCEEDED"), eq(generationJobs.status, "PARTIAL_SUCCEEDED"))!)).limit(1); if (!linked) throw new ApiError(422, "INVALID_SOURCE", "作品必须来自已完成的最终任务。"); return asset; }

export async function submitGallery(input: {
  ownerId: string;
  sourceAssetId: string;
  category: GalleryCategory;
  title: string;
  note: string;
  publicPrompt: string | null;
  imageConsent: string;
  promptConsent: boolean;
  sanitizer: ImageSanitizer;
}) {
  if (input.imageConsent !== GALLERY_CONSENT_VERSION) {
    throw new ApiError(400, "CONSENT_REQUIRED", "请确认最新的公开展示授权。");
  }
  const source = await sourceReady(input.ownerId, input.sourceAssetId);
  if (!input.sanitizer.deriveGalleryImages) throw new ApiError(503, "GALLERY_DERIVER_NOT_CONFIGURED", "服务端展示图处理尚未配置。");
  const { thumb, display } = await input.sanitizer.deriveGalleryImages(await getAssetBytes(source));
  if (thumb.byteLength > 5 * 1024 * 1024 || display.byteLength > 20 * 1024 * 1024) {
    throw new ApiError(413, "FILE_TOO_LARGE", "公开图片超过大小限制。");
  }
  validateGalleryWebp(thumb, 640);
  const displayInfo = validateGalleryWebp(display, 1920);
  const stamp = now();
  const galleryId = id();
  const thumbKey = `gallery/${input.ownerId}/${galleryId}/thumb.webp`;
  const displayKey = `gallery/${input.ownerId}/${galleryId}/display.webp`;
  const row: GalleryRow = {
    id: galleryId,
    ownerId: input.ownerId,
    sourceAssetId: source.id,
    category: input.category,
    title: input.title,
    note: input.note,
    publicPrompt: input.promptConsent ? input.publicPrompt : null,
    consentVersion: input.imageConsent,
    imageConsentAt: stamp,
    promptConsentAt: input.promptConsent ? stamp : null,
    thumbKey,
    displayKey,
    thumbMime: "image/webp",
    displayMime: "image/webp",
    thumbBytes: thumb.byteLength,
    displayBytes: display.byteLength,
    thumbSha256: sha(thumb),
    displaySha256: sha(display),
    width: displayInfo.width,
    height: displayInfo.height,
    status: "PENDING",
    submittedAt: stamp,
    reviewedAt: null,
    publishedAt: null,
    rejectedAt: null,
    revokedAt: null,
    updatedAt: stamp,
    reviewerOwnerId: null,
    reviewNote: null,
    retentionExpiresAt: Math.floor(Date.now() / 1000) + ASSET_RETENTION_POLICY.pendingGalleryDays * 86_400,
  };

  if (storage() === "memory-demo") {
    const active = [...memory().rows.values()].filter(
      (item) =>
        item.ownerId === input.ownerId &&
        (item.status === "PENDING" || item.status === "APPROVED"),
    );
    if (active.length >= 5) throw galleryQuotaError();
    if (active.some((item) => item.sourceAssetId === source.id)) {
      throw duplicateGalleryError();
    }
    memory().rows.set(row.id, row);
    memory().blobs.set(thumbKey, thumb.slice());
    memory().blobs.set(displayKey, display.slice());
    return row;
  }

  await ensureDatabase();
  const bucket = getR2Binding();
  if (!bucket) {
    throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "对象存储尚未配置。");
  }
  try {
    await bucket.put(thumbKey, thumb, galleryObjectOptions(row, "thumb"));
    await bucket.put(
      displayKey,
      display,
      galleryObjectOptions(row, "display"),
    );
    await insertGalleryRowWithQuota(row);
    return row;
  } catch (error) {
    await cleanupGalleryObjects(row);
    if (isUniqueViolation(error)) throw duplicateGalleryError();
    throw error;
  }
}
function isUniqueViolation(error: unknown): boolean { const text = error instanceof Error ? error.message : String(error); return /unique constraint|constraint failed.*uidx_gallery_active_source/i.test(text); }
function duplicateGalleryError(): ApiError {
  return new ApiError(409, "DUPLICATE_SOURCE", "该作品已经投稿。");
}
function galleryQuotaError(): ApiError {
  return new ApiError(
    409,
    "GALLERY_QUOTA",
    "最多只能保留5个待审核或已通过作品。",
  );
}
function galleryObjectOptions(row: GalleryRow, variant: "thumb" | "display") {
  return {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      galleryId: row.id,
      variant,
      sha256: variant === "thumb" ? row.thumbSha256 : row.displaySha256,
    },
  };
}
async function insertGalleryRowWithQuota(row: GalleryRow): Promise<void> {
  const d1 = getD1Binding();
  if (!d1) {
    throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "D1 存储尚未配置。");
  }
  const columns = [
    "id", "owner_id", "source_asset_id", "category", "title", "note",
    "public_prompt", "consent_version", "image_consent_at",
    "prompt_consent_at", "thumb_key", "display_key", "thumb_mime",
    "display_mime", "thumb_bytes", "display_bytes", "thumb_sha256",
    "display_sha256", "width", "height", "status", "submitted_at",
    "reviewed_at", "published_at", "rejected_at", "revoked_at",
    "updated_at", "reviewer_owner_id", "review_note", "retention_expires_at",
  ];
  const values = [
    row.id, row.ownerId, row.sourceAssetId, row.category, row.title, row.note,
    row.publicPrompt, row.consentVersion, row.imageConsentAt,
    row.promptConsentAt, row.thumbKey, row.displayKey, row.thumbMime,
    row.displayMime, row.thumbBytes, row.displayBytes, row.thumbSha256,
    row.displaySha256, row.width, row.height, row.status, row.submittedAt,
    row.reviewedAt, row.publishedAt, row.rejectedAt, row.revokedAt,
    row.updatedAt, row.reviewerOwnerId, row.reviewNote, row.retentionExpiresAt,
  ];
  const placeholders = columns.map(() => "?").join(", ");
  const statement = d1.prepare(
    `INSERT INTO gallery_items (${columns.join(", ")})
     SELECT ${placeholders}
     WHERE (SELECT COUNT(*) FROM gallery_items
            WHERE owner_id = ? AND status IN ('PENDING', 'APPROVED')) < 5
       AND NOT EXISTS (
         SELECT 1 FROM gallery_items
         WHERE source_asset_id = ? AND status IN ('PENDING', 'APPROVED')
       )`,
  );
  const result = await statement.bind(...values, row.ownerId, row.sourceAssetId).run();
  if (Number(result.meta.changes) > 0) return;
  const [duplicate] = await getDb()
    .select({ id: galleryItems.id })
    .from(galleryItems)
    .where(
      and(
        eq(galleryItems.sourceAssetId, row.sourceAssetId),
        or(
          eq(galleryItems.status, "PENDING"),
          eq(galleryItems.status, "APPROVED"),
        )!,
      ),
    )
    .limit(1);
  if (duplicate) throw duplicateGalleryError();
  throw galleryQuotaError();
}
async function cleanupGalleryObjects(row: GalleryRow): Promise<void> {
  if (storage() === "memory-demo") {
    memory().blobs.delete(row.thumbKey);
    memory().blobs.delete(row.displayKey);
    return;
  }
  const d1 = getD1Binding();
  if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "数据库尚未配置，展示图清理任务无法保存。");
  await d1.batch(galleryCleanupStatements(d1, row, null));
  await deleteGalleryObjects(row);
}
function galleryCleanupStatements(d1: D1Database, row: GalleryRow, actionId: string | null, enabled = true): D1PreparedStatement[] {
  return [[`cleanup_gallery_thumb_${row.id}`, row.thumbKey], [`cleanup_gallery_display_${row.id}`, row.displayKey]].map(([taskId, key]) => d1.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key) SELECT ?, 'GALLERY', ?, ? WHERE ? = 1 AND (? IS NULL OR EXISTS (SELECT 1 FROM gallery_audit_events WHERE action_id = ? AND gallery_id = ?))").bind(taskId, row.id, key, Number(enabled), actionId, actionId, row.id));
}
async function deleteGalleryObjects(row: GalleryRow): Promise<void> {
  const bucket = getR2Binding(), d1 = getD1Binding();
  if (!bucket || !d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "对象存储尚未配置，展示图将在恢复后清理。");
  const tasks = [[`cleanup_gallery_thumb_${row.id}`, row.thumbKey], [`cleanup_gallery_display_${row.id}`, row.displayKey]] as const;
  const results = await Promise.allSettled(tasks.map(([, key]) => bucket.delete(key)));
  await d1.batch(results.map((result, index) => result.status === "fulfilled"
    ? d1.prepare("UPDATE object_cleanup_tasks SET status = 'SUCCEEDED', attempt_count = attempt_count + 1, last_error_code = NULL, completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status IN ('PENDING','RETRY')").bind(tasks[index][0])
    : d1.prepare("UPDATE object_cleanup_tasks SET status = 'RETRY', attempt_count = attempt_count + 1, next_attempt_at = unixepoch() + 60, last_error_code = 'OBJECT_DELETE_FAILED', updated_at = unixepoch() WHERE id = ? AND status IN ('PENDING','RETRY')").bind(tasks[index][0])));
}

function galleryActionHash(input: { galleryId: string; actorId: string; action: string; note: string }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function findGalleryAction(actionId: string): Promise<{ detailHash: string } | null> {
  const [row] = await getDb().select({ detailHash: galleryAuditEvents.detailHash }).from(galleryAuditEvents).where(eq(galleryAuditEvents.actionId, actionId)).limit(1);
  return row ?? null;
}
async function verifyGalleryDerivatives(row: GalleryRow): Promise<void> {
  for (const variant of ["thumb", "display"] as const) {
    await readVerifiedGalleryDerivative(row, variant);
  }
}
async function readVerifiedGalleryDerivative(row: GalleryRow, variant: "thumb" | "display"): Promise<Uint8Array> {
  const key = variant === "thumb" ? row.thumbKey : row.displayKey;
  const expectedBytes = variant === "thumb" ? row.thumbBytes : row.displayBytes;
  const expectedSha = variant === "thumb" ? row.thumbSha256 : row.displaySha256;
  let bytes: Uint8Array | undefined;
  if (storage() === "memory-demo") bytes = memory().blobs.get(key)?.slice();
  else {
    const object = await getR2Binding()?.get(key);
    if (!object || object.httpMetadata?.contentType !== "image/webp" || object.customMetadata?.galleryId !== row.id || object.customMetadata?.variant !== variant || object.customMetadata?.sha256 !== expectedSha) throw invalidDerivativeError();
    bytes = new Uint8Array(await object.arrayBuffer());
  }
  if (!bytes || bytes.byteLength !== expectedBytes || sha(bytes) !== expectedSha) throw invalidDerivativeError();
  validateGalleryWebp(bytes, variant === "thumb" ? 640 : 1920);
  return bytes;
}
function invalidDerivativeError(): ApiError {
  return new ApiError(
    409,
    "INVALID_GALLERY_DERIVATIVE",
    "展示图片不完整，请撤回后重新投稿。",
  );
}
export async function getGalleryImage(_rowId: string, _variant: "thumb" | "display"): Promise<{ bytes: Uint8Array; mime: string } | null> { void _rowId; void _variant; return null; }
export async function getGalleryReviewImage(rowId: string, variant: "thumb" | "display") { let row: GalleryRow | undefined; if (storage() === "memory-demo") row = memory().rows.get(rowId); else { await ensureDatabase(); row = (await getDb().select().from(galleryItems).where(eq(galleryItems.id, rowId)).limit(1))[0]; } if (!row || row.status !== "PENDING" || row.revokedAt) return null; try { return { bytes: await readVerifiedGalleryDerivative(row, variant), mime: "image/webp" }; } catch { return null; } }
export async function listOwnerGallery(ownerId: string) { if (storage() === "memory-demo") return [...memory().rows.values()].filter((r) => r.ownerId === ownerId).sort((a,b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id)).slice(0, 100).map(serializeOwnerGalleryItem); await ensureDatabase(); return (await getDb().select().from(galleryItems).where(eq(galleryItems.ownerId, ownerId)).orderBy(desc(galleryItems.submittedAt), desc(galleryItems.id)).limit(100)).map(serializeOwnerGalleryItem); }
export async function revokeGallery(ownerId: string, rowId: string, actionId: string): Promise<boolean> {
  const stamp = now(), detailHash = galleryActionHash({ galleryId: rowId, actorId: storage() === "memory-demo" ? ownerId : await identityNamespace(getD1Binding()!, ownerId), action: "REVOKE", note: "" });
  if (storage() === "memory-demo") { const replay = memory().actions.get(actionId); if (replay) { if (replay !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return true; } const row = memory().rows.get(rowId); if (!row || row.ownerId !== ownerId || ["REVOKED", "REJECTED"].includes(row.status)) return false; memory().rows.set(rowId, { ...row, status: "REVOKED", revokedAt: stamp, updatedAt: stamp, retentionExpiresAt: Math.floor(Date.now() / 1000) }); memory().actions.set(actionId, detailHash); await cleanupGalleryObjects(row); return true; }
  await ensureDatabase(); const replay = await findGalleryAction(actionId); if (replay) { if (replay.detailHash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return true; }
  const [row] = await getDb().select().from(galleryItems).where(and(eq(galleryItems.id, rowId), eq(galleryItems.ownerId, ownerId))).limit(1); if (!row || ["REVOKED", "REJECTED"].includes(row.status)) return false;
  const d1 = getD1Binding()!; let result: D1Result;
  try { [result] = await d1.batch([
    d1.prepare("UPDATE gallery_items SET status = 'REVOKED', revoked_at = ?, updated_at = ?, retention_expires_at = unixepoch() WHERE id = ? AND owner_id = ? AND status IN ('PENDING','APPROVED')").bind(stamp, stamp, rowId, ownerId),
    d1.prepare("INSERT INTO gallery_audit_events (id, action_id, gallery_id, actor_id, action, detail_hash) SELECT ?, ?, ?, ?, 'REVOKE', ? WHERE EXISTS (SELECT 1 FROM gallery_items WHERE id = ? AND owner_id = ? AND status = 'REVOKED' AND revoked_at = ?)").bind(`gallery_event_${crypto.randomUUID()}`, actionId, rowId, ownerId, detailHash, rowId, ownerId, stamp),
    ...galleryCleanupStatements(d1, row, actionId),
  ]); } catch (error) { const concurrent = await findGalleryAction(actionId); if (!concurrent) throw error; if (concurrent.detailHash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return true; }
  if (Number(result.meta.changes) > 0) { await deleteGalleryObjects(row); return true; }
  const concurrent = await findGalleryAction(actionId); if (concurrent?.detailHash === detailHash) return true; if (concurrent) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return false;
}
export async function revokeMemoryGalleryBySource(ownerId: string, sourceAssetId: string): Promise<void> { for (const row of memory().rows.values()) if (row.ownerId === ownerId && row.sourceAssetId === sourceAssetId && (row.status === "PENDING" || row.status === "APPROVED")) { const stamp = now(); memory().rows.set(row.id, { ...row, status: "REVOKED", revokedAt: stamp, updatedAt: stamp, retentionExpiresAt: Math.floor(Date.now() / 1000) }); await cleanupGalleryObjects(row); } }
export async function listAdminGallery() { if (storage() === "memory-demo") return [...memory().rows.values()].filter((r) => r.status === "PENDING").sort((a,b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id)).slice(0, 100).map(serializeAdminGalleryItem); await ensureDatabase(); return (await getDb().select().from(galleryItems).where(eq(galleryItems.status, "PENDING")).orderBy(desc(galleryItems.submittedAt), desc(galleryItems.id)).limit(100)).map(serializeAdminGalleryItem); }
export async function reviewGallery(rowId: string, reviewerOwnerId: string, approve: boolean, reviewNote: string, actionId: string) {
  const stamp = now();
  const action = approve ? "APPROVE" : "REJECT";
  const detailHash = galleryActionHash({ galleryId: rowId, actorId: storage() === "memory-demo" ? reviewerOwnerId : await identityNamespace(getD1Binding()!, reviewerOwnerId), action, note: reviewNote });
  if (storage() === "memory-demo") {
    const replay = memory().actions.get(actionId); if (replay) { if (replay !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return; }
    const row = memory().rows.get(rowId);
    if (!row || row.status !== "PENDING") throw new ApiError(409, "INVALID_STATE", "作品不在待审核状态。");
    if (approve) await verifyGalleryDerivatives(row);
    const current = memory().rows.get(rowId);
    if (!current || current.status !== "PENDING") throw new ApiError(409, "INVALID_STATE", "作品不在待审核状态。");
    memory().rows.set(rowId, { ...current, status: approve ? "APPROVED" : "REJECTED", reviewedAt: stamp, publishedAt: approve ? stamp : null, rejectedAt: approve ? null : stamp, revokedAt: approve ? null : stamp, reviewerOwnerId, reviewNote, updatedAt: stamp, retentionExpiresAt: approve ? Math.floor(Date.now() / 1000) + ASSET_RETENTION_POLICY.approvedGalleryDays * 86_400 : Math.floor(Date.now() / 1000) }); memory().actions.set(actionId, detailHash);
    if (!approve) await cleanupGalleryObjects(current);
    return;
  }
  await ensureDatabase();
  const replay = await findGalleryAction(actionId); if (replay) { if (replay.detailHash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return; }
  const [row] = await getDb().select().from(galleryItems).where(and(eq(galleryItems.id, rowId), eq(galleryItems.status, "PENDING"))).limit(1);
  if (!row) throw new ApiError(409, "INVALID_STATE", "作品不在待审核状态。");
  if (approve) await verifyGalleryDerivatives(row);
  const d1 = getD1Binding()!; let result: D1Result;
  try { [result] = await d1.batch([
    d1.prepare("UPDATE gallery_items SET status = ?, reviewed_at = ?, published_at = ?, rejected_at = ?, revoked_at = ?, reviewer_owner_id = ?, review_note = ?, updated_at = ?, retention_expires_at = ? WHERE id = ? AND status = 'PENDING'").bind(approve ? "APPROVED" : "REJECTED", stamp, approve ? stamp : null, approve ? null : stamp, approve ? null : stamp, reviewerOwnerId, reviewNote, stamp, Math.floor(Date.now() / 1000) + (approve ? ASSET_RETENTION_POLICY.approvedGalleryDays * 86_400 : 0), rowId),
    d1.prepare("INSERT INTO gallery_audit_events (id, action_id, gallery_id, actor_id, action, detail_hash) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gallery_items WHERE id = ? AND reviewer_owner_id = ? AND reviewed_at = ?)").bind(`gallery_event_${crypto.randomUUID()}`, actionId, rowId, reviewerOwnerId, action, detailHash, rowId, reviewerOwnerId, stamp),
    ...galleryCleanupStatements(d1, row, actionId, !approve),
  ]); } catch (error) { const concurrent = await findGalleryAction(actionId); if (!concurrent) throw error; if (concurrent.detailHash !== detailHash) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); return; }
  if (Number(result.meta.changes) < 1) { const concurrent = await findGalleryAction(actionId); if (concurrent?.detailHash === detailHash) return; if (concurrent) throw new ApiError(409, "ACTION_CONFLICT", "操作编号已用于其他请求。"); throw new ApiError(409, "INVALID_STATE", "作品不在待审核状态。"); }
  if (!approve) await deleteGalleryObjects(row);
}
export { categories, statuses, getRequestActor };
