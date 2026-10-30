"use client";

import { loadSession } from "@/components/site/session";
import { localEditOptions, parseLocalEditInstruction, localEditUsesPrompt } from "@/lib/domain/local-edit";
import type { UploadedImage } from "@/components/studio/StudioFields";
import { AssetUploadError, deleteAsset, GenerationSubmissionError, submitGeneration, uploadAsset, type JobSnapshot } from "@/components/site/api";
import { imageModelCapabilities, normalizeImageModel } from "@/lib/domain/image-models";

const DB_NAME = "zaoshi-studio-drafts";
const STORE_NAME = "images";
const SESSION_KEY = "zaoshi:draft-session";
const PARAMETER_PREFIX = "zaoshi:draft:";
const OWNER_SCOPE_KEY = "zaoshi:draft-owner";
const PENDING_PREFIX = "zaoshi:pending-submit:";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const registry = new Map<string, { file: File; kind: string; uploadKey: string; width: number; height: number }>();
const uploaded = new Map<string, Awaited<ReturnType<typeof uploadAsset>>>();
const previews = new Map<string, string>();
const mutations = new Map<string, Promise<unknown>>();
let pruned = false;
let draftEpoch = 0;
export function captureDraftSession(): () => boolean {
  const epoch = draftEpoch; const id = sessionId(); const owner = currentDraftScope();
  return () => epoch === draftEpoch && sessionStorage.getItem(SESSION_KEY) === id && currentDraftScope() === owner;
}
const channel = typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("zaoshi-drafts");

type StoredImage = { id: string; sessionId: string; draftKey: string; kind: string; file: File; width: number; height: number; uploadKey?: string; savedAt?: number };
type PendingSubmit = { idempotencyKey: string; draftScope?: string; resolvedPayload?: Record<string, unknown>; created: { localId: string; assetId: string }[]; confirmedAt?: number; savedAt: number };

function sessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, id); }
  return id;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => {
      const db = request.result;
      if (pruned) { resolve(db); return; }
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const cursor = transaction.objectStore(STORE_NAME).openCursor();
      cursor.onsuccess = () => { const row = cursor.result; if (!row) return; const value = row.value as StoredImage; if (!value.savedAt || Date.now() - value.savedAt >= DRAFT_TTL_MS) row.delete(); row.continue(); };
      transaction.oncomplete = () => { pruned = true; resolve(db); };
      transaction.onerror = transaction.onabort = () => { pruned = false; reject(transaction.error ?? new Error("浏览器草稿清理失败。")); };
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开浏览器草稿库。"));
  });
}

async function storeRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const epoch = draftEpoch; const owner = currentDraftScope();
  const db = await openDatabase();
  try {
    if (epoch !== draftEpoch || owner !== currentDraftScope()) throw new Error("图片选择已失效，原图片仍保留。");
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("浏览器草稿操作失败。"));
    });
  } finally { db.close(); }
}

async function mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutations.set(id, next);
  try { return await next; } finally { if (mutations.get(id) === next) mutations.delete(id); }
}

function forgetUploads(id: string) { for (const key of uploaded.keys()) if (key.startsWith(`${id}:`)) uploaded.delete(key); }
function forgetPreview(id: string) { const url = previews.get(id); if (url) URL.revokeObjectURL(url); previews.delete(id); }
function cacheKey(id: string, variant: string) { return `${id}:${variant}`; }

