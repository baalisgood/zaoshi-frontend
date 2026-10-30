import { domesticImageModelCapabilities, domesticImageModelProvider, type DomesticImageModel } from "@/lib/domain/domestic-image-models";
import type { AiRuntimeEnvironment } from "./types";

export const ARK_IMAGE_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
export const QWEN_IMAGE_MODEL = "qwen-image-3.0-pro";
export const HUNYUAN_IMAGE_MODEL = "hy-image-v3";
export const HUNYUAN_IMAGE_URL = "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation";
export const KLING_IMAGE_MODEL = "kling-v3-omni";
export const KLING_IMAGE_URL = "https://api-singapore.klingai.com/v1/images/omni-image";

export type DomesticProviderConfiguration = {
  apiKey: string;
  endpoint: string;
  model: string;
};

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u;
export function resolveDomesticProviderConfiguration(
  provider: DomesticImageModel,
  environment: Partial<AiRuntimeEnvironment>,
): DomesticProviderConfiguration | undefined {
  switch (domesticImageModelProvider(provider)) {
    case "seedream":
      return environment.ARK_API_KEY
        ? { apiKey: environment.ARK_API_KEY, endpoint: ARK_IMAGE_URL, model: domesticImageModelCapabilities[provider].officialModel }
        : undefined;
    case "qwen":
      return environment.DASHSCOPE_API_KEY && environment.DASHSCOPE_WORKSPACE_ID && WORKSPACE_ID.test(environment.DASHSCOPE_WORKSPACE_ID)
        ? {
            apiKey: environment.DASHSCOPE_API_KEY,
            endpoint: `https://${environment.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`,
            model: domesticImageModelCapabilities[provider].officialModel,
          }
        : undefined;
  }
}
