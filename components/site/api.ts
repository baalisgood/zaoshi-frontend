import { requireAssetAccess } from "@/components/site/session";
export type AssetRecord = {
  id: string;
  kind: string;
  url: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  parentAssetId?: string | null;
  createdAt?: string;
  retentionExpiresAt?: number | null;
  moderationStatus?: "UNREVIEWED" | "PENDING" | "APPROVED" | "REJECTED";
  width?: number;
  height?: number;
  local?: boolean;
  created?: boolean;
  replayed?: boolean;
};

export type GalleryCategory = "interior" | "landscape" | "architecture";
export type GalleryItem = {
  id: string;
  title: string;
  note: string;
  category: GalleryCategory;
  prompt?: string;
  source?: string;
  publishedAt?: string;
  width: number;
  height: number;
  thumbUrl: string;
  displayUrl: string;
};
export type GallerySubmission = { id: string; title: string; note: string; category: GalleryCategory; status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED"; submittedAt?: string; publishedAt?: string; reviewedAt?: string; reviewNote?: string; width: number; height: number; sourceAssetId: string };
export type GalleryAdminItem = GalleryItem & { status: GallerySubmission["status"]; publicPrompt?: string | null; submittedAt?: string; reviewedAt?: string; reviewNote?: string };

export type StyleRecord = {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  schemes?: { id: string; previousVersionId?: string; legacyVersionIds?: string[]; name: string; description: string; palette: [string, string, string] }[];
};

export type JobResult = {
  assetId: string;
  url?: string;
  mimeType?: string;
  byteSize?: number;
  parentAssetId?: string | null;
  moderationStatus?: AssetRecord["moderationStatus"];
};
export type JobAdditionalReference = { assetId: string; role: "selection" | "reference" | "furnishing" | "structure" | "material" | "lighting-color" | "composition" };
export type GenerationPriceQuote = { billingMode?: "private-test-reservation"; privateTestOnly?: true; quality?: string; priceVersion: string; modelId: string; purpose: "preview" | "final"; operationType: "text-to-image" | "image-to-image" | "multi-reference"; effectiveResolution: string; inputImageCount: number; billableInputImageCount: number; outputCount: number; outputCreditsPerImage: number; inputCredits: number; amountPerItem: number; totalCredits: number };

export type JobSnapshot = {
  id?: string;
  status: string;
  reconciliationRequired?: boolean;
  hasPendingOutputs?: boolean;
  provider?: string;
  model?: string;
  purpose?: "preview" | "final";
  workflowType?: string;
  taskMode?: "bare-shell";
  spaceType?: "living-room" | "corridor" | "children-room" | "bedroom" | "dining-room" | "kitchen" | "bathroom" | "study" | "unspecified";
  resolution?: string;
  quality?: string;
  visualRealism?: "conceptual" | "rendered" | "realistic" | "photorealistic";
  effectiveResolution?: string;
  aspectRatio?: string;
  stylePresetId?: string;
  designSchemeId?: string | null;
  lightingPreset?: string;
  preservationMode?: string;
  providerPreference?: string;
  lampState?: string;
  colorTemperatureKelvin?: number;
  advancedSettings?: Record<string, unknown>;
  customPrompt?: string | null;
  sourceAssetId?: string | null;
  referenceAssetId?: string | null;
  depthAssetId?: string | null;
  normalAssetId?: string | null;
  additionalReferences?: JobAdditionalReference[];
  outputCount?: number;
  completedOutputCount?: number;
  createdAt?: string;
  updatedAt?: string;
  errorCode?: string;
  sourceJobId?: string | null;
  promotedFromAssetId?: string | null;
  results: JobResult[];
  message?: string;
  retryable?: boolean;
};

export function shouldPollReconciliation(job: Pick<JobSnapshot, "reconciliationRequired" | "hasPendingOutputs">, privateTest: boolean | undefined): boolean {
  return !job.reconciliationRequired || (job.hasPendingOutputs === true && privateTest === true);
}

export type VisionArtifact = AssetRecord & { artifactType?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function visualRealism(value: unknown): JobSnapshot["visualRealism"] {
  return ["conceptual", "rendered", "realistic", "photorealistic"].includes(String(value)) ? value as JobSnapshot["visualRealism"] : undefined;
}

function galleryItem(value: unknown): GalleryItem | undefined {
  const item = record(value); if (!item) return undefined;
  const id = text(item.id), title = text(item.title), category = item.category;
  if (!id || !title || !["interior", "landscape", "architecture"].includes(String(category))) return undefined;
  const width = number(item.width), height = number(item.height), thumbUrl = text(item.thumbUrl), displayUrl = text(item.displayUrl);
  if (!width || !height || !thumbUrl || !displayUrl) return undefined;
  return { id, title, note: text(item.note) ?? "", category: category as GalleryCategory, prompt: text(item.prompt), source: text(item.source), publishedAt: text(item.publishedAt), width, height, thumbUrl, displayUrl };
}
function gallerySubmission(value: unknown): GallerySubmission | undefined {
  const item = record(value); if (!item) return undefined;
  const id = text(item.id), title = text(item.title), category = String(item.category), status = String(item.status);
  const width = number(item.width), height = number(item.height), sourceAssetId = text(item.sourceAssetId);
  if (!id || !title || !["interior", "landscape", "architecture"].includes(category) || !["PENDING", "APPROVED", "REJECTED", "REVOKED"].includes(status) || !width || !height || !sourceAssetId) return undefined;
  return { id, title, note: text(item.note) ?? "", category: category as GalleryCategory, status: status as GallerySubmission["status"], submittedAt: text(item.submittedAt), publishedAt: text(item.publishedAt), reviewedAt: text(item.reviewedAt), reviewNote: text(item.reviewNote), width, height, sourceAssetId };
}
function galleryItems(payload: unknown): GalleryItem[] { const root = record(payload);
  const list = Array.isArray(root?.items) ? root.items : Array.isArray(payload) ? payload : []; return list.flatMap((x) => { const item = galleryItem(x); return item ? [item] : []; }); }
async function galleryRequest(path: string, init?: RequestInit): Promise<unknown> { const response = await fetch(path, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } }); if (!response.ok) throw new Error(await responseMessage(response, "图库服务暂时不可用。")); return response.json(); }

