import { runtimeModeration } from "./machine-moderation";
import { and, asc, count, desc, eq, gte, getTableColumns, sql, inArray, lt, ne, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ensureDatabase, getD1Binding, getDb, getR2Binding } from "@/db";
import {
  assets,
  generationJobOutputs,
  generationJobs,
  type AssetKind,
  type JobStatus,
} from "@/db/schema";
import { ApiError } from "./api";
import type { GenerationBilling, GenerationPriceExpectation } from "./credit-ledger";
import {
  assertD1QueuedJobItems,
  createD1QueuedJobIdempotently,
} from "./queued-job-creation";
import { startOfTodayInShanghai } from "./product-time";
import { decideRecovery, resolveMemoryOrdinal } from "./output-saga";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";

export async function getJobByIdempotencyKey(ownerId: string, key: string): Promise<PersistedJob | null> {
  await ensureDatabase();
  const [row] = await getDb().select(ownerJobSelection).from(generationJobs).where(and(eq(generationJobs.ownerId, ownerId), eq(generationJobs.idempotencyKey, key))).limit(1);
  return row ?? null;
}

export type PersistedAsset = Omit<typeof assets.$inferSelect, "moderationMode"> & { moderationMode?: "disabled" | "tencent" | null };
export type PersistedJob = typeof generationJobs.$inferSelect & { reconciliationRequired?: boolean; hasPendingOutputs?: boolean };

const ownerJobSelection = {
  ...getTableColumns(generationJobs),
  reconciliationRequired: sql<boolean>`EXISTS (SELECT 1 FROM generation_job_items AS item WHERE item.job_id = generation_jobs.id AND item.owner_id = generation_jobs.owner_id AND item.status = 'RECONCILIATION_REQUIRED')`.mapWith(Boolean),
  hasPendingOutputs: sql<boolean>`EXISTS (SELECT 1 FROM generation_job_items AS item WHERE item.job_id = generation_jobs.id AND item.owner_id = generation_jobs.owner_id AND item.status NOT IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED','CANCELED'))`.mapWith(Boolean),
};
export type PersistedJobWithOutputs = {
  job: PersistedJob;
  outputs: PersistedAsset[];
};
export type StorageMode =
  | "cloudflare-d1-r2"
  | "node-sqlite-filesystem"
  | "memory-demo";

export type NewAsset = {
  id: string;
  ownerId: string;
  kind: AssetKind;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sanitizationVersion: string;
  storageKey: string;
  parentAssetId?: string | null;
  createdAt: string;
  retentionExpiresAt?: number | null;
  moderationStatus?: PersistedAsset["moderationStatus"];
};

export type NewJob = {
  id: string;
  ownerId: string;
  sourceAssetId: string | null;
  referenceAssetId: string | null;
  additionalReferencesJson: string;
  maskAssetId: string | null;
  depthAssetId: string | null;
  normalAssetId: string | null;
  workflowType: PersistedJob["workflowType"];
  purpose: PersistedJob["purpose"];
  sourceJobId?: string | null;
  promotedFromAssetId?: string | null;
  resolution: PersistedJob["resolution"];
  effectiveResolution: PersistedJob["effectiveResolution"];
  aspectRatio: PersistedJob["aspectRatio"];
  quality: PersistedJob["quality"];
  visualRealism: PersistedJob["visualRealism"];
  lampState: PersistedJob["lampState"];
  colorTemperatureKelvin: number;
  spaceType?: PersistedJob["spaceType"];
  stylePresetId: string;
  designSchemeId?: string | null;
  lightingPreset: string;
  preservationMode: string;
  providerPreference: string;
  editInstruction: string | null;
  customPrompt?: string | null;
  outputCount: number;
  advancedSettingsJson: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
};

export type JobPatch = Partial<
  Pick<
    PersistedJob,
    | "status"
    | "completedOutputCount"
    | "provider"
    | "model"
    | "providerRequestId"
    | "promptTemplateVersion"
    | "errorCode"
    | "errorMessage"
    | "errorRetryable"
    | "startedAt"
    | "finishedAt"
  >
>;

type MemoryState = {
  assets: Map<string, PersistedAsset>;
  blobs: Map<string, Uint8Array>;
  jobs: Map<string, PersistedJob>;
  idempotency: Map<string, string>;
  outputs: Map<string, Array<{ assetId: string; ordinal: number }>>;
};

// A writer may still be uploading between polling attempts. Keep recent
// PENDING rows hidden; only old rows are eligible for crash cleanup.
export const OUTPUT_RECOVERY_THRESHOLD_MS = 10 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
export const ASSET_RETENTION_POLICY = { uploadsDays: 30, outputsDays: 90, pendingGalleryDays: 7, approvedGalleryDays: 365 } as const;

function defaultRetentionExpiresAt(kind: AssetKind, createdAt: string): number {
  const created = Math.floor(new Date(createdAt).getTime() / 1000);
  return created + (kind === "output" ? ASSET_RETENTION_POLICY.outputsDays : ASSET_RETENTION_POLICY.uploadsDays) * DAY_SECONDS;
}

const MEMORY_KEY = Symbol.for("designer.memory-demo.persistence");