export async function saveDraftImage(draftKey: string, kind: string, file: File, width: number, height: number, previewUrl?: string, stillAllowed?: () => boolean): Promise<UploadedImage> {
  const sessionCurrent = captureDraftSession();
  const allowed = () => sessionCurrent() && (!stillAllowed || stillAllowed());
  const id = `local:${sessionId()}:${draftKey}`;
  const stored: StoredImage = { id, sessionId: sessionId(), draftKey, kind, file, width, height, uploadKey: crypto.randomUUID(), savedAt: Date.now() };
  let previous: StoredImage | undefined;
  const restore = async () => { if (!sessionCurrent()) return; const current = await storeRequest<StoredImage | undefined>("readonly", (store) => store.get(id)); if (sessionCurrent() && current?.uploadKey === stored.uploadKey) { if (previous) await storeRequest("readwrite", (store) => store.put(previous)); else await storeRequest("readwrite", (store) => store.delete(id)); } };
  await mutate(id, async () => {
    previous = await storeRequest<StoredImage | undefined>("readonly", (store) => store.get(id));
    if (!allowed()) throw new Error("图片选择已失效，原图片仍保留。");
    await storeRequest("readwrite", (store) => store.put(stored));
    if (!allowed()) { await restore(); throw new Error("图片选择已失效，原图片仍保留。"); }
  });
  if (!allowed()) { await mutate(id, restore); throw new Error("图片选择已失效，原图片仍保留。"); }
  const resolvedPreviewUrl = previewUrl ?? URL.createObjectURL(file);
  forgetUploads(id); forgetPreview(id); previews.set(id, resolvedPreviewUrl);
  registry.set(id, { file, kind, uploadKey: stored.uploadKey!, width, height });
  return { id, kind, url: resolvedPreviewUrl, fileName: file.name, mimeType: file.type, byteSize: file.size, width, height, local: true, draftVersion: stored.uploadKey };
}

export async function loadDraftImage(draftKey: string): Promise<UploadedImage | undefined> {
  const sessionCurrent = captureDraftSession();
  const id = `local:${sessionId()}:${draftKey}`;
  const stored = await mutate(id, async () => {
    const value = await storeRequest<StoredImage | undefined>("readonly", (store) => store.get(id));
    if (!sessionCurrent() || !value) return undefined;
    if (!value.savedAt || Date.now() - value.savedAt >= DRAFT_TTL_MS) {
      await storeRequest("readwrite", (store) => store.delete(id));
      return undefined;
    }
    if (value?.file && !value.uploadKey) {
      const uploadKey = crypto.randomUUID();
      await storeRequest("readwrite", (store) => store.put({ ...value, uploadKey, savedAt: Date.now() }));
      return { ...value, uploadKey };
    }
    return value;
  });
  if (!sessionCurrent() || !stored?.file) return undefined;
  const uploadKey = stored.uploadKey!;
  registry.set(id, { file: stored.file, kind: stored.kind, uploadKey, width: stored.width, height: stored.height });
  forgetPreview(id); const url = URL.createObjectURL(stored.file); previews.set(id, url);
  return { id, kind: stored.kind, url, fileName: stored.file.name, mimeType: stored.file.type, byteSize: stored.file.size, width: stored.width, height: stored.height, local: true, draftVersion: uploadKey };
}

export async function removeDraftImage(draftKey: string): Promise<void> {
  const id = `local:${sessionId()}:${draftKey}`;
  registry.delete(id); forgetUploads(id); forgetPreview(id);
  await mutate(id, () => storeRequest("readwrite", (store) => store.delete(id)));
}

export function localDraft(id: string): { file: File; kind: string; uploadKey: string; width: number; height: number } | undefined { return registry.get(id); }

async function rotateUploadKey(id: string): Promise<{ file: File; kind: string; uploadKey: string; width: number; height: number }> {
  return mutate(id, async () => {
    const draft = registry.get(id);
    if (!draft) throw new Error("当前标签页的图片草稿已失效，请重新选择图片。");
    const uploadKey = crypto.randomUUID();
    const stored = await storeRequest<StoredImage | undefined>("readonly", (store) => store.get(id));
    if (stored) await storeRequest("readwrite", (store) => store.put({ ...stored, uploadKey, savedAt: Date.now() }));
    const next = { ...draft, uploadKey }; registry.set(id, next); forgetUploads(id); return next;
  });
}

