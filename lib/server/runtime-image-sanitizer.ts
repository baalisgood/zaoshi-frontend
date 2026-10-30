import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import {
  IMAGE_SANITIZER_BINDING,
  isImageSanitizer,
  type ImageSanitizer,
} from "@/lib/platform/image-sanitizer";
import { ApiError } from "./api";

export function readRuntimeImageSanitizer(): ImageSanitizer {
  const value = readRuntimeBindings()[IMAGE_SANITIZER_BINDING];
  if (!isImageSanitizer(value)) {
    throw new ApiError(
      503,
      "IMAGE_SANITIZER_NOT_CONFIGURED",
      "图片安全处理服务尚未配置。",
    );
  }
  return value;
}