export function getStorageMode(): StorageMode {
  const hasD1 = Boolean(getD1Binding());
  const hasR2 = Boolean(getR2Binding());
  if (hasD1 && hasR2) {
    return process.env.ZAOSHI_RUNTIME === "node"
      ? "node-sqlite-filesystem"
      : "cloudflare-d1-r2";
  }

  if (process.env.NODE_ENV !== "production" && !hasD1 && !hasR2) {
    return "memory-demo";
  }

  throw new ApiError(
    503,
    "STORAGE_NOT_CONFIGURED",
    "持久化存储尚未配置，生产环境不会回退到内存。",
  );
}

export async function createAsset(
  record: NewAsset,
  bytes: Uint8Array,
): Promise<PersistedAsset> {
  const mode = getStorageMode();
  const row: PersistedAsset = {
    ...record,
    status: "READY",
    parentAssetId: record.parentAssetId ?? null,
    deletedAt: null,
    retentionExpiresAt: record.retentionExpiresAt ?? defaultRetentionExpiresAt(record.kind, record.createdAt),
    deletionRequestedAt: null,
    deletionActionId: null,
    purgedAt: null,
    moderationStatus: record.moderationStatus ?? "UNREVIEWED",
    moderatedAt: null,
    moderationReason: null,
    moderationActionId: null,
  };

  if (mode === "memory-demo") {
    const memory = getMemory();
    if (memory.assets.has(row.id)) throw new Error("ASSET_ID_CONFLICT");
    memory.assets.set(row.id, row);
    memory.blobs.set(row.storageKey, bytes.slice());
    return row;
  }

  const d1 = getD1Binding()!;
  const audit = await runtimeModeration(d1);
  await ensureDatabase();
  const bucket = requireR2();
  await bucket.put(row.storageKey, bytes, {
    httpMetadata: { contentType: row.mimeType },
    customMetadata: {
      assetId: row.id,
      sha256: row.sha256,
      kind: row.kind,
      sanitizationVersion: record.sanitizationVersion,
    },
  });

  try {
    const [inserted] = await getDb().insert(assets).values({ ...row, status: "PENDING", moderationStatus: "UNREVIEWED", moderationMode: audit.mode }).returning();
    if (!inserted) throw new Error("D1 did not return the inserted asset");
    row.status = inserted.status;
  } catch (error) {
    try {
      await bucket.delete(row.storageKey);
    } catch (cleanupError) {
      try {
        await getD1Binding()!.prepare("INSERT OR IGNORE INTO object_cleanup_tasks (id, source_type, source_id, object_key, last_error_code) VALUES (?, 'ASSET', ?, ?, 'ORPHANED_ASSET_WRITE')").bind(`cleanup_orphan_${row.id}`, row.id, row.storageKey).run();
      } catch (queueError) {
        throw new AggregateError([error, cleanupError, queueError], "Asset persistence and rollback both failed");
      }
    }
    throw error;
  }
  await audit.asset(row.ownerId, row.id, bytes);
  await d1.prepare(`UPDATE assets SET status='READY',moderation_status=CASE WHEN ?='tencent' THEN 'APPROVED' ELSE 'UNREVIEWED' END,moderated_at=CASE WHEN ?='tencent' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=? AND owner_id=? AND status='PENDING' AND sha256=? AND sanitization_version=? AND moderation_status<>'REJECTED' AND EXISTS(SELECT 1 FROM users WHERE id=assets.owner_id AND status='ACTIVE') AND NOT EXISTS(SELECT 1 FROM asset_moderation_evidence e JOIN assets previous ON previous.id=e.asset_id WHERE previous.owner_id=assets.owner_id AND e.content_sha256=assets.sha256 AND e.decision IN ('Review','Block')) AND (?='disabled' OR EXISTS(SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version=? AND e.decision='Pass'))`).bind(audit.mode,audit.mode,row.id,row.ownerId,row.sha256,IMAGE_SANITIZATION_VERSION,audit.mode,audit.policyVersion).run();
  const saved = await getAsset(row.id,row.ownerId);
  if (!saved) throw new ApiError(409,"MODERATION_CONTENT_CHANGED","图片或账户状态已变化，请重新上传。");
  return saved;

}

export async function getAsset(
  id: string,
  ownerId: string,
): Promise<PersistedAsset | null> {
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const row = getMemory().assets.get(id);
    return row?.ownerId === ownerId && row.status === "READY" && row.moderationStatus !== "REJECTED" ? row : null;
  }

  await ensureDatabase();
  const [row] = await getDb()
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.id, id),
        eq(assets.ownerId, ownerId),
        eq(assets.status, "READY"),
        ne(assets.moderationStatus, "REJECTED"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getAssetRecord(id: string, ownerId: string): Promise<PersistedAsset | null> {
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const row = getMemory().assets.get(id);
    return row?.ownerId === ownerId ? row : null;
  }
  await ensureDatabase();
  const [row] = await getDb().select().from(assets).where(and(eq(assets.id, id), eq(assets.ownerId, ownerId))).limit(1);
  return row ?? null;
}

export async function getAssetBytes(asset: PersistedAsset): Promise<Uint8Array> {
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const bytes = getMemory().blobs.get(asset.storageKey);
    if (!bytes) throw missingBlobError();
    return bytes.slice();
  }

  const object = await requireR2().get(asset.storageKey);
  if (!object) throw missingBlobError();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.sha256 || object.customMetadata?.assetId !== asset.id || object.customMetadata?.sha256 !== asset.sha256 || object.customMetadata?.kind !== asset.kind || (asset.sanitizationVersion !== null && object.customMetadata?.sanitizationVersion !== asset.sanitizationVersion) || object.httpMetadata?.contentType !== asset.mimeType) throw new ApiError(409, "ASSET_INTEGRITY_FAILED", "图片存储校验失败，请联系管理员。");
  return bytes;
}