export async function listPublicGallery(category?: GalleryCategory, cursor?: string, signal?: AbortSignal): Promise<{ items: GalleryItem[]; nextCursor?: string; hasCommunity: boolean; source: "community" | "demo" }> { const query = new URLSearchParams({ limit: "30" }); if (category) query.set("category", category); if (cursor) query.set("cursor", cursor);
  const payload = await galleryRequest(`/api/gallery?${query}`, { signal });
  const root = record(payload); return { items: galleryItems(payload), nextCursor: text(root?.nextCursor), hasCommunity: root?.hasCommunity === true, source: root?.source === "demo" ? "demo" : "community" }; }
export async function submitGallerySubmission(body: Record<string, unknown>): Promise<GallerySubmission> { const payload = await galleryRequest("/api/gallery/submissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const item = gallerySubmission(record(record(payload)?.item)); if (!item) throw new Error("投稿返回格式无法识别。"); return item;
}
export async function listMyGallerySubmissions(): Promise<GallerySubmission[]> { const payload = await galleryRequest("/api/gallery/submissions");
  const root = record(payload); return (Array.isArray(root?.items) ? root.items : []).flatMap((x) => { const item = gallerySubmission(x); return item ? [item] : []; }); }
export async function revokeGallerySubmission(id: string): Promise<void> { await galleryRequest(`/api/gallery/submissions/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }); }
export async function listAdminGallery(): Promise<GalleryAdminItem[]> { const payload = await galleryRequest("/api/admin/gallery");
  const root = record(payload); return (Array.isArray(root?.items) ? root.items : []).flatMap((x) => { const item = galleryItem(x), raw = record(x); if (!item || !raw || !["PENDING", "APPROVED", "REJECTED", "REVOKED"].includes(String(raw.status))) return []; return [{ ...item, status: raw.status as GallerySubmission["status"], publicPrompt: text(raw.publicPrompt), submittedAt: text(raw.submittedAt), reviewedAt: text(raw.reviewedAt), reviewNote: text(raw.reviewNote) }]; }); }
export async function reviewGallery(id: string, action: "approve" | "reject", reason = ""): Promise<void> { await galleryRequest("/api/admin/gallery", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, reason, actionId: crypto.randomUUID() }) }); }

export function parseAsset(value: unknown): AssetRecord | undefined {
  const item = record(value);
  if (!item) return undefined;
  const id = text(item.id ?? item.assetId);
  if (!id) return undefined;
  return {
    id,
    kind: text(item.kind ?? item.assetKind) ?? "image",
    url: text(item.url ?? item.previewUrl ?? item.imageUrl) ?? `/api/assets/${encodeURIComponent(id)}?content=1`,
    fileName: text(item.fileName ?? item.originalFileName),
    mimeType: text(item.mimeType),
    byteSize: number(item.byteSize),
    parentAssetId: text(item.parentAssetId) ?? null,
    createdAt: text(item.createdAt),
    retentionExpiresAt: number(item.retentionExpiresAt) ?? null,
    moderationStatus: ["UNREVIEWED", "PENDING", "APPROVED", "REJECTED"].includes(String(item.moderationStatus))
      ? item.moderationStatus as AssetRecord["moderationStatus"]
      : undefined,
    width: number(item.width),
    height: number(item.height),
  };
}

export function parseAssetPayload(payload: unknown): AssetRecord | undefined {
  const root = record(payload);
  return parseAsset(root?.asset ?? root?.data ?? payload);
}

export function parseAssetList(payload: unknown): AssetRecord[] {
  const root = record(payload);
  const nested = record(root?.data);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.assets)
      ? root.assets
      : Array.isArray(nested?.assets)
        ? nested.assets
        : [];
  return list.flatMap((item) => {
    const asset = parseAsset(item);
    return asset ? [asset] : [];
  });
}

export function parseStyles(payload: unknown): StyleRecord[] {
  const root = record(payload);
  const nested = record(root?.data);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.styles)
      ? root.styles
      : Array.isArray(nested?.styles)
        ? nested.styles
        : [];
  return list.flatMap((value) => {
    const item = record(value);
    const id = text(item?.id ?? item?.stylePresetId);
    const name = text(item?.name ?? item?.label);
    if (!id || !name) return [];
    return [{
      id,
      name,
      description: text(item?.description ?? item?.note) ?? "室内设计风格预设",
      imageUrl: text(item?.imageUrl ?? item?.preview),
      schemes: Array.isArray(item?.schemes) ? item.schemes.flatMap((value) => { const scheme = record(value); const id = text(scheme?.id); const previousVersionId = text(scheme?.previousVersionId); const name = text(scheme?.name); const description = text(scheme?.description); const palette = scheme?.palette; return id && name && description && Array.isArray(palette) && palette.length === 3 && palette.every((color) => typeof color === "string" && /^#[0-9A-Fa-f]{6}$/u.test(color)) ? [{ id, ...(previousVersionId ? { previousVersionId } : {}), ...(Array.isArray(scheme?.legacyVersionIds) ? { legacyVersionIds: scheme.legacyVersionIds.filter((value): value is string => typeof value === "string") } : {}), name, description, palette: palette as [string, string, string] }] : []; }) : [],
    }];
  });
}

export function parseJob(payload: unknown): JobSnapshot {
  const root = record(payload);
  const data = record(root?.job ?? root?.data) ?? root ?? {};
  const rawError = record(data.error);
  const resultList = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.outputs)
      ? data.outputs
      : [];
  const results = resultList.flatMap((value): JobResult[] => {
    const item = record(value);
    const assetId = text(item?.assetId ?? item?.id);
    if (!assetId) return [];
    return [{
      assetId,
      url: text(item?.url ?? item?.previewUrl ?? item?.imageUrl),
      mimeType: text(item?.mimeType),
      byteSize: number(item?.byteSize),
      parentAssetId: text(item?.parentAssetId) ?? null,
      moderationStatus: ["UNREVIEWED", "PENDING", "APPROVED", "REJECTED"].includes(String(item?.moderationStatus))
        ? item?.moderationStatus as AssetRecord["moderationStatus"]
        : undefined,
    }];
  });
  return {
    id: text(data.id ?? data.jobId),
    status: (text(data.status ?? data.stage) ?? "QUEUED").toUpperCase(),
    reconciliationRequired: data.reconciliationRequired === true,
    hasPendingOutputs: data.hasPendingOutputs === true,
    provider: text(data.provider),
    model: text(data.model),
    purpose: text(data.purpose) as JobSnapshot["purpose"],
    workflowType: text(data.workflowType),
    ...(data.taskMode === "bare-shell" ? { taskMode: "bare-shell" as const } : {}),
    spaceType: ["living-room", "corridor", "children-room", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified"].includes(String(data.spaceType)) ? data.spaceType as JobSnapshot["spaceType"] : undefined,
    resolution: text(data.resolution),
    quality: text(data.quality),
    visualRealism: visualRealism(data.visualRealism),
    effectiveResolution: text(data.effectiveResolution),
    aspectRatio: text(data.aspectRatio),
    stylePresetId: text(data.stylePresetId),
    designSchemeId: text(data.designSchemeId) ?? null,
    lightingPreset: text(data.lightingPreset),
    preservationMode: text(data.preservationMode),
    providerPreference: text(data.providerPreference),
    lampState: text(data.lampState),
    colorTemperatureKelvin: number(data.colorTemperatureKelvin),
    advancedSettings: record(data.advancedSettings),
    customPrompt: text(data.customPrompt) ?? null,
    sourceAssetId: text(data.sourceAssetId) ?? null,
    referenceAssetId: text(data.referenceAssetId) ?? null,
    depthAssetId: text(data.depthAssetId) ?? null,
    normalAssetId: text(data.normalAssetId) ?? null,
    additionalReferences: Array.isArray(data.additionalReferences)
      ? data.additionalReferences.flatMap((value) => {
          const item = record(value);
          const assetId = text(item?.assetId);
          const role = String(item?.role);
          return assetId && ["selection", "reference", "furnishing", "structure", "material", "lighting-color", "composition"].includes(role)
            ? [{ assetId, role: role as JobAdditionalReference["role"] }]
            : [];
        })
      : [],
    outputCount: number(data.outputCount),
    completedOutputCount: number(data.completedOutputCount),
    createdAt: text(data.createdAt),
    updatedAt: text(data.updatedAt),
    errorCode: text(rawError?.code),
    sourceJobId: text(data.sourceJobId) ?? null,
    promotedFromAssetId: text(data.promotedFromAssetId) ?? null,
    results,
    message: text(rawError?.message ?? data.message ?? data.errorMessage),
    retryable: typeof rawError?.retryable === "boolean" ? rawError.retryable : undefined,
  };
}

export async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.clone().json() as unknown;
    const root = record(payload);
    const error = record(root?.error);
    return text(error?.message ?? root?.message) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function uploadAsset(file: File, kind: string, idempotencyKey: string | undefined, draftScope: string): Promise<AssetRecord> {
  const body = new FormData();
  body.append("file", file);
  body.append("kind", kind);
  const response = await fetch("/api/assets", { method: "POST", headers: { "X-Zaoshi-Draft-Scope": draftScope, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, body });
  if (!response.ok) {
    let code: string | undefined;
    try { const root = record(await response.clone().json()); code = text(record(root?.error)?.code ?? root?.code); } catch { /* Non-JSON upload failures have no stable recovery code. */ }
    throw new AssetUploadError(response.status, code, await responseMessage(response, "图片上传失败。"));
  }
  const asset = parseAssetPayload(await response.json());
  if (!asset) throw new Error("上传已返回，但未找到图片记录。");
  return { ...asset, created: response.status === 201, replayed: response.status === 200 };
}

export class AssetUploadError extends Error {
  constructor(public readonly status: number, public readonly code: string | undefined, message: string) { super(message); this.name = "AssetUploadError"; }
}

export async function fetchAsset(id: string): Promise<AssetRecord> {
  await requireAssetAccess();
  const response = await fetch(`/api/assets/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "没有找到这张图片。"));
  const asset = parseAssetPayload(await response.json());
  if (!asset) throw new Error("图片记录格式无法识别。");
  return asset;
}