async function uploadDraftVariant(id: string, draft: { file: File; kind: string; uploadKey: string }, file: File, variant: string, draftScope: string) {
  try { return await uploadAsset(file, draft.kind, `${draft.uploadKey}:${variant}`, draftScope); }
  catch (error) {
    if (!(error instanceof AssetUploadError) || error.code !== "UPLOAD_IDEMPOTENCY_EXPIRED") throw error;
    const fresh = await rotateUploadKey(id);
    return uploadAsset(file, fresh.kind, `${fresh.uploadKey}:${variant}`, draftScope);
  }
}

export async function ensureUploadedDraftImage(image: UploadedImage): Promise<UploadedImage> {
  if (!image.local) return image;
  if (await syncBrowserDraftScope()) throw new Error("登录账号已经变化，本地草稿已清除，请重新选择图片。");
  const draftScope = currentDraftScope();
  if (!draftScope) throw new Error("无法确认当前登录账号，本地草稿上传已停止。");
  const key = cacheKey(image.id, "raw"); const cached = uploaded.get(key); if (cached) return { ...cached, width: image.width, height: image.height };
  const draft = localDraft(image.id); if (!draft) throw new Error("当前标签页的图片草稿已失效，请重新选择图片。");
  const asset = await uploadDraftVariant(image.id, draft, draft.file, "raw", draftScope); uploaded.set(key, asset);
  return { ...asset, width: image.width, height: image.height };
}

async function pngCopy(file: File): Promise<File> {
  if (file.type !== "image/webp") return file;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("WebP 转换失败。")), "image/png"));
    return new File([blob], file.name.replace(/\.webp$/iu, ".png"), { type: "image/png" });
  } finally { bitmap.close(); }
}

const assetFields = ["sourceAssetId", "referenceAssetId", "maskAssetId", "depthAssetId", "normalAssetId"] as const;
function localIds(payload: Record<string, unknown>): string[] {
  const values = assetFields.map((field) => payload[field]);
  if (Array.isArray(payload.additionalReferences)) values.push(...payload.additionalReferences.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).assetId : undefined));
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.startsWith("local:")))];
}

function providerLocalIds(payload: Record<string, unknown>): Set<string> {
  const value = { ...payload, maskAssetId: undefined };
  return new Set(localIds(value));
}

export function providerInputCount(payload: Record<string, unknown>): number {
  const direct = assetFields.filter((field) => field !== "maskAssetId" && typeof payload[field] === "string" && Boolean(payload[field])).length;
  const additional = Array.isArray(payload.additionalReferences) ? payload.additionalReferences.filter((item) => item && typeof item === "object" && typeof item.assetId === "string" && Boolean(item.assetId)).length : 0;
  return direct + additional;
}

export function submittedParameterSummary(payload: Record<string, unknown>): string {
  const labels: Record<string, string> = { spaceType: "空间类型", stylePresetId: "风格编号", designSchemeId: "设计方案", lightingPreset: "光照时段", lampState: "灯具状态", preservationMode: "保留策略", visualRealism: "视觉表现", colorTemperatureKelvin: "色温", aspectRatio: "画面比例", quality: "质量", advancedSettings: "高级设置", customPrompt: "自定义提示词", editInstruction: "局部修改说明" };
  const operation = parseLocalEditInstruction(payload.editInstruction);
  const local = operation && Array.isArray(payload.additionalReferences) && payload.additionalReferences.some((entry) => entry?.role === "selection");
  const fields = Object.entries(labels).flatMap(([key, label]) => {
    if (local && ["spaceType", "lightingPreset", "lampState", "preservationMode", "visualRealism", "colorTemperatureKelvin", "advancedSettings"].includes(key)) return [];
    if (local && key === "editInstruction") return [`局部修改：${localEditUsesPrompt(payload.editInstruction) && typeof payload.customPrompt === "string" && payload.customPrompt.trim() ? "按提示词修改" : localEditOptions.find((option) => option.value === operation)?.label}`];
    const value = key === "quality" && payload.purpose === "preview" ? "draft" : payload[key];
    return value === undefined || value === null || value === "" ? [] : [`${label}：${typeof value === "object" ? JSON.stringify(value) : String(value)}`];
  });
  return fields.length ? fields.join("\n") : "无额外参数";
}

