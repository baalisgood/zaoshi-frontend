import { base64ToBytes, bytesToBase64 } from "../base64";
import {
  AiServiceError,
  type GenerateInteriorImagesRequest,
  type GenerateInteriorImagesResult,
  type GeneratedInteriorImage,
  type ImageMimeType,
} from "../types";
import type { ImageProviderAdapter, ProviderGenerationContext } from "./types";

export const GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image";
export const GOOGLE_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

interface GoogleImageBlock {
  type?: string;
  data?: string;
  mime_type?: string;
}

interface GoogleInteractionBody {
  id?: string;
  output_image?: GoogleImageBlock;
  steps?: Array<{ type?: string; content?: GoogleImageBlock[] }>;
  error?: { code?: number; message?: string; status?: string };
}

function normalizeOutputMimeType(value?: string): ImageMimeType {
  if (value === "image/jpeg" || value === "image/webp" || value === "image/png") {
    return value;
  }
  return "image/png";
}

function getFinalImageBlock(body: GoogleInteractionBody): GoogleImageBlock | undefined {
  const modelImages = (body.steps ?? []).flatMap((step) =>
    step.type === "model_output"
      ? (step.content ?? []).filter((block) => block.type === "image" && block.data)
      : [],
  );
  if (modelImages.length) return modelImages.at(-1);
  if (body.output_image?.data) return body.output_image;
  return undefined;
}

