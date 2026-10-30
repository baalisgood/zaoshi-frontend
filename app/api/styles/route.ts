import {
  listPublicStylePresets,
  STYLE_TEMPLATE_VERSION,
} from "@/lib/ai";
import { listPublicDesignSchemes } from "@/lib/ai/design-schemes";
import { errorResponse, jsonResponse } from "@/lib/server/api";
import {
  lightingPresets,
  preservationModes,
} from "@/lib/server/job-contract";

const lightingLabels = {
  morning: ["清晨", "柔和晨光与偏暖色温"],
  noon: ["正午", "明亮中性自然光"],
  sunset: ["黄昏", "金色斜阳与暖调氛围"],
  night: ["夜晚", "室内灯光主导的夜景"],
} as const;

const preservationLabels = {
  structure: ["结构策略", "智能工作台仅重设软装；高级工作台整体设计并保留空间结构"],
  furniture: ["家具策略", "智能工作台整体焕新；高级工作台仅替换软装"],
  clear: ["清空重构", "保留空间轮廓，清除现有软装后重新设计"],
} as const;

export async function GET(): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return jsonResponse({
      styles: listPublicStylePresets().map((style) => ({
        id: style.id,
        name: style.name,
        description: style.description,
        note: style.description,
        version: STYLE_TEMPLATE_VERSION,
        schemes: listPublicDesignSchemes(style.id),
        ...(style.preview
          ? { preview: style.preview, imageUrl: style.preview }
          : {}),
      })),
      lightingPresets: lightingPresets.map((id) => ({
        id,
        name: lightingLabels[id][0],
        description: lightingLabels[id][1],
      })),
      preservationModes: preservationModes.map((id) => ({
        id,
        name: preservationLabels[id][0],
        description: preservationLabels[id][1],
      })),
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