function replaceLocalIds(payload: Record<string, unknown>, replacements: Map<string, string>): Record<string, unknown> {
  const result = { ...payload };
  for (const field of assetFields) if (typeof result[field] === "string") result[field] = replacements.get(result[field] as string) ?? result[field];
  if (Array.isArray(result.additionalReferences)) result.additionalReferences = result.additionalReferences.map((item) => item && typeof item === "object" ? { ...item as Record<string, unknown>, assetId: replacements.get(String((item as Record<string, unknown>).assetId)) ?? (item as Record<string, unknown>).assetId } : item);
  return result;
}

async function fingerprint(payload: Record<string, unknown>): Promise<string> {
  const value: Record<string, unknown> = { ...payload, __localUploadKeys: localIds(payload).map((id) => [id, localDraft(id)?.uploadKey ?? null]) }; delete value.idempotencyKey;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function currentDraftScope(): string | undefined { try { const value = localStorage.getItem(OWNER_SCOPE_KEY); return value || undefined; } catch { return undefined; } }
function pendingSubmit(key: string, fallbackKey: string): PendingSubmit {
  let stored: string | null;
  try { stored = localStorage.getItem(`${PENDING_PREFIX}${key}`); }
  catch { throw new Error("浏览器本地存储不可用，为避免重复任务，本次生成已停止。请允许本站存储后重试。"); }
  if (stored) {
    try { const value = JSON.parse(stored) as PendingSubmit; if (Date.now() - value.savedAt < DRAFT_TTL_MS) return value; localStorage.removeItem(`${PENDING_PREFIX}${key}`); }
    catch { /* Replace a damaged recovery record before any upload starts. */ }
  }
  return { idempotencyKey: fallbackKey, draftScope: currentDraftScope(), created: [], savedAt: Date.now() };
}

function savePending(key: string, value: PendingSubmit) { try { localStorage.setItem(`${PENDING_PREFIX}${key}`, JSON.stringify(value)); } catch { throw new Error("浏览器本地存储不可用，为避免重复任务，本次生成已停止。请允许本站存储后重试。"); } }
function clearPending(key: string) { try { localStorage.removeItem(`${PENDING_PREFIX}${key}`); } catch { /* The accepted server task remains authoritative. */ } }
export function requiresFreshPaidConfirmation(_confirmedAt: number | undefined, privateTest: boolean): boolean { return privateTest; }
export function shouldRecoverPendingSubmissions(origin: string, responseOk: boolean, authMode?: string): boolean {
  return origin !== "http://127.0.0.1:3000" && responseOk && (authMode === "demo" || authMode === "wechat");
}

export async function privateTestModeForSubmission(origin: string, confirmedAt: number | undefined, fetchMe: typeof fetch = fetch): Promise<boolean> {
  if (confirmedAt && origin !== "http://127.0.0.1:3000") return false;
  try {
    const response = await fetchMe("/api/me", { cache: "no-store" });
    if (!response.ok) throw new Error("Mode unavailable");
    return (await response.json() as { authMode?: string }).authMode === "private-test";
  } catch {
    if (origin === "http://127.0.0.1:3000") throw new Error("无法确认 SSH 私测状态；为避免重复付费，本次提交已停止。");
    return false;
  }
}
function definiteSubmissionRejection(error: unknown) { return error instanceof GenerationSubmissionError && (error.status >= 400 && error.status < 500 || ["GENERATION_QUEUE_NOT_READY", "PROVIDER_NOT_CONFIGURED", "PERSISTENT_QUEUE_REQUIRED"].includes(error.code ?? "")); }
function invalidatedAssetError(error: unknown) { return error instanceof GenerationSubmissionError && ["ASSET_NOT_FOUND", "ASSET_SANITIZATION_REQUIRED", "ASSET_INTEGRITY_FAILED"].includes(error.code ?? ""); }
async function invalidateLocalAssets(payload: Record<string, unknown>) { await Promise.allSettled(localIds(payload).map(async (id) => { forgetUploads(id); await rotateUploadKey(id); })); }

export async function submitGenerationDraft(payload: Record<string, unknown>): Promise<JobSnapshot> {
  // submitGenerationDraft uploads local files with uploadAsset before submitGeneration.
  if (await syncBrowserDraftScope()) throw new Error("登录账号已经变化，本地草稿已清除，请重新选择图片。");
  const draftScope = currentDraftScope();
  if (!draftScope) throw new Error("无法确认当前登录账号，本地草稿上传已停止。");
  const model = normalizeImageModel(payload.providerPreference);
  const capability = imageModelCapabilities[model];
  const ids = localIds(payload);
  const providerIds = providerLocalIds(payload);
  const variant = model;
  const selected = ids.map((id) => ({ id, cached: uploaded.get(cacheKey(id, variant)), draft: localDraft(id) }));
  const providerSelected = selected.filter((item) => providerIds.has(item.id));
  if (selected.some((item) => !item.cached && !item.draft)) throw new Error("当前标签页的图片草稿已失效，请重新选择图片。");
  const totalBytes = providerSelected.reduce((sum, item) => sum + (item.cached?.byteSize ?? item.draft?.file.size ?? 0), 0);
  if (providerIds.size > capability.maxInputImages) throw new Error(`当前模型最多支持 ${capability.maxInputImages} 张输入图片。`);
  if (providerSelected.some((item) => (item.cached?.byteSize ?? item.draft?.file.size ?? 0) > capability.maxImageBytes) || totalBytes > capability.maxTotalImageBytes) throw new Error("输入图片体积超过当前模型限制，请压缩后重试。");
  const submitFingerprint = await fingerprint(payload);
  const fallbackKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : crypto.randomUUID();
  let pending = pendingSubmit(submitFingerprint, fallbackKey);
  const scope = draftScope;
  if (!scope || pending.draftScope !== scope) {
    clearPending(submitFingerprint);
    pending = { idempotencyKey: crypto.randomUUID(), draftScope: scope, created: [], savedAt: Date.now() };
  }
  pending.draftScope = pending.draftScope ?? scope;
  if (pending.resolvedPayload) pending.resolvedPayload = { ...pending.resolvedPayload, draftScope: pending.draftScope };
  const privateTest = await privateTestModeForSubmission(window.location.origin, pending.confirmedAt);
  if (requiresFreshPaidConfirmation(pending.confirmedAt, privateTest)) {
    const label = imageModelCapabilities[model].label;
    const preview = payload.purpose === "preview";
    const purpose = preview ? "参考图" : "成品图";
    const credits = Number(payload.expectedTotalCredits);
    if (!Number.isSafeInteger(credits) || credits < 1 || typeof payload.expectedPriceVersion !== "string") throw new Error("请等待服务端报价后再提交，图片尚未上传。");
    const resolution = preview ? capability.supportedResolutions[0] : String(payload.resolution);
    const outputCount = preview ? 1 : Number(payload.outputCount);
    if (!Number.isSafeInteger(outputCount) || outputCount < 1 || !(capability.supportedResolutions as readonly string[]).includes(resolution)) throw new Error("输出规格与服务端报价不一致，图片尚未上传。");
    const workflow = ({ concept: "概念", advanced: "高级", floorplan: "平面图", "self-service": "自助" } as Record<string, string>)[String(payload.workflowType)] ?? "未知";
    const charge = privateTest ? "开发者私测免积分；供应商 API 费用另计，金额取决于所选模型、尺寸、质量和输入图。" : `本站预计扣除：${credits} 积分\n供应商 API 费用另计，积分不是人民币账单上限。`;
    const siteQuote = privateTest && payload.billingMode === "private-test-reservation" ? "开发者私测免积分" : `本站总报价：${credits} 积分`;
    if (!window.confirm(`确认付费生成？\n\n工作台：${workflow}\n模型：${label}\n类型：${purpose}\n实际提交参数：\n${submittedParameterSummary(payload)}\n输入图：${providerInputCount(payload)} 张\n实际输出：${outputCount} 张 · ${resolution}${privateTest ? "（逐张执行、同时仅1张）" : ""}\n${siteQuote}\n${charge}\n\n确认后才会上传图片并进入任务队列。`)) throw new Error("已取消本次生成，图片未上传、任务未创建。");
    pending.confirmedAt = Date.now();
  }
  savePending(submitFingerprint, pending);
  if (pending.resolvedPayload) {
    try { const job = await submitGeneration(pending.resolvedPayload); clearPending(submitFingerprint); return job; }
    catch (error) { if (invalidatedAssetError(error)) await invalidateLocalAssets(payload); if (definiteSubmissionRejection(error)) { for (const item of pending.created) forgetUploads(item.localId); await Promise.allSettled(pending.created.map((item) => deleteAsset(item.assetId))); clearPending(submitFingerprint); } throw error; }
  }
  const replacements = new Map<string, string>();
  const created: { localId: string; assetId: string }[] = [];
  let preparedBytes = providerSelected.filter((item) => item.cached).reduce((sum, item) => sum + (item.cached?.byteSize ?? 0), 0);
  try {
    for (const id of ids) {
      const key = cacheKey(id, variant); const cached = uploaded.get(key);
      if (cached) { replacements.set(id, cached.id); continue; }
      const draft = localDraft(id);
      if (!draft) throw new Error("当前标签页的图片草稿已失效，请重新选择图片。");
      const file = capability.provider === "seedream" ? await pngCopy(draft.file) : draft.file;
      if (providerIds.has(id)) {
        preparedBytes += file.size;
        if (file.size > capability.maxImageBytes || preparedBytes > capability.maxTotalImageBytes) throw new Error("转换后的输入图片体积超过当前模型限制，请压缩后重试。");
      }
      const asset = await uploadDraftVariant(id, draft, file, variant, draftScope);
      uploaded.set(key, asset); replacements.set(id, asset.id); if (asset.created === true) created.push({ localId: id, assetId: asset.id });
    }
  } catch (error) {
    for (const item of created) uploaded.delete(cacheKey(item.localId, variant));
    await Promise.allSettled(created.map((item) => deleteAsset(item.assetId)));
    clearPending(submitFingerprint);
    throw error;
  }
  pending.resolvedPayload = { ...replaceLocalIds(payload, replacements), idempotencyKey: pending.idempotencyKey, draftScope: pending.draftScope };
  pending.created = created;
  try { savePending(submitFingerprint, pending); }
  catch (error) { for (const item of created) uploaded.delete(cacheKey(item.localId, variant)); await Promise.allSettled(created.map((item) => deleteAsset(item.assetId))); clearPending(submitFingerprint); throw error; }
  if (await syncBrowserDraftScope()) throw new Error("登录账号已经变化，本地草稿已清除，请重新选择图片。");
  try { const job = await submitGeneration(pending.resolvedPayload); clearPending(submitFingerprint); return job; }
  catch (error) {
    if (invalidatedAssetError(error)) await invalidateLocalAssets(payload);
    if (definiteSubmissionRejection(error)) {
      for (const item of created) uploaded.delete(cacheKey(item.localId, variant));
      await Promise.allSettled(created.map((item) => deleteAsset(item.assetId)));
      clearPending(submitFingerprint);
    }
    throw error;
  }
}

export function saveParameterDraft(workflow: string, value: Record<string, unknown>): void {
  sessionStorage.setItem(`${PARAMETER_PREFIX}${workflow}`, JSON.stringify({ savedAt: Date.now(), value }));
}

export function loadParameterDraft(workflow: string): Record<string, unknown> | undefined {
  try {
    const key = `${PARAMETER_PREFIX}${workflow}`; const raw = sessionStorage.getItem(key); if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; value?: unknown };
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt >= DRAFT_TTL_MS || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) { sessionStorage.removeItem(key); return undefined; }
    return parsed.value as Record<string, unknown>;
  } catch { try { sessionStorage.removeItem(`${PARAMETER_PREFIX}${workflow}`); } catch { /* Storage may be blocked. */ } return undefined; }
}

