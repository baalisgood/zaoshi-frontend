import type { GenerateInteriorImagesRequest, GenerateInteriorImagesResult, OutputAspectRatio } from "../types";
import {
  assertDomesticRequest,
  domesticResult,
  downloadProviderImage,
  fetchProviderJson,
  imageDataUrl,
  withInputLegend,
} from "./domestic-common";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";

const HUNYUAN_SIZES: Record<OutputAspectRatio, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:2": "1152x768",
  "16:9": "1280x720",
  "9:16": "720x1280",
};

type HunyuanBody = {
  id?: string;
  request_id?: string;
  data?: Array<{ url?: string }>;
};

export const hunyuanProvider: ImageProviderAdapter = {
  name: "hunyuan",
  model: "hy-image-v3",
  async generate(request: GenerateInteriorImagesRequest, context: ProviderGenerationContext): Promise<GenerateInteriorImagesResult> {
    const capability = { supportedResolutions: ["1K"] as const, maxInputImages: 3, acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 30 * 1024 * 1024 };
    const images = assertDomesticRequest("hunyuan", request, { maxInputImages: capability.maxInputImages, supportedResolutions: capability.supportedResolutions, acceptedMimeTypes: capability.acceptedMimeTypes, maxImageBytes: capability.maxImageBytes, maxTotalImageBytes: capability.maxTotalImageBytes });
    const outputs: Array<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }> = [];
    const model = context.model ?? this.model;
    let requestId = "";
    for (let index = 0; index < request.outputCount; index += 1) {
      try {
        const { body, response } = await fetchProviderJson<HunyuanBody>("hunyuan", context, context.baseUrl!, {
          method: "POST",
          headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: `${withInputLegend(context.prompt, images)}\nCreate variation ${index + 1} of ${request.outputCount}.`,
            images: images.map(({ image }) => imageDataUrl(image)),
            size: HUNYUAN_SIZES[request.aspectRatio],
            revise: false,
          }),
        });
        requestId ||= body.request_id ?? body.id ?? response.headers.get("x-request-id") ?? `hunyuan_${Date.now().toString(36)}`;
        const url = body.data?.[0]?.url;
        if (!url) return domesticResult("hunyuan", model, requestId, request, context, outputs);
        outputs.push(await downloadProviderImage("hunyuan", context, url, ["aigc-image.cos.myqcloud.com"]));
      } catch (error) {
        if (outputs.length) return domesticResult("hunyuan", model, requestId, request, context, outputs);
        throw error;
      }
    }
    return domesticResult("hunyuan", model, requestId, request, context, outputs);
  },
};
