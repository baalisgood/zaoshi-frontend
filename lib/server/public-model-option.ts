import { resolvePublicModelOption } from "@/lib/domain/public-model-options";
import { ApiError } from "./api";
export function requirePublicModelOption(input: { optionId?: unknown; modelId?: unknown; resolution?: unknown; quality?: unknown }) {
  const tuple = resolvePublicModelOption(input.optionId, input.resolution);
  if (!tuple || tuple.model !== input.modelId || tuple.quality !== input.quality) throw new ApiError(400, "INVALID_PUBLIC_MODEL_OPTION", "请重新选择模型和清晰度后确认报价。", { field: "optionId" });
  return tuple;
}
