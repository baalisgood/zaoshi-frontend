import { Buffer } from "node:buffer";
import { imageModelCapabilities, imageModelProvider, imageModelSupportsQuality, isOverseasImageModel, normalizeImageQuality } from "@/lib/domain/image-models";
import { AiServiceError, type GenerateInteriorImagesRequest, type GenerateInteriorImagesResult, type ImageMimeType } from "../types";
import { openAiSize } from "../output-spec";
import { detectImageMime, readImageMetadata } from "../image-metadata";
import { assertDomesticRequest, domesticResult, fetchProviderJson, orderedProviderImages, withInputLegend, withProviderRequestId } from "./domestic-common";
import type { ProviderGenerationContext } from "./types";

type ProviderBody = { responseId?: string; data?: { b64_json?: string }[]; candidates?: { finishReason?: string; content?: { parts?: { thought?: boolean; inlineData?: { data?: string; mimeType?: string } }[] } }[] };

/** Builds a single paid request before dispatch. No fallback or automatic replay. */
export function prepareOverseasImageRequest(request: GenerateInteriorImagesRequest, context: ProviderGenerationContext) {
  if (!isOverseasImageModel(request.providerPreference) || request.outputCount !== 1 || typeof context.fetch !== "function") throw new Error("INVALID_OVERSEAS_REQUEST");
  const model = request.providerPreference;
  const provider = imageModelProvider(model) as "openai" | "google";
  const capability = imageModelCapabilities[model];
  const images = assertDomesticRequest(provider, request, { ...capability, dimensions: capability.inputDimensions });
  if (!imageModelSupportsQuality(model, request.quality)) throw new AiServiceError({ code: "INVALID_INPUT", provider, message: "Unsupported native quality", userMessage: "当前模型不支持所选质量档位。" });
  const prompt = request.workflowType === "self-service" ? context.prompt : withInputLegend(context.prompt, images);
  let endpoint: string;
  let init: RequestInit;
  if (provider === "openai") {
    if (request.resolution === "0.5K") throw new Error("INVALID_OPENAI_RESOLUTION");
    const fields = { model, prompt, n: 1, size: openAiSize(request.resolution, request.aspectRatio), quality: normalizeImageQuality(model, request.quality), output_format: "jpeg" };
    if (images.length) {
      endpoint = "https://api.openai.com/v1/images/edits";
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
      orderedProviderImages(request).forEach(({ image }, index) => form.append("image[]", new Blob([new Uint8Array(image.bytes).buffer], { type: image.mimeType }), `input-${index}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`));
      init = { method: "POST", headers: { Authorization: `Bearer ${context.apiKey}` }, body: form };
    } else {
      endpoint = "https://api.openai.com/v1/images/generations";
      init = { method: "POST", headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(fields) };
    }
  } else {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, ...images.map(({ image }) => ({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") } }))] }], generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"], imageConfig: { imageSize: request.resolution === "0.5K" ? "512" : request.resolution, aspectRatio: request.aspectRatio } } });
    if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw new AiServiceError({ code: "IMAGE_TOO_LARGE", provider, message: "Google request exceeds site 20MiB limit", userMessage: "参考图片编码后超过站内请求限制，请减少或压缩图片。" });
    init = { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": context.apiKey }, body };
  }
  let executed = false;
  return {
    provider, model, promptTemplateVersion: context.promptTemplateVersion,
    async execute(): Promise<GenerateInteriorImagesResult> {
      if (executed) throw new AiServiceError({ code: "PROVIDER_ERROR", provider, message: "Prepared request already executed", userMessage: "任务执行状态异常，已停止重复调用。" });
      executed = true;
      const { body, response } = await fetchProviderJson<ProviderBody>(provider, context, endpoint, init, { maxJsonBytes: 12 * 1024 * 1024, maxErrorJsonBytes: 64 * 1024 });
      const actualId = response.headers.get("x-zaoshi-provider-request-id");
      let providerRequestId = actualId && actualId.length <= 200 ? actualId : undefined;
      try {
        if (provider === "google" && (body.candidates?.length !== 1 || body.candidates[0].finishReason !== "STOP")) throw new AiServiceError({ code: "NO_IMAGE_OUTPUT", provider, message: "Expected one completed candidate", userMessage: "模型响应尚未完成，任务需要核对。" });
        const blocks = provider === "openai"
          ? (body.data ?? []).map((entry) => ({ type: "image", data: entry.b64_json, mime_type: undefined }))
          : (body.candidates?.[0].content?.parts ?? []).filter((part) => !part.thought && part.inlineData).map((part) => ({ type: "image", data: part.inlineData!.data, mime_type: part.inlineData!.mimeType }));
        if (blocks.length !== 1 || !blocks[0]?.data) throw new AiServiceError({ code: "NO_IMAGE_OUTPUT", provider, message: "Expected exactly one final image", userMessage: "模型未返回唯一可用成品图，任务需要核对。" });
        if (!providerRequestId && provider === "google" && typeof body.responseId === "string" && body.responseId.length <= 200) providerRequestId = body.responseId;
        const image = decodeImage(blocks[0].data, blocks[0].mime_type, provider);
        return domesticResult(provider, model, providerRequestId ?? `${provider}_${crypto.randomUUID()}`, request, context, [image], providerRequestId);
      } catch (error) { throw withProviderRequestId(provider, error, providerRequestId); }
    },
  };
}

function decodeImage(encoded: string, mime: string | undefined, provider: "openai" | "google") {
  if (provider === "google" && !["image/png", "image/jpeg", "image/webp"].includes(mime ?? "") || encoded.length > 4 * Math.ceil(8 * 1024 * 1024 / 3) || (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(encoded) || encoded.indexOf("=") >= 0 && !/^={1,2}$/u.test(encoded.slice(encoded.indexOf("="))))) throw invalidImage(provider);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== encoded) throw invalidImage(provider);
  const mimeType = provider === "openai" ? detectImageMime(bytes)?.mimeType : mime as ImageMimeType;
  if (!mimeType) throw invalidImage(provider);
  const metadata = readImageMetadata({ bytes, mimeType });
  if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > 40_000_000) throw invalidImage(provider);
  return { bytes: new Uint8Array(bytes), mimeType };
}

function invalidImage(provider: "openai" | "google") { return new AiServiceError({ code: "NO_IMAGE_OUTPUT", provider, message: "Invalid or oversized provider image", userMessage: "模型图片格式或大小不符合站内存储限制，任务需要核对。" }); }
