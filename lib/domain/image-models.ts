import { domesticImageModelCapabilities, domesticImageModelValues, normalizeKnownDomesticImageModel, type DomesticImageModel } from "@/lib/domain/domestic-image-models";

export const overseasImageModelValues = ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"] as const;
export const imageModelValues = [...domesticImageModelValues, ...overseasImageModelValues] as const;
export type OverseasImageModel = (typeof overseasImageModelValues)[number];
export type ImageModel = (typeof imageModelValues)[number];
export type ImageProvider = "seedream" | "qwen" | "google" | "openai";
export type ImageResolution = "0.5K" | "1K" | "2K" | "4K";
export const imageQualityValues = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof imageQualityValues)[number];
export type StoredImageQuality = ImageQuality | "draft" | "standard";
export const imageQualityOptions = [
  { value: "auto", label: "自动" }, { value: "low", label: "低" }, { value: "medium", label: "中" },
  { value: "high", label: "高" }, { value: "xhigh", label: "超高 Xhigh" }, { value: "max", label: "最高 Max" },
] as const;
type Capability = Omit<(typeof domesticImageModelCapabilities)[DomesticImageModel], "provider" | "supportedResolutions"> & {
  provider: ImageProvider;
  supportedResolutions: readonly ImageResolution[];
  nativeQualities: readonly ImageQuality[];
};
// Conservative site input limits also fit the existing upload/sanitization path.
const overseasInputs = { maxInputImages: 10, acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"] as const, maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 30 * 1024 * 1024, nativeSequenceOutput: false, nativeInteractiveEdit: false, layerDecomposition: false };
const googleInputs = { ...overseasInputs, maxInputImages: 14, maxTotalImageBytes: 14 * 1024 * 1024 };
const overseasCapabilities: Record<OverseasImageModel, Capability> = {
  "gemini-3.1-flash-lite-image": { ...googleInputs, label: "Nano Banana 2 Lite", provider: "google", officialModel: "gemini-3.1-flash-lite-image", supportedResolutions: ["1K"], officialResolutions: ["1K"], nativeQualities: [], officialSummary: "Google 图像生成与编辑模型；输出 1K。", siteSummary: "当前接入 1K、单图输出与有序参考图；站内采用最多14张、单图10MB、原图总计14MiB的保守输入范围；最终请求不超过20MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "Google；1K；未提供原生质量档位。" },
  "gemini-3.1-flash-image": { ...googleInputs, label: "Nano Banana 2", provider: "google", officialModel: "gemini-3.1-flash-image", supportedResolutions: ["0.5K", "1K", "2K", "4K"], officialResolutions: ["0.5K", "1K", "2K", "4K"], nativeQualities: [], officialSummary: "Google 图像生成与编辑模型；支持 0.5K、1K、2K、4K。", siteSummary: "当前接入四种分辨率、单图输出与有序参考图；站内采用最多14张、单图10MB、原图总计14MiB的保守输入范围；最终请求不超过20MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "Google；0.5K / 1K / 2K / 4K；未提供原生质量档位。" },
  "gemini-3-pro-image": { ...googleInputs, label: "Nano Banana Pro", provider: "google", officialModel: "gemini-3-pro-image", supportedResolutions: ["1K", "2K", "4K"], officialResolutions: ["1K", "2K", "4K"], nativeQualities: [], officialSummary: "Google 图像生成与编辑模型；支持 1K、2K、4K。", siteSummary: "当前接入三种分辨率、单图输出与有序参考图；站内采用最多14张、单图10MB、原图总计14MiB的保守输入范围；最终请求不超过20MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "Google；1K / 2K / 4K；未提供原生质量档位。" },
  "gpt-image-2.5-sunburst": { ...overseasInputs, label: "GPT Image 2.5 Sunburst", provider: "openai", officialModel: "gpt-image-2.5-sunburst", supportedResolutions: ["1K", "2K", "4K"], officialResolutions: ["自定义宽高"], nativeQualities: imageQualityValues, officialSummary: "OpenAI 图像生成与编辑模型；提供六种原生质量档位与自定义尺寸。", siteSummary: "当前以自定义尺寸映射 1K/2K/4K，接入六档质量与有序参考图；站内最多10张、单图10MB、原图总计30MB；编码请求不超过32MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "OpenAI；1K / 2K / 4K；六档原生质量。" },
  "gpt-image-2.5-flare": { ...overseasInputs, label: "GPT Image 2.5 Flare", provider: "openai", officialModel: "gpt-image-2.5-flare", supportedResolutions: ["1K", "2K", "4K"], officialResolutions: ["自定义宽高"], nativeQualities: imageQualityValues, officialSummary: "OpenAI 图像生成与编辑模型；提供六种原生质量档位与自定义尺寸。", siteSummary: "当前以自定义尺寸映射 1K/2K/4K，接入六档质量与有序参考图；站内最多10张、单图10MB、原图总计30MB；编码请求不超过32MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "OpenAI；1K / 2K / 4K；六档原生质量。" },
  "gpt-image-2": { ...overseasInputs, label: "GPT Image 2", provider: "openai", officialModel: "gpt-image-2", supportedResolutions: ["1K", "2K", "4K"], officialResolutions: ["自定义宽高"], nativeQualities: ["auto", "low", "medium", "high"], officialSummary: "OpenAI 图像生成与编辑模型；提供自动、低、中、高四种原生质量与自定义尺寸。", siteSummary: "当前以自定义尺寸映射 1K/2K/4K，接入四档质量与有序参考图；站内最多10张、单图10MB、原图总计30MB；编码请求不超过32MiB、输出存储不超过8MiB。正式生图需验证邮箱登录、余额与配额充足，并由服务端开放模型。", note: "OpenAI；1K / 2K / 4K；四档原生质量。" },
};
export const imageModelCapabilities = Object.fromEntries([
  ...domesticImageModelValues.map((model) => [model, { ...domesticImageModelCapabilities[model], nativeQualities: [] }]),
  ...Object.entries(overseasCapabilities),
]) as Record<ImageModel, Capability>;
export const imageModelOptions = imageModelValues.map((value) => ({ value, label: imageModelCapabilities[value].label, note: imageModelCapabilities[value].note }));
export function isImageModel(value: unknown): value is ImageModel { return typeof value === "string" && (imageModelValues as readonly string[]).includes(value); }
export function isOverseasImageModel(value: unknown): value is OverseasImageModel { return typeof value === "string" && (overseasImageModelValues as readonly string[]).includes(value); }
export function normalizeKnownImageModel(value: unknown): ImageModel | undefined { return isImageModel(value) ? value : value === "openai" ? "gpt-image-2" : value === "google" ? "gemini-3.1-flash-image" : normalizeKnownDomesticImageModel(value); }
export function normalizeImageModel(value: unknown): ImageModel { return normalizeKnownImageModel(value) ?? domesticImageModelValues[0]; }
export function imageModelProvider(model: ImageModel): ImageProvider { return imageModelCapabilities[model].provider; }
export function imageModelSupportsResolution(model: ImageModel, resolution: unknown): resolution is ImageResolution { return (imageModelCapabilities[model].supportedResolutions as readonly unknown[]).includes(resolution); }
export function normalizeImageResolution(model: ImageModel, value: unknown): ImageResolution { return imageModelSupportsResolution(model, value) ? value : imageModelCapabilities[model].supportedResolutions[0]; }
export function imageModelResolutionOptions(model: ImageModel) { return (["0.5K", "1K", "2K", "4K"] as const).map((value) => ({ value, label: value, disabled: !imageModelSupportsResolution(model, value) })); }
export function imageModelPreviewResolution(model: ImageModel): ImageResolution { return imageModelCapabilities[model].supportedResolutions[0]; }
export function isStoredImageQuality(value: unknown): value is StoredImageQuality { return value === "draft" || value === "standard" || (imageQualityValues as readonly unknown[]).includes(value); }
export function imageModelSupportsQuality(model: ImageModel, value: unknown): value is StoredImageQuality {
  if (!isStoredImageQuality(value)) return false;
  if (value === "draft" || value === "standard") return true;
  const supported = imageModelCapabilities[model].nativeQualities;
  return supported.length ? supported.includes(value) : value === "auto" || value === "high";
}
export function normalizeImageQuality(model: ImageModel, value: unknown): ImageQuality {
  const quality = value === "draft" ? "low" : value === "standard" ? "medium" : value;
  return (imageModelCapabilities[model].nativeQualities as readonly unknown[]).includes(quality) ? quality as ImageQuality : "auto";
}
export function imageQualityLabel(value: ImageQuality): string { return imageQualityOptions.find((option) => option.value === value)!.label; }
export function imageModelMaxReferences(model: ImageModel, purpose: "preview" | "final", reservePreviewSlot = true): number { const max = imageModelCapabilities[model].maxInputImages; return purpose === "preview" && reservePreviewSlot ? Math.max(0, max - 1) : max; }
/** Resolve self-service drafts before normalizing quality: old quality selected resolution. */
export function restoreSelfServiceResolution(model: ImageModel, config: Record<string, unknown>): ImageResolution {
  if (config.resolution !== undefined) return normalizeImageResolution(model, config.resolution);
  const supported = imageModelCapabilities[model].supportedResolutions;
  return config.quality === "high" ? supported[supported.length - 1] : normalizeImageResolution(model, config.quality === "draft" ? "1K" : "2K");
}
