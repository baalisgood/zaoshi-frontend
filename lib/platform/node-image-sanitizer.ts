import sharpRuntime from "sharp";
import type {
  ImageSanitizeInput,
  ImageSanitizer,
  SanitizedImage,
} from "./image-sanitizer";

type SharpResult = {
  data: Buffer;
  info: { channels: number; height: number; width: number };
};

type SharpPipeline = {
  flatten(options: { background: string }): SharpPipeline;
  jpeg(options: { chromaSubsampling: "4:4:4"; quality: number }): SharpPipeline;
  metadata(): Promise<{
    format?: string;
    height?: number;
    pages?: number;
    width?: number;
  }>;
  png(options: { adaptiveFiltering: true; compressionLevel: number }): SharpPipeline;
  rotate(): SharpPipeline;
  toBuffer(options: { resolveWithObject: true }): Promise<SharpResult>;
  resize(options: { fit: "inside"; height: number; width: number; withoutEnlargement: true }): SharpPipeline;
  webp(options: { lossless: true } | { quality: number }): SharpPipeline;
};

const sharp = sharpRuntime as unknown as (
  input: Buffer,
  options: {
    animated: false;
    failOn: "error";
    limitInputPixels: number;
    sequentialRead: true;
  },
) => SharpPipeline;

export const nodeImageSanitizer: ImageSanitizer = {
  async sanitize(input: ImageSanitizeInput): Promise<SanitizedImage> {
    const source = sharp(Buffer.from(input.bytes), {
      animated: false,
      failOn: "error",
      limitInputPixels: input.maxPixels,
      sequentialRead: true,
    });
    const metadata = await source.metadata();
    const expectedFormat = input.mimeType.slice("image/".length).replace("jpeg", "jpg");
    if (
      metadata.format?.replace("jpeg", "jpg") !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width > input.maxSide ||
      metadata.height > input.maxSide ||
      metadata.width * metadata.height > input.maxPixels
    ) {
      throw new Error("unsafe image dimensions or animation");
    }

    const oriented = source.rotate();
    const encoded =
      input.mimeType === "image/jpeg"
        ? oriented.jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        : input.mimeType === "image/png"
          ? oriented.png({ adaptiveFiltering: true, compressionLevel: 9 })
          : oriented.webp({ lossless: true });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (
      data.byteLength > input.maxBytes ||
      info.width > input.maxSide ||
      info.height > input.maxSide ||
      info.width * info.height > input.maxPixels
    ) {
      throw new Error("sanitized image exceeds limits");
    }
    return {
      bytes: new Uint8Array(data),
      mimeType: input.mimeType,
      width: info.width,
      height: info.height,
      hasAlpha: info.channels === 2 || info.channels === 4,
    };
  },
  async deriveGalleryImages(bytes: Uint8Array) {
    async function resize(edge: number, quality: number): Promise<Uint8Array> {
      const data = await sharp(Buffer.from(bytes), { animated: false, failOn: "error", limitInputPixels: 40_000_000, sequentialRead: true })
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      return new Uint8Array(data.data);
    }
    const [thumb, display] = await Promise.all([resize(640, 78), resize(1920, 86)]);
    return { thumb, display };
  },
};
