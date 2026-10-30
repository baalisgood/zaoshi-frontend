import { bytesToBase64 } from "../base64";
import {
  AiServiceError,
  isAiServiceError,
  type AiProviderName,
  type BinaryImage,
  type GenerateInteriorImagesRequest,
  type GenerateInteriorImagesResult,
  type ImageMimeType,
} from "../types";
import type { ProviderGenerationContext } from "./types";
import { readImageMetadata } from "../image-metadata";

const MAX_JSON_BYTES = 256 * 1024;
// Keep decoded outputs below the shared Sites isolate memory budget. This can
// be raised only after provider execution moves to a profiled CVM queue worker.
const MAX_OUTPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;

type DomesticProvider = Extract<AiProviderName, "seedream" | "qwen" | "hunyuan" | "kling" | "google" | "openai">;

const CONTENT_ERROR_CODES = new Set([
  "content_policy_violation",
  "datainspectionfailed",
  "data_inspection_failed",
  "inputimagesensitivecontentdetected",
  "input_image_sensitive_content_detected",
  "inputtextsensitivecontentdetected",
  "outputimagesensitivecontentdetected",
  "output_image_sensitive_content_detected",
  "sensitivecontentdetected",
  "sensitive_content",
]);
const AUTH_ERROR_CODES = new Set([
  "access_denied",
  "accessdenied",
  "authentication_failed",
  "forbidden",
  "invalid_api_key",
  "invalidapikey",
  "unauthorized",
]);
const QUOTA_ERROR_CODES = new Set([
  "arrearage",
  "commoditynotpurchased",
  "isv.out_of_service",
  "postpaidbilloverdue",
  "prepaidbilloverdue",
]);
const RATE_ERROR_CODES = new Set([
  "insufficient_quota",
  "limit_burst_rate",
  "limit_requests",
  "resourceexhausted",
  "throttling",
  "throttling.allocationquota",
  "throttling.burstrate",
  "throttling.concurrency",
  "throttling.ratelimit",
  "throttling.ratequota",
  "too_many_requests",
]);
const TIMEOUT_ERROR_CODES = new Set(["requesttimeout", "responsetimeout"]);

export type OrderedProviderImage = {
  image: BinaryImage;
  role: string;
};

export function unpackReferenceImage(value: NonNullable<GenerateInteriorImagesRequest["referenceImages"]>[number]): { image: BinaryImage; role: string } {
  return "image" in value ? value : { image: value, role: "style reference" };
}

export function orderedProviderImages(request: GenerateInteriorImagesRequest): OrderedProviderImage[] {
  const images: OrderedProviderImage[] = request.sourceImage ? [{ image: request.sourceImage, role: "primary room or plan input" }] : [];
  request.referenceImages?.forEach((value, index) => { const reference = unpackReferenceImage(value); images.push({ image: reference.image, role: reference.role || `style or prior-concept reference ${index + 1}` }); });
  request.controlImages?.forEach((control) => images.push({ image: control.image, role: `${control.kind} structural reference` }));
  return images;
}