function clearSessionValues() {
  draftEpoch++;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("zaoshi:drafts-cleared"));
  for (const key of Object.keys(sessionStorage)) if (key === SESSION_KEY || key.startsWith(PARAMETER_PREFIX)) sessionStorage.removeItem(key);
  registry.clear(); uploaded.clear(); for (const url of previews.values()) URL.revokeObjectURL(url); previews.clear();
}

let reloadScheduled = false;
function clearFromOtherTab() { clearSessionValues(); if (!reloadScheduled && typeof window !== "undefined") { reloadScheduled = true; window.location.reload(); } }
channel?.addEventListener("message", (event) => { if (event.data === "clear") clearFromOtherTab(); });
if (typeof window !== "undefined") window.addEventListener("storage", (event) => { if (event.key === OWNER_SCOPE_KEY) clearFromOtherTab(); });

export async function clearBrowserDrafts(): Promise<void> {
  clearSessionValues();
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(PENDING_PREFIX)) localStorage.removeItem(key); } catch { /* Storage may be blocked. */ }
  channel?.postMessage("clear");
  await storeRequest("readwrite", (store) => store.clear());
}

export async function syncBrowserDraftScope(): Promise<boolean> {
  const value = await loadSession(true);
  if (typeof value.draftScope !== "string") throw new Error("无法确认当前登录账号，请刷新后重试。");
  let previous: string | null = null;
  try { previous = localStorage.getItem(OWNER_SCOPE_KEY); } catch { previous = sessionStorage.getItem(OWNER_SCOPE_KEY); }
  if (!previous) { try { localStorage.setItem(OWNER_SCOPE_KEY, value.draftScope); } catch { sessionStorage.setItem(OWNER_SCOPE_KEY, value.draftScope); } return false; }
  if (previous === value.draftScope) return false;
  await clearBrowserDrafts();
  try { localStorage.setItem(OWNER_SCOPE_KEY, value.draftScope); } catch { sessionStorage.setItem(OWNER_SCOPE_KEY, value.draftScope); }
  return true;
}

