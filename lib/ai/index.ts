import { getDesignScheme } from "./design-schemes";
import { compileInteriorPrompt, PROMPT_TEMPLATE_VERSION } from "./prompt";
import { resolveAiEnvironment } from "./env";
import { googleProvider } from "./providers/google";
import { hunyuanProvider } from "./providers/hunyuan";
import { klingProvider } from "./providers/kling";
import { generateMockInteriorImages } from "./providers/mock";
import { openAiProvider } from "./providers/openai";
import { qwenProvider } from "./providers/qwen";
import { seedreamProvider } from "./providers/seedream";
import { assertDomesticRequest } from "./providers/domestic-common";
import {
  getStylePreset,
  listPublicStylePresets,
  STYLE_PRESETS,
  STYLE_TEMPLATE_VERSION,
} from "./styles";
import {
  AiServiceError,
  isAiServiceError,
  type GenerateInteriorImagesOptions,
  type GenerateInteriorImagesRequest,
  type GenerateInteriorImagesResult,
  type AdvancedSettings,
} from "./types";
import { generateVisionArtifacts } from "./vision";
import { openAiQuality, openAiSize } from "./output-spec";
import { domesticImageModelCapabilities, domesticImageModelProvider, domesticImageModelValues, isDomesticImageModel, type DomesticImageModel, type DomesticImageProvider } from "@/lib/domain/domestic-image-models";
import { resolveDomesticProviderConfiguration } from "./domestic-config";
import { prepareOverseasImageRequest } from "./providers/overseas";
import { isOverseasImageModel } from "@/lib/domain/image-models";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const WORKFLOW_TYPES = new Set(["concept", "advanced", "floorplan", "self-service"]);
const OUTPUT_RESOLUTIONS = new Set(["0.5K", "1K", "2K", "4K"]);
const OUTPUT_ASPECT_RATIOS = new Set(["1:1", "4:3", "3:2", "16:9", "9:16"]);
const OUTPUT_QUALITIES = new Set(["draft", "standard", "auto", "low", "medium", "high", "xhigh", "max"]);
const VISUAL_REALISM_LEVELS = new Set(["conceptual", "rendered", "realistic", "photorealistic"]);
const LAMP_STATES = new Set(["on", "off", "mixed"]);
const LEGACY_PROVIDER_PREFERENCES = new Set(["auto", "openai", "google", "mock"]);

function validateRequest(request: GenerateInteriorImagesRequest): void {
  if (request.workflowType !== "self-service" && (!(request.sourceImage?.bytes instanceof Uint8Array) || request.sourceImage.bytes.length === 0)) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: "sourceImage.bytes must be a non-empty Uint8Array",
      userMessage: "现场照片为空或无法读取，请重新上传。",
    });
  }
  if (request.sourceImage && (!(request.sourceImage.bytes instanceof Uint8Array) || request.sourceImage.bytes.length === 0)) {
    throw new AiServiceError({ code: "INVALID_INPUT", message: "sourceImage.bytes must be non-empty when sourceImage is supplied", userMessage: "原始图片为空或无法读取，请重新上传。" });
  }
  if (request.sourceImage && !SUPPORTED_IMAGE_MIME_TYPES.has(request.sourceImage.mimeType)) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: `Unsupported source image MIME type: ${request.sourceImage.mimeType}`,
      userMessage: "目前仅支持 JPEG、PNG 和 WebP 图片。",
    });
  }
  if (!Number.isInteger(request.outputCount) || request.outputCount < 1 || request.outputCount > 4) {
    throw new AiServiceError({
      code: "INVALID_INPUT",
      message: "outputCount must be an integer between 1 and 4",
      userMessage: "单次生成数量必须为1至4张。",
    });
  }
  if (!WORKFLOW_TYPES.has(request.workflowType)) {
    throw invalidRequest("workflowType is unsupported", "工作流类型不受支持。");
  }
  if (!OUTPUT_RESOLUTIONS.has(request.resolution)) {
    throw invalidRequest("resolution is unsupported", "输出分辨率不受支持。");
  }
  if (!OUTPUT_ASPECT_RATIOS.has(request.aspectRatio)) {
    throw invalidRequest("aspectRatio is unsupported", "输出画幅不受支持。");
  }
  if (!OUTPUT_QUALITIES.has(request.quality)) {
    throw invalidRequest("quality is unsupported", "输出质量不受支持。");
  }
  if (request.visualRealism !== undefined && !VISUAL_REALISM_LEVELS.has(request.visualRealism)) {
    throw invalidRequest("visualRealism is unsupported", "视觉表现档位不受支持。");
  }
  if (request.visualRealism !== undefined && request.workflowType !== "concept" && request.workflowType !== "advanced") {
    throw invalidRequest("visualRealism is only supported by concept or advanced workflow", "视觉表现仅适用于概念或高级工作台。");
  }
  if (!LAMP_STATES.has(request.lighting.lampState)) {
    throw invalidRequest("lampState is unsupported", "灯光状态不受支持。");
  }
  const customPrompt = request.customPrompt?.trim();
  if (request.workflowType === "self-service" && (!customPrompt || customPrompt.length > 2000)) {
    throw invalidRequest("customPrompt is required for self-service", "自助工作台必须填写不超过2000字的提示词。");
  }
  if (request.customPrompt && request.customPrompt.length > 2000) {
    throw invalidRequest("customPrompt is too long", "提示词不能超过2000字。");
  }
  if (request.workflowType !== "self-service" && request.workflowType !== "advanced" && customPrompt) {
    throw invalidRequest("customPrompt is only supported by advanced or self-service", "当前工作流不接受自定义提示词。");
  }
  if (
    !Number.isInteger(request.lighting.colorTemperatureKelvin) ||
    request.lighting.colorTemperatureKelvin < 2700 ||
    request.lighting.colorTemperatureKelvin > 6500
  ) {
    throw invalidRequest(
      "colorTemperatureKelvin must be an integer from 2700 through 6500",
      "色温必须是2700K至6500K之间的整数。",
    );
  }
  const controlKinds = request.controlImages?.map((control) => control.kind) ?? [];
  if (
    controlKinds.length > 2 ||
    new Set(controlKinds).size !== controlKinds.length ||
    controlKinds.some((kind) => kind !== "depth" && kind !== "normal") ||
    (controlKinds.includes("depth") && controlKinds.includes("normal") &&
      controlKinds.indexOf("depth") > controlKinds.indexOf("normal"))
  ) {
    throw invalidRequest(
      "controlImages must be unique and ordered depth then normal",
      "结构控制图必须按深度图、法线图的顺序提供。",
    );
  }
  if (request.renovationScope === "local-edit" && !request.mask) {
    throw new AiServiceError({
      code: "MASK_REQUIRED",
      message: "A mask is required for local-edit",
      userMessage: "局部修改需要先涂抹要调整的区域。",
    });
  }
}