export function assertDomesticRequest(
  provider: DomesticProvider,
  request: GenerateInteriorImagesRequest,
  options: {
    maxInputImages: number;
    supportedResolutions: readonly string[];
    acceptedMimeTypes?: readonly ImageMimeType[];
    maxImageBytes?: number;
    maxTotalImageBytes?: number;
    dimensions?: { minSide?: number; maxSide?: number; maxPixels?: number; minRatio?: number; maxRatio?: number };
  },
): OrderedProviderImage[] {
  if (request.mask) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: `${provider} does not expose the current alpha-mask contract`,
      userMessage: "当前国产模型通用入口还不能把透明蒙版作为硬选区，请先使用整图生成。",
      provider,
    });
  }
  if (!options.supportedResolutions.includes(request.resolution)) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: `${provider} does not support ${request.resolution}`,
      userMessage: "当前模型不支持所选分辨率，请根据模型说明调整后重试。",
      provider,
    });
  }
  const images = orderedProviderImages(request);
  if (images.length > options.maxInputImages) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: `${provider} accepts at most ${options.maxInputImages} input images`,
      userMessage: `当前模型最多接受${options.maxInputImages}张输入图，请减少参考图或结构图。`,
      provider,
    });
  }
  const accepted = options.acceptedMimeTypes;
  const maxImageBytes = options.maxImageBytes;
  const totalImageBytes = images.reduce((total, item) => total + item.image.bytes.byteLength, 0);
  if (options.maxTotalImageBytes && totalImageBytes > options.maxTotalImageBytes) {
    throw new AiServiceError({
      code: "IMAGE_TOO_LARGE",
      message: `${provider} total input images exceed ${options.maxTotalImageBytes} bytes`,
      userMessage: "本次输入图片总量过大，请减少参考图或压缩图片后重试。",
      provider,
    });
  }
  for (const { image } of images) {
    if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) {
      throw new AiServiceError({ code: "INVALID_INPUT", message: `${provider} received an empty input image`, userMessage: "参考图片为空或无法读取，请重新上传。", provider });
    }
    if (accepted && !accepted.includes(image.mimeType)) {
      throw new AiServiceError({
        code: "INVALID_INPUT",
        message: `${provider} does not accept ${image.mimeType}`,
        userMessage: "当前模型不支持这张图片的格式，请改用 JPG 或 PNG。",
        provider,
      });
    }
    if (maxImageBytes && image.bytes.byteLength > maxImageBytes) {
      throw new AiServiceError({
        code: "IMAGE_TOO_LARGE",
        message: `${provider} input image exceeds ${maxImageBytes} bytes`,
        userMessage: "输入图片超过当前模型的10MB限制，请压缩后重试。",
        provider,
      });
    }
    if (options.dimensions) {
      const metadata = readImageMetadata(image);
      if (!metadata.width || !metadata.height) {
        throw new AiServiceError({ code: "INVALID_INPUT", message: `${provider} input image dimensions could not be read`, userMessage: "当前模型无法读取这张图片的尺寸，请重新导出为标准 JPG 或 PNG。", provider });
      }
      const shortest = Math.min(metadata.width, metadata.height);
      const longest = Math.max(metadata.width, metadata.height);
      const ratio = metadata.width / metadata.height;
      if ((options.dimensions.minSide && shortest < options.dimensions.minSide) ||
          (options.dimensions.maxSide && longest > options.dimensions.maxSide) ||
          (options.dimensions.maxPixels && metadata.width * metadata.height > options.dimensions.maxPixels) ||
          (options.dimensions.minRatio && ratio < options.dimensions.minRatio) ||
          (options.dimensions.maxRatio && ratio > options.dimensions.maxRatio)) {
        throw new AiServiceError({ code: "INVALID_INPUT", message: `${provider} input image dimensions are outside the supported range`, userMessage: "这张图片的像素尺寸不符合当前模型要求，请调整后重试。", provider });
      }
    }
  }
  return images;
}

export function withInputLegend(prompt: string, images: OrderedProviderImage[]): string {
  if (!images.length) return prompt;
  const legend = images.map(({ role }, index) => `Image ${index + 1}: ${role}.`).join(" ");
  return `${prompt}\nInput image order: ${legend}`;
}

export function imageDataUrl(image: BinaryImage): string {
  return `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`;
}

export async function fetchProviderJson<T>(
  provider: DomesticProvider,
  context: ProviderGenerationContext,
  input: RequestInfo | URL,
  init: RequestInit,
  options: { maxJsonBytes?: number; maxErrorJsonBytes?: number } = {},
): Promise<{ body: T; response: Response }> {
  let response: Response;
  const signal = providerRequestSignal(context.signal, context.requestTimeoutMs);
  try {
    response = await context.fetch(input, { ...init, redirect: "error", signal });
  } catch (cause) {
    const aborted = requestWasAborted(cause, signal);
    const providerRequestId = cause && typeof cause === "object" && "providerRequestId" in cause && typeof cause.providerRequestId === "string" && cause.providerRequestId.length <= 200 ? cause.providerRequestId : undefined;
    throw new AiServiceError({
      code: aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      message: `${provider} request ${aborted ? "was aborted" : "could not connect"}`,
      userMessage: aborted ? "图片生成超时，请稍后重试。" : "图片服务暂时无法连接，请稍后重试。",
      retryable: true,
      provider,
      ...(providerRequestId ? { providerRequestId } : {}),
      cause,
    });
  }
  const overseas = provider === "openai" || provider === "google";
  const headerRequestId = response.headers.get(overseas ? "x-zaoshi-provider-request-id" : "x-request-id") ?? undefined;
  let body: T;
  try {
    body = await readBoundedJson<T>(provider, response, !response.ok, signal, !response.ok && options.maxErrorJsonBytes ? options.maxErrorJsonBytes : options.maxJsonBytes ?? MAX_JSON_BYTES);
  } catch (error) {
    throw withProviderRequestId(provider, error, headerRequestId);
  }
  if (!response.ok) {
    throw withProviderRequestId(
      provider,
      mapDomesticHttpError(provider, response.status, body),
      headerRequestId ?? (overseas ? undefined : requestIdFromBody(body)),
    );
  }
  return { body, response };
}

