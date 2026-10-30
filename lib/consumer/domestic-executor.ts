import { readImageMetadata } from "@/lib/ai/image-metadata";
import { createHash } from "node:crypto";
import {
  isAiServiceError,
  prepareDomesticSingleImageGeneration,
  prepareOverseasSingleImageGeneration,
  type AiRuntimeEnvironment,
  type GenerateInteriorImagesRequest,
  type ImageMimeType,
  type ReferenceRole,
} from "@/lib/ai";
import {
  imageModelProvider,
  isImageModel,
  isOverseasImageModel,
  type ImageModel,
  type ImageProvider,
} from "@/lib/domain/image-models";
import { parseGenerationWorkSpec } from "@/lib/domain/generation-work";
import type { GenerationWorkSpec } from "@/lib/domain/generation-work";
import {
  GenerationExecutionError,
  type DownloadedInput,
  type GenerationExecutor,
  type PreparedGeneration,
} from "./contracts";
import type { ImageSanitizer } from "@/lib/platform/image-sanitizer";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import { sanitizeGeneratedImage } from "@/lib/server/files";

const SLOT_ID = /^[A-Za-z0-9:_-]{1,128}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u;
const REFERENCE_ROLES = new Set<ReferenceRole>([
  "selection",
  "style",
  "reference",
  "furnishing",
  "structure",
  "material",
  "lighting-color",
  "composition",
]);

export type DomesticAccountSlot =
  | { id: string; provider: "seedream"; apiKey: string }
  | {
      id: string;
      provider: "qwen";
      apiKey: string;
      workspaceId: string;
    };

export type ImageAccountSlot = DomesticAccountSlot | { id: string; provider: "openai" | "google"; apiKey: string };

type ProviderWorkSpec = GenerationWorkSpec & {
  executionKind: "provider";
  providerPreference: ImageModel;
};

