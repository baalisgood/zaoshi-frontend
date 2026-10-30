import { resolveAiEnvironment } from "@/lib/ai/env";
import { ApiError } from "./api";
import type { AiRuntimeEnvironment, ProviderPreference } from "@/lib/ai";
import type { RequestActor } from "./actor";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { imageModelCapabilities, imageModelSupportsResolution, isImageModel, isOverseasImageModel } from "@/lib/domain/image-models";
import { resolveDomesticProviderConfiguration } from "@/lib/ai/domestic-config";
import { readImageMetadata } from "@/lib/ai/image-metadata";
import type { BinaryImage, ImageMimeType } from "@/lib/ai";

export type BackendProfile = "sites-demo" | "cn-production";

export function assertSameOriginMutation(request: Request): void {
  const target = new URL(request.url);
  const origin = request.headers.get("origin");
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if ((!origin && local) || (origin === target.origin && (local || target.protocol === "https:"))) return;
  throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。生产环境必须使用本站来源提交请求。");
}

export function resolveBackendProfile(environment?: Partial<AiRuntimeEnvironment>): BackendProfile {
  const resolved = resolveAiEnvironment(environment);
  if (!resolved.BACKEND_PROFILE || (resolved.BACKEND_PROFILE !== "sites-demo" && resolved.BACKEND_PROFILE !== "cn-production")) throw new ApiError(503, "INVALID_BACKEND_PROFILE", "后端运行模式配置无效。");
  return resolved.BACKEND_PROFILE === "cn-production" ? "cn-production" : "sites-demo";
}

export function isPublicImageGenerationEnabled(environment?: Partial<AiRuntimeEnvironment>): boolean {
  const env = resolveAiEnvironment(environment);
  return env.BACKEND_PROFILE === "cn-production" && env.AUTH_MODE === "email" && env.PUBLIC_IMAGE_GENERATION_ENABLED === "1" && env.GENERATION_INTERNAL_API_ENABLED === "1";
}
export function assertPublicImageGenerationActor(actor: RequestActor, environment?: Partial<AiRuntimeEnvironment>): void {
  if (!isPublicImageGenerationEnabled(environment)) throw new ApiError(503, "GENERATION_QUEUE_NOT_READY", "正式生图尚未开放。");
  if (!actor.trusted || !actor.user.authenticated || (!actor.user.email && actor.user.verifiedIdentity !== "wechat")) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先通过微信或邮箱登录。");
}

export function assertGenerationRuntime(preference: ProviderPreference, environment?: Partial<AiRuntimeEnvironment>): void {
  const resolved = resolveAiEnvironment(environment);
  const profile = resolveBackendProfile(resolved);
  if (isOverseasImageModel(preference) && isPublicImageGenerationEnabled(resolved) && resolved.OVERSEAS_RELAY_ENABLED === "1") return;
  if (isOverseasImageModel(preference)) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "海外模型仅开放开发者 SSH 私测。", { provider: preference });
  if (isDomesticImageModel(preference)) {
    if (profile !== "cn-production") {
      throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "国产真实图片模型只允许在国内生产模式使用。", { provider: preference });
    }
    if (!resolveDomesticProviderConfiguration(preference, resolved)) {
      throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "当前国产图片模型尚未配置服务端密钥。", { provider: preference });
    }
    return;
  }
  if (profile !== "cn-production") return;
  throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "国内生产环境不允许调用海外图片模型或演示模型。", { provider: preference });
}

