import {
  generateInteriorImages,
  AiServiceError,
  isAiServiceError,
  type ControlImage,
  type GenerateInteriorImagesRequest,
  type ImageMimeType,
} from "@/lib/ai";
import type { PersistedAsset, PersistedJob } from "./persistence";
import { sanitizeGeneratedImage } from "./files";
import {
  attachJobOutput,
  claimQueuedJob,
  getAsset,
  getAssetBytes,
  getJobOutputs,
  updateJob,
} from "./persistence";
import { ApiError } from "./api";
import { auditGenerationInputs } from "./machine-moderation";
import { readAiEnvironment } from "./ai-environment";
import { assertDomesticInputAssetMetadata } from "./runtime-policy";
import {
  referenceAssetKindsForWorkflow,
  sourceAssetKindsForWorkflow,
  safeParseAdvancedSettingsJson,
  parseAdditionalReferencesJson,
  mapPreservation,
  type LightingPreset,
  type PreservationMode,
  type ProviderPreference,
} from "./job-contract";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import { readRuntimeImageSanitizer } from "./runtime-image-sanitizer";

export function assertUniqueJobAssetIds(job: Pick<PersistedJob, "sourceAssetId" | "referenceAssetId" | "maskAssetId" | "depthAssetId" | "normalAssetId">, additionalAssetIds: readonly string[]): void {
  const ids = [job.sourceAssetId, job.referenceAssetId, ...additionalAssetIds, job.maskAssetId, job.depthAssetId, job.normalAssetId].filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) throw new ApiError(500, "INVALID_PERSISTED_ASSET_GRAPH", "任务引用了重复资产，已安全停止处理。");
}