function invalidRequest(message: string, userMessage: string): AiServiceError {
  return new AiServiceError({
    code: "INVALID_INPUT",
    message,
    userMessage,
  });
}

function validateAdvancedSettings(request: GenerateInteriorImagesRequest): void {
  if (request.advancedSettings === undefined) return;
  if (request.workflowType !== "advanced") throw invalidRequest("advancedSettings is only supported by advanced workflow", "高级设计参数仅适用于 advanced 工作流。");
  const candidate: unknown = request.advancedSettings;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw invalidRequest("advancedSettings must be an object", "高级设计参数格式不正确。");
  const settings = candidate as AdvancedSettings;
  const values: Record<string, readonly string[]> = {
    geometryFidelity: ["strict", "balanced"], cameraPolicy: ["locked", "correct-verticals"],
    furnishingDensity: ["sparse", "balanced", "layered"], materialExpression: ["clean", "natural", "tactile"], lightingContrast: ["soft", "balanced", "dramatic"],
  };
  if (settings.version !== 1 || Object.keys(settings).some((key) => key !== "version" && !(key in values)) || Object.entries(values).some(([key, allowed]) => !allowed.includes(String(settings[key as keyof AdvancedSettings])))) throw invalidRequest("advancedSettings is invalid", "高级设计参数不受支持。");
}