export function assertDomesticCanaryActor(
  preference: ProviderPreference,
  actor: RequestActor,
  environment?: Partial<AiRuntimeEnvironment>,
): void {
  if (!isDomesticImageModel(preference)) return;
  const resolved = resolveAiEnvironment(environment);
  if (resolveBackendProfile(resolved) !== "cn-production") {
    throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "国产真实图片模型只允许在国内生产模式使用。", { provider: preference });
  }
  const allowlist = new Set(
    String(resolved.DOMESTIC_AI_CANARY_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const email = actor.user.email?.trim().toLowerCase();
  if (!actor.user.authenticated || !email || !allowlist.has(email)) {
    throw new ApiError(403, "CANARY_ACCESS_REQUIRED", "国产图片模型目前仅向小额测试账号开放。");
  }
}

/** Real domestic generation stays closed until durable queue/lease/budget gates ship. */
export function assertDomesticGenerationQueueReady(preference: ProviderPreference, environment?: Partial<AiRuntimeEnvironment>): void {
  if (isImageModel(preference) && isPublicImageGenerationEnabled(environment)) return;
  if (isImageModel(preference)) throw new ApiError(503, "GENERATION_QUEUE_NOT_READY", "国产生图服务正在进行队列与额度安全联调，暂未开放真实生成。", { provider: preference });
}

export function assertDomesticGenerationParameters(
  preference: ProviderPreference,
  resolution: string,
  hasMask: boolean,
): void {
  if (!isImageModel(preference)) return;
  if (!imageModelSupportsResolution(preference, resolution)) {
    throw new ApiError(400, "PROVIDER_RESOLUTION_UNSUPPORTED", "当前模型不支持所选分辨率，请根据模型说明调整后重试。", { provider: preference, resolution });
  }
  if (hasMask) {
    throw new ApiError(400, "PROVIDER_MASK_UNSUPPORTED", "当前国产模型通用入口还不能把透明蒙版作为硬选区，请先使用整图生成。", { provider: preference });
  }
}

export function assertDomesticInputAssets(
  preference: ProviderPreference,
  assets: readonly { mimeType: string; byteSize: number; bytes?: Uint8Array }[],
): void {
  assertDomesticInputAssetMetadata(preference, assets);
  assertDomesticInputAssetDimensions(preference, assets);
}

export function assertDomesticInputAssetMetadata(
  preference: ProviderPreference,
  assets: readonly { mimeType: string; byteSize: number }[],
): void {
  if (!isImageModel(preference)) return;
  const capability = imageModelCapabilities[preference];
  if (assets.length > capability.maxInputImages) {
    throw new ApiError(400, "PROVIDER_INPUT_LIMIT", `当前模型最多接受${capability.maxInputImages}张输入图。`, { provider: preference, maxInputImages: capability.maxInputImages });
  }
  const accepted = new Set<string>(capability.acceptedMimeTypes);
  if (assets.some((asset) => !accepted.has(asset.mimeType))) {
    throw new ApiError(400, "PROVIDER_IMAGE_FORMAT_UNSUPPORTED", "当前模型不支持其中一张图片的格式，请改用 JPG 或 PNG。", { provider: preference });
  }
  if (assets.some((asset) => asset.byteSize > capability.maxImageBytes) || assets.reduce((sum, asset) => sum + asset.byteSize, 0) > capability.maxTotalImageBytes) {
    throw new ApiError(413, "PROVIDER_IMAGE_TOO_LARGE", "当前模型的输入图片过大，请减少参考图或压缩后重试。", { provider: preference, maxTotalBytes: capability.maxTotalImageBytes });
  }
}

export function assertDomesticInputAssetDimensions(
  preference: ProviderPreference,
  assets: readonly { mimeType: string; byteSize: number; bytes?: Uint8Array }[],
): void {
  if (!isImageModel(preference)) return;
  const capability = imageModelCapabilities[preference];
  if ("inputDimensions" in capability) {
    const limits = capability.inputDimensions;
    if (!limits) return;
    for (const asset of assets) {
      if (!asset.bytes) throw new ApiError(400, "PROVIDER_IMAGE_DIMENSIONS_UNREADABLE", "无法核对图片尺寸，请重新上传。", { provider: preference });
      const metadata = readImageMetadata({ bytes: asset.bytes, mimeType: asset.mimeType as ImageMimeType } satisfies BinaryImage);
      if (!metadata.width || !metadata.height) throw new ApiError(400, "PROVIDER_IMAGE_DIMENSIONS_UNREADABLE", "当前模型无法读取这张图片的尺寸，请重新导出为标准 JPG 或 PNG。", { provider: preference });
      const shortest = Math.min(metadata.width, metadata.height);
      const longest = Math.max(metadata.width, metadata.height);
      const maxSide = "maxSide" in limits && typeof limits.maxSide === "number" ? limits.maxSide : undefined;
      const maxPixels = "maxPixels" in limits && typeof limits.maxPixels === "number" ? limits.maxPixels : undefined;
      const minRatio = "minRatio" in limits && typeof limits.minRatio === "number" ? limits.minRatio : undefined;
      const maxRatio = "maxRatio" in limits && typeof limits.maxRatio === "number" ? limits.maxRatio : undefined;
      const ratio = metadata.width / metadata.height;
      if (
        (limits.minSide && shortest < limits.minSide) ||
        (maxSide && longest > maxSide) ||
        (maxPixels && metadata.width * metadata.height > maxPixels) ||
        (minRatio && ratio < minRatio) ||
        (maxRatio && ratio > maxRatio)
      ) {
        throw new ApiError(400, "PROVIDER_IMAGE_DIMENSIONS_UNSUPPORTED", "这张图片的像素尺寸不符合当前模型要求，请调整后重试。", { provider: preference, width: metadata.width, height: metadata.height });
      }
    }
  }
}

/**
 * Rejects oversized input sets from persisted metadata before reading R2 bodies.
 * Dimension-bound providers are then checked one image at a time to keep the
 * Worker memory peak bounded by one validated upload rather than the whole set.
 */
export async function validateDomesticInputAssetsForProvider<T extends { mimeType: string; byteSize: number }>(
  preference: ProviderPreference,
  assets: readonly T[],
  readBytes: (asset: T) => Promise<Uint8Array>,
): Promise<void> {
  assertDomesticInputAssetMetadata(preference, assets);
  if (!domesticInputDimensionsRequired(preference)) return;
  for (const asset of assets) {
    const bytes = await readBytes(asset);
    assertDomesticInputAssetDimensions(preference, [{ ...asset, bytes }]);
  }
}

export function domesticInputDimensionsRequired(preference: ProviderPreference): boolean {
  return isImageModel(preference) && "inputDimensions" in imageModelCapabilities[preference];
}
export function assertCostBearingActor(actor: RequestActor, environment?: Partial<AiRuntimeEnvironment>): void {
  resolveAiEnvironment(environment);
  if (!actor.user.authenticated || actor.trusted !== true) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先登录后再上传图片或调用 AI 服务。");
  }
}

/** Prompt optimization spends a provider token even in demo mode, so it always needs trusted identity. */
export function assertPromptOptimizerActor(actor: RequestActor, environment?: Partial<AiRuntimeEnvironment>): void {
  resolveAiEnvironment(environment);
  if (!actor.user.authenticated || actor.trusted !== true) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先登录后再使用 AI 提示词优化。");
  }
}
export function assertVisionRuntime(environment?: Partial<AiRuntimeEnvironment>): void { const profile=resolveBackendProfile(environment); if(profile === "cn-production") throw new ApiError(503, "VISION_PROVIDER_DISABLED", "国内视觉服务尚未冻结，暂不支持深度图或法线图生成。"); }

export function assertVisionActor(actor: RequestActor, environment?: Partial<AiRuntimeEnvironment>): void {
  resolveAiEnvironment(environment);
  if (!actor.user.authenticated || actor.trusted !== true) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先登录后再生成深度图或法线图。");
  }
}
