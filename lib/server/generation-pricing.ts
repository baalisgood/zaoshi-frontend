import {
  domesticImageModelCapabilities,
  domesticImageModelPreviewResolution,
  isDomesticImageModel,
  type DomesticImageModel,
} from "@/lib/domain/domestic-image-models";
import { openAiSize } from "@/lib/ai/output-spec";
import type { OutputAspectRatio } from "@/lib/ai/types";
import { ApiError } from "./api";
import type { GenerationBilling, GenerationPriceExpectation } from "./credit-ledger";
import { imageModelCapabilities, imageModelPreviewResolution, imageModelSupportsQuality, imageModelSupportsResolution, isOverseasImageModel, normalizeImageQuality, type ImageModel, type ImageResolution, type ImageQuality } from "@/lib/domain/image-models";
import { assertPrivateTestActive, assertPrivateTestActor, type PrivateTestConfig } from "./private-test-policy";
import type { RequestActor } from "./actor";

export const GENERATION_PRICE_VERSION = "cn-image-v2-20261005";
export const OVERSEAS_IMAGE_PRICE_VERSION = "overseas-image-v2-20261005";
export const OVERSEAS_PRIVATE_TEST_PRICE_VERSION = "private-test-overseas-reservation-v1-20260930";

type Resolution = "1K" | "2K" | "4K";
type Purpose = "preview" | "final";
const resolutions: readonly Resolution[] = ["1K", "2K", "4K"];

const outputCostMicroCny: Record<DomesticImageModel, Partial<Record<Resolution, number>>> = {
  "doubao-seedream-5-0-pro-260628": { "2K": 600000 },
  "doubao-seedream-5-0-260128": { "2K": 220000 },
  "doubao-seedream-4-5-251128": { "2K": 250000, "4K": 250000 },
  "qwen-image-3.0-pro": { "1K": 250000, "2K": 500000 },
  "qwen-image-3.0": { "1K": 180000, "2K": 180000 },
  "qwen-image-2.0-pro": { "1K": 500000, "2K": 500000 },
};

export type GenerationPriceQuote = {
  priceVersion: typeof GENERATION_PRICE_VERSION | typeof OVERSEAS_PRIVATE_TEST_PRICE_VERSION | typeof OVERSEAS_IMAGE_PRICE_VERSION;
  modelId: ImageModel;
  purpose: Purpose;
  operationType: "text-to-image" | "image-to-image" | "multi-reference";
  effectiveResolution: ImageResolution;
  inputImageCount: number;
  billableInputImageCount: number;
  outputCount: number;
  outputCreditsPerImage: number;
  inputCredits: number;
  amountPerItem: number;
  totalCredits: number;
  quality?: ImageQuality;
  privateTestOnly?: true;
  billingMode?: "private-test-reservation";
};