export async function generateInteriorImages(
  request: GenerateInteriorImagesRequest,
  options: GenerateInteriorImagesOptions = {},
): Promise<GenerateInteriorImagesResult> {
  const compiledPrompt = compileValidatedPrompt(request);
  const environment = resolveAiEnvironment(options.env);
  const preference = request.providerPreference ?? "auto";
  if (!environment.BACKEND_PROFILE || (environment.BACKEND_PROFILE !== "sites-demo" && environment.BACKEND_PROFILE !== "cn-production")) {
    throw new AiServiceError({ code: "PROVIDER_ERROR", message: "Unknown BACKEND_PROFILE", userMessage: "后端运行模式配置无效。" });
  }
  const domestic = (domesticImageModelValues as readonly string[]).includes(preference);
  if (!domestic && !LEGACY_PROVIDER_PREFERENCES.has(preference)) {
    throw new AiServiceError({ code: "PROVIDER_ERROR", message: "Unsupported image provider preference", userMessage: "图片服务配置无效。" });
  }
  if (domestic && environment.BACKEND_PROFILE !== "cn-production") {
    throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Domestic image providers are disabled outside cn-production", userMessage: "国产图片模型只允许在国内生产模式使用。" });
  }
  if (!domestic && environment.BACKEND_PROFILE === "cn-production") {
    throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Legacy image providers are disabled in cn-production", userMessage: "国内生产环境不允许使用海外或演示图片模型。" });
  }
  if (preference === "mock") return generateMockInteriorImages(request);

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const providerContext = (
    apiKey: string,
    baseUrl?: string,
    model?: string,
  ) => ({
    apiKey,
    fetch: fetchImplementation,
    signal: options.signal,
    prompt: compiledPrompt.text,
    promptTemplateVersion: compiledPrompt.templateVersion,
    baseUrl,
    model,
    requestTimeoutMs: options.providerRequestTimeoutMs,
  });

  if (domestic) {
    const selected = preference as (typeof domesticImageModelValues)[number];
    const configuration = resolveDomesticProviderConfiguration(selected, environment);
    if (!configuration) {
      throw new AiServiceError({
        code: "NOT_CONFIGURED",
        message: `${selected} image provider configuration is missing or invalid`,
        userMessage: "当前国产图片模型尚未配置服务端密钥，请联系管理员。",
        provider: domesticImageModelProvider(selected),
      });
    }
    const adapters = {
      seedream: seedreamProvider,
      qwen: qwenProvider,
      hunyuan: hunyuanProvider,
      kling: klingProvider,
    } as const;
    return adapters[domesticImageModelProvider(selected)].generate(
      request,
      providerContext(configuration.apiKey, configuration.endpoint, configuration.model),
    );
  }

  if (preference === "openai") {
    if (!environment.OPENAI_API_KEY) {
      throw new AiServiceError({
        code: "NOT_CONFIGURED",
        message: "OPENAI_API_KEY is not configured",
        userMessage: "OpenAI图片服务尚未配置。",
        provider: "openai",
      });
    }
    return openAiProvider.generate(request, providerContext(environment.OPENAI_API_KEY));
  }

  const googleApiKey = environment.GOOGLE_API_KEY ?? environment.GEMINI_API_KEY;
  if (preference === "google") {
    if (!googleApiKey) {
      throw new AiServiceError({
        code: "NOT_CONFIGURED",
        message: "GOOGLE_API_KEY or GEMINI_API_KEY is not configured",
        userMessage: "Google图片服务尚未配置。",
        provider: "google",
      });
    }
    return googleProvider.generate(request, providerContext(googleApiKey));
  }

  const candidates = [
    environment.OPENAI_API_KEY
      ? { adapter: openAiProvider, apiKey: environment.OPENAI_API_KEY }
      : undefined,
    googleApiKey ? { adapter: googleProvider, apiKey: googleApiKey } : undefined,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (!candidates.length) return generateMockInteriorImages(request);

  let lastRetryableError: AiServiceError | undefined;
  for (const candidate of candidates) {
    try {
      return await candidate.adapter.generate(request, providerContext(candidate.apiKey));
    } catch (error) {
      if (!isAiServiceError(error) || !error.retryable) throw error;
      lastRetryableError = error;
    }
  }
  throw lastRetryableError ?? new AiServiceError({
    code: "PROVIDER_UNAVAILABLE",
    message: "No configured image provider was available",
    userMessage: "图片服务暂时不可用，请稍后重试。",
    retryable: true,
  });
}

export type PreparedDomesticSingleImageGeneration = {
  provider: DomesticImageProvider;
  model: DomesticImageModel;
  promptTemplateVersion: string;
  execute(): Promise<GenerateInteriorImagesResult>;
};

export function prepareDomesticSingleImageGeneration(
  request: GenerateInteriorImagesRequest,
  options: GenerateInteriorImagesOptions = {},
): PreparedDomesticSingleImageGeneration {
  if (request.outputCount !== 1 || !isDomesticImageModel(request.providerPreference)) {
    throw invalidRequest(
      "domestic queue execution requires one output and an exact domestic model",
      "持久队列任务的模型或输出数量无效。",
    );
  }
  const model = request.providerPreference;
  const provider = domesticImageModelProvider(model);
  const compiledPrompt = compileValidatedPrompt(request);
  const environment = resolveAiEnvironment(options.env);
  if (environment.BACKEND_PROFILE !== "cn-production") {
    throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Domestic queue execution requires cn-production", userMessage: "国产图片模型只允许在国内生产模式使用。", provider });
  }
  const configuration = resolveDomesticProviderConfiguration(model, environment);
  if (!configuration) {
    throw new AiServiceError({ code: "NOT_CONFIGURED", message: `${model} provider slot is missing or invalid`, userMessage: "当前国产图片模型账号槽位未配置。", provider });
  }
  const capability = domesticImageModelCapabilities[model];
  assertDomesticRequest(provider, request, {
    maxInputImages: capability.maxInputImages,
    supportedResolutions: capability.supportedResolutions,
    acceptedMimeTypes: capability.acceptedMimeTypes,
    maxImageBytes: capability.maxImageBytes,
    maxTotalImageBytes: capability.maxTotalImageBytes,
    dimensions: capability.inputDimensions,
  });
  const adapter = provider === "seedream" ? seedreamProvider : qwenProvider;
  const context = {
    apiKey: configuration.apiKey,
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
    prompt: compiledPrompt.text,
    promptTemplateVersion: compiledPrompt.templateVersion,
    baseUrl: configuration.endpoint,
    model: configuration.model,
    requestTimeoutMs: options.providerRequestTimeoutMs,
  };
  let executed = false;
  return {
    provider,
    model,
    promptTemplateVersion: compiledPrompt.templateVersion,
    async execute() {
      if (executed) {
        throw new AiServiceError({ code: "PROVIDER_ERROR", message: "Prepared provider request was already executed", userMessage: "任务执行状态异常，已停止重复调用。", provider });
      }
      executed = true;
      return adapter.generate(request, context);
    },
  };
}

function compileValidatedPrompt(request: GenerateInteriorImagesRequest) {
  validateRequest(request);
  validateAdvancedSettings(request);
  if (request.designSchemeId && (request.workflowType !== "concept" || getDesignScheme(request.designSchemeId)?.styleId !== request.style.presetId)) {
    throw invalidRequest("designSchemeId does not belong to style", "所选设计方案与风格不匹配。");
  }

  const style = request.workflowType !== "concept"
    ? {
        id: request.workflowType,
        name: "自定义设计",
        description: "用户自定义提示词",
        preview: "",
        promptDirective: "",
      }
    : getStylePreset(request.style.presetId);
  if (!style) {
    throw new AiServiceError({
      code: "STYLE_NOT_FOUND",
      message: `Unknown style preset: ${request.style.presetId}`,
      userMessage: "所选设计风格不存在或已经下线，请重新选择。",
    });
  }
  if (
    request.workflowType === "concept" &&
    request.style.templateVersion &&
    request.style.templateVersion !== STYLE_TEMPLATE_VERSION
  ) {
    throw new AiServiceError({
      code: "STYLE_VERSION_MISMATCH",
      message: `Expected style template ${STYLE_TEMPLATE_VERSION}, received ${request.style.templateVersion}`,
      userMessage: "设计风格已更新，请刷新页面后重新选择。",
    });
  }

  return compileInteriorPrompt(request, style);
}

/** Queue-only overseas path: the caller must supply its fixed TLS tunnel fetch. */
export function prepareOverseasSingleImageGeneration(request: GenerateInteriorImagesRequest, options: GenerateInteriorImagesOptions) {
  if (!isOverseasImageModel(request.providerPreference) || request.outputCount !== 1 || !options.fetch) throw invalidRequest("Overseas queue needs exact model, one output and tunnel fetch", "海外持久队列参数或出口未配置。");
  const compiled = compileValidatedPrompt(request);
  const environment = resolveAiEnvironment(options.env);
  if (environment.BACKEND_PROFILE !== "cn-production") throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Overseas queue needs production private test", userMessage: "海外模型仅开放开发者 SSH 私测。" });
  const apiKey = request.providerPreference.startsWith("gpt-") ? environment.OPENAI_API_KEY : environment.GOOGLE_API_KEY ?? environment.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length < 8) throw new AiServiceError({ code: "NOT_CONFIGURED", message: "Overseas provider key is missing", userMessage: "海外图片模型账号槽位未配置。" });
  return prepareOverseasImageRequest(request, { apiKey: apiKey.trim(), fetch: options.fetch, signal: options.signal, prompt: compiled.text, promptTemplateVersion: compiled.templateVersion, model: request.providerPreference, requestTimeoutMs: options.providerRequestTimeoutMs });
}

export {
  AiServiceError,
  getStylePreset,
  isAiServiceError,
  listPublicStylePresets,
  generateVisionArtifacts,
  openAiQuality,
  openAiSize,
  PROMPT_TEMPLATE_VERSION,
  STYLE_PRESETS,
  STYLE_TEMPLATE_VERSION,
};

export type {
  AiErrorCode,
  AiOutputMetadata,
  AiProviderName,
  AiRuntimeEnvironment,
  BinaryImage,
  ColorTemperature,
  ControlImage,
  GeneratedInteriorImage,
  GenerateInteriorImagesOptions,
  GenerateInteriorImagesRequest,
  GenerateInteriorImagesResult,
  ImageMimeType,
  LampState,
  LightingSelection,
  OutputAspectRatio,
  OutputQuality,
  OutputResolution,
  ProviderPreference,
  ReferenceRole,
  RenovationScope,
  StyleSelection,
  TimeOfDay,
  WorkflowType,
  GenerateVisionArtifactsRequest,
  GenerateVisionArtifactsResult,
  VisionArtifact,
  VisionArtifactKind,
} from "./types";

export type { PublicStylePreset, StylePreset } from "./styles";
