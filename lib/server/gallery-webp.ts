import { ApiError } from "./api";

export type WebpInfo = { width: number; height: number };

export function validateGalleryWebp(
  bytes: Uint8Array,
  maxEdge: number,
): WebpInfo {
  if (
    bytes.byteLength < 20 ||
    fourCc(bytes, 0) !== "RIFF" ||
    fourCc(bytes, 8) !== "WEBP"
  ) {
    throw new ApiError(415, "INVALID_WEBP", "仅支持安全的 WebP 图片。");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) {
    throw new ApiError(415, "INVALID_WEBP", "WebP 容器长度无效。");
  }

  let offset = 12;
  let image: WebpInfo | null = null;
  let extended: WebpInfo | null = null;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new ApiError(415, "INVALID_WEBP", "WebP 容器不完整。");
    }

    const kind = fourCc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size & 1);
    if (end > bytes.length) {
      throw new ApiError(415, "INVALID_WEBP", "WebP 容器不完整。");
    }
    if (kind !== "VP8 " && kind !== "VP8L" && kind !== "VP8X") {
      throw new ApiError(
        415,
        "UNSAFE_WEBP_METADATA",
        "不允许包含未知 WebP 数据块。",
      );
    }

    if (kind === "VP8X") {
      if (extended || image || size !== 10 || bytes[offset + 8] !== 0) {
        throw new ApiError(415, "UNSAFE_WEBP", "WebP 扩展块无效。");
      }
      extended = {
        width:
          1 +
          bytes[offset + 12] +
          (bytes[offset + 13] << 8) +
          (bytes[offset + 14] << 16),
        height:
          1 +
          bytes[offset + 15] +
          (bytes[offset + 16] << 8) +
          (bytes[offset + 17] << 16),
      };
    } else {
      if (image) {
        throw new ApiError(
          415,
          "UNSAFE_WEBP",
          "不允许包含多个图像数据块。",
        );
      }
      image =
        kind === "VP8 "
          ? readVp8(view, bytes, offset, size)
          : readVp8Lossless(bytes, offset, size);
    }

    offset = end;
  }

  if (
    !image ||
    (extended &&
      (extended.width !== image.width || extended.height !== image.height))
  ) {
    throw new ApiError(415, "INVALID_WEBP", "WebP 图像尺寸不一致。");
  }

  const longest = Math.max(image.width, image.height);
  const shortest = Math.min(image.width, image.height);
  if (
    image.width < 64 ||
    image.height < 64 ||
    longest > maxEdge ||
    longest / shortest > 4 ||
    image.width * image.height > 16_000_000
  ) {
    throw new ApiError(
      422,
      "INVALID_DIMENSIONS",
      "图片尺寸或比例不符合要求。",
    );
  }
  return image;
}

function readVp8(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  size: number,
): WebpInfo {
  if (
    size < 10 ||
    bytes[offset + 11] !== 0x9d ||
    bytes[offset + 12] !== 0x01 ||
    bytes[offset + 13] !== 0x2a
  ) {
    throw new ApiError(415, "INVALID_WEBP", "VP8 图像数据无效。");
  }
  return {
    width: view.getUint16(offset + 14, true) & 0x3fff,
    height: view.getUint16(offset + 16, true) & 0x3fff,
  };
}

function readVp8Lossless(
  bytes: Uint8Array,
  offset: number,
  size: number,
): WebpInfo {
  if (size < 5 || bytes[offset + 8] !== 0x2f) {
    throw new ApiError(415, "INVALID_WEBP", "VP8L 图像数据无效。");
  }
  const b1 = bytes[offset + 9];
  const b2 = bytes[offset + 10];
  const b3 = bytes[offset + 11];
  const b4 = bytes[offset + 12];
  if ((b4 & 0xf0) !== 0) {
    throw new ApiError(
      415,
      "UNSAFE_WEBP",
      "不允许透明或未知版本的 WebP。",
    );
  }
  return {
    width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
    height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
  };
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}