export async function processGenerationJob(job: PersistedJob): Promise<void> {
  let completedOutputCount = 0;

  try {
    if (!(await claimQueuedJob(job.id, job.ownerId))) return;
    const sanitizer = readRuntimeImageSanitizer();
    completedOutputCount = (await getJobOutputs(job.id, job.ownerId)).length;
    await updateJob(job.id, {
      status: "PREPROCESSING",
      startedAt: new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
      errorRetryable: null,
    });

    const source = job.sourceAssetId ? await requiredAsset(job.sourceAssetId, job.ownerId, sourceAssetKindsForWorkflow(job.workflowType, Boolean(job.maskAssetId), job.purpose, Boolean(job.sourceJobId))) : null;
    if (!source && job.workflowType !== "self-service") throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Non self-service job has no source asset", userMessage: "历史任务缺少原始图片，无法继续生成。" });
    const reference = job.referenceAssetId
      ? await requiredAsset(
          job.referenceAssetId,
          job.ownerId,
          referenceAssetKindsForWorkflow(job.workflowType),
        )
      : null;
    const additionalReferences = parseAdditionalReferencesJson(job.additionalReferencesJson, job.workflowType);
    assertUniqueJobAssetIds(job, additionalReferences.map((entry) => entry.assetId));
    const additionalAssets = await Promise.all(additionalReferences.map((entry) => requiredAsset(entry.assetId, job.ownerId, ["reference"])));
    const mask = job.maskAssetId
      ? await requiredAsset(job.maskAssetId, job.ownerId, ["mask"])
      : null;
    const depth = job.depthAssetId
      ? await requiredAsset(job.depthAssetId, job.ownerId, ["depth"])
      : null;
    const normal = job.normalAssetId
      ? await requiredAsset(job.normalAssetId, job.ownerId, ["normal"])
      : null;

    if (isDomesticImageModel(job.providerPreference)) {
      assertDomesticInputAssetMetadata(
        job.providerPreference,
        [source, reference, ...additionalAssets, depth, normal].filter((asset): asset is PersistedAsset => Boolean(asset)),
      );
    }

    await auditGenerationInputs(job.ownerId,[job.customPrompt,job.editInstruction].filter(Boolean).join("\n"),[source,reference,...additionalAssets,mask,depth,normal].filter((asset):asset is PersistedAsset=>Boolean(asset)),async asset=>{const current=await getAsset(asset.id,job.ownerId);if(!current)throw new ApiError(404,"ASSET_NOT_FOUND","图片不可用。");return getAssetBytes(current);});
    const request = await buildAiRequest(
      job,
      source,
      reference,
      additionalReferences,
      additionalAssets,
      mask,
      depth,
      normal,
    );
    await updateJob(job.id, { status: "GENERATING" });
    const result = await generateInteriorImages(request, {
      env: readAiEnvironment(),
    });
    await updateJob(job.id, {
      status: "VALIDATING",
      provider: result.provider,
      model: result.model,
      providerRequestId: result.providerRequestId ?? null,
      promptTemplateVersion: result.promptTemplateVersion,
    });

    const outputErrors: unknown[] = [];
    if (result.outputs.length < job.outputCount) {
      outputErrors.push(
        new ApiError(
          502,
          "SOME_OUTPUTS_MISSING",
          "图像供应商只返回了部分结果。",
        ),
      );
    }
    for (const [index, output] of result.outputs.entries()) {
      if (index >= job.outputCount) break;
      try {
        const image = await sanitizeGeneratedImage(
          output.bytes,
          output.mimeType,
          sanitizer,
        );
        const id = `asset_${job.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${index}`;
        await attachJobOutput(
          job,
          index,
          {
            id,
            ownerId: job.ownerId,
            kind: "output",
            originalFileName: `generated-${index + 1}.${image.extension}`,
            mimeType: image.mimeType,
            byteSize: image.bytes.byteLength,
            sha256: image.sha256,
            sanitizationVersion: IMAGE_SANITIZATION_VERSION,
            storageKey: `generated/${job.ownerId}/${job.id}/${index}.${image.extension}`,
            parentAssetId: job.sourceAssetId,
            createdAt: new Date().toISOString(),
          },
          image.bytes,
        );
        completedOutputCount = (await getJobOutputs(job.id, job.ownerId)).length;
        await updateJob(job.id, { completedOutputCount });
      } catch (error) {
        outputErrors.push(error);
        console.error("Generated output was rejected", {
          jobId: job.id,
          ordinal: index,
          errorName: safeErrorName(error),
        });
      }
    }

    if (outputErrors.some(error => error instanceof ApiError && error.code === "MODERATION_UNAVAILABLE")) {
      await updateJob(job.id,{status:"VALIDATING",completedOutputCount,errorCode:"MODERATION_UNAVAILABLE",errorMessage:"图片已保存，内容检查服务暂不可用，正在等待恢复。",errorRetryable:false});
      return;
    }
    if (completedOutputCount === 0) {
      throw outputErrors[0] ?? new ApiError(
        502,
        "EMPTY_PROVIDER_OUTPUT",
        "图像供应商没有返回可用结果。",
      );
    }

    await updateJob(job.id, {
      status:
        completedOutputCount === job.outputCount
          ? "SUCCEEDED"
          : "PARTIAL_SUCCEEDED",
      completedOutputCount,
      finishedAt: new Date().toISOString(),
      ...(outputErrors.length > 0
        ? {
            errorCode: "SOME_OUTPUTS_UNAVAILABLE",
            errorMessage: "部分图片未返回或未通过文件校验，未计入结果。",
            errorRetryable: true,
          }
        : {}),
    });
  } catch (error) {
    const normalized = normalizeGenerationError(error);
    await updateJob(job.id, {
      status: completedOutputCount > 0 ? "PARTIAL_SUCCEEDED" : "FAILED",
      completedOutputCount,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      errorRetryable: normalized.retryable,
      finishedAt: new Date().toISOString(),
    }).catch((persistenceError) => {
      console.error("Could not persist terminal generation state", {
        jobId: job.id,
        errorName: safeErrorName(persistenceError),
      });
    });
  }
}