export function quoteGenerationPrice(input: {
  modelId: unknown;
  purpose: unknown;
  requestedResolution: unknown;
  inputImageCount: unknown;
  outputCount: unknown;
  quality?: unknown;
  aspectRatio?: unknown;
}, context?: { privateTest?: { config: PrivateTestConfig; actor: RequestActor }; production?: true }): GenerationPriceQuote {
  const aspectRatio = input.aspectRatio ?? "4:3";
  if (typeof aspectRatio !== "string" || !["1:1", "4:3", "3:2", "16:9", "9:16"].includes(aspectRatio)) invalid("画面比例无效。", "aspectRatio");
  if (isOverseasImageModel(input.modelId)) {
    if (!context?.privateTest && !context?.production) throw new ApiError(403, "OVERSEAS_PRIVATE_TEST_ONLY", "海外模型仅开放开发者 SSH 免积分私测。");
    if (context?.privateTest) { assertPrivateTestActor(context.privateTest.actor); assertPrivateTestActive(context.privateTest.config); }
    const modelId = input.modelId;
    const capability = imageModelCapabilities[modelId];
    if (input.purpose !== "preview" && input.purpose !== "final") invalid("生成类型无效。", "purpose");
    if (!imageModelSupportsResolution(modelId, input.requestedResolution)) invalid("当前模型不支持所选分辨率。", "resolution");
    if (!Number.isSafeInteger(input.inputImageCount) || Number(input.inputImageCount) < 0 || Number(input.inputImageCount) > capability.maxInputImages) invalid("输入图片数量超出当前模型限制。", "inputImageCount");
    if (!Number.isSafeInteger(input.outputCount) || Number(input.outputCount) < 1 || Number(input.outputCount) > 4) invalid("输出数量必须是1到4。", "outputCount");
    if (!imageModelSupportsQuality(modelId, input.quality ?? "standard")) invalid("当前模型不支持所选质量。", "quality");
    const inputImageCount = Number(input.inputImageCount);
    const outputCount = input.purpose === "preview" ? 1 : Number(input.outputCount);
    const effectiveResolution = input.purpose === "preview" ? imageModelPreviewResolution(modelId) : input.requestedResolution;
    const quality = normalizeImageQuality(modelId, input.purpose === "preview" ? "draft" : input.quality ?? "standard");
    if (context?.privateTest) {
    return { priceVersion: OVERSEAS_PRIVATE_TEST_PRICE_VERSION, modelId, purpose: input.purpose, effectiveResolution: input.purpose === "preview" ? imageModelPreviewResolution(modelId) : input.requestedResolution, quality, operationType: inputImageCount === 0 ? "text-to-image" : inputImageCount === 1 ? "image-to-image" : "multi-reference", inputImageCount, billableInputImageCount: 0, outputCount, outputCreditsPerImage: 1, inputCredits: 0, amountPerItem: 1, totalCredits: outputCount, privateTestOnly: true, billingMode: "private-test-reservation" };
    }
    const cost = overseasCost(modelId, effectiveResolution, quality, aspectRatio as OutputAspectRatio);
    const outputCreditsPerImage = costCredits(cost.base);
    const amountPerItem = costCredits(cost.base + inputImageCount * cost.perInput);
    const inputCredits = amountPerItem - outputCreditsPerImage;
    return { priceVersion: OVERSEAS_IMAGE_PRICE_VERSION, modelId, purpose: input.purpose, effectiveResolution, quality, operationType: inputImageCount === 0 ? "text-to-image" : inputImageCount === 1 ? "image-to-image" : "multi-reference", inputImageCount, billableInputImageCount: inputImageCount, outputCount, outputCreditsPerImage, inputCredits, amountPerItem, totalCredits: amountPerItem * outputCount };

  }
  if (!isDomesticImageModel(input.modelId)) invalid("图像模型无效。", "modelId");
  if (input.purpose !== "preview" && input.purpose !== "final") invalid("生成类型无效。", "purpose");
  if (typeof input.requestedResolution !== "string" || !resolutions.includes(input.requestedResolution as Resolution)) invalid("分辨率无效。", "resolution");
  if (!Number.isSafeInteger(input.inputImageCount) || Number(input.inputImageCount) < 0) invalid("输入图片数量无效。", "inputImageCount");
  if (!Number.isSafeInteger(input.outputCount) || Number(input.outputCount) < 1 || Number(input.outputCount) > 4) invalid("输出数量必须是1到4。", "outputCount");

  const modelId = input.modelId as DomesticImageModel;
  const purpose = input.purpose as Purpose;
  const capability = domesticImageModelCapabilities[modelId];
  const inputImageCount = Number(input.inputImageCount);
  if (inputImageCount > capability.maxInputImages) invalid(`当前模型最多接受${capability.maxInputImages}张输入图。`, "inputImageCount");
  const effectiveResolution = (purpose === "preview"
    ? domesticImageModelPreviewResolution(modelId)
    : input.requestedResolution) as Resolution;
  if (!capability.supportedResolutions.includes(effectiveResolution)) invalid("当前模型不支持所选分辨率。", "resolution");
  const outputCost = outputCostMicroCny[modelId][effectiveResolution];
  if (!outputCost) throw new ApiError(503, "GENERATION_PRICING_NOT_CONFIGURED", "当前模型和分辨率尚未配置积分价格。");

  const billableInputImageCount = modelId === "doubao-seedream-5-0-pro-260628"
    ? Math.max(0, inputImageCount - 1)
    : modelId === "qwen-image-3.0-pro" || modelId === "qwen-image-3.0"
      ? inputImageCount
      : 0;
  const outputCreditsPerImage = costCredits(outputCost);
  const amountPerItem = costCredits(outputCost + billableInputImageCount * 20000);
  const inputCredits = amountPerItem - outputCreditsPerImage;
  const outputCount = purpose === "preview" ? 1 : Number(input.outputCount);
  return {
    priceVersion: GENERATION_PRICE_VERSION,
    modelId,
    purpose,
    operationType: inputImageCount === 0 ? "text-to-image" : inputImageCount === 1 ? "image-to-image" : "multi-reference",
    effectiveResolution,
    inputImageCount,
    billableInputImageCount,
    outputCount,
    outputCreditsPerImage,
    inputCredits,
    amountPerItem,
    totalCredits: amountPerItem * outputCount,
  };
}

export function generationBilling(quote: GenerationPriceQuote): GenerationBilling {
  return { amountPerItem: quote.amountPerItem, priceVersion: quote.priceVersion };
}

export function readGenerationPriceExpectation(value: unknown): GenerationPriceExpectation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("缺少积分报价。", "expectedPriceVersion");
  const body = value as Record<string, unknown>;
  if (body.expectedPriceVersion === undefined && body.expectedTotalCredits === undefined) return undefined;
  if (typeof body.expectedPriceVersion !== "string" || body.expectedPriceVersion.length < 1 || body.expectedPriceVersion.length > 80) invalid("积分报价版本无效。", "expectedPriceVersion");
  if (!Number.isSafeInteger(body.expectedTotalCredits) || Number(body.expectedTotalCredits) < 1) invalid("预计积分无效。", "expectedTotalCredits");
  return { expectedPriceVersion: body.expectedPriceVersion, expectedTotalCredits: Number(body.expectedTotalCredits) };
}