export async function listAssets(
  ownerId: string,
  options: { scope: "today" | "all"; kind?: AssetKind; limit: number },
): Promise<PersistedAsset[]> {
  const start = options.scope === "today" ? startOfTodayInShanghai() : null;
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    return [...getMemory().assets.values()]
      .filter(
        (asset) =>
          asset.ownerId === ownerId &&
          asset.status === "READY" &&
          asset.moderationStatus !== "REJECTED" &&
          (!options.kind || asset.kind === options.kind) &&
          (!start || asset.createdAt >= start),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  await ensureDatabase();
  const conditions = [
    eq(assets.ownerId, ownerId),
    eq(assets.status, "READY"),
    ne(assets.moderationStatus, "REJECTED"),
  ];
  if (options.kind) conditions.push(eq(assets.kind, options.kind));
  if (start) conditions.push(gte(assets.createdAt, start));
  return getDb()
    .select()
    .from(assets)
    .where(and(...conditions))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(options.limit);
}

export async function getAssetStats(ownerId: string): Promise<{
  total: number;
  today: number;
  byKind: Record<AssetKind, number>;
}> {
  const start = startOfTodayInShanghai();
  const byKind = emptyKindCounts();
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const owned = [...getMemory().assets.values()].filter(
      (asset) => asset.ownerId === ownerId && asset.status === "READY",
    );
    for (const asset of owned) byKind[asset.kind] += 1;
    return {
      total: owned.length,
      today: owned.filter((asset) => asset.createdAt >= start).length,
      byKind,
    };
  }

  await ensureDatabase();
  const baseCondition = and(
    eq(assets.ownerId, ownerId),
    eq(assets.status, "READY"),
  );
  const [totalRows, todayRows, groupedRows] = await Promise.all([
    getDb().select({ value: count() }).from(assets).where(baseCondition),
    getDb()
      .select({ value: count() })
      .from(assets)
      .where(and(baseCondition, gte(assets.createdAt, start))),
    getDb()
      .select({ kind: assets.kind, value: count() })
      .from(assets)
      .where(baseCondition)
      .groupBy(assets.kind),
  ]);
  for (const row of groupedRows) byKind[row.kind] = row.value;
  return {
    total: totalRows[0]?.value ?? 0,
    today: todayRows[0]?.value ?? 0,
    byKind,
  };
}

export async function createJobIdempotently(
  record: NewJob,
): Promise<{ job: PersistedJob; created: boolean }> {
  const mode = getStorageMode();
  const row = newJobRow(record);

  if (mode === "memory-demo") {
    const memory = getMemory();
    const key = `${row.ownerId}:${row.idempotencyKey}`;
    const existingId = memory.idempotency.get(key);
    if (existingId) {
      const existing = memory.jobs.get(existingId);
      if (!existing) throw new Error("Memory idempotency index is corrupt");
      return { job: existing, created: false };
    }
    memory.jobs.set(row.id, row);
    memory.idempotency.set(key, row.id);
    return { job: row, created: true };
  }

  await ensureDatabase();
  const inserted = await getDb()
    .insert(generationJobs)
    .values(row)
    .onConflictDoNothing({
      target: [generationJobs.ownerId, generationJobs.idempotencyKey],
    })
    .returning();
  if (inserted[0]) return { job: inserted[0], created: true };

  const [existing] = await getDb()
    .select(ownerJobSelection)
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.ownerId, row.ownerId),
        eq(generationJobs.idempotencyKey, row.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Idempotent job conflict could not be read");
  return { job: existing, created: false };
}

export async function createQueuedJobIdempotently(
  record: NewJob,
  billing: GenerationBilling,
  expectation?: GenerationPriceExpectation,
  policy: { moderationPolicyVersion?: string; requireMachineModeration?: boolean; allowPrivateTestOverseas?: boolean; maxAttempts?: number; privateTestAutoCredit?: boolean; privateTestDailyUnlimited?: boolean; requireActiveVerifiedIdentity?: boolean; wechatAppId?: string } = {},
): Promise<{ job: PersistedJob; created: boolean }> {
  if (getStorageMode() === "memory-demo") {
    throw new ApiError(
      503,
      "QUEUE_REQUIRES_D1",
      "持久任务队列需要 D1，不能回退到本地内存。",
    );
  }
  await ensureDatabase();
  const d1 = getD1Binding();
  if (!d1) {
    throw new ApiError(503, "QUEUE_REQUIRES_D1", "持久任务队列需要 D1。");
  }
  const row = newJobRow(record);
  const identity = await createD1QueuedJobIdempotently(d1, row, billing, { requirePriceExpectation: true, ...policy }, expectation);
  const [job] = await getDb()
    .select(ownerJobSelection)
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.ownerId, row.ownerId),
        eq(generationJobs.idempotencyKey, row.idempotencyKey),
      ),
    )
    .limit(1);
  if (!job || job.id !== identity.jobId) {
    throw new ApiError(
      500,
      "QUEUE_JOB_CREATE_FAILED",
      "生成任务未能可靠写入持久队列。",
    );
  }
  return { job, created: identity.created };
}

