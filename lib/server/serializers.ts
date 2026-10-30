import type { PersistedAsset, PersistedJob } from "./persistence";
import { parseAdditionalReferencesJson, safeParseAdvancedSettingsJson } from "./job-contract";

export function serializeAsset(asset: PersistedAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    fileName: asset.originalFileName,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    parentAssetId: asset.parentAssetId,
    createdAt: asset.createdAt,
    retentionExpiresAt: asset.retentionExpiresAt,
    moderationStatus: asset.moderationStatus,
    url: `/api/assets/${encodeURIComponent(asset.id)}?content=1`,
  };
}

export function serializeJob(job: (Omit<PersistedJob, "advancedSettingsJson" | "additionalReferencesJson" | "purpose" | "sourceJobId" | "promotedFromAssetId" | "effectiveResolution" | "customPrompt" | "visualRealism" | "spaceType" | "designSchemeId"> & { spaceType?: PersistedJob["spaceType"]; advancedSettingsJson?: string; additionalReferencesJson?: string; visualRealism?: PersistedJob["visualRealism"] }) & Partial<Pick<PersistedJob, "purpose" | "sourceJobId" | "promotedFromAssetId" | "effectiveResolution" | "customPrompt" | "designSchemeId">>, outputs: PersistedAsset[]) {
  return {
    id: job.id,
    status: job.status,
    reconciliationRequired: job.reconciliationRequired === true,
    sourceAssetId: job.sourceAssetId,
    referenceAssetId: job.referenceAssetId,
    additionalReferences: parseAdditionalReferencesJson(job.additionalReferencesJson, job.workflowType),
    maskAssetId: job.maskAssetId,
    depthAssetId: job.depthAssetId,
    normalAssetId: job.normalAssetId,
    controlAssetIds: [job.depthAssetId, job.normalAssetId].filter(
      (assetId): assetId is string => Boolean(assetId),
    ),
    workflowType: job.workflowType,
    purpose: job.purpose ?? "final",
    sourceJobId: job.sourceJobId ?? null,
    promotedFromAssetId: job.promotedFromAssetId ?? null,
    resolution: job.resolution,
    effectiveResolution: job.effectiveResolution ?? job.resolution,
    aspectRatio: job.aspectRatio,
    quality: job.quality,
    ...(job.workflowType === "concept" || job.workflowType === "advanced" ? { visualRealism: job.visualRealism ?? "photorealistic" } : {}),
    lampState: job.lampState,
    colorTemperatureKelvin: job.colorTemperatureKelvin,
    spaceType: job.spaceType ?? "unspecified",
    stylePresetId: job.stylePresetId,
    ...(job.workflowType === "concept" ? { designSchemeId: job.designSchemeId ?? null } : {}),
    lightingPreset: job.lightingPreset,
    preservationMode: job.preservationMode,
    providerPreference: job.providerPreference,
    ...((job.workflowType === "self-service" || job.workflowType === "advanced") ? { customPrompt: job.customPrompt ?? null } : {}),
    outputCount: job.outputCount,
    hasPendingOutputs: job.hasPendingOutputs === true,
    advancedSettings: safeParseAdvancedSettingsJson(job.advancedSettingsJson),
    completedOutputCount: job.completedOutputCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    provider: job.provider,
    model: job.model,
    results: outputs.map((asset) => ({
      assetId: asset.id,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      parentAssetId: asset.parentAssetId,
      moderationStatus: asset.moderationStatus,
      url: `/api/assets/${encodeURIComponent(asset.id)}?content=1`,
      previewUrl: `/api/assets/${encodeURIComponent(asset.id)}?content=1`,
    })),
    error: job.errorCode
      ? {
          code: job.errorCode,
          message: job.errorMessage ?? "生成失败，请稍后重试。",
          retryable: Boolean(job.errorRetryable),
        }
      : null,
  };
}
