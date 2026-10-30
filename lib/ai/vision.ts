import { base64ToBytes, bytesToBase64 } from "./base64";
import { resolveAiEnvironment } from "./env";
import {
  AiServiceError,
  type GenerateInteriorImagesOptions,
  type GenerateVisionArtifactsRequest,
  type GenerateVisionArtifactsResult,
  type ImageMimeType,
  type VisionArtifactKind,
} from "./types";

interface VisionPipelineBody {
  requestId?: string;
  request_id?: string;
  artifacts?: Array<{
    kind?: string;
    type?: string;
    data?: string;
    mimeType?: string;
    mime_type?: string;
    model?: string;
    confidence?: number;
  }>;
  error?: { code?: string; message?: string };
}

const VISION_TIMEOUT_MS = 45_000;
const MAX_VISION_JSON_BYTES = 40 * 1024 * 1024;
const MAX_VISION_ARTIFACT_BYTES = 25 * 1024 * 1024;

function isVisionKind(value: string | undefined): value is VisionArtifactKind {
  return value === "depth" || value === "normal";
}

function normalizeMimeType(value?: string): ImageMimeType {
  if (value === "image/jpeg" || value === "image/webp" || value === "image/png") {
    return value;
  }
  return "image/png";
}

export async function generateVisionArtifacts(
  request: GenerateVisionArtifactsRequest,
  options: GenerateInteriorImagesOptions = {},
): Promise<GenerateVisionArtifactsResult> {
  const environment = resolveAiEnvironment(options.env);
  if (!environment.VISION_PIPELINE_URL) {
    throw new AiServiceError({
      code: "NOT_CONFIGURED",
      message: "VISION_PIPELINE_URL is not configured",
      userMessage: "深度图和法线图服务尚未配置。",
      provider: "vision-pipeline",
    });
  }
  if (!request.artifacts.length || request.artifacts.some((kind) => !isVisionKind(kind))) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: "Vision artifacts must contain depth and/or normal",
      userMessage: "请选择需要生成的深度图或法线图。",
      provider: "vision-pipeline",
    });
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new AiServiceError({
      code: "VISION_PIPELINE_ERROR",
      message: "fetch is unavailable in this runtime",
      userMessage: "视觉分析服务暂时不可用。",
      retryable: true,
      provider: "vision-pipeline",
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (environment.VISION_PIPELINE_API_KEY) {
    headers.Authorization = `Bearer ${environment.VISION_PIPELINE_API_KEY}`;
  }

  const signal = combinedSignal(options.signal);
  let response: Response;
  try {
    response = await fetchImplementation(environment.VISION_PIPELINE_URL, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        image: {
          mime_type: request.sourceImage.mimeType,
          data: bytesToBase64(request.sourceImage.bytes),
        },
        artifacts: request.artifacts,
      }),
        signal,
    });
  } catch (cause) {
    throw new AiServiceError({
      code: "VISION_PIPELINE_ERROR",
      message: "Vision pipeline request failed",
      userMessage: "深度图或法线图生成失败，请稍后重试。",
      retryable: true,
      provider: "vision-pipeline",
      cause,
    });
  }

  let body: VisionPipelineBody = {};
  try {
    body = await readVisionJson(response, signal);
  } catch (cause) {
    throw visionError("Vision pipeline response could not be read", cause);
  }
  const requestId =
    response.headers.get("x-request-id") ?? body.requestId ?? body.request_id ?? `vision_${Date.now().toString(36)}`;

  if (!response.ok) {
    throw new AiServiceError({
      code: "VISION_PIPELINE_ERROR",
      message: body.error?.message ?? `Vision pipeline failed with ${response.status}`,
      userMessage: "深度图或法线图生成失败，请稍后重试。",
      retryable: response.status === 429 || response.status >= 500,
      provider: "vision-pipeline",
      providerCode: body.error?.code,
      requestId,
      status: response.status,
    });
  }

  const parsedArtifacts = (body.artifacts ?? []).flatMap((artifact) => {
    const kind = artifact.kind ?? artifact.type;
    if (!isVisionKind(kind) || !artifact.data) return [];
    return [{
      kind,
      bytes: decodeVisionArtifact(artifact.data),
      mimeType: normalizeMimeType(artifact.mimeType ?? artifact.mime_type),
      model: artifact.model,
      confidence: artifact.confidence,
    }];
  });

  const artifactByKind = new Map(
    parsedArtifacts.map((artifact) => [artifact.kind, artifact] as const),
  );
  const returnedKinds = new Set(artifactByKind.keys());
  if (request.artifacts.some((kind) => !returnedKinds.has(kind))) {
    throw new AiServiceError({
      code: "VISION_PIPELINE_ERROR",
      message: "Vision pipeline omitted one or more requested artifacts",
      userMessage: "视觉分析结果不完整，请稍后重试。",
      retryable: true,
      provider: "vision-pipeline",
      requestId,
    });
  }

  const artifacts = request.artifacts.map((kind) => artifactByKind.get(kind)!);
  return { requestId, provider: "vision-pipeline", artifacts };
}

function combinedSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readVisionJson(response: Response, signal: AbortSignal): Promise<VisionPipelineBody> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_VISION_JSON_BYTES) throw new Error("Vision pipeline JSON response exceeded size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Vision pipeline response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await readVisionChunk(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_VISION_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Vision pipeline JSON response exceeded size limit");
      }
      chunks.push(part.value);
    }
  } catch (cause) {
    if (signal.aborted) throw new DOMException("Vision pipeline response timed out", "TimeoutError");
    throw cause;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as VisionPipelineBody;
}

function readVisionChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function decodeVisionArtifact(data: string): Uint8Array {
  try {
    const bytes = base64ToBytes(data);
    if (bytes.byteLength > MAX_VISION_ARTIFACT_BYTES) throw new Error("Vision artifact exceeded decoded size limit");
    return bytes;
  } catch (cause) {
    throw visionError("Vision artifact could not be decoded", cause);
  }
}

function visionError(message: string, cause?: unknown): AiServiceError {
  return new AiServiceError({ code: "VISION_PIPELINE_ERROR", message, userMessage: "深度图或法线图生成失败，请稍后重试。", retryable: true, provider: "vision-pipeline", cause });
}
