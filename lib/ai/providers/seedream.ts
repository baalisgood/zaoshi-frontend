import { base64ToBytes } from "../base64";
import { AiServiceError, type GenerateInteriorImagesRequest, type GenerateInteriorImagesResult } from "../types";
import {
  assertDomesticRequest,
  domesticResult,
  fetchProviderJson,
  imageDataUrl,
  withProviderRequestId,
  withInputLegend,
} from "./domestic-common";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";
import { domesticImageModelCapabilities, domesticImageModelProvider, isDomesticImageModel } from "@/lib/domain/domestic-image-models";

type SeedreamBody = {
  model?: string;
  data?: Array<{ b64_json?: string; output_format?: string }>;
  error?: { code?: string };
};

const MAX_SEEDREAM_JSON_BYTES = 12 * 1024 * 1024;
const MAX_SEEDREAM_OUTPUT_BYTES = 8 * 1024 * 1024;

export const seedreamProvider: ImageProviderAdapter = {
  name: "seedream",
  model: "doubao-seedream-5-0-pro-260628",
  async generate(request: GenerateInteriorImagesRequest, context: ProviderGenerationContext): Promise<GenerateInteriorImagesResult> {
    if (!context.model || !isDomesticImageModel(context.model) || domesticImageModelProvider(context.model) !== "seedream") {
      throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Seedream requires a validated model ID", userMessage: "当前 Seedream 模型配置无效，请联系管理员。", provider: "seedream" });
    }
    const model = context.model;
    const capability = domesticImageModelCapabilities[model];
    const images = assertDomesticRequest("seedream", request, { maxInputImages: capability.maxInputImages, supportedResolutions: capability.supportedResolutions, acceptedMimeTypes: capability.acceptedMimeTypes, maxImageBytes: capability.maxImageBytes, maxTotalImageBytes: capability.maxTotalImageBytes, dimensions: capability.inputDimensions });
    const outputs: Array<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> = [];
    let requestId = "";
    let providerRequestId: string | undefined;
    for (let index = 0; index < request.outputCount; index += 1) {
      try {
        const { body, response } = await fetchProviderJson<SeedreamBody>("seedream", context, context.baseUrl!, {
          method: "POST",
          headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: `${withInputLegend(context.prompt, images)}\nCreate variation ${index + 1} of ${request.outputCount}.`,
            ...(images.length ? { image: images.map(({ image }) => imageDataUrl(image)) } : {}),
            size: request.resolution,
            ...(model === "doubao-seedream-5-0-pro-260628" || model === "doubao-seedream-5-0-260128"
              ? { output_format: "png" }
              : {}),
            response_format: "b64_json",
            watermark: false,
          }),
        }, { maxJsonBytes: MAX_SEEDREAM_JSON_BYTES });
        providerRequestId ||= response.headers.get("x-request-id") ?? undefined;
        requestId ||= providerRequestId ?? `local_seedream_${crypto.randomUUID()}`;
        const encoded = body.data?.[0]?.b64_json;
        if (!encoded) return domesticResult("seedream", model, requestId, request, context, outputs, providerRequestId);
        const bytes = base64ToBytes(encoded);
        if (bytes.byteLength > MAX_SEEDREAM_OUTPUT_BYTES) {
          throw new AiServiceError({ code: "IMAGE_TOO_LARGE", message: "seedream output exceeded the decoded size limit", userMessage: "生成结果文件过大，请降低输出规格后重试。", retryable: false, provider: "seedream" });
        }
        const mimeType = detectSeedreamOutputMime(bytes);
        const expectedMimeType = model === "doubao-seedream-4-5-251128" ? "image/jpeg" : "image/png";
        if (mimeType !== expectedMimeType) {
          throw new AiServiceError({ code: "PROVIDER_ERROR", message: "seedream returned an unsupported image output", userMessage: "图片服务返回了无法识别的图片格式，请稍后重试。", retryable: true, provider: "seedream" });
        }
        outputs.push({ bytes, mimeType });
      } catch (error) {
        if (outputs.length) return domesticResult("seedream", model, requestId, request, context, outputs, providerRequestId);
        throw withProviderRequestId("seedream", error, providerRequestId);
      }
    }
    return domesticResult("seedream", model, requestId, request, context, outputs, providerRequestId);
  },
};

function detectSeedreamOutputMime(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return undefined;
}