async function buildAiRequest(
  job: PersistedJob,
  source: PersistedAsset | null,
  reference: PersistedAsset | null,
  additionalReferences: Array<{ assetId: string; role: import("./job-contract").AdditionalReferenceRole }>,
  additionalAssets: PersistedAsset[],
  mask: PersistedAsset | null,
  depth: PersistedAsset | null,
  normal: PersistedAsset | null,
): Promise<GenerateInteriorImagesRequest> {
  if (!isDomesticImageModel(job.providerPreference)) {
    throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Persisted provider preference is no longer supported", userMessage: "该历史任务使用的图片模型已停用，请重新提交任务。" });
  }
  const lighting = mapLighting(
    job.lightingPreset as LightingPreset,
    job.lampState,
    job.colorTemperatureKelvin,
  );
  const localEdit = Boolean(mask && job.editInstruction);
  const controlImages: ControlImage[] = [];
  if (depth) {
    controlImages.push({ kind: "depth", image: await binaryImage(depth) });
  }
  if (normal) {
    controlImages.push({ kind: "normal", image: await binaryImage(normal) });
  }
  return {
    ...(source ? { sourceImage: await binaryImage(source) } : {}),
    workflowType: job.workflowType,
    spaceType: job.spaceType ?? "unspecified",
    purpose: job.purpose,
    promotedFromPreview: Boolean(job.sourceJobId && job.promotedFromAssetId),
    resolution: job.effectiveResolution as GenerateInteriorImagesRequest["resolution"],
    aspectRatio: job.aspectRatio,
    quality: job.quality,
    ...(job.workflowType === "concept" || job.workflowType === "advanced" ? { visualRealism: job.visualRealism } : {}),
    style: { presetId: job.stylePresetId },
    designSchemeId: job.designSchemeId,
    ...(job.customPrompt ? { customPrompt: job.customPrompt } : {}),
    lighting,
    renovationScope: localEdit
      ? "local-edit"
      : mapPreservation(job.preservationMode as PreservationMode, job.workflowType),
    ...(controlImages.length ? { controlImages } : {}),
    ...((reference || additionalAssets.length) ? { referenceImages: [ ...(reference ? [{ role: "style" as const, image: await binaryImage(reference) }] : []), ...await Promise.all(additionalAssets.map(async (asset, index) => ({ role: additionalReferences[index]!.role, image: await binaryImage(asset) }))) ] } : {}),
    ...(mask ? { mask: await binaryImage(mask) } : {}),
    ...(job.editInstruction ? { editInstruction: job.editInstruction } : {}),
    outputCount: job.outputCount,
    providerPreference: job.providerPreference as ProviderPreference,
    ...(job.workflowType === "advanced" ? { advancedSettings: safeParseAdvancedSettingsJson(job.advancedSettingsJson) } : {}),
  };
}

async function binaryImage(asset: PersistedAsset) {
  return {
    bytes: await getAssetBytes(asset),
    mimeType: asset.mimeType as ImageMimeType,
    fileName: asset.originalFileName,
  };
}

async function requiredAsset(
  id: string,
  ownerId: string,
  expectedKinds: readonly (
    | "source"
    | "reference"
    | "mask"
    | "output"
    | "depth"
    | "normal"
    | "floorplan"
  )[],
): Promise<PersistedAsset> {
  const asset = await getAsset(id, ownerId);
  if (!asset || !expectedKinds.includes(asset.kind)) {
    throw new ApiError(
      400,
      "ASSET_NOT_READY",
      "生成所需的图片不存在或类型不正确。",
    );
  }
  if (asset.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) {
    throw new ApiError(
      409,
      "ASSET_SANITIZATION_REQUIRED",
      "历史图片需要重新上传后才能用于生成。",
    );
  }
  if (asset.moderationStatus === "REJECTED") {
    throw new ApiError(409, "ASSET_REJECTED", "生成所需的图片不可用于生成。");
  }
  return asset;
}

function mapLighting(
  preset: LightingPreset,
  lampState: PersistedJob["lampState"],
  colorTemperatureKelvin: number,
) {
  const shared = { lampState, colorTemperatureKelvin };
  switch (preset) {
    case "morning":
      return {
        timeOfDay: "dawn" as const,
        ...shared,
      };
    case "noon":
      return {
        timeOfDay: "day" as const,
        ...shared,
      };
    case "sunset":
      return {
        timeOfDay: "dusk" as const,
        ...shared,
      };
    case "night":
      return {
        timeOfDay: "night" as const,
        ...shared,
      };
  }
}

function normalizeGenerationError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (isAiServiceError(error)) {
    return {
      code: error.code,
      message: error.userMessage,
      retryable: error.retryable,
    };
  }
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, retryable: error.status >= 500 };
  }
  console.error("Unhandled generation error", {
    errorName: safeErrorName(error),
  });
  return {
    code: "GENERATION_FAILED",
    message: "生成失败，请稍后重试。",
    retryable: true,
  };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
