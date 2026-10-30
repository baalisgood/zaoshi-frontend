import { base64ToBytes, toOwnedArrayBuffer } from "../base64";
import { readImageMetadata } from "../image-metadata";
import { openAiQuality, openAiSize } from "../output-spec";
import {
  AiServiceError,
  type BinaryImage,
  type GenerateInteriorImagesRequest,
  type GenerateInteriorImagesResult,
} from "../types";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";

export const OPENAI_IMAGE_MODEL = "gpt-image-2";
export const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

interface OpenAiErrorBody {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
}

interface OpenAiImageBody extends OpenAiErrorBody {
  id?: string;
  data?: Array<{ b64_json?: string }>;
}

function extensionFor(image: BinaryImage): string {
  if (image.mimeType === "image/jpeg") return "jpg";
  if (image.mimeType === "image/webp") return "webp";
  return "png";
}

function appendImage(form: FormData, field: string, image: BinaryImage, index: number): void {
  const fileName = `${field.replace(/\W/g, "")}-${index}.${extensionFor(image)}`;
  form.append(
    field,
    new Blob([toOwnedArrayBuffer(image.bytes)], { type: image.mimeType }),
    fileName,
  );
}

function validateMask(source: BinaryImage, mask: BinaryImage): void {
  if (source.bytes.length >= MAX_IMAGE_BYTES || mask.bytes.length >= MAX_IMAGE_BYTES) {
    throw new AiServiceError({
      code: "IMAGE_TOO_LARGE",
      message: "OpenAI edit image and mask must each be less than 50MB",
      userMessage: "原图和局部修改蒙版均须小于50MB。",
      provider: "openai",
    });
  }
  if (source.mimeType !== mask.mimeType) {
    throw new AiServiceError({
      code: "MASK_FORMAT_MISMATCH",
      message: "OpenAI edit image and mask must have the same format",
      userMessage: "局部修改蒙版必须与原图使用相同图片格式。",
      provider: "openai",
    });
  }

  const sourceMetadata = readImageMetadata(source);
  const maskMetadata = readImageMetadata(mask);
  if (
    !sourceMetadata.width ||
    !sourceMetadata.height ||
    !maskMetadata.width ||
    !maskMetadata.height
  ) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: "Unable to verify image and mask dimensions",
      userMessage: "无法读取原图或蒙版尺寸，请重新导出为PNG后上传。",
      provider: "openai",
    });
  }
  if (
    sourceMetadata.width !== maskMetadata.width ||
    sourceMetadata.height !== maskMetadata.height
  ) {
    throw new AiServiceError({
      code: "MASK_DIMENSIONS_MISMATCH",
      message: "OpenAI edit image and mask dimensions differ",
      userMessage: "局部修改蒙版必须与原图尺寸完全一致。",
      provider: "openai",
    });
  }
  if (!maskMetadata.hasAlpha) {
    throw new AiServiceError({
      code: "MASK_ALPHA_REQUIRED",
      message: "OpenAI edit mask must contain an alpha channel",
      userMessage: "局部修改蒙版必须包含透明通道，请重新导出为带透明通道的图片。",
      provider: "openai",
    });
  }
}

