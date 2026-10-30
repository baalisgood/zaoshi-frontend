import type { AiRuntimeEnvironment } from "@/lib/ai";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";

export function readAiEnvironment(): AiRuntimeEnvironment {
  const bindings = readRuntimeBindings();
  return {
    OPENAI_API_KEY: optionalSecret(bindings.OPENAI_API_KEY),
    GOOGLE_API_KEY: optionalSecret(bindings.GOOGLE_API_KEY),
    GEMINI_API_KEY: optionalSecret(bindings.GEMINI_API_KEY),
    VISION_PIPELINE_URL: optionalSecret(bindings.VISION_PIPELINE_URL),
    VISION_PIPELINE_API_KEY: optionalSecret(bindings.VISION_PIPELINE_API_KEY),
    ARK_API_KEY: optionalSecret(bindings.ARK_API_KEY),
    ARK_BASE_URL: optionalSecret(bindings.ARK_BASE_URL),
    ARK_PROMPT_MODEL: optionalSecret(bindings.ARK_PROMPT_MODEL),
    ARK_IMAGE_MODEL: optionalSecret(bindings.ARK_IMAGE_MODEL),
    DASHSCOPE_API_KEY: optionalSecret(bindings.DASHSCOPE_API_KEY),
    DASHSCOPE_WORKSPACE_ID: optionalSecret(bindings.DASHSCOPE_WORKSPACE_ID),
    TENCENT_TOKENHUB_API_KEY: optionalSecret(bindings.TENCENT_TOKENHUB_API_KEY),
    KLING_API_TOKEN: optionalSecret(bindings.KLING_API_TOKEN),
    PUBLIC_IMAGE_GENERATION_ENABLED: optionalSecret(bindings.PUBLIC_IMAGE_GENERATION_ENABLED),
    GENERATION_INTERNAL_API_ENABLED: optionalSecret(bindings.GENERATION_INTERNAL_API_ENABLED),
    OVERSEAS_RELAY_ENABLED: optionalSecret(bindings.OVERSEAS_RELAY_ENABLED),
    AUTH_MODE: optionalSecret(bindings.AUTH_MODE),
    DOMESTIC_AI_CANARY_EMAILS: optionalSecret(bindings.DOMESTIC_AI_CANARY_EMAILS),
    TRUST_PLATFORM_IDENTITY_HEADERS: optionalSecret(bindings.TRUST_PLATFORM_IDENTITY_HEADERS) as AiRuntimeEnvironment["TRUST_PLATFORM_IDENTITY_HEADERS"],
    BACKEND_PROFILE: optionalSecret(bindings.BACKEND_PROFILE) as AiRuntimeEnvironment["BACKEND_PROFILE"],
  };
}

function optionalSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
