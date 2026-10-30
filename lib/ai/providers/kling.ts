import { bytesToBase64 } from "../base64";
import { AiServiceError, type GenerateInteriorImagesRequest, type GenerateInteriorImagesResult } from "../types";
import {
  assertDomesticRequest,
  domesticResult,
  downloadProviderImage,
  fetchProviderJson,
  mapDomesticHttpError,
  providerDelay,
} from "./domestic-common";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";

const MAX_POLL_ATTEMPTS = 90;
const POLL_INTERVAL_MS = 2_000;
const MAX_OPERATION_MS = 10 * 60 * 1_000;

type KlingBody = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    task_id?: string;
    task_status?: "submitted" | "processing" | "succeed" | "failed";
    task_result?: {
      images?: Array<{ url?: string }>;
      series_images?: Array<{ url?: string }>;
    };
  };
};

export const klingProvider: ImageProviderAdapter = {
  name: "kling",
  model: "kling-v3-omni",
  async generate(request: GenerateInteriorImagesRequest, context: ProviderGenerationContext): Promise<GenerateInteriorImagesResult> {
    const operationTimeout = AbortSignal.timeout(MAX_OPERATION_MS);
    const operationContext = {
      ...context,
      signal: context.signal ? AbortSignal.any([context.signal, operationTimeout]) : operationTimeout,
    };
    const capability = { supportedResolutions: ["1K", "2K", "4K"] as const, maxInputImages: 10, acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maxImageBytes: 10 * 1024 * 1024, maxTotalImageBytes: 32 * 1024 * 1024, inputDimensions: undefined };
    const images = assertDomesticRequest("kling", request, { maxInputImages: capability.maxInputImages, supportedResolutions: capability.supportedResolutions, acceptedMimeTypes: capability.acceptedMimeTypes, maxImageBytes: capability.maxImageBytes, maxTotalImageBytes: capability.maxTotalImageBytes, dimensions: capability.inputDimensions });
    const prompt = `${context.prompt}\n${images.map(({ role }, index) => `<<<image_${index + 1}>>>: ${role}.`).join(" ")}`;
    if (prompt.length > 2_500) {
      throw new AiServiceError({
        code: "INVALID_INPUT",
        message: "Kling prompt exceeds 2500 characters",
        userMessage: "当前提示词超过可灵2500字符限制，请精简后重试。",
        provider: "kling",
      });
    }
    const model = context.model ?? this.model;
    const { body: created } = await fetchProviderJson<KlingBody>("kling", operationContext, context.baseUrl!, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model_name: model,
        prompt,
        image_list: images.map(({ image }) => ({ image: bytesToBase64(image.bytes) })),
        resolution: request.resolution.toLowerCase(),
        n: request.outputCount,
        aspect_ratio: request.aspectRatio,
        result_type: "single",
        watermark_info: { enabled: false },
      }),
    });
    if (created.code !== undefined && created.code !== 0) throw mapDomesticHttpError("kling", 400, created);
    const taskId = created.data?.task_id;
    if (!taskId) throw new AiServiceError({ code: "PROVIDER_ERROR", message: "Kling create response had no task_id", userMessage: "可灵没有返回任务编号，请稍后重试。", retryable: true, provider: "kling", requestId: created.request_id });

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        try {
          await providerDelay(POLL_INTERVAL_MS, operationContext.signal);
        } catch (cause) {
          throw new AiServiceError({ code: "PROVIDER_TIMEOUT", message: "Kling polling was aborted", userMessage: "可灵图片任务已超时，请稍后重试。", retryable: true, provider: "kling", requestId: created.request_id ?? taskId, cause });
        }
      }
      const { body } = await fetchProviderJson<KlingBody>("kling", operationContext, `${context.baseUrl}/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
      });
      if (body.code !== undefined && body.code !== 0) throw mapDomesticHttpError("kling", 400, body);
      if (body.data?.task_status === "failed") {
        throw new AiServiceError({ code: "PROVIDER_ERROR", message: "Kling image task failed", userMessage: "可灵图片任务生成失败，请调整素材后重试。", provider: "kling", requestId: body.request_id ?? taskId });
      }
      if (body.data?.task_status !== "succeed") continue;
      const urls = [
        ...(body.data.task_result?.images ?? []),
        ...(body.data.task_result?.series_images ?? []),
      ].flatMap((item) => item.url ? [item.url] : []);
      const downloads = await Promise.allSettled(urls.slice(0, request.outputCount).map((url) => downloadProviderImage("kling", operationContext, url, ["p1-kling.klingai.com"])));
      const outputs = downloads.flatMap((download) => download.status === "fulfilled" ? [download.value] : []);
      if (!outputs.length) {
        const failure = downloads.find((download): download is PromiseRejectedResult => download.status === "rejected");
        if (failure) throw failure.reason;
      }
      return domesticResult("kling", model, body.request_id ?? created.request_id ?? taskId, request, context, outputs);
    }
    throw new AiServiceError({
      code: "PROVIDER_TIMEOUT",
      message: "Kling image task did not finish before the polling deadline",
      userMessage: "可灵图片任务处理时间过长，请稍后重试。",
      retryable: true,
      provider: "kling",
      requestId: created.request_id ?? taskId,
    });
  },
};
