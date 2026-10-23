export const domesticImageModelValues = ["doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro"] as const;
export type DomesticImageModel = (typeof domesticImageModelValues)[number];
export type DomesticImageProvider = "seedream" | "qwen";
export const domesticImageModelDescription = "服务端按所选官方模型路由；未配置对应密钥或队列未开放时会明确停止，不会回退。";
type Capability = {
  label: string;
  provider: DomesticImageProvider;
  officialModel: string;
  /** Priced and tested product subset. Do not confuse with official model support. */
  supportedResolutions: readonly ("1K" | "2K" | "4K")[];
  officialResolutions: readonly string[];
  maxInputImages: number;
  acceptedMimeTypes: readonly ("image/png" | "image/jpeg" | "image/webp")[];
  maxImageBytes: number;
  maxTotalImageBytes: number;
  inputDimensions?: { minSide?: number; maxSide?: number; maxPixels?: number; minRatio?: number; maxRatio?: number };
  nativeSequenceOutput: boolean;
  nativeInteractiveEdit: boolean;
  layerDecomposition: boolean;
  officialSummary: string;
  siteSummary: string;
  note: string;
};
export const domesticImageModelCapabilities: Record<DomesticImageModel, Capability> = {
  "doubao-seedream-5-0-pro-260628": { label: "Seedream 5.0 Pro", provider: "seedream", officialModel: "doubao-seedream-5-0-pro-260628", supportedResolutions: ["2K"], officialResolutions: ["1K", "1.5K", "2K"], maxInputImages: 10, acceptedMimeTypes: ["image/png", "image/jpeg"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 32 * 1024 * 1024, inputDimensions: { minSide: 15, maxPixels: 36_000_000, minRatio: 1 / 16, maxRatio: 16 }, nativeSequenceOutput: false, nativeInteractiveEdit: true, layerDecomposition: true, officialSummary: "官方支持文生图、最多10张参考图生单图、标注式交互编辑与图层拆分。", siteSummary: "造室当前已接文生图、多参考单图与2K；交互标注和图层拆分尚未接入。", note: "火山方舟；造室当前开放2K；最多10张输入图。" },
  "doubao-seedream-5-0-260128": { label: "Seedream 5.0 Lite", provider: "seedream", officialModel: "doubao-seedream-5-0-260128", supportedResolutions: ["2K"], officialResolutions: ["2K", "3K", "4K"], maxInputImages: 14, acceptedMimeTypes: ["image/png", "image/jpeg"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 32 * 1024 * 1024, inputDimensions: { minSide: 15, maxPixels: 36_000_000, minRatio: 1 / 16, maxRatio: 16 }, nativeSequenceOutput: true, nativeInteractiveEdit: false, layerDecomposition: false, officialSummary: "官方支持文生图、最多14张参考图、单图及内容关联组图。", siteSummary: "造室当前已接文生图、多参考单图与2K；关联组图、联网和流式尚未接入。", note: "火山方舟；造室当前开放2K；最多14张输入图。" },
  "doubao-seedream-4-5-251128": { label: "Seedream 4.5", provider: "seedream", officialModel: "doubao-seedream-4-5-251128", supportedResolutions: ["2K", "4K"], officialResolutions: ["2K", "4K"], maxInputImages: 14, acceptedMimeTypes: ["image/png", "image/jpeg"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 32 * 1024 * 1024, inputDimensions: { minSide: 15, maxPixels: 36_000_000, minRatio: 1 / 16, maxRatio: 16 }, nativeSequenceOutput: true, nativeInteractiveEdit: false, layerDecomposition: false, officialSummary: "官方支持文生图、最多14张参考图、单图及内容关联组图，输出固定JPEG。", siteSummary: "造室当前已接文生图、多参考单图与2K/4K；关联组图和流式尚未接入。", note: "火山方舟；造室当前开放2K/4K；最多14张输入图。" },
  "qwen-image-3.0-pro": { label: "qwen-image-3.0-pro", provider: "qwen", officialModel: "qwen-image-3.0-pro", supportedResolutions: ["1K", "2K"], officialResolutions: ["总像素512×512—2048×2048，可自定义宽高"], maxInputImages: 3, acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 30 * 1024 * 1024, nativeSequenceOutput: false, nativeInteractiveEdit: false, layerDecomposition: false, officialSummary: "官方支持文生图、1至3图自然语言编辑/融合及每次最多6个独立结果。", siteSummary: "造室当前已接文生图、多参考编辑、1K/2K；负向提示词、种子和提示词增强尚未开放。", note: "阿里云百炼北京区；图生图最多3张。" },
  "qwen-image-3.0": { label: "qwen-image-3.0", provider: "qwen", officialModel: "qwen-image-3.0", supportedResolutions: ["1K", "2K"], officialResolutions: ["总像素512×512—2048×2048，可自定义宽高"], maxInputImages: 3, acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 30 * 1024 * 1024, nativeSequenceOutput: false, nativeInteractiveEdit: false, layerDecomposition: false, officialSummary: "官方支持文生图、1至3图自然语言编辑/融合及每次最多6个独立结果。", siteSummary: "造室当前已接文生图、多参考编辑、1K/2K；负向提示词、种子和提示词增强尚未开放。", note: "阿里云百炼北京区；图生图最多3张。" },
  "qwen-image-2.0-pro": { label: "qwen-image-2.0-pro", provider: "qwen", officialModel: "qwen-image-2.0-pro", supportedResolutions: ["1K", "2K"], officialResolutions: ["总像素512×512—2048×2048，可自定义宽高"], maxInputImages: 3, acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 30 * 1024 * 1024, nativeSequenceOutput: false, nativeInteractiveEdit: false, layerDecomposition: false, officialSummary: "官方支持文生图、1至3图自然语言编辑/融合及每次最多6个独立结果。", siteSummary: "造室当前已接文生图、多参考编辑、1K/2K；负向提示词、种子和提示词增强尚未开放。", note: "阿里云百炼北京区；图生图最多3张。" },
};
export const domesticImageModelOptions = domesticImageModelValues.map((value) => ({ value, label: domesticImageModelCapabilities[value].label, note: domesticImageModelCapabilities[value].note }));
const legacyModelMap: Record<string, DomesticImageModel> = { seedream: domesticImageModelValues[0], qwen: "qwen-image-3.0-pro", hunyuan: domesticImageModelValues[0], kling: domesticImageModelValues[0] };
export function normalizeKnownDomesticImageModel(value: unknown): DomesticImageModel | undefined { return typeof value === "string" ? (isDomesticImageModel(value) ? value : legacyModelMap[value]) : undefined; }
export function isDomesticImageModel(value: unknown): value is DomesticImageModel { return typeof value === "string" && (domesticImageModelValues as readonly string[]).includes(value); }
export function normalizeDomesticImageModel(value: unknown): DomesticImageModel { return normalizeKnownDomesticImageModel(value) ?? domesticImageModelValues[0]; }
export function domesticImageModelLabel(value: unknown): string { return domesticImageModelCapabilities[normalizeDomesticImageModel(value)].label; }
export function domesticImageModelSupportsResolution(model: DomesticImageModel, resolution: string): boolean { return (domesticImageModelCapabilities[model].supportedResolutions as readonly string[]).includes(resolution); }
export type DomesticOutputResolution = "1K" | "2K" | "4K";
export function domesticImageModelResolutionOptions(model: DomesticImageModel) {
  const note = model === "doubao-seedream-4-5-251128"
    ? "官方仅支持 2K / 4K；需要 1K 请切换 Qwen Image 2.0 Pro。"
    : `当前模型可选：${domesticImageModelCapabilities[model].supportedResolutions.join(" / ")}。`;
  return domesticImageModelCapabilities[model].supportedResolutions.map((value) => ({ value, label: value, note }));
}
export function normalizeDomesticImageResolution(model: DomesticImageModel, value: unknown): DomesticOutputResolution { const supported = domesticImageModelCapabilities[model].supportedResolutions; return (supported as readonly unknown[]).includes(value) ? value as DomesticOutputResolution : supported[0]; }
export function domesticImageModelQualityResolution(model: DomesticImageModel, quality: "draft" | "standard" | "high"): DomesticOutputResolution { const supported = domesticImageModelCapabilities[model].supportedResolutions; if (quality === "high") return supported[supported.length - 1]; return normalizeDomesticImageResolution(model, quality === "standard" ? "2K" : "1K"); }
export function domesticImageModelPreviewResolution(model: DomesticImageModel): DomesticOutputResolution { return domesticImageModelCapabilities[model].supportedResolutions[0]; }
export function domesticImageModelProvider(model: DomesticImageModel): DomesticImageProvider { return domesticImageModelCapabilities[model].provider; }
/**
 * Self-service preview promotes one generated image into the next request's
 * provider input, so reserve one input slot for that selected output. Direct
 * final generations can use the model's full documented input capacity.
 */
export function domesticImageModelMaxReferences(model: DomesticImageModel, purpose: "preview" | "final", reservePreviewSlot = true): number {
  const max = domesticImageModelCapabilities[model].maxInputImages;
  return purpose === "preview" && reservePreviewSlot ? Math.max(0, max - 1) : max;
}
