import { createHash } from "node:crypto";
import { detectImageMime, readImageMetadata } from "@/lib/ai/image-metadata";
import type { ImageMimeType } from "@/lib/ai/types";
import {
  type ImageSanitizer,
} from "@/lib/platform/image-sanitizer";
import { ApiError } from "./api";
import { MAX_INPUT_IMAGE_BYTES, MAX_INPUT_IMAGE_PIXELS, MAX_INPUT_IMAGE_SIDE } from "@/lib/domain/image-input-limits";

export const MAX_UPLOAD_BYTES = MAX_INPUT_IMAGE_BYTES;
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;
export const MAX_UPLOAD_SIDE = MAX_INPUT_IMAGE_SIDE;
export const MAX_UPLOAD_PIXELS = MAX_INPUT_IMAGE_PIXELS;
export const MAX_GENERATED_BYTES = 25 * 1024 * 1024;
export const MAX_GENERATED_SIDE = 8192;
export const MAX_GENERATED_PIXELS = 40_000_000;

export type SupportedImageMime = "image/jpeg" | "image/png" | "image/webp";

export type ValidatedImage = {
  bytes: Uint8Array;
  mimeType: SupportedImageMime;
  sha256: string;
  extension: "jpg" | "png" | "webp";
};

export async function readBoundedFormData(
  request: Request,
  maxBodyBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "请求必须使用 multipart/form-data。");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new ApiError(400, "INVALID_CONTENT_LENGTH", "请求正文长度无效。");
    }
    if (parsedLength > maxBodyBytes) {
      throw new ApiError(413, "BODY_TOO_LARGE", "请求正文过大。");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "EMPTY_BODY", "请求正文不能为空。");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "BODY_TOO_LARGE", "请求正文过大。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new ApiError(400, "INVALID_MULTIPART", "无法读取上传内容。");
  }
}

export async function validateUploadedImage(
  file: File,
  sanitizer: ImageSanitizer,
): Promise<ValidatedImage> {
  if (file.size <= 0) {
    throw new ApiError(400, "EMPTY_FILE", "上传的图片不能为空。");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", "单张图片不能超过 20MB。", {
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImageMime(bytes);
  if (!detected) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "仅支持真实的 JPEG、PNG 或 WebP 图片。",
    );
  }
  if (file.type && normalizeMime(file.type) !== detected.mimeType) {
    throw new ApiError(
      415,
      "MIME_MISMATCH",
      "文件内容与浏览器声明的图片类型不一致。",
    );
  }

  let sanitized;
  try {
    sanitized = await sanitizer.sanitize({
      bytes,
      mimeType: detected.mimeType,
      maxBytes: MAX_UPLOAD_BYTES,
      maxPixels: MAX_UPLOAD_PIXELS,
      maxSide: MAX_UPLOAD_SIDE,
    });
  } catch {
    throw new ApiError(
      422,
      "INVALID_IMAGE",
      "图片无法安全解码，请重新导出后上传。",
    );
  }
  if (sanitized.mimeType !== detected.mimeType) {
    throw new ApiError(500, "IMAGE_SANITIZER_ERROR", "图片安全处理结果无效。");
  }
  const canonical = detectImageMime(sanitized.bytes);
  if (
    !canonical ||
    canonical.mimeType !== sanitized.mimeType ||
    sanitized.width < 1 ||
    sanitized.height < 1 ||
    sanitized.width > MAX_UPLOAD_SIDE ||
    sanitized.height > MAX_UPLOAD_SIDE ||
    sanitized.width * sanitized.height > MAX_UPLOAD_PIXELS ||
    sanitized.bytes.byteLength > MAX_UPLOAD_BYTES
  ) {
    throw new ApiError(500, "IMAGE_SANITIZER_ERROR", "图片安全处理结果无效。");
  }

  return {
    bytes: sanitized.bytes,
    ...canonical,
    sha256: createHash("sha256").update(sanitized.bytes).digest("hex"),
  };
}

export async function sanitizeGeneratedImage(
  bytes: Uint8Array,
  declaredMime: string,
  sanitizer: ImageSanitizer,
  maxBytes = MAX_GENERATED_BYTES,
): Promise<ValidatedImage> {
  const input = validateGeneratedImage(bytes, declaredMime);
  let sanitized;
  try {
    sanitized = await sanitizer.sanitize({
      bytes: input.bytes,
      mimeType: input.mimeType,
      maxBytes,
      maxPixels: MAX_GENERATED_PIXELS,
      maxSide: MAX_GENERATED_SIDE,
    });
  } catch {
    throw new ApiError(
      502,
      "INVALID_PROVIDER_OUTPUT",
      "图像供应商返回了无法安全处理的图片。",
    );
  }
  const output = validateGeneratedImage(sanitized.bytes, sanitized.mimeType);
  if (
    sanitized.mimeType !== input.mimeType ||
    sanitized.width < 1 ||
    sanitized.height < 1 ||
    sanitized.width > MAX_GENERATED_SIDE ||
    sanitized.height > MAX_GENERATED_SIDE ||
    sanitized.width * sanitized.height > MAX_GENERATED_PIXELS ||
    output.bytes.byteLength > maxBytes
  ) {
    throw new ApiError(502, "INVALID_PROVIDER_OUTPUT", "图像安全处理结果无效。");
  }
  return output;
}

export function validateGeneratedImage(
  bytes: Uint8Array,
  declaredMime: string,
): Omit<ValidatedImage, "sha256"> & { sha256: string } {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_GENERATED_BYTES) {
    throw new ApiError(
      502,
      "INVALID_PROVIDER_OUTPUT",
      "图像供应商返回了无效大小的图片。",
    );
  }
  const detected = detectImageMime(bytes);
  if (!detected || normalizeMime(declaredMime) !== detected.mimeType) {
    throw new ApiError(
      502,
      "INVALID_PROVIDER_OUTPUT",
      "图像供应商返回了无效格式的图片。",
    );
  }
  const metadata = readImageMetadata({
    bytes,
    mimeType: detected.mimeType as ImageMimeType,
  });
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_GENERATED_SIDE ||
    metadata.height > MAX_GENERATED_SIDE ||
    metadata.width * metadata.height > MAX_GENERATED_PIXELS
  ) {
    throw new ApiError(
      502,
      "INVALID_PROVIDER_OUTPUT",
      "图像供应商返回了无法安全处理的图片尺寸。",
    );
  }
  return {
    bytes,
    ...detected,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function safeFileName(value: string): string {
  const base = value.split(/[\\/]/u).at(-1) ?? "image";
  const cleaned = Array.from(base.normalize("NFKC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim();
  return (cleaned || "image").slice(0, 180);
}

function normalizeMime(value: string): string {
  const normalized = value.toLowerCase().split(";", 1)[0]?.trim();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}