export function createDomesticGenerationExecutor(options: {
  slots: Partial<Record<ImageProvider, ImageAccountSlot>>;
  fetch: typeof globalThis.fetch;
  overseasTransport?: { fetch: typeof globalThis.fetch; assertReady: (provider: "openai" | "google") => Promise<void> };
  sanitizer: ImageSanitizer;
  providerRequestTimeoutMs?: number;
  privateTestExpiresAt?: number;
  publicGenerationEnabled?: boolean;
}): GenerationExecutor {
  if (options.publicGenerationEnabled && options.privateTestExpiresAt !== undefined) throw new Error("MIXED_GENERATION_MODE");
  const slots = validateSlots(options.slots);
  if (typeof options.fetch !== "function") throw new Error("INVALID_PROVIDER_FETCH");
  if (options.privateTestExpiresAt !== undefined && (!Number.isSafeInteger(options.privateTestExpiresAt) || options.privateTestExpiresAt <= 0)) throw new Error("INVALID_PRIVATE_TEST_EXPIRY");
  const providerFetch: typeof globalThis.fetch = (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (options.privateTestExpiresAt !== undefined && method.toUpperCase() === "POST" && Date.now() >= options.privateTestExpiresAt * 1000) throw new Error("PRIVATE_TEST_EXPIRED");
    return options.fetch(input, init);
  };
  return {
    async prepare(workValue, downloaded): Promise<PreparedGeneration> {
      const work = parseGenerationWorkSpec(workValue);
      if (
        work.executionKind !== "provider" ||
        !isImageModel(work.providerPreference)
      ) {
        throw new Error("INVALID_PROVIDER_MODEL");
      }
      const providerWork = work as ProviderWorkSpec;
      const provider = imageModelProvider(providerWork.providerPreference);
      const slot = slots[provider];
      if (!slot || slot.provider !== provider) {
        throw new Error("PROVIDER_ACCOUNT_SLOT_NOT_CONFIGURED");
      }
      const overseas = isOverseasImageModel(providerWork.providerPreference);
      if (overseas) {
        if (!options.overseasTransport || (!options.publicGenerationEnabled && (options.privateTestExpiresAt === undefined || Date.now() >= options.privateTestExpiresAt * 1000))) throw new Error("OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED");
        await options.overseasTransport.assertReady(provider as "openai" | "google");
      }
      const request = buildRequest(providerWork, downloaded);
      const environment: AiRuntimeEnvironment = {
        BACKEND_PROFILE: "cn-production",
        ...(slot.provider === "seedream"
          ? { ARK_API_KEY: slot.apiKey }
          : slot.provider === "qwen" ? {
              DASHSCOPE_API_KEY: slot.apiKey,
              DASHSCOPE_WORKSPACE_ID: slot.workspaceId,
            } : slot.provider === "openai" ? { OPENAI_API_KEY: slot.apiKey } : { GOOGLE_API_KEY: slot.apiKey }),
      };
      const prepare = overseas ? prepareOverseasSingleImageGeneration : prepareDomesticSingleImageGeneration;
      const prepared = prepare(request, {
        env: environment,
        fetch: overseas ? (input, init) => {
          if (!options.publicGenerationEnabled && Date.now() >= options.privateTestExpiresAt! * 1000) throw new Error("PRIVATE_TEST_EXPIRED");
          const headers = new Headers(init?.headers);
          headers.set("X-Request-ID", work.attemptId);
          return options.overseasTransport!.fetch(input, { ...init, headers });
        } : providerFetch,
        providerRequestTimeoutMs: options.providerRequestTimeoutMs,
      });
      if (prepared.provider !== provider || prepared.model !== providerWork.providerPreference) {
        throw new Error("PROVIDER_PREPARATION_CONFLICT");
      }
      return {
        provider,
        model: providerWork.providerPreference,
        accountSlotId: slot.id,
        async execute() {
          let providerRequestId: string | null = null;
          try {
            const result = await prepared.execute();
            if (
              result.providerRequestId !== undefined &&
              !validRequestId(result.providerRequestId)
            ) {
              throw new GenerationExecutionError(null);
            }
            providerRequestId = result.providerRequestId ?? null;
            if (
              result.provider !== provider ||
              result.model !== providerWork.providerPreference ||
              result.outputs.length !== 1 ||
              !result.outputs[0]
            ) {
              throw new GenerationExecutionError(providerRequestId);
            }
            const output = await sanitizeGeneratedImage(
              result.outputs[0].bytes,
              result.outputs[0].mimeType,
              options.sanitizer,
              8 * 1024 * 1024,
            );
            return {
              bytes: output.bytes,
              mimeType: output.mimeType,
              providerRequestId,
              promptTemplateVersion: result.promptTemplateVersion,
              sanitizationVersion: IMAGE_SANITIZATION_VERSION,
            };
          } catch (error) {
            if (error instanceof GenerationExecutionError) throw error;
            if (overseas && isAiServiceError(error) && error.code === "NO_IMAGE_OUTPUT") {
              const reason = error.message === "Expected exactly one final image" ? "FINAL_IMAGE_COUNT"
                : error.message === "Expected one completed candidate" ? "CANDIDATE_INCOMPLETE"
                  : error.message === "Invalid or oversized provider image" ? "IMAGE_INVALID" : "UNKNOWN";
              console.warn("zaoshi.overseas_image_rejected", { attemptId: work.attemptId, reason });
            }
            const errorRequestId =
              isAiServiceError(error) && validRequestId(error.providerRequestId)
                ? error.providerRequestId ?? null
                : providerRequestId;
            throw new GenerationExecutionError(errorRequestId, {
              cause: error,
              code: isAiServiceError(error) ? error.code : "PROVIDER_ERROR",
            });
          }
        },
      };
    },
  };
}