export async function listAssets(scope: "today" | "all", limit: number): Promise<AssetRecord[]> {
  const query = new URLSearchParams({ scope, limit: String(limit) });
  const response = await fetch(`/api/assets?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "图片列表暂时不可用。"));
  return parseAssetList(await response.json());
}

export async function deleteAsset(id: string): Promise<void> {
  const response = await fetch(`/api/assets/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Accept: "application/json", "Idempotency-Key": crypto.randomUUID() } });
  if (!response.ok) throw new Error(await responseMessage(response, "图片删除失败。"));
}

export async function listStyles(): Promise<StyleRecord[]> {
  const response = await fetch("/api/styles", { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "风格列表暂时不可用。"));
  return parseStyles(await response.json());
}

export async function submitGeneration(payload: Record<string, unknown>): Promise<JobSnapshot> {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let code: string | undefined;
    try { const root = record(await response.clone().json()); code = text(record(root?.error)?.code ?? root?.code); } catch { /* Non-JSON proxy errors are ambiguous. */ }
    throw new GenerationSubmissionError(response.status, code, await responseMessage(response, "生成任务未能提交。"));
  }
  return parseJob(await response.json());
}

export class GenerationSubmissionError extends Error {
  constructor(public readonly status: number, public readonly code: string | undefined, message: string) { super(message); this.name = "GenerationSubmissionError"; }
}