export function withProviderRequestId(
  provider: DomesticProvider,
  error: unknown,
  requestId: string | undefined,
): Error {
  if (!requestId || requestId.length > 200) {
    return error instanceof Error ? error : new Error("PROVIDER_EXECUTION_FAILED");
  }
  if (isAiServiceError(error)) {
    return new AiServiceError({
      code: error.code,
      message: error.message,
      userMessage: error.userMessage,
      retryable: error.retryable,
      provider: error.provider ?? provider,
      providerRequestId: requestId,
      requestId: error.requestId ?? requestId,
      status: error.status,
      providerCode: error.providerCode,
      cause: error,
    });
  }
  return new AiServiceError({
    code: "PROVIDER_ERROR",
    message: `${provider} failed after returning a request identifier`,
    userMessage: "图片服务返回内容异常，请稍后重试。",
    retryable: false,
    provider,
    providerRequestId: requestId,
    requestId,
    cause: error,
  });
}

function requestIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).request_id;
  return typeof value === "string" && value.length >= 1 && value.length <= 200
    ? value
    : undefined;
}

async function readBoundedJson<T>(provider: DomesticProvider, response: Response, allowEmpty: boolean, signal: AbortSignal, maxJsonBytes: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxJsonBytes) throw invalidProviderResponse(provider, "JSON response exceeded the declared size limit");
  const reader = response.body?.getReader();
  if (!reader) {
    if (allowEmpty) return {} as T;
    throw invalidProviderResponse(provider, "JSON response had no body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await readWithSignal(reader, signal);
    } catch (cause) {
      if (requestWasAborted(cause, signal)) throw providerTimeout(provider, cause);
      throw cause;
    }
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxJsonBytes) {
      await reader.cancel();
      throw invalidProviderResponse(provider, "JSON response exceeded the streaming size limit");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!bytes.byteLength && allowEmpty) return {} as T;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new AiServiceError({
      code: "PROVIDER_ERROR",
      message: `${provider} returned invalid JSON`,
      userMessage: "图片服务返回格式无效，请稍后重试。",
      retryable: true,
      provider,
      cause,
    });
  }
}

function invalidProviderResponse(provider: DomesticProvider, message: string): AiServiceError {
  return new AiServiceError({
    code: "PROVIDER_ERROR",
    message: `${provider}: ${message}`,
    userMessage: "图片服务返回内容异常，请稍后重试。",
    retryable: true,
    provider,
  });
}

function providerCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.code === "string" || typeof record.code === "number") return String(record.code);
  if (record.error && typeof record.error === "object") {
    const code = (record.error as Record<string, unknown>).code;
    if (typeof code === "string" || typeof code === "number") return String(code);
  }
  return undefined;
}

export function mapDomesticHttpError(provider: DomesticProvider, status: number, body: unknown): AiServiceError {
  const code = providerCode(body);
  const normalized = (code ?? "").trim().toLowerCase();
  const safeProviderCode = [CONTENT_ERROR_CODES, AUTH_ERROR_CODES, QUOTA_ERROR_CODES, RATE_ERROR_CODES, TIMEOUT_ERROR_CODES]
    .some((codes) => codes.has(normalized))
    ? normalized
    : undefined;
  const base = {
    message: `${provider} request failed with HTTP ${status}`,
    provider,
    ...(safeProviderCode ? { providerCode: safeProviderCode } : {}),
    status,
  } as const;
  if (CONTENT_ERROR_CODES.has(normalized)) {
    return new AiServiceError({ ...base, code: "CONTENT_REJECTED", userMessage: "图片或修改要求未通过内容安全检查，请更换素材后重试。" });
  }
  if (status === 401 || status === 403 || AUTH_ERROR_CODES.has(normalized)) {
    return new AiServiceError({ ...base, code: "PROVIDER_AUTHENTICATION_FAILED", userMessage: "图片服务鉴权失败，请联系管理员。" });
  }
  if (QUOTA_ERROR_CODES.has(normalized)) {
    return new AiServiceError({ ...base, code: "PROVIDER_QUOTA_EXCEEDED", userMessage: "图片服务额度暂时不足，请联系管理员。", retryable: false });
  }
  if (status === 408 || TIMEOUT_ERROR_CODES.has(normalized)) {
    return new AiServiceError({ ...base, code: "PROVIDER_TIMEOUT", userMessage: "图片生成超时，请稍后重试。", retryable: true });
  }
  if (status === 429 || RATE_ERROR_CODES.has(normalized)) {
    return new AiServiceError({ ...base, code: "RATE_LIMITED", userMessage: "当前生成任务较多，请稍后重试。", retryable: true });
  }
  if (status >= 500) {
    return new AiServiceError({ ...base, code: "PROVIDER_UNAVAILABLE", userMessage: "图片服务暂时不可用，请稍后重试。", retryable: true });
  }
  if (status === 400 || status === 422) {
    return new AiServiceError({ ...base, code: "INVALID_INPUT", userMessage: "图片或生成参数不符合当前模型要求，请调整后重试。" });
  }
  return new AiServiceError({ ...base, code: "PROVIDER_ERROR", userMessage: "图片生成失败，请稍后重试。", retryable: status >= 500 });
}