function buildRequest(
  work: ProviderWorkSpec,
  downloaded: readonly DownloadedInput[],
): GenerateInteriorImagesRequest {
  if (downloaded.length !== work.inputs.length) throw new Error("INPUT_COUNT_CONFLICT");
  const verified = downloaded.map((input, index) => {
    const expected = work.inputs[index];
    if (
      !expected ||
      input.index !== index ||
      input.role !== expected.role ||
      input.mimeType !== expected.mimeType ||
      input.bytes.byteLength !== expected.byteSize ||
      digest(input.bytes) !== expected.sha256
    ) {
      throw new Error("INPUT_INTEGRITY_CONFLICT");
    }
    return {
      role: input.role,
      image: {
        bytes: input.bytes,
        mimeType: input.mimeType as ImageMimeType,
      },
    };
  });
  const source = verified.find((input) => input.role === "source");
  const selection = verified.find((input) => input.role === "selection");
  if (selection) {
    if (!source) throw new Error("LOCAL_EDIT_SOURCE_REQUIRED");
    const baseSize = readImageMetadata(source.image); const markedSize = readImageMetadata(selection.image);
    if (![baseSize.width, baseSize.height, markedSize.width, markedSize.height].every((value) => Number.isInteger(value) && Number(value) > 0) || baseSize.width !== markedSize.width || baseSize.height !== markedSize.height) throw new Error("LOCAL_EDIT_DIMENSIONS");
  }
  const controls = verified.filter(
    (input): input is typeof input & { role: "depth" | "normal" } =>
      input.role === "depth" || input.role === "normal",
  );
  const references = verified.filter((input) => REFERENCE_ROLES.has(input.role as ReferenceRole));
  return {
    ...(source ? { sourceImage: source.image } : {}),
    workflowType: work.workflowType,
    spaceType: work.spaceType ?? "unspecified",
    purpose: work.purpose,
    promotedFromPreview: work.promotedFromPreview,
    resolution: work.resolution,
    aspectRatio: work.aspectRatio,
    quality: work.quality,
    ...((work.workflowType === "concept" || work.workflowType === "advanced")
      ? { visualRealism: work.visualRealism }
      : {}),
    style: { presetId: work.stylePresetId },
    designSchemeId: work.designSchemeId,
    variationKey: work.itemId,
    lighting: {
      timeOfDay: timeOfDay(work.lightingPreset),
      lampState: work.lampState,
      colorTemperatureKelvin: work.colorTemperatureKelvin,
    },
    renovationScope: work.renovationScope,
    ...(controls.length
      ? {
          controlImages: controls.map((input) => ({
            kind: input.role,
            image: input.image,
          })),
        }
      : {}),
    ...(references.length
      ? {
          referenceImages: references.map((input) => ({
            role: input.role as ReferenceRole,
            image: input.image,
          })),
        }
      : {}),
    ...(work.editInstruction ? { editInstruction: work.editInstruction } : {}),
    ...(work.customPrompt ? { customPrompt: work.customPrompt } : {}),
    outputCount: 1,
    providerPreference: work.providerPreference,
    ...(work.advancedSettings ? { advancedSettings: work.advancedSettings } : {}),
  };
}

function validateSlots(
  value: Partial<Record<ImageProvider, ImageAccountSlot>>,
): Partial<Record<ImageProvider, ImageAccountSlot>> {
  const result: Partial<Record<ImageProvider, ImageAccountSlot>> = {};
  for (const provider of ["seedream", "qwen", "openai", "google"] as const) {
    const slot = value[provider];
    if (!slot) continue;
    if (
      slot.provider !== provider ||
      !SLOT_ID.test(slot.id) ||
      typeof slot.apiKey !== "string" ||
      slot.apiKey.trim().length < 8 ||
      (slot.provider === "qwen" && !WORKSPACE_ID.test(slot.workspaceId))
    ) {
      throw new Error("INVALID_PROVIDER_ACCOUNT_SLOT");
    }
    result[provider] = { ...slot, apiKey: slot.apiKey.trim() };
  }
  return result;
}

function timeOfDay(value: "morning" | "noon" | "sunset" | "night") {
  if (value === "morning") return "dawn" as const;
  if (value === "noon") return "day" as const;
  if (value === "sunset") return "dusk" as const;
  return "night" as const;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validRequestId(value: string | undefined): boolean {
  return value === undefined || (value.length >= 1 && value.length <= 200);
}
