import { validLocalEdit } from "@/lib/domain/local-edit";
import {
  imageModelCapabilities,
  isImageModel,
  type ImageModel,
  imageModelSupportsQuality,
} from "./image-models";
import type { AdvancedSettings } from "@/lib/ai/types";
import type { GenerationExecutionKind } from "@/db/schema";

const ID = /^[A-Za-z0-9:_-]{1,160}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INPUT_ROLES = new Set([
  "source",
  "selection",
  "style",
  "reference",
  "furnishing",
  "structure",
  "material",
  "lighting-color",
  "composition",
  "depth",
  "normal",
]);
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type GenerationWorkInput = {
  role: string;
  index: number;
  mimeType: string;
  byteSize: number;
  sha256: string;
  ticket: string;
};

export type GenerationWorkSpec = {
  version: 1;
  executionKind: GenerationExecutionKind;
  itemId: string;
  attemptId: string;
  outputOrdinal: number;
  totalOutputs: number;
  providerPreference: ImageModel | "acceptance-fixture-v1";
  workflowType: "concept" | "advanced" | "floorplan" | "self-service";
  spaceType?: "living-room" | "corridor" | "children-room" | "bedroom" | "dining-room" | "kitchen" | "bathroom" | "study" | "unspecified";
  purpose: "preview" | "final";
  resolution: "0.5K" | "1K" | "2K" | "4K";
  aspectRatio: "1:1" | "4:3" | "3:2" | "16:9" | "9:16";
  quality: import("./image-models").StoredImageQuality;
  visualRealism: "conceptual" | "rendered" | "realistic" | "photorealistic";
  stylePresetId: string;
  designSchemeId?: string | null;
  lightingPreset: "morning" | "noon" | "sunset" | "night";
  lampState: "on" | "off" | "mixed";
  colorTemperatureKelvin: number;
  renovationScope: "restyle" | "replace-soft-furnishings" | "empty-room";
  promotedFromPreview: boolean;
  editInstruction: string | null;
  customPrompt: string | null;
  advancedSettings: AdvancedSettings | null;
  outputCount: 1;
  inputs: GenerationWorkInput[];
};