function invalid(message: string, field: string): never {
  throw new ApiError(400, "INVALID_PRICING_INPUT", message, { field });
}

// Approved Excel budget: FX 7, 55% margin, 100 credits/CNY; costs use integer micro-CNY.
// Round only the complete per-output cost, including all inputs; auto uses the highest fixed budget.
function costCredits(microCny: number): number { return Math.ceil(microCny / 4500); }

const openAiOutputMicroUsd: Record<string, Record<string, number>> = {
  "1024x1024": {
    "low": 5880,
    "medium": 13170,
    "high": 52680,
    "xhigh": 93660,
    "max": 210720
  },
  "1024x768": {
    "low": 4020,
    "medium": 9030,
    "high": 36120,
    "xhigh": 64200,
    "max": 144450
  },
  "1152x768": {
    "low": 3810,
    "medium": 8310,
    "high": 33240,
    "xhigh": 59550,
    "max": 132930
  },
  "1280x720": {
    "low": 3180,
    "medium": 7380,
    "high": 28410,
    "xhigh": 50490,
    "max": 113610
  },
  "720x1280": {
    "low": 3180,
    "medium": 7380,
    "high": 28410,
    "xhigh": 50490,
    "max": 113610
  },
  "2048x2048": {
    "low": 11910,
    "medium": 26760,
    "high": 107040,
    "xhigh": 190290,
    "max": 428160
  },
  "2048x1536": {
    "low": 7410,
    "medium": 16680,
    "high": 66690,
    "xhigh": 118560,
    "max": 266760
  },
  "2304x1536": {
    "low": 7320,
    "medium": 15960,
    "high": 63810,
    "xhigh": 114330,
    "max": 255240
  },
  "2048x1152": {
    "low": 4710,
    "medium": 11010,
    "high": 42390,
    "xhigh": 75330,
    "max": 169500
  },
  "1152x2048": {
    "low": 4710,
    "medium": 11010,
    "high": 42390,
    "xhigh": 75330,
    "max": 169500
  },
  "2880x2880": {
    "low": 19770,
    "medium": 44490,
    "high": 177900,
    "xhigh": 316260,
    "max": 711570
  },
  "3200x2400": {
    "low": 13950,
    "medium": 31380,
    "high": 125460,
    "xhigh": 223050,
    "max": 501840
  },
  "3456x2304": {
    "low": 13170,
    "medium": 28710,
    "high": 114780,
    "xhigh": 205650,
    "max": 459090
  },
  "3840x2160": {
    "low": 11130,
    "medium": 25950,
    "high": 100080,
    "xhigh": 177900,
    "max": 400260
  },
  "2160x3840": {
    "low": 11130,
    "medium": 25950,
    "high": 100080,
    "xhigh": 177900,
    "max": 400260
  }
};

function overseasCost(model: ImageModel, resolution: ImageResolution, quality: ImageQuality, aspectRatio: OutputAspectRatio): { base: number; perInput: number } {
  if (model.startsWith("gpt-image-")) {
    if (resolution === "0.5K") invalid("当前模型不支持所选分辨率。", "resolution");
    const tier = quality === "auto" ? "max" : model === "gpt-image-2" ? ({ low: "low", medium: "high", high: "max" } as Record<string, string>)[quality] : quality;
    const output = openAiOutputMicroUsd[openAiSize(resolution, aspectRatio)]?.[tier];
    if (!output) throw new ApiError(503, "GENERATION_PRICING_NOT_CONFIGURED", "当前规格尚未配置价格。");
    return { base: (output + 5000) * 7, perInput: 8000 * 7 };
  }
  const google = model === "gemini-3.1-flash-lite-image" ? { outputs: { "1K": 33600 }, inputRate: 0.25, textRate: 1.5, imageTokens: 1000 }
    : model === "gemini-3.1-flash-image" ? { outputs: { "0.5K": 44820, "1K": 67200, "2K": 100800, "4K": 151200 }, inputRate: 0.5, textRate: 3, imageTokens: 1000 }
    : { outputs: { "1K": 134400, "2K": 134400, "4K": 240000 }, inputRate: 2, textRate: 12, imageTokens: 560 };
  const output = (google.outputs as Partial<Record<ImageResolution, number>>)[resolution];
  if (!output) throw new ApiError(503, "GENERATION_PRICING_NOT_CONFIGURED", "当前规格尚未配置价格。");
  return { base: (output + 1000 * google.inputRate + 1000 * google.textRate) * 7, perInput: google.imageTokens * google.inputRate * 7 };
}