function mapOpenAiError(
  status: number,
  body: OpenAiErrorBody,
  requestId?: string,
): AiServiceError {
  const providerCode = body.error?.code ?? body.error?.type;
  const providerMessage = body.error?.message ?? `OpenAI request failed with ${status}`;
  const normalizedCode = providerCode?.toLowerCase() ?? "";

  if (
    normalizedCode.includes("content_policy") ||
    normalizedCode.includes("moderation") ||
    normalizedCode.includes("safety")
  ) {
    return new AiServiceError({
      code: "CONTENT_REJECTED",
      message: providerMessage,
      userMessage: "图片或修改要求未通过内容安全检查，请更换素材后重试。",
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  if (normalizedCode.includes("rate_limit") || status === 429) {
    return new AiServiceError({
      code: "RATE_LIMITED",
      message: providerMessage,
      userMessage: "当前生成任务较多，请稍后重试。",
      retryable: true,
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  if (normalizedCode.includes("invalid_api_key") || status === 401 || status === 403) {
    return new AiServiceError({
      code: "PROVIDER_AUTHENTICATION_FAILED",
      message: providerMessage,
      userMessage: "图片服务暂时不可用，请联系管理员。",
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  if (normalizedCode.includes("quota") || normalizedCode.includes("billing")) {
    return new AiServiceError({
      code: "PROVIDER_QUOTA_EXCEEDED",
      message: providerMessage,
      userMessage: "图片服务额度暂时不足，请联系管理员。",
      retryable: true,
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  if (status >= 500) {
    return new AiServiceError({
      code: "PROVIDER_UNAVAILABLE",
      message: providerMessage,
      userMessage: "图片服务暂时不可用，请稍后重试。",
      retryable: true,
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  if (status === 400 || normalizedCode.includes("invalid")) {
    return new AiServiceError({
      code: "INVALID_INPUT",
      message: providerMessage,
      userMessage: "图片或生成参数不符合要求，请调整后重试。",
      provider: "openai",
      providerCode,
      requestId,
      status,
    });
  }
  return new AiServiceError({
    code: "PROVIDER_ERROR",
    message: providerMessage,
    userMessage: "图片生成失败，请稍后重试。",
    retryable: status >= 500,
    provider: "openai",
    providerCode,
    requestId,
    status,
  });
}

async function readBody(response: Response): Promise<OpenAiImageBody> {
  try {
    return (await response.json()) as OpenAiImageBody;
  } catch {
    return {};
  }
}

export const openAiProvider: ImageProviderAdapter = {
  name: "openai",
  model: OPENAI_IMAGE_MODEL,
  async generate(
    request: GenerateInteriorImagesRequest,
    context: ProviderGenerationContext,
  ): Promise<GenerateInteriorImagesResult> {
    if (!request.sourceImage) throw new AiServiceError({ code: "INVALID_INPUT", message: "OpenAI provider requires a source image", userMessage: "当前图片模型不支持纯文字生图。", provider: "openai" });
    if (request.mask) validateMask(request.sourceImage, request.mask);

    const form = new FormData();
    form.append("model", OPENAI_IMAGE_MODEL);
    form.append("prompt", context.prompt);
    form.append("n", String(request.outputCount));
    form.append("output_format", "png");
    if (request.resolution === "0.5K") throw new AiServiceError({ code: "INVALID_INPUT", message: "OpenAI does not support 0.5K", userMessage: "OpenAI 不支持0.5K预览。", provider: "openai" });
    form.append("size", openAiSize(request.resolution, request.aspectRatio));
    form.append("quality", openAiQuality(request.quality));
    appendImage(form, "image[]", request.sourceImage, 0);
    request.referenceImages?.forEach((reference, index) =>
      appendImage(form, "image[]", "image" in reference ? reference.image : reference, index + 1),
    );
    const controlOffset = 1 + (request.referenceImages?.length ?? 0);
    request.controlImages?.forEach((control, index) =>
      appendImage(form, "image[]", control.image, index + controlOffset),
    );
    if (request.mask) appendImage(form, "mask", request.mask, 0);

    let response: Response;
    try {
      response = await context.fetch(OPENAI_IMAGE_EDIT_URL, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${context.apiKey}` },
        body: form,
        signal: context.signal,
      });
    } catch (cause) {
      const aborted = context.signal?.aborted ||
        (cause instanceof Error && cause.name === "AbortError");
      throw new AiServiceError({
        code: aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        message: aborted ? "OpenAI image request was aborted" : "OpenAI image request failed",
        userMessage: aborted
          ? "图片生成超时，请稍后重试。"
          : "图片服务暂时无法连接，请稍后重试。",
        retryable: true,
        provider: "openai",
        cause,
      });
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const body = await readBody(response);
    if (!response.ok) throw mapOpenAiError(response.status, body, requestId);

    const encodedOutputs = body.data?.flatMap((item) => item.b64_json ? [item.b64_json] : []) ?? [];
    if (!encodedOutputs.length) {
      throw new AiServiceError({
        code: "NO_IMAGE_OUTPUT",
        message: "OpenAI response did not contain data[].b64_json",
        userMessage: "模型没有返回可用图片，请稍后重试。",
        retryable: true,
        provider: "openai",
        requestId,
      });
    }

    const normalizedRequestId = requestId ?? body.id ?? `openai_${Date.now().toString(36)}`;
    const outputs = encodedOutputs.map((encoded) => ({
      bytes: base64ToBytes(encoded),
      mimeType: "image/png" as const,
      provider: "openai" as const,
      model: OPENAI_IMAGE_MODEL,
      requestId: normalizedRequestId,
      metadata: {
        mock: false,
        promptTemplateVersion: context.promptTemplateVersion,
        stylePresetId: request.style.presetId,
        workflowType: request.workflowType,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        controlKinds: request.controlImages?.map((control) => control.kind).join(",") ?? "",
      },
    }));

    return {
      outputs,
      provider: "openai",
      model: OPENAI_IMAGE_MODEL,
      requestId: normalizedRequestId,
      promptTemplateVersion: context.promptTemplateVersion,
    };
  },
};
