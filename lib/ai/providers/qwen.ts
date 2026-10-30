import { AiServiceError, type GenerateInteriorImagesRequest, type GenerateInteriorImagesResult } from "../types";
import { openAiSize } from "../output-spec";
import {
  assertDomesticRequest,
  domesticResult,
  downloadProviderImage,
  fetchProviderJson,
  imageDataUrl,
  withProviderRequestId,
  withInputLegend,
} from "./domestic-common";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";
import { domesticImageModelCapabilities, domesticImageModelProvider, isDomesticImageModel } from "@/lib/domain/domestic-image-models";

type QwenBody = {
  request_id?: string;
  code?: string;
  output?: {
    choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>;
  };
};

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const QWEN_RESULT_HOST = new RegExp(
  `^dashscope-${DNS_LABEL}\\.oss-(?:accelerate|cn-${DNS_LABEL})\\.aliyuncs\\.com$`,
  "u",
);

export function isApprovedQwenResultHost(hostname: string): boolean {
  return QWEN_RESULT_HOST.test(hostname);
}

export const qwenProvider: ImageProviderAdapter = {
  name: "qwen",
  model: "qwen-image-3.0-pro",
  async generate(request: GenerateInteriorImagesRequest, context: ProviderGenerationContext): Promise<GenerateInteriorImagesResult> {
    if (!context.model || !isDomesticImageModel(context.model) || domesticImageModelProvider(context.model) !== "qwen") {
      throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Qwen requires a validated model ID", userMessage: "当前 Qwen 模型配置无效，请联系管理员。", provider: "qwen" });
    }
    const model = context.model;
    const capability = domesticImageModelCapabilities[model];
    const images = assertDomesticRequest("qwen", request, { maxInputImages: capability.maxInputImages, supportedResolutions: capability.supportedResolutions, acceptedMimeTypes: capability.acceptedMimeTypes, maxImageBytes: capability.maxImageBytes, maxTotalImageBytes: capability.maxTotalImageBytes });
    const { body, response } = await fetchProviderJson<QwenBody>("qwen", context, context.baseUrl!, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: {
          messages: [{
            role: "user",
            content: [
              ...images.map(({ image }) => ({ image: imageDataUrl(image) })),
              { text: withInputLegend(context.prompt, images) },
            ],
          }],
        },
        parameters: {
          prompt_extend: false,
          n: request.outputCount,
          size: openAiSize(request.resolution as "1K" | "2K", request.aspectRatio).replace("x", "*"),
          watermark: false,
        },
      }),
    });
    const providerRequestId = body.request_id ?? response.headers.get("x-request-id") ?? undefined;
    const requestId = providerRequestId ?? `local_qwen_${crypto.randomUUID()}`;
    const urls = body.output?.choices?.flatMap((choice) => choice.message?.content?.flatMap((item) => item.image ? [item.image] : []) ?? []) ?? [];
    const downloads: PromiseSettledResult<{ bytes: Uint8Array; mimeType: import("../types").ImageMimeType }>[] = [];
    for (const url of urls.slice(0, request.outputCount)) {
      try {
        downloads.push({ status: "fulfilled", value: await downloadProviderImage("qwen", context, url, isApprovedQwenResultHost) });
      } catch (reason) {
        downloads.push({ status: "rejected", reason });
      }
    }
    const outputs = downloads.flatMap((download) => download.status === "fulfilled" ? [download.value] : []);
    if (!outputs.length) {
      const failure = downloads.find((download): download is PromiseRejectedResult => download.status === "rejected");
      if (failure) throw withProviderRequestId("qwen", failure.reason, providerRequestId);
    }
    return domesticResult("qwen", model, requestId, request, context, outputs, providerRequestId);
  },
};
