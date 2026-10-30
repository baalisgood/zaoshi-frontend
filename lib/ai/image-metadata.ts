import type { BinaryImage, ImageMimeType } from "./types";

export interface ImageMetadata {
  width?: number;
  height?: number;
  hasAlpha: boolean;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function parsePng(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 26 || !isPng(bytes)) return { hasAlpha: false };
  const colorType = bytes[25];
  let hasTransparencyChunk = false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = readUint32BigEndian(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (type === "tRNS") hasTransparencyChunk = true;
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
    hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk,
  };
}

function parseWebp(bytes: Uint8Array): ImageMetadata {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 20 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") {
    return { hasAlpha: false };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) {
    return { hasAlpha: false };
  }
  const chunkType = ascii(12, 4);
  if (chunkType === "VP8X") {
    if (bytes.length < 30 || view.getUint32(16, true) !== 10) {
      return { hasAlpha: false };
    }
    const read24 = (offset: number) =>
      bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
    return {
      width: read24(24) + 1,
      height: read24(27) + 1,
      hasAlpha: Boolean(bytes[20] & 0x10),
    };
  }
  if (chunkType === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return { hasAlpha: false };
    }
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
      height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
      hasAlpha: Boolean(b4 & 0x10),
    };
  }
  if (
    chunkType === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      hasAlpha: false,
    };
  }
  return { hasAlpha: false };
}

function parseJpeg(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { hasAlpha: false };
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  for (let offset = 2; offset + 3 < bytes.length; ) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        width: bytes[offset + 5] * 256 + bytes[offset + 6],
        height: bytes[offset + 3] * 256 + bytes[offset + 4],
        hasAlpha: false,
      };
    }
    offset += length;
  }
  return { hasAlpha: false };
}

export function readImageMetadata(image: BinaryImage): ImageMetadata {
  if (image.mimeType === "image/png") return parsePng(image.bytes);
  if (image.mimeType === "image/jpeg") return parseJpeg(image.bytes);
  if (image.mimeType === "image/webp") return parseWebp(image.bytes);
  return { hasAlpha: false };
}

export function detectImageMime(
  bytes: Uint8Array,
): { mimeType: ImageMimeType; extension: "jpg" | "png" | "webp" } | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