export async function downloadProviderImage(
  provider: DomesticProvider,
  context: ProviderGenerationContext,
  value: string,
  allowedHosts: readonly string[] | ((hostname: string) => boolean),
): Promise<{ bytes: Uint8Array; mimeType: ImageMimeType }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidProviderResponse(provider, "image URL was invalid");
  }
  const allowed = typeof allowedHosts === "function"
    ? allowedHosts(url.hostname)
    : allowedHosts.includes(url.hostname);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !allowed) {
    throw invalidProviderResponse(provider, "image URL host was not allowlisted");
  }
  let response: Response;
  const signal = providerRequestSignal(context.signal, context.requestTimeoutMs);
  try {
    response = await context.fetch(url, { method: "GET", redirect: "error", signal });
  } catch (cause) {
    const aborted = requestWasAborted(cause, signal);
    throw new AiServiceError({
      code: aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      message: `${provider} output image download failed`,
      userMessage: aborted ? "图片生成超时，请稍后重试。" : "生成结果暂时无法下载，请稍后重试。",
      retryable: true,
      provider,
      cause,
    });
  }
  if (!response.ok) throw mapDomesticHttpError(provider, response.status, {});
  const mimeType = normalizeImageMimeType(response.headers.get("content-type"));
  if (!mimeType) throw invalidProviderResponse(provider, "image response had an unsupported content type");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_OUTPUT_IMAGE_BYTES) throw invalidProviderResponse(provider, "image response exceeded the declared size limit");
  const reader = response.body?.getReader();
  if (!reader) throw invalidProviderResponse(provider, "image response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await readWithSignal(reader, signal);
    } catch (cause) {
      if (requestWasAborted(cause, signal)) throw providerTimeout(provider, cause);
      throw cause;
    }
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_OUTPUT_IMAGE_BYTES) {
      await reader.cancel();
      throw invalidProviderResponse(provider, "image response exceeded the streaming size limit");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!bytes.byteLength) throw invalidProviderResponse(provider, "image response was empty");
  return { bytes, mimeType };
}

function providerRequestSignal(parent?: AbortSignal, requestedTimeoutMs?: number): AbortSignal {
  const timeoutMs = requestedTimeoutMs === undefined || !Number.isFinite(requestedTimeoutMs)
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : Math.min(300_000, Math.max(1, Math.trunc(requestedTimeoutMs)));
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function requestWasAborted(cause: unknown, parent?: AbortSignal): boolean {
  const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
  return Boolean(parent?.aborted || name === "AbortError" || name === "TimeoutError");
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function providerTimeout(provider: DomesticProvider, cause: unknown): AiServiceError {
  return new AiServiceError({
    code: "PROVIDER_TIMEOUT",
    message: `${provider} response body timed out`,
    userMessage: "图片生成超时，请稍后重试。",
    retryable: true,
    provider,
    cause,
  });
}

function normalizeImageMimeType(value: string | null): ImageMimeType | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") return normalized;
  return undefined;
}

export function domesticResult(
  provider: DomesticProvider,
  model: string,
  requestId: string,
  request: GenerateInteriorImagesRequest,
  context: ProviderGenerationContext,
  images: readonly { bytes: Uint8Array; mimeType: ImageMimeType }[],
  providerRequestId?: string,
): GenerateInteriorImagesResult {
  if (!images.length) {
    throw new AiServiceError({
      code: "NO_IMAGE_OUTPUT",
      message: `${provider} returned no image output`,
      userMessage: "模型没有返回可用图片，请稍后重试。",
      retryable: true,
      provider,
      ...(providerRequestId ? { providerRequestId } : {}),
      requestId,
    });
  }
  return {
    provider,
    model,
    requestId,
    ...(providerRequestId ? { providerRequestId } : {}),
    promptTemplateVersion: context.promptTemplateVersion,
    outputs: images.map((image) => ({
      ...image,
      provider,
      model,
      requestId,
      metadata: {
        mock: false,
        promptTemplateVersion: context.promptTemplateVersion,
        stylePresetId: request.style.presetId,
        workflowType: request.workflowType,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        quality: request.quality,
        controlKinds: request.controlImages?.map((control) => control.kind).join(",") ?? "",
        maskHandling: "unsupported",
      },
    })),
  };
}

export function providerDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