export function parseGenerationWorkSpec(value: unknown): GenerationWorkSpec {
  const work = object(value);
  exactKeys(work, [
    "version", "executionKind", "itemId", "attemptId", "outputOrdinal", "totalOutputs",
    "providerPreference", "workflowType", "spaceType", "purpose", "resolution",
    "aspectRatio", "quality", "visualRealism", "stylePresetId", "designSchemeId",
    "lightingPreset", "lampState", "colorTemperatureKelvin",
    "renovationScope", "promotedFromPreview", "editInstruction",
    "customPrompt", "advancedSettings", "outputCount", "inputs",
  ], ["spaceType", "designSchemeId"]);
  if (work.version !== 1 || work.outputCount !== 1) invalid();
  const executionKind = enumeration(work.executionKind, [
    "provider",
    "acceptance",
  ] as const);
  const itemId = identifier(work.itemId);
  const attemptId = identifier(work.attemptId);
  const outputOrdinal = integer(work.outputOrdinal, 0, 3);
  const totalOutputs = integer(work.totalOutputs, 1, 4);
  if (outputOrdinal >= totalOutputs) invalid();
  if (
    (executionKind === "provider" &&
      !isImageModel(work.providerPreference)) ||
    (executionKind === "acceptance" &&
      work.providerPreference !== "acceptance-fixture-v1")
  ) {
    invalid();
  }
  const providerPreference = work.providerPreference as GenerationWorkSpec["providerPreference"];
  const workflowType = enumeration(work.workflowType, ["concept", "advanced", "floorplan", "self-service"] as const);
  const spaceType = enumeration(work.spaceType ?? "unspecified", ["living-room", "corridor", "children-room", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified"] as const);
  if (spaceType === "children-room" && workflowType !== "concept") invalid();
  const purpose = enumeration(work.purpose, ["preview", "final"] as const);
  const resolution = enumeration(work.resolution, ["0.5K", "1K", "2K", "4K"] as const);
  if (
    executionKind === "provider" &&
    !(
      imageModelCapabilities[providerPreference as ImageModel]
        .supportedResolutions as readonly string[]
    ).includes(resolution)
  ) invalid();
  if (executionKind === "acceptance" && resolution !== "0.5K") invalid();
  const aspectRatio = enumeration(work.aspectRatio, ["1:1", "4:3", "3:2", "16:9", "9:16"] as const);
  const quality = enumeration(work.quality, ["draft", "standard", "auto", "low", "medium", "high", "xhigh", "max"] as const);
  if (executionKind === "provider" && !imageModelSupportsQuality(providerPreference as ImageModel, quality)) invalid();
  const visualRealism = enumeration(work.visualRealism, ["conceptual", "rendered", "realistic", "photorealistic"] as const);
  const stylePresetId = boundedString(work.stylePresetId, 1, 100);
  const designSchemeId = work.designSchemeId === undefined ? null : nullableString(work.designSchemeId, 100);
  if (workflowType !== "concept" && designSchemeId) invalid();
  const lightingPreset = enumeration(work.lightingPreset, ["morning", "noon", "sunset", "night"] as const);
  const lampState = enumeration(work.lampState, ["on", "off", "mixed"] as const);
  const colorTemperatureKelvin = integer(work.colorTemperatureKelvin, 2700, 6500);
  const renovationScope = enumeration(work.renovationScope, ["restyle", "replace-soft-furnishings", "empty-room"] as const);
  if (typeof work.promotedFromPreview !== "boolean") invalid();
  const editInstruction = nullableString(work.editInstruction, 2000);
  const customPrompt = nullableString(work.customPrompt, 2000);
  const advancedSettings = parseAdvancedSettings(work.advancedSettings, workflowType);
  if (!Array.isArray(work.inputs)) invalid();
  const inputs = work.inputs.map((entry, index) => parseInput(entry, index));
  if (inputs.some((input) => input.role === "selection") && (purpose !== "final" || work.promotedFromPreview || !validLocalEdit(workflowType, inputs.map((input) => input.role), editInstruction))) invalid();
  if (executionKind === "provider") {
    validateInputRoles(
      inputs,
      workflowType,
      providerPreference as ImageModel,
    );
  } else if (
    workflowType !== "concept" ||
    inputs.length !== 1 ||
    inputs[0]?.role !== "source"
  ) {
    invalid();
  }
  if (
    executionKind === "acceptance" &&
    (purpose !== "final" ||
      aspectRatio !== "1:1" ||
      quality !== "draft" ||
      visualRealism !== "conceptual" ||
      stylePresetId !== "acceptance-fixture-v1" ||
      lightingPreset !== "noon" ||
      lampState !== "off" ||
      colorTemperatureKelvin !== 4000 ||
      renovationScope !== "restyle" ||
      work.promotedFromPreview !== false ||
      editInstruction !== null ||
      customPrompt !== null ||
      advancedSettings !== null)
  ) {
    invalid();
  }
  return {
    version: 1,
    executionKind,
    itemId,
    attemptId,
    outputOrdinal,
    totalOutputs,
    providerPreference,
    workflowType,
    spaceType,
    purpose,
    resolution,
    aspectRatio,
    quality,
    visualRealism,
    stylePresetId,
    ...(work.designSchemeId !== undefined ? { designSchemeId } : {}),
    lightingPreset,
    lampState,
    colorTemperatureKelvin,
    renovationScope,
    promotedFromPreview: work.promotedFromPreview,
    editInstruction,
    customPrompt,
    advancedSettings,
    outputCount: 1,
    inputs,
  };
}

function parseInput(value: unknown, expectedIndex: number): GenerationWorkInput {
  const input = object(value);
  exactKeys(input, ["role", "index", "mimeType", "byteSize", "sha256", "ticket"]);
  const role = boundedString(input.role, 1, 40);
  if (!INPUT_ROLES.has(role) || input.index !== expectedIndex) invalid();
  const mimeType = boundedString(input.mimeType, 1, 40);
  if (!MIME_TYPES.has(mimeType)) invalid();
  const byteSize = integer(input.byteSize, 1, 12 * 1024 * 1024);
  const sha256 = boundedString(input.sha256, 64, 64);
  if (!SHA256.test(sha256)) invalid();
  const ticket = boundedString(input.ticket, 64, 4096);
  return { role, index: expectedIndex, mimeType, byteSize, sha256, ticket };
}

function validateInputRoles(
  inputs: readonly GenerationWorkInput[],
  workflowType: GenerationWorkSpec["workflowType"],
  providerPreference: keyof typeof imageModelCapabilities,
): void {
  const capability = imageModelCapabilities[providerPreference];
  if (inputs.length > capability.maxInputImages || inputs.some((input) => input.byteSize > capability.maxImageBytes || !(capability.acceptedMimeTypes as readonly string[]).includes(input.mimeType)) || inputs.reduce((sum, input) => sum + input.byteSize, 0) > capability.maxTotalImageBytes) invalid();
  for (const role of ["source", "style", "depth", "normal"]) {
    if (inputs.filter((input) => input.role === role).length > 1) invalid();
  }
  if (workflowType !== "self-service" && inputs[0]?.role !== "source") invalid();
  if (inputs.some((input) => input.role === "depth" || input.role === "normal") && workflowType !== "advanced") invalid();
  const depth = inputs.findIndex((input) => input.role === "depth");
  const normal = inputs.findIndex((input) => input.role === "normal");
  if (depth >= 0 && normal >= 0 && depth > normal) invalid();
  if (depth >= 0 && inputs.slice(depth + 1).some((input) => input.role !== "normal")) invalid();
  if (normal >= 0 && normal !== inputs.length - 1) invalid();
}

function parseAdvancedSettings(
  value: unknown,
  workflowType: GenerationWorkSpec["workflowType"],
): AdvancedSettings | null {
  if (value === null) {
    if (workflowType === "advanced") invalid();
    return null;
  }
  if (workflowType !== "advanced") invalid();
  const settings = object(value);
  exactKeys(settings, ["version", "geometryFidelity", "cameraPolicy", "furnishingDensity", "materialExpression", "lightingContrast"]);
  if (settings.version !== 1) invalid();
  return {
    version: 1,
    geometryFidelity: enumeration(settings.geometryFidelity, ["strict", "balanced"] as const),
    cameraPolicy: enumeration(settings.cameraPolicy, ["locked", "correct-verticals"] as const),
    furnishingDensity: enumeration(settings.furnishingDensity, ["sparse", "balanced", "layered"] as const),
    materialExpression: enumeration(settings.materialExpression, ["clean", "natural", "tactile"] as const),
    lightingContrast: enumeration(settings.lightingContrast, ["soft", "balanced", "dramatic"] as const),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))) invalid();
}

function identifier(value: unknown): string {
  const result = boundedString(value, 1, 160);
  if (!ID.test(result)) invalid();
  return result;
}

function boundedString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid();
  return value;
}

function nullableString(value: unknown, max: number): string | null {
  if (value === null) return null;
  return boundedString(value, 1, max);
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
  return value as number;
}

function enumeration<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T[number];
}

function invalid(): never {
  throw new Error("CONTROL_PLANE_WORK_INVALID");
}
