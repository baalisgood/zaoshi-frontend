import type { AiRuntimeEnvironment } from "./types";

type RuntimeGlobal = typeof globalThis & {
  env?: Partial<AiRuntimeEnvironment>;
  ENV?: Partial<AiRuntimeEnvironment>;
  process?: { env?: Record<string, string | undefined> };
};

export function resolveAiEnvironment(
  explicit?: AiRuntimeEnvironment,
): AiRuntimeEnvironment {
  const runtime = globalThis as RuntimeGlobal;
  const workerEnvironment = runtime.env ?? runtime.ENV ?? {};
  const processEnvironment = runtime.process?.env ?? {};

  const read = (key: keyof AiRuntimeEnvironment): string | undefined => {
    const value = explicit?.[key] ?? workerEnvironment[key] ?? processEnvironment[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  return {
    OPENAI_API_KEY: read("OPENAI_API_KEY"),
    GOOGLE_API_KEY: read("GOOGLE_API_KEY"),
    GEMINI_API_KEY: read("GEMINI_API_KEY"),
    VISION_PIPELINE_URL: read("VISION_PIPELINE_URL"),
    VISION_PIPELINE_API_KEY: read("VISION_PIPELINE_API_KEY"),
    ARK_API_KEY: read("ARK_API_KEY"),
    ARK_BASE_URL: read("ARK_BASE_URL"),
    ARK_PROMPT_MODEL: read("ARK_PROMPT_MODEL"),
    ARK_IMAGE_MODEL: read("ARK_IMAGE_MODEL"),
    DASHSCOPE_API_KEY: read("DASHSCOPE_API_KEY"),
    DASHSCOPE_WORKSPACE_ID: read("DASHSCOPE_WORKSPACE_ID"),
    TENCENT_TOKENHUB_API_KEY: read("TENCENT_TOKENHUB_API_KEY"),
    KLING_API_TOKEN: read("KLING_API_TOKEN"),
    PUBLIC_IMAGE_GENERATION_ENABLED: read("PUBLIC_IMAGE_GENERATION_ENABLED"),
    GENERATION_INTERNAL_API_ENABLED: read("GENERATION_INTERNAL_API_ENABLED"),
    OVERSEAS_RELAY_ENABLED: read("OVERSEAS_RELAY_ENABLED"),
    AUTH_MODE: read("AUTH_MODE"),
    DOMESTIC_AI_CANARY_EMAILS: read("DOMESTIC_AI_CANARY_EMAILS"),
    TRUST_PLATFORM_IDENTITY_HEADERS: read("TRUST_PLATFORM_IDENTITY_HEADERS") as AiRuntimeEnvironment["TRUST_PLATFORM_IDENTITY_HEADERS"],
    BACKEND_PROFILE: read("BACKEND_PROFILE") as AiRuntimeEnvironment["BACKEND_PROFILE"],
  };
}
