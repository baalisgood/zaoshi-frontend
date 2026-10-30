export const IMAGE_SANITIZER_BINDING = "ZAOSHI_IMAGE_SANITIZER";
export const IMAGE_SANITIZATION_VERSION = "canonical-image-v1";

export type SanitizableImageMime = "image/jpeg" | "image/png" | "image/webp";

export type ImageSanitizeInput = {
  bytes: Uint8Array;
  mimeType: SanitizableImageMime;
  maxBytes: number;
  maxPixels: number;
  maxSide: number;
};

export type SanitizedImage = {
  bytes: Uint8Array;
  mimeType: SanitizableImageMime;
  width: number;
  height: number;
  hasAlpha: boolean;
};

export interface ImageSanitizer {
  sanitize(input: ImageSanitizeInput): Promise<SanitizedImage>;
  deriveGalleryImages?(bytes: Uint8Array): Promise<{
    thumb: Uint8Array;
    display: Uint8Array;
  }>;
}

export function isImageSanitizer(value: unknown): value is ImageSanitizer {
  return Boolean(
    value &&
      typeof value === "object" &&
      "sanitize" in value &&
      typeof value.sanitize === "function",
  );
}