export async function quoteGeneration(payload: { optionId?: string; modelId: string; purpose: "preview" | "final"; resolution: string; inputImageCount: number; outputCount: number; quality?: string ; aspectRatio: string }, signal?: AbortSignal, privateTest = false): Promise<GenerationPriceQuote> {
  const publicModel = Boolean(payload.optionId) && !privateTest;
  const response = publicModel ? await fetch(`/api/prices?${new URLSearchParams({ optionId: payload.optionId ?? "", quality: payload.quality ?? "auto", purpose: payload.purpose, modelId: payload.modelId, resolution: payload.resolution, inputImageCount: String(payload.inputImageCount), outputCount: String(payload.outputCount), aspectRatio: payload.aspectRatio })}`, { signal }) : await fetch("/api/jobs/quote", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal });
  if (!response.ok) throw new Error(await responseMessage(response, "当前无法确认积分价格。"));
  const quote = record((await response.json() as Record<string, unknown>).quote);
  if (!quote || typeof quote.priceVersion !== "string" || typeof quote.totalCredits !== "number" || typeof quote.amountPerItem !== "number") throw new Error("报价服务返回的数据无效。");
  return quote as GenerationPriceQuote;
}

export async function quoteFinalizedGeneration(previewId: string, payload: { optionId?: string; providerPreference?: string; resolution: string; outputCount: number; quality?: string }, signal?: AbortSignal): Promise<GenerationPriceQuote> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(previewId)}/quote`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal });
  if (!response.ok) throw new Error(await responseMessage(response, "当前无法确认高清成品积分价格。"));
  const quote = record((await response.json() as Record<string, unknown>).quote);
  if (!quote || typeof quote.priceVersion !== "string" || typeof quote.totalCredits !== "number" || typeof quote.amountPerItem !== "number") throw new Error("高清成品报价服务返回的数据无效。");
  return quote as GenerationPriceQuote;
}

export async function listGenerationJobs(
  workflowType: string,
  limit = 20,
  cursor?: string,
  signal?: AbortSignal,
): Promise<{ jobs: JobSnapshot[]; nextCursor?: string }> {
  const query = new URLSearchParams({ workflowType, limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/jobs?${query}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(await responseMessage(response, "任务列表暂时不可用。"));
  const payload = await response.json() as unknown;
  const root = record(payload);
  const jobs = Array.isArray(root?.jobs) ? root.jobs.map(parseJob) : [];
  return { jobs, nextCursor: text(root?.nextCursor) };
}

export class PromptOptimizationError extends Error {
  constructor(message: string, public readonly terminal: boolean) { super(message); }
}
export type PromptOptimizationQuote = { quoteId: string; maximumCredits: number; tokenUpperBound: number; expiresAt: number; availableCredits: number };
export async function readPromptOptimization(quoteId: string): Promise<PromptOptimizationResult | {status: "FAILED"} | {status: "QUOTED"}> {
  const value = record(await promptOptimizationRequest({ action: "result", quoteId }));
  if (value?.status === "FAILED" || value?.status === "QUOTED") return { status: value.status };
  return parsePromptOptimizationResult(value);
}
export type PromptOptimizationResult = { status: "SUCCEEDED"; optimizedPrompt: string; chargedCredits: number } | { status: "DISPATCHING" };
export type PromptOptimizationContext = "ordinary" | "local-prompt";
export async function quoteImagePrompt(prompt: string, context: PromptOptimizationContext): Promise<PromptOptimizationQuote> {
  const value = record(await promptOptimizationRequest({ action: "quote", prompt, context }));
  if (!value || typeof value.quoteId !== "string" || !/^optimization_[a-f0-9-]{36}$/u.test(value.quoteId) || ![value.maximumCredits, value.tokenUpperBound, value.expiresAt, value.availableCredits].every(item => Number.isSafeInteger(item)) || Number(value.maximumCredits)<1 || Number(value.maximumCredits)>100 || Number(value.availableCredits)<0) throw new Error("优化报价无效，请稍后重试。");
  return value as PromptOptimizationQuote;
}
export async function optimizeImagePrompt(prompt: string, quoteId: string, context: PromptOptimizationContext): Promise<PromptOptimizationResult> {
  return parsePromptOptimizationResult(record(await promptOptimizationRequest({ action: "optimize", prompt, quoteId, context })));
}
function parsePromptOptimizationResult(value: Record<string, unknown> | undefined): PromptOptimizationResult {
  if (value?.status === "DISPATCHING") return { status: "DISPATCHING" };
  if (value?.status !== "SUCCEEDED" || typeof value.optimizedPrompt !== "string" || !value.optimizedPrompt.trim() || value.optimizedPrompt.length > 2000 || !Number.isSafeInteger(value.chargedCredits) || Number(value.chargedCredits)<1 || Number(value.chargedCredits)>100) throw new Error("结果暂未确认，请查询同一优化请求。");
  return { status: "SUCCEEDED", optimizedPrompt: value.optimizedPrompt, chargedCredits: Number(value.chargedCredits) };
}
async function promptOptimizationRequest(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/prompts/optimize", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const error = record(record(payload)?.error);
    throw new PromptOptimizationError(text(error?.message) ?? "AI 提示词优化暂不可用，原提示词保持不变。", ["PROMPT_OPTIMIZER_UNAVAILABLE", "INSUFFICIENT_CREDITS", "OPTIMIZATION_BUSY", "OPTIMIZATION_QUOTE_CHANGED", "INVALID_PROMPT", "INVALID_OPTIMIZATION_CONTEXT"].includes(String(error?.code)));
  }
  return response.json();
}
export async function finalizeGeneration(previewId: string, payload: Record<string, unknown>): Promise<JobSnapshot> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(previewId)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(await responseMessage(response, "高清成品任务未能提交。"));
  return parseJob(await response.json());
}

export async function fetchGeneration(id: string): Promise<JobSnapshot> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "任务状态暂时无法获取。"));
  return parseJob(await response.json());
}

export async function generateVision(sourceAssetId: string): Promise<VisionArtifact[]> {
  const response = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sourceAssetId, artifacts: ["depth", "normal"] }),
  });
  if (!response.ok) throw new Error(await responseMessage(response, "外部视觉服务未配置或暂时不可用。"));
  const payload = await response.json() as unknown;
  const root = record(payload);
  const nested = record(root?.data);
  const values = Array.isArray(root?.artifacts)
    ? root.artifacts
    : Array.isArray(nested?.artifacts)
      ? nested.artifacts
      : [];
  return values.flatMap((value): VisionArtifact[] => {
    const item = record(value);
    const asset = parseAsset(item?.asset ?? value);
    if (!asset) return [];
    return [{ ...asset, artifactType: text(item?.artifactType ?? item?.type) ?? asset.kind }];
  });
}

export function readImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("无法读取图片尺寸。"));
    image.src = url;
  });
}