export async function assertQueuedJobItemsConsistent(
  job: Pick<
    PersistedJob,
    "id" | "ownerId" | "providerPreference" | "outputCount"
  >,
): Promise<void> {
  const d1 = getD1Binding();
  if (!d1) {
    throw new ApiError(503, "QUEUE_REQUIRES_D1", "持久任务队列需要 D1。");
  }
  await assertD1QueuedJobItems(d1, job);
}

function newJobRow(record: NewJob): PersistedJob {
  return {
    ...record,
    spaceType: record.spaceType ?? "unspecified",
    customPrompt: record.customPrompt ?? null,
    designSchemeId: record.designSchemeId ?? null,
    additionalReferencesJson: record.additionalReferencesJson,
    sourceJobId: record.sourceJobId ?? null,
    promotedFromAssetId: record.promotedFromAssetId ?? null,
    status: "QUEUED",
    completedOutputCount: 0,
    provider: null,
    model: null,
    providerRequestId: null,
    promptTemplateVersion: null,
    errorCode: null,
    errorMessage: null,
    errorRetryable: null,
    startedAt: null,
    finishedAt: null,
  };
}

export async function getJob(
  id: string,
  ownerId: string,
): Promise<PersistedJob | null> {
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const row = getMemory().jobs.get(id);
    return row?.ownerId === ownerId ? row : null;
  }

  await ensureDatabase();
  const [row] = await getDb()
    .select(ownerJobSelection)
    .from(generationJobs)
    .where(and(eq(generationJobs.id, id), eq(generationJobs.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function listJobsWithOutputs(
  ownerId: string,
  options: {
    workflowType: PersistedJob["workflowType"];
    limit: number;
    cursor?: { createdAt: string; id: string };
  },
): Promise<{ items: PersistedJobWithOutputs[]; hasMore: boolean }> {
  const mode = getStorageMode();
  const precedesCursor = (job: PersistedJob) =>
    !options.cursor ||
    job.createdAt < options.cursor.createdAt ||
    (job.createdAt === options.cursor.createdAt && job.id < options.cursor.id);

  if (mode === "memory-demo") {
    const memory = getMemory();
    const rows = [...memory.jobs.values()]
      .filter(
        (job) =>
          job.ownerId === ownerId &&
          job.workflowType === options.workflowType &&
          precedesCursor(job),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, options.limit + 1);
    const hasMore = rows.length > options.limit;
    return {
      items: rows.slice(0, options.limit).map((job) => ({
        job,
        outputs: (memory.outputs.get(job.id) ?? [])
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((row) => memory.assets.get(row.assetId))
          .filter(
            (asset): asset is PersistedAsset =>
              Boolean(
                asset &&
                  asset.ownerId === ownerId &&
                  asset.kind === "output" &&
                  asset.status === "READY",
              ),
          ),
      })),
      hasMore,
    };
  }

  await ensureDatabase();
  const conditions = [
    eq(generationJobs.ownerId, ownerId),
    eq(generationJobs.workflowType, options.workflowType),
  ];
  if (options.cursor) {
    conditions.push(
      or(
        lt(generationJobs.createdAt, options.cursor.createdAt),
        and(
          eq(generationJobs.createdAt, options.cursor.createdAt),
          lt(generationJobs.id, options.cursor.id),
        ),
      )!,
    );
  }
  const rows = await getDb()
    .select(ownerJobSelection)
    .from(generationJobs)
    .where(and(...conditions))
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const jobs = rows.slice(0, options.limit);
  if (!jobs.length) return { items: [], hasMore };

  const outputRows = await getDb()
    .select({
      jobId: generationJobOutputs.jobId,
      ordinal: generationJobOutputs.ordinal,
      id: assets.id,
      ownerId: assets.ownerId,
      kind: assets.kind,
      status: assets.status,
      originalFileName: assets.originalFileName,
      mimeType: assets.mimeType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      sanitizationVersion: assets.sanitizationVersion,
      storageKey: assets.storageKey,
      parentAssetId: assets.parentAssetId,
      createdAt: assets.createdAt,
      deletedAt: assets.deletedAt,
      retentionExpiresAt: assets.retentionExpiresAt,
      deletionRequestedAt: assets.deletionRequestedAt,
      deletionActionId: assets.deletionActionId,
      purgedAt: assets.purgedAt,
      moderationStatus: assets.moderationStatus,
      moderatedAt: assets.moderatedAt,
      moderationReason: assets.moderationReason,
      moderationActionId: assets.moderationActionId,
    })
    .from(generationJobOutputs)
    .innerJoin(
      generationJobs,
      and(
        eq(generationJobs.id, generationJobOutputs.jobId),
        eq(generationJobs.ownerId, ownerId),
      ),
    )
    .innerJoin(
      assets,
      and(
        eq(assets.id, generationJobOutputs.assetId),
        eq(assets.ownerId, ownerId),
        eq(assets.kind, "output"),
        eq(assets.status, "READY"),
        ne(assets.moderationStatus, "REJECTED"),
      ),
    )
    .where(inArray(generationJobOutputs.jobId, jobs.map((job) => job.id)))
    .orderBy(asc(generationJobOutputs.jobId), asc(generationJobOutputs.ordinal));
  const outputsByJob = new Map<string, PersistedAsset[]>();
  for (const { jobId, ordinal, ...asset } of outputRows) {
    void ordinal;
    const current = outputsByJob.get(jobId) ?? [];
    current.push(asset);
    outputsByJob.set(jobId, current);
  }
  return {
    items: jobs.map((job) => ({
      job,
      outputs: outputsByJob.get(job.id) ?? [],
    })),
    hasMore,
  };
}

export async function updateJob(id: string, patch: JobPatch): Promise<void> {
  const updatedAt = new Date().toISOString();
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const memory = getMemory();
    const current = memory.jobs.get(id);
    if (!current) throw new Error(`Unknown job ${id}`);
    memory.jobs.set(id, { ...current, ...patch, updatedAt });
    return;
  }

  await ensureDatabase();
  await getDb()
    .update(generationJobs)
    .set({ ...patch, updatedAt })
    .where(eq(generationJobs.id, id));
}

export async function claimQueuedJob(id: string, ownerId: string): Promise<boolean> {
  const mode = getStorageMode();
  if (mode === "memory-demo") { const current = getMemory().jobs.get(id); if (!current || current.ownerId !== ownerId || current.status !== "QUEUED") return false; getMemory().jobs.set(id, { ...current, status: "PREPROCESSING", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return true; }
  await ensureDatabase();
  const result = await getDb().update(generationJobs).set({ status: "PREPROCESSING", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(and(eq(generationJobs.id, id), eq(generationJobs.ownerId, ownerId), eq(generationJobs.status, "QUEUED")));
  return Number(result.meta.changes) > 0;
}

export async function attachJobOutput(
  job: PersistedJob,
  ordinal: number,
  asset: NewAsset,
  bytes: Uint8Array,
): Promise<PersistedAsset> {
  const mode = getStorageMode();
  const existingRows = mode === "memory-demo" ? getMemory().outputs.get(job.id) ?? [] : [];
  const existingId = existingRows.find((row) => row.ordinal === ordinal)?.assetId;
  if (mode === "memory-demo" && existingId) {
    const existing = resolveMemoryOrdinal(existingRows, getMemory().assets, ordinal, job.ownerId);
    if (existing && existing.ownerId === job.ownerId && existing.status === "READY") return existing;
    throw new ApiError(409, "OUTPUT_INTEGRITY_CONFLICT", "任务输出关联存在但资产记录缺失。");
  }
  if (mode !== "memory-demo") return attachCloudflareOutput(job, ordinal, asset, bytes);
  const output = { ...asset, status: "READY" as const, parentAssetId: asset.parentAssetId ?? null, deletedAt: null, retentionExpiresAt: asset.retentionExpiresAt ?? defaultRetentionExpiresAt("output", asset.createdAt), deletionRequestedAt: null, deletionActionId: null, purgedAt: null, moderationStatus: asset.moderationStatus ?? "APPROVED" as const, moderatedAt: null, moderationReason: null, moderationActionId: null };
  if (mode === "memory-demo") {
    const rows = getMemory().outputs.get(job.id) ?? [];
    if (!rows.some((row) => row.ordinal === ordinal)) {
      rows.push({ assetId: output.id, ordinal });
      rows.sort((a, b) => a.ordinal - b.ordinal);
      getMemory().outputs.set(job.id, rows);
    }
    getMemory().assets.set(output.id, output);
    getMemory().blobs.set(output.storageKey, bytes.slice());
    return output;
  }
  throw new Error("unreachable");
}

export async function getJobOutputs(
  jobId: string,
  ownerId: string,
): Promise<PersistedAsset[]> {
  const mode = getStorageMode();
  if (mode === "memory-demo") {
    const memory = getMemory();
    return (memory.outputs.get(jobId) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => memory.assets.get(row.assetId))
      .filter(
        (asset): asset is PersistedAsset =>
          Boolean(asset && asset.ownerId === ownerId && asset.kind === "output" && asset.status === "READY" && asset.moderationStatus !== "REJECTED"),
      );
  }

  await ensureDatabase();
  await reconcilePendingOutputs(jobId, ownerId);
  return getDb()
    .select({
      id: assets.id,
      ownerId: assets.ownerId,
      kind: assets.kind,
      status: assets.status,
      originalFileName: assets.originalFileName,
      mimeType: assets.mimeType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      sanitizationVersion: assets.sanitizationVersion,
      storageKey: assets.storageKey,
      parentAssetId: assets.parentAssetId,
      createdAt: assets.createdAt,
      deletedAt: assets.deletedAt,
      retentionExpiresAt: assets.retentionExpiresAt,
      deletionRequestedAt: assets.deletionRequestedAt,
      deletionActionId: assets.deletionActionId,
      purgedAt: assets.purgedAt,
      moderationStatus: assets.moderationStatus,
      moderatedAt: assets.moderatedAt,
      moderationReason: assets.moderationReason,
      moderationActionId: assets.moderationActionId,
    })
    .from(generationJobOutputs)
    .innerJoin(assets, eq(generationJobOutputs.assetId, assets.id))
    .where(
      and(
        eq(generationJobOutputs.jobId, jobId),
        eq(assets.ownerId, ownerId),
        eq(assets.kind, "output"),
        eq(assets.status, "READY"),
        ne(assets.moderationStatus, "REJECTED"),
      ),
    )
    .orderBy(asc(generationJobOutputs.ordinal));
}

async function attachCloudflareOutput(
  job: PersistedJob,
  ordinal: number,
  asset: NewAsset,
  bytes: Uint8Array,
): Promise<PersistedAsset> {
  await ensureDatabase();
  const d1 = getD1Binding();
  if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "D1 存储尚未配置。");
  const [linked] = await getDb().select({ asset: assets }).from(generationJobOutputs)
    .innerJoin(assets, eq(generationJobOutputs.assetId, assets.id))
    .where(and(eq(generationJobOutputs.jobId, job.id), eq(generationJobOutputs.ordinal, ordinal), eq(assets.ownerId, job.ownerId), eq(assets.status, "READY"))).limit(1);
  if (linked?.asset) return linked.asset;

  const [deterministic] = await getDb().select().from(assets)
    .where(and(eq(assets.id, asset.id), eq(assets.ownerId, job.ownerId))).limit(1);
  if (deterministic && (!sameOutputIdentity(deterministic, asset) || deterministic.status === "DELETED")) {
    throw new ApiError(409, "OUTPUT_INTEGRITY_CONFLICT", "确定性输出资产与既有记录不一致。");
  }
  const audit = await runtimeModeration(d1);
  if (audit.mode === "disabled" && deterministic && deterministic.moderationMode !== "disabled") throw new ApiError(503,"MODERATION_UNAVAILABLE","历史输出等待原审核流程处理。");
  if (!deterministic) {
    await d1.prepare(`INSERT OR IGNORE INTO assets
      (id, owner_id, kind, status, original_file_name, mime_type, byte_size, sha256, sanitization_version, storage_key, parent_asset_id, created_at, retention_expires_at, moderation_status, moderation_mode)
      VALUES (?, ?, 'output', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(asset.id, asset.ownerId, asset.originalFileName, asset.mimeType, asset.byteSize, asset.sha256, asset.sanitizationVersion, asset.storageKey, asset.parentAssetId ?? null, asset.createdAt, asset.retentionExpiresAt ?? defaultRetentionExpiresAt("output", asset.createdAt), "UNREVIEWED", audit.mode).run();
  }
  const current = await getDb().select().from(assets).where(eq(assets.id, asset.id)).limit(1);
  if (!current[0] || !sameOutputIdentity(current[0], asset)) throw new ApiError(409, "OUTPUT_INTEGRITY_CONFLICT", "确定性输出资产与既有记录不一致。");

  const bucket = requireR2();
  let object = await bucket.get(asset.storageKey);
  if (!object) {
    await bucket.put(asset.storageKey, bytes, {
      httpMetadata: { contentType: asset.mimeType },
      customMetadata: { assetId: asset.id, sha256: asset.sha256, kind: asset.kind, sanitizationVersion: asset.sanitizationVersion },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    object = await bucket.get(asset.storageKey);
  }
  if (!object || !(await verifyR2Object(object, asset, bytes))) {
    throw new ApiError(502, "OUTPUT_STORAGE_INTEGRITY", "输出对象校验失败。");
  }

  await audit.asset(job.ownerId, asset.id, bytes);
  await d1.batch([
    // Guard the relation insert by status: this closes the cleanup/attach race
    // where a stale writer could otherwise relink a tombstoned asset.
    d1.prepare("INSERT OR IGNORE INTO generation_job_outputs (job_id, asset_id, ordinal) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND kind = 'output' AND status IN ('PENDING','READY') AND moderation_status<>'REJECTED' AND EXISTS(SELECT 1 FROM users u WHERE u.id=assets.owner_id AND u.status='ACTIVE') AND assets.sanitization_version='canonical-image-v1' AND NOT EXISTS(SELECT 1 FROM asset_moderation_evidence e JOIN assets previous ON previous.id=e.asset_id WHERE previous.owner_id=assets.owner_id AND e.content_sha256=assets.sha256 AND e.decision IN ('Review','Block')) AND ("+(audit.mode==="disabled"?"assets.moderation_mode='disabled'":"EXISTS(SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version='"+audit.policyVersion+"' AND e.decision='Pass')")+"))").bind(job.id, asset.id, ordinal, asset.id, job.ownerId),
    d1.prepare(`UPDATE assets SET status = 'READY', deleted_at = NULL, moderation_status=CASE WHEN ?='disabled' THEN 'UNREVIEWED' ELSE 'APPROVED' END, moderated_at=CASE WHEN ?='disabled' THEN NULL ELSE unixepoch() END WHERE id = ? AND owner_id = ? AND kind = 'output' AND status IN ('PENDING','READY') AND moderation_status<>'REJECTED' AND ((?='disabled' AND assets.moderation_mode='disabled') OR EXISTS (SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version=? AND e.decision='Pass')) AND EXISTS (SELECT 1 FROM generation_job_outputs WHERE job_id = ? AND asset_id = ? AND ordinal = ?)`)
      .bind(audit.mode, audit.mode, asset.id, job.ownerId, audit.mode, audit.policyVersion, job.id, asset.id, ordinal),
  ]);
  const [resolved] = await getDb().select({ asset: assets }).from(generationJobOutputs).innerJoin(assets, eq(generationJobOutputs.assetId, assets.id))
    .where(and(eq(generationJobOutputs.jobId, job.id), eq(generationJobOutputs.ordinal, ordinal), eq(assets.ownerId, job.ownerId), eq(assets.status, "READY"))).limit(1);
  if (resolved?.asset) {
    if (resolved.asset.id !== asset.id) await cleanupUnlinkedOutput(asset.id, asset.storageKey);
    return resolved.asset;
  }
  throw new ApiError(409, "OUTPUT_INTEGRITY_CONFLICT", "输出关联未能确认。");
}

function sameOutputIdentity(row: PersistedAsset, asset: NewAsset): boolean {
  return row.ownerId === asset.ownerId && row.kind === "output" && row.storageKey === asset.storageKey && row.sha256 === asset.sha256 && row.sanitizationVersion === asset.sanitizationVersion && row.parentAssetId === (asset.parentAssetId ?? null) && row.byteSize === asset.byteSize;
}

async function verifyR2Object(
  object: R2ObjectBody,
  asset: NewAsset | PersistedAsset,
  expected: Uint8Array,
): Promise<boolean> {
  const metadata = object.customMetadata ?? {};
  if (metadata.assetId !== asset.id || metadata.kind !== "output" || metadata.sha256 !== asset.sha256 || metadata.sanitizationVersion !== asset.sanitizationVersion || object.httpMetadata?.contentType !== asset.mimeType) return false;
  const actual = new Uint8Array(await object.arrayBuffer());
  return actual.byteLength === asset.byteSize && (expected.byteLength === 0 || actual.byteLength === expected.byteLength) && createHash("sha256").update(actual).digest("hex") === asset.sha256;
}

async function cleanupUnlinkedOutput(assetId: string, storageKey: string): Promise<void> {
  const d1 = getD1Binding();
  if (!d1) return;
  const tombstone = await d1.prepare("UPDATE assets SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'DELETED' AND NOT EXISTS (SELECT 1 FROM generation_job_outputs WHERE asset_id = ?)").bind(assetId, assetId).run();
  if (Number(tombstone.meta.changes ?? 0) > 0 || await assetIsDeleted(d1, assetId)) {
    await requireR2().delete(storageKey);
    await d1.prepare("DELETE FROM assets WHERE id = ? AND status = 'DELETED' AND NOT EXISTS (SELECT 1 FROM generation_job_outputs WHERE asset_id = ?) AND NOT EXISTS (SELECT 1 FROM asset_moderation_evidence WHERE asset_id = assets.id)").bind(assetId, assetId).run();
  }
}

async function assetIsDeleted(d1: D1Database, assetId: string): Promise<boolean> {
  const row = await d1.prepare("SELECT status FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM generation_job_outputs WHERE asset_id = ?)").bind(assetId, assetId).first<{ status: string }>();
  return row?.status === "DELETED";
}

async function reconcilePendingOutputs(jobId: string, ownerId: string): Promise<void> {
  const d1 = getD1Binding();
  if (!d1) return;
  // Queue-managed jobs have a separate fenced output-commit protocol. The
  // legacy recovery path must never publish an object written by an expired
  // queue attempt merely because the object happens to be present in R2.
  const queued = await d1
    .prepare("SELECT 1 AS present FROM generation_job_items WHERE job_id = ? LIMIT 1")
    .bind(jobId)
    .first<{ present: number }>();
  if (queued) return;
  const [job] = await getDb().select({ outputCount: generationJobs.outputCount, status: generationJobs.status, errorCode: generationJobs.errorCode }).from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.ownerId, ownerId))).limit(1);
  if (!job) return;
  const prefix = `asset_${jobId.replace(/[^A-Za-z0-9_-]/g, "_")}_`;
  const maxOrdinal = Math.min(job.outputCount, 4);
  for (let ordinal = 0; ordinal < maxOrdinal; ordinal += 1) {
    const deterministicId = `${prefix}${ordinal}`;
    const [candidate] = await getDb().select().from(assets).where(and(eq(assets.id, deterministicId), eq(assets.ownerId, ownerId), eq(assets.kind, "output"))).limit(1);
    if (!candidate || candidate.moderationStatus === "REJECTED") continue;
    if (candidate.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) continue;
    const object = await requireR2().get(candidate.storageKey);
    const valid = object ? await verifyR2Object(object, candidate, new Uint8Array()) : false;
    const decision = decideRecovery(candidate.status, valid, Date.now() - Date.parse(candidate.createdAt), OUTPUT_RECOVERY_THRESHOLD_MS);
    if (decision === "attach") {
      let audit;
      try {
        audit = await runtimeModeration(d1);
        if (audit.mode === "disabled" && candidate.moderationMode !== "disabled") continue;
        const stored = await requireR2().get(candidate.storageKey);
        if (!stored) continue;
        await audit.asset(ownerId, candidate.id, new Uint8Array(await stored.arrayBuffer()));
      } catch (error) {
        if (error instanceof ApiError && ["CONTENT_BLOCKED","CONTENT_REVIEW_REQUIRED"].includes(error.code)) {
          await d1.prepare("UPDATE assets SET moderation_status='REJECTED' WHERE id=? AND owner_id=? AND status='PENDING'").bind(candidate.id,ownerId).run();
          continue;
        }
        if (error instanceof ApiError && error.status === 503) continue;
        throw error;
      }
      await d1.batch([
        d1.prepare("INSERT OR IGNORE INTO generation_job_outputs (job_id, asset_id, ordinal) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND kind = 'output' AND status IN ('PENDING','READY') AND moderation_status<>'REJECTED' AND EXISTS(SELECT 1 FROM users u WHERE u.id=assets.owner_id AND u.status='ACTIVE') AND assets.sanitization_version='canonical-image-v1' AND NOT EXISTS(SELECT 1 FROM asset_moderation_evidence e JOIN assets previous ON previous.id=e.asset_id WHERE previous.owner_id=assets.owner_id AND e.content_sha256=assets.sha256 AND e.decision IN ('Review','Block')) AND ("+(audit.mode==="disabled"?"assets.moderation_mode='disabled'":"EXISTS(SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version='"+audit.policyVersion+"' AND e.decision='Pass')")+"))").bind(jobId, candidate.id, ordinal, candidate.id, ownerId),
        d1.prepare("UPDATE assets SET status = 'READY',moderation_status=CASE WHEN ?='disabled' THEN 'UNREVIEWED' ELSE 'APPROVED' END,moderated_at=CASE WHEN ?='disabled' THEN NULL ELSE unixepoch() END WHERE id = ? AND status IN ('PENDING','READY') AND moderation_status<>'REJECTED' AND ((?='disabled' AND assets.moderation_mode='disabled') OR EXISTS (SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version=? AND e.decision='Pass')) AND EXISTS (SELECT 1 FROM generation_job_outputs WHERE job_id = ? AND asset_id = ? AND ordinal = ?)").bind(audit.mode, audit.mode, candidate.id, audit.mode, audit.policyVersion, jobId, candidate.id, ordinal),
      ]);
    } else if (decision === "cleanup" || decision === "retry-tombstone") {
      await cleanupUnlinkedOutput(candidate.id, candidate.storageKey);
    }
  }
  if (job.status === "VALIDATING" && job.errorCode === "MODERATION_UNAVAILABLE") {
    const unresolved = await d1.prepare("SELECT 1 AS present FROM assets WHERE owner_id=? AND kind='output' AND id LIKE ? AND status='PENDING' AND moderation_status<>'REJECTED' LIMIT 1").bind(ownerId,prefix+"%").first();
    if (!unresolved) {
      const result = await d1.prepare("SELECT COUNT(*) AS count FROM generation_job_outputs o JOIN assets a ON a.id=o.asset_id WHERE o.job_id=? AND a.owner_id=? AND a.status='READY' AND a.moderation_status<>'REJECTED'").bind(jobId,ownerId).first<{count:number}>();
      const count = Number(result?.count ?? 0);
      await d1.prepare("UPDATE generation_jobs SET status=?,completed_output_count=?,finished_at=?,error_code=?,error_message=?,error_retryable=0 WHERE id=? AND owner_id=? AND status='VALIDATING' AND error_code='MODERATION_UNAVAILABLE'").bind(count===job.outputCount?"SUCCEEDED":count>0?"PARTIAL_SUCCEEDED":"FAILED",count,new Date().toISOString(),count===job.outputCount?null:"OUTPUTS_UNAVAILABLE",count===job.outputCount?null:"部分或全部图片未通过内容检查，未计入结果。",jobId,ownerId).run();
    }
  }
}

export function storageHeaders(mode = getStorageMode()): HeadersInit {
  return {
    "X-Designer-Storage": mode,
    ...(mode === "memory-demo"
      ? { Warning: '299 - "Local demo memory storage; data is not durable"' }
      : {}),
  };
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return [
    "SUCCEEDED",
    "PARTIAL_SUCCEEDED",
    "FAILED",
    "CANCELED",
  ].includes(status);
}

function requireR2(): R2Bucket {
  const bucket = getR2Binding();
  if (!bucket) {
    throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "R2 存储尚未配置。");
  }
  return bucket;
}

function missingBlobError(): ApiError {
  return new ApiError(410, "ASSET_CONTENT_MISSING", "图片文件已经不可用。");
}

function emptyKindCounts(): Record<AssetKind, number> {
  return {
    source: 0,
    reference: 0,
    mask: 0,
    output: 0,
    depth: 0,
    normal: 0,
    floorplan: 0,
  };
}

function getMemory(): MemoryState {
  const scope = globalThis as typeof globalThis & {
    [MEMORY_KEY]?: MemoryState;
  };
  if (!scope[MEMORY_KEY]) {
    console.warn(
      "Designer API is using non-durable in-memory storage for local demo only.",
    );
    scope[MEMORY_KEY] = {
      assets: new Map(),
      blobs: new Map(),
      jobs: new Map(),
      idempotency: new Map(),
      outputs: new Map(),
    };
  }
  return scope[MEMORY_KEY];
}

export function tombstoneMemoryAsset(ownerId: string, assetId: string): boolean {
  const memory = getMemory();
  const asset = memory.assets.get(assetId);
  if (!asset || asset.ownerId !== ownerId) return false;
  if (asset.status === "DELETED") return true;
  if (asset.status !== "READY") throw new ApiError(409, "ASSET_NOT_READY", "图片尚未完成，暂时不能删除。");
  const active = [...memory.jobs.values()].some((job) => job.ownerId === ownerId && !["SUCCEEDED", "PARTIAL_SUCCEEDED", "FAILED", "CANCELED"].includes(job.status) && ([job.sourceAssetId, job.referenceAssetId, job.maskAssetId, job.depthAssetId, job.normalAssetId].includes(assetId) || job.additionalReferencesJson.includes(assetId)));
  if (active) throw new ApiError(409, "ASSET_IN_ACTIVE_JOB", "图片正在用于生成任务，请等待任务结束后再删除。");
  const stamp = new Date().toISOString();
  memory.assets.set(assetId, { ...asset, status: "DELETED", deletedAt: stamp, deletionRequestedAt: Math.floor(Date.now() / 1000), purgedAt: Math.floor(Date.now() / 1000) });
  memory.blobs.delete(asset.storageKey);
  return true;
}