function mapGoogleError(
  status: number,
  body: GoogleInteractionBody,
  requestId?: string,
): AiServiceError {
  const providerCode = body.error?.status;
  const providerMessage = body.error?.message ?? `Google request failed with ${status}`;
  const normalized = `${providerCode ?? ""} ${providerMessage}`.toLowerCase();

  if (normalized.includes("safety") || normalized.includes("blocked") || normalized.includes("policy")) {
    return new AiServiceError({
      code: "CONTENT_REJECTED",
      message: providerMessage,
      userMessage: "图片或修改要求未通过内容安全检查，请更换素材后重试。",
      provider: "google",
      providerCode,
      requestId,
      status,
    });
  }
  if (status === 429 || normalized.includes("resource_exhausted")) {
    return new AiServiceError({
      code: "RATE_LIMITED",
      message: providerMessage,
      userMessage: "当前生成任务较多，请稍后重试。",
      retryable: true,
      provider: "google",
      providerCode,
      requestId,
      status,
    });
  }
  if (status === 401 || status === 403 || normalized.includes("permission_denied")) {
    return new AiServiceError({
      code: "PROVIDER_AUTHENTICATION_FAILED",
      message: providerMessage,
      userMessage: "图片服务暂时不可用，请联系管理员。",
      provider: "google",
      providerCode,
      requestId,
      status,
    });
  }
  if (status >= 500 || normalized.includes("unavailable")) {
    return new AiServiceError({
      code: "PROVIDER_UNAVAILABLE",
      message: providerMessage,
      userMessage: "图片服务暂时不可用，请稍后重试。",
      retryable: true,
      provider: "google",
      providerCode,
      requestId,
      status,
    });
  }
  if (status === 400 || normalized.includes("invalid_argument")) {
    return new AiServiceError({
      code: "INVALID_INPUT",
      message: providerMessage,
      userMessage: "图片或生成参数不符合要求，请调整后重试。",
      provider: "google",
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
    provider: "google",
    providerCode,
    requestId,
    status,
  });
}

async function readBody(response: Response): Promise<GoogleInteractionBody> {
  try {
    return (await response.json()) as GoogleInteractionBody;
  } catch {
    return {};
  }
}

async function generateOne(
  request: GenerateInteriorImagesRequest,
  context: ProviderGenerationContext,
  variationIndex: number,
) {
  if (!request.sourceImage) throw new AiServiceError({ code: "INVALID_INPUT", message: "Google provider requires a source image", userMessage: "当前图片模型不支持纯文字生图。", provider: "google" });
  const input: Array<Record<string, string>> = [
    {
      type: "text",
      text: `${context.prompt}\nCreate variation ${variationIndex + 1} with a distinct but coherent furniture and material treatment.`,
    },
    {
      type: "image",
      mime_type: request.sourceImage.mimeType,
      data: bytesToBase64(request.sourceImage.bytes),
    },
  ];

  request.referenceImages?.forEach((reference) => {
    const image = "image" in reference ? reference.image : reference;
    const role = "image" in reference ? reference.role : "style";
    const roleDirections: Record<string, string> = {
      style: "overall design language, palette, and material direction",
      furnishing: "movable furniture, lighting fixtures, textiles, and decor objects",
      structure: "architectural form such as doors, windows, stairs, and fixed elements",
      material: "surface finishes, textures, and material/color treatment",
      "lighting-color": "lighting color, time-of-day atmosphere, and illumination balance",
      composition: "framing and composition while preserving the primary room geometry",
    };
    input.push({
      type: "text",
      text: `The next image is a ${roleDirections[role] ?? roleDirections.style} reference. Use it only for that role and preserve the primary input geometry unless the role explicitly targets architecture.`,
    });
    input.push({
      type: "image",
      mime_type: image.mimeType,
      data: bytesToBase64(image.bytes),
    });
  });
  request.controlImages?.forEach((control) => {
    input.push({
      type: "text",
      text: `The next image is the ${control.kind} structural control reference for the primary room. Use it only for geometry, in the declared control order.`,
    });
    input.push({
      type: "image",
      mime_type: control.image.mimeType,
      data: bytesToBase64(control.image.bytes),
    });
  });
  if (request.mask) {
    input.push({
      type: "text",
      text: "The final supplied image is the edit mask. Restrict the requested change to its transparent edit region and preserve everything outside that region.",
    });
    input.push({
      type: "image",
      mime_type: request.mask.mimeType,
      data: bytesToBase64(request.mask.bytes),
    });
  }

  let response: Response;
  try {
    response = await context.fetch(GOOGLE_INTERACTIONS_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": context.apiKey,
      },
      body: JSON.stringify({
        model: GOOGLE_IMAGE_MODEL,
        input,
        response_format: {
          type: "image",
          mime_type: "image/png",
          image_size: request.resolution,
          aspect_ratio: request.aspectRatio,
        },
      }),
      signal: context.signal,
    });
  } catch (cause) {
    const aborted = context.signal?.aborted ||
      (cause instanceof Error && cause.name === "AbortError");
    throw new AiServiceError({
      code: aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      message: aborted ? "Google image request was aborted" : "Google image request failed",
      userMessage: aborted
        ? "图片生成超时，请稍后重试。"
        : "图片服务暂时无法连接，请稍后重试。",
      retryable: true,
      provider: "google",
      cause,
    });
  }

  const headerRequestId =
    response.headers.get("x-request-id") ?? response.headers.get("x-goog-request-id") ?? undefined;
  const body = await readBody(response);
  if (!response.ok) throw mapGoogleError(response.status, body, headerRequestId);

  const image = getFinalImageBlock(body);
  if (!image?.data) {
    throw new AiServiceError({
      code: "NO_IMAGE_OUTPUT",
      message: "Google interaction did not contain a final image output block",
      userMessage: "模型没有返回可用图片，请稍后重试。",
      retryable: true,
      provider: "google",
      requestId: headerRequestId ?? body.id,
    });
  }

  const requestId = headerRequestId ?? body.id ?? `google_${Date.now().toString(36)}_${variationIndex}`;
  return {
    bytes: base64ToBytes(image.data),
    mimeType: normalizeOutputMimeType(image.mime_type),
    provider: "google" as const,
    model: GOOGLE_IMAGE_MODEL,
    requestId,
    metadata: {
      mock: false,
      promptTemplateVersion: context.promptTemplateVersion,
      stylePresetId: request.style.presetId,
      maskHandling: request.mask ? "reference-guided" : "none",
      workflowType: request.workflowType,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      controlKinds: request.controlImages?.map((control) => control.kind).join(",") ?? "",
    },
  };
}

export const googleProvider: ImageProviderAdapter = {
  name: "google",
  model: GOOGLE_IMAGE_MODEL,
  async generate(
    request: GenerateInteriorImagesRequest,
    context: ProviderGenerationContext,
  ): Promise<GenerateInteriorImagesResult> {
    if (!request.sourceImage) throw new AiServiceError({ code: "INVALID_INPUT", message: "Google provider requires a source image", userMessage: "当前图片模型不支持纯文字生图。", provider: "google" });
    const outputs: GeneratedInteriorImage[] = [];
    for (let index = 0; index < request.outputCount; index += 1) {
      try {
        outputs.push(await generateOne(request, context, index));
      } catch (error) {
        // Google generates one variation per request. Preserve already completed
        // variations so the job layer can expose a truthful partial result instead
        // of discarding paid provider work after a later variation fails.
        if (!outputs.length) throw error;
        break;
      }
    }
    const requestId = outputs[0].requestId;
    return {
      outputs,
      provider: "google",
      model: GOOGLE_IMAGE_MODEL,
      requestId,
      promptTemplateVersion: context.promptTemplateVersion,
    };
  },
};
