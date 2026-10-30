import { AiServiceError } from "./types";

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
    chunks.push(binary);
  }
  return btoa(chunks.join(""));
}

export function base64ToBytes(value: string): Uint8Array {
  try {
    const normalized = value.replace(/\s/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (cause) {
    throw new AiServiceError({
      code: "NO_IMAGE_OUTPUT",
      message: "Provider returned invalid base64 image data",
      userMessage: "图片生成结果无法读取，请稍后重试。",
      retryable: true,
      cause,
    });
  }
}

export function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