let recoveryPromise: Promise<void> | undefined;
export function recoverPendingSubmissions(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    const scope = currentDraftScope();
    if (!scope) return;
    let keys: string[];
    try { keys = Object.keys(localStorage).filter((key) => key.startsWith(PENDING_PREFIX)); } catch { return; }
    for (const key of keys) {
      let pending: PendingSubmit | undefined;
      try { pending = JSON.parse(localStorage.getItem(key) ?? "") as PendingSubmit; } catch { try { localStorage.removeItem(key); } catch { /* Storage may be blocked. */ } continue; }
      if (!pending || typeof pending.savedAt !== "number" || Date.now() - pending.savedAt >= DRAFT_TTL_MS) { try { localStorage.removeItem(key); } catch { /* Storage may be blocked. */ } continue; }
      if (pending.draftScope !== scope) { try { localStorage.removeItem(key); } catch { /* Storage may be blocked. */ } continue; }
      if (!pending.resolvedPayload) continue;
      try { await submitGeneration(pending.resolvedPayload); try { localStorage.removeItem(key); } catch { /* Storage may be blocked. */ } }
      catch (error) {
        if (!definiteSubmissionRejection(error)) continue;
        for (const item of pending.created ?? []) { forgetUploads(item.localId); await Promise.allSettled([deleteAsset(item.assetId)]); }
        try { localStorage.removeItem(key); } catch { /* Storage may be blocked. */ }
      }
    }
  })().finally(() => { recoveryPromise = undefined; });
  return recoveryPromise;
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => { for (const url of previews.values()) URL.revokeObjectURL(url); previews.clear(); });
