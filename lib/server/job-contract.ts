import { validLocalEdit, localEditUsesPrompt } from "@/lib/domain/local-edit";
import { isBareShellInstruction } from "@/lib/domain/bare-shell";
import { createHash } from "node:crypto";
import { getStylePreset } from "@/lib/ai";
import { firstDesignScheme, firstV2DesignScheme, firstLegacyDesignScheme, getDesignScheme } from "@/lib/ai/design-schemes";
import type { AssetKind } from "@/db/schema";
import type { PersistedAsset } from "./persistence";
import {
  ApiError,
  optionalString,
  requireEnum,
  requireJsonObject,
  requireString,
} from "./api";
import type { AdvancedSettings, VisualRealism } from "@/lib/ai/types";
import { imageModelMaxReferences, imageModelPreviewResolution, imageModelValues, imageModelSupportsQuality } from "@/lib/domain/image-models";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";

export const lightingPresets = ["morning", "noon", "sunset", "night"] as const;
export const preservationModes = ["structure", "furniture", "clear"] as const;
export const providerPreferences = imageModelValues;
export const workflowTypes = ["concept", "advanced", "floorplan", "self-service"] as const;
export const jobPurposes = ["preview", "final"] as const;
export const outputResolutions = ["0.5K", "1K", "2K", "4K"] as const;
export const outputAspectRatios = ["1:1", "4:3", "3:2", "16:9", "9:16"] as const;
export const outputQualities = ["draft", "standard", "auto", "low", "medium", "high", "xhigh", "max"] as const;
export const visualRealismLevels = ["conceptual", "rendered", "realistic", "photorealistic"] as const;
export const lampStates = ["on", "off", "mixed"] as const;
export const spaceTypes = ["living-room", "corridor", "children-room", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified"] as const;

export type LightingPreset = (typeof lightingPresets)[number];
export type PreservationMode = (typeof preservationModes)[number];
export type ProviderPreference = (typeof providerPreferences)[number];
export type WorkflowType = (typeof workflowTypes)[number];
export type JobPurpose = (typeof jobPurposes)[number];
export type OutputResolution = (typeof outputResolutions)[number];
export type EffectiveResolution = "0.5K" | OutputResolution;
export type OutputAspectRatio = (typeof outputAspectRatios)[number];
export type OutputQuality = (typeof outputQualities)[number];
export type VisualRealismLevel = (typeof visualRealismLevels)[number];
export type LampState = (typeof lampStates)[number];
export type SpaceType = (typeof spaceTypes)[number];
export const additionalReferenceRoles = ["selection", "reference", "furnishing", "structure", "material", "lighting-color", "composition"] as const;
export type AdditionalReferenceRole = (typeof additionalReferenceRoles)[number];
export type AdditionalReference = { assetId: string; role: AdditionalReferenceRole };

export function mapPreservation(mode: PreservationMode, workflowType: WorkflowType): "restyle" | "replace-soft-furnishings" | "empty-room" {
  switch (mode) {
    case "structure": return workflowType === "advanced" ? "restyle" : "replace-soft-furnishings";
    case "furniture": return workflowType === "advanced" ? "replace-soft-furnishings" : "restyle";
    case "clear": return "empty-room";
  }
}
export const defaultAdvancedSettings: AdvancedSettings = { version: 1, geometryFidelity: "balanced", cameraPolicy: "locked", furnishingDensity: "balanced", materialExpression: "natural", lightingContrast: "balanced" };
const advancedSettingEnums = {
  geometryFidelity: ["strict", "balanced"],
  cameraPolicy: ["locked", "correct-verticals"],
  furnishingDensity: ["sparse", "balanced", "layered"],
  materialExpression: ["clean", "natural", "tactile"],
  lightingContrast: ["soft", "balanced", "dramatic"],
} as const;

export function parseAdvancedSettingsObject(value: unknown): AdvancedSettings {
  if (value === undefined) return defaultAdvancedSettings;
  const settings = requireJsonObject(value);
  const allowed = new Set(["version", ...Object.keys(advancedSettingEnums)]);
  const unknown = Object.keys(settings).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "INVALID_ADVANCED_SETTINGS", `advancedSettings 不允许未知字段 ${unknown}。`, { field: "advancedSettings" });
  if (settings.version !== 1) throw new ApiError(400, "INVALID_ADVANCED_SETTINGS", "advancedSettings.version 必须为1。", { field: "advancedSettings.version" });
  for (const [field, values] of Object.entries(advancedSettingEnums)) {
    if (typeof settings[field] !== "string" || !(values as readonly string[]).includes(settings[field] as string)) {
      throw new ApiError(400, "INVALID_ADVANCED_SETTINGS", `advancedSettings.${field} 的取值不受支持。`, { field: `advancedSettings.${field}` });
    }
  }
  return { version: 1, geometryFidelity: settings.geometryFidelity as AdvancedSettings["geometryFidelity"], cameraPolicy: settings.cameraPolicy as AdvancedSettings["cameraPolicy"], furnishingDensity: settings.furnishingDensity as AdvancedSettings["furnishingDensity"], materialExpression: settings.materialExpression as AdvancedSettings["materialExpression"], lightingContrast: settings.lightingContrast as AdvancedSettings["lightingContrast"] };
}

export function parseAdvancedSettingsJson(value: unknown): AdvancedSettings {
  if (value === undefined) return defaultAdvancedSettings;
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw new ApiError(500, "INVALID_PERSISTED_ADVANCED_SETTINGS", "持久化高级设置无法解析。", { field: "advancedSettingsJson" }); }
  }
  return parseAdvancedSettingsObject(decoded);
}

export function safeParseAdvancedSettingsJson(value: unknown): AdvancedSettings {
  return parseAdvancedSettingsJson(value);
}

const advancedReferenceKinds = ["reference", "output"] as const;
const standardReferenceKinds = ["reference"] as const;
const standardSourceKinds = ["source"] as const;
const editableSourceKinds = ["source", "output"] as const;
const floorplanSourceKinds = ["floorplan"] as const;
const selfServiceSourceKinds = ["reference", "source", "output"] as const;

export function sourceAssetKindsForWorkflow(
  workflowType: WorkflowType,
  hasMask: boolean,
  purpose: "preview" | "final" = "final",
  promoted = false,
): readonly AssetKind[] {
  if (purpose === "final" && promoted) return workflowType === "floorplan" ? ["output"] : workflowType === "advanced" || hasMask ? editableSourceKinds : ["source", "output"];
  if (workflowType === "floorplan") return floorplanSourceKinds;
  if (workflowType === "self-service") return selfServiceSourceKinds;
  if (workflowType === "advanced" || hasMask) return editableSourceKinds;
  return standardSourceKinds;
}

export function referenceAssetKindsForWorkflow(
  workflowType: WorkflowType,
): readonly AssetKind[] {
  return workflowType === "advanced"
    ? advancedReferenceKinds
    : standardReferenceKinds;
}

export type CreateJobInput = {
  sourceAssetId: string | null;
  stylePresetId: string;
  designSchemeId: string | null;
  designSchemeProvided: boolean;
  lightingPreset: LightingPreset;
  preservationMode: PreservationMode;
  providerPreference: ProviderPreference;
  workflowType: WorkflowType;
  purpose: JobPurpose;
  effectiveResolution: EffectiveResolution;
  resolution: OutputResolution;
  aspectRatio: OutputAspectRatio;
  quality: OutputQuality;
  visualRealism: VisualRealismLevel;
  lampState: LampState;
  colorTemperatureKelvin: number;
  spaceType: SpaceType;
  referenceAssetId: string | null;
  additionalReferences: AdditionalReference[];
  maskAssetId: string | null;
  depthAssetId: string | null;
  normalAssetId: string | null;
  editInstruction: string | null;
  customPrompt: string | null;
  outputCount: number;
  idempotencyKey: string;
  requestHash: string;
  advancedSettings: AdvancedSettings;
  advancedSettingsProvided: boolean;
  visualRealismProvided: boolean;
  legacyRequestHash: string;
  previousRequestHash: string;
  preSpaceTypeRequestHash: string;
  preSchemeRequestHash: string;
  preV2DefaultSchemeRequestHash: string | null;
  preNeutralStyleRequestHash: string | null;
  preNeutralStylePreSpaceTypeRequestHash: string | null;
  preVisualRealismRequestHash: string;
  preSelfServiceV2RequestHash: string;
  legacyPreviewRequestHash: string;
};

export function parseCreateJobInput(value: unknown): CreateJobInput {
  const body = requireJsonObject(value);
  const workflowType = requireEnum(
    body.workflowType ?? "concept",
    "workflowType",
    workflowTypes,
  );
  const selfService = workflowType === "self-service";
  const spaceType = requireEnum(body.spaceType ?? "unspecified", "spaceType", spaceTypes);
  if (spaceType === "children-room" && workflowType !== "concept") throw new ApiError(400, "INVALID_FIELD", "儿童房仅适用于概念工作台。", { field: "spaceType" });
  if (spaceType !== "unspecified" && (workflowType === "floorplan" || workflowType === "self-service")) throw new ApiError(400, "INVALID_FIELD", "spaceType 仅适用于概念和高级工作台。", { field: "spaceType" });
  const sourceAssetId = body.sourceAssetId == null && selfService ? null : requireString(body.sourceAssetId, "sourceAssetId", { max: 100 });
  const stylePresetId = workflowType === "concept"
    ? requireString(body.stylePresetId, "stylePresetId", { max: 100 })
    : workflowType;
  if (workflowType === "concept" && !getStylePreset(stylePresetId)) {
    throw new ApiError(400, "UNKNOWN_STYLE", "所选设计风格不存在。", {
      field: "stylePresetId",
    });
  }
  const designSchemeProvided = body.designSchemeId !== undefined && body.designSchemeId !== null;
  if (workflowType !== "concept" && designSchemeProvided) throw new ApiError(400, "INVALID_FIELD", "designSchemeId 仅适用于概念工作台。", { field: "designSchemeId" });
  const designSchemeId = workflowType === "concept"
    ? (designSchemeProvided ? requireString(body.designSchemeId, "designSchemeId", { max: 100 }) : (firstV2DesignScheme(stylePresetId) ?? firstDesignScheme(stylePresetId))?.id)
    : null;
  if (workflowType === "concept" && (!designSchemeId || getDesignScheme(designSchemeId)?.styleId !== stylePresetId)) throw new ApiError(400, "UNKNOWN_DESIGN_SCHEME", "所选设计方案不属于当前风格。", { field: "designSchemeId" });

  const lightingPreset = requireEnum(
    body.lightingPreset ?? (selfService ? "noon" : undefined),
    "lightingPreset",
    lightingPresets,
  );
  const preservationMode = requireEnum(
    body.preservationMode ?? (selfService ? "structure" : undefined),
    "preservationMode",
    preservationModes,
  );
  const providerPreference = requireEnum(
    body.providerPreference,
    "providerPreference",
    providerPreferences,
  );
  const purpose = requireEnum(body.purpose ?? "final", "purpose", jobPurposes);
  if (workflowType !== "advanced" && body.advancedSettings !== undefined) {
    throw new ApiError(400, "INVALID_ADVANCED_SETTINGS", "advancedSettings 仅适用于 advanced 工作流。", { field: "advancedSettings" });
  }
  const requestedResolution = requireEnum(
    body.resolution ?? "1K",
    "resolution",
    outputResolutions,
  );
  const resolution: EffectiveResolution = purpose === "preview"
    ? imageModelPreviewResolution(providerPreference)
    : requestedResolution;
  const aspectRatio = requireEnum(
    body.aspectRatio ?? "4:3",
    "aspectRatio",
    outputAspectRatios,
  );
  const requestedQuality = requireEnum(
    body.quality ?? "standard",
    "quality",
    outputQualities,
  );
  if (!imageModelSupportsQuality(providerPreference, requestedQuality)) throw new ApiError(400, "PROVIDER_QUALITY_UNSUPPORTED", "当前模型不支持所选质量档位。", { field: "quality" });
  const quality = purpose === "preview" ? "draft" : requestedQuality;
  const visualRealismProvided = body.visualRealism !== undefined;
  if (visualRealismProvided && workflowType !== "concept" && workflowType !== "advanced") {
    throw new ApiError(400, "INVALID_FIELD", "visualRealism 仅适用于 concept 或 advanced 工作流。", { field: "visualRealism" });
  }
  const visualRealism = requireEnum(
    body.visualRealism ?? "photorealistic",
    "visualRealism",
    visualRealismLevels,
  ) as VisualRealism;
  const lampState = requireEnum(
    body.lampState ?? "mixed",
    "lampState",
    lampStates,
  );
  const colorTemperatureKelvin =
    body.colorTemperatureKelvin === undefined
      ? 4000
      : body.colorTemperatureKelvin;
  if (
    typeof colorTemperatureKelvin !== "number" ||
    !Number.isInteger(colorTemperatureKelvin) ||
    colorTemperatureKelvin < 2700 ||
    colorTemperatureKelvin > 6500
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "colorTemperatureKelvin 必须是2700到6500之间的整数。",
      { field: "colorTemperatureKelvin", min: 2700, max: 6500 },
    );
  }
  const referenceAssetId = optionalString(
    body.referenceAssetId,
    "referenceAssetId",
    100,
  );
  const additionalReferences = parseAdditionalReferences(body.additionalReferences, workflowType, {
    model: providerPreference,
    purpose,
    reservePreviewSlot: selfService && sourceAssetId === null,
  });
  if (referenceAssetId && additionalReferences.some((reference) => reference.assetId === referenceAssetId)) {
    throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", "风格参考图不能同时作为附加参考图。", { field: "additionalReferences" });
  }
  const maskAssetId = optionalString(body.maskAssetId, "maskAssetId", 100);
  const depthAssetId = optionalString(body.depthAssetId, "depthAssetId", 100);
  const normalAssetId = optionalString(body.normalAssetId, "normalAssetId", 100);
  if (workflowType !== "advanced" && (depthAssetId || normalAssetId)) throw new ApiError(400, "INVALID_CONTROLS", "深度图和法线图仅适用于高级工作台。", { field: "depthAssetId" });
  const assetIds = [sourceAssetId, referenceAssetId, ...additionalReferences.map((entry) => entry.assetId), maskAssetId, depthAssetId, normalAssetId].filter((id): id is string => Boolean(id));
  if (new Set(assetIds).size !== assetIds.length) throw new ApiError(400, "INVALID_FIELD", "source、参考图、蒙版和控制图不能重复使用同一资产。", { field: "assetId" });
  const editInstruction = optionalString(
    body.editInstruction,
    "editInstruction",
    500,
  );
  const ignoreLocalPrompt = editInstruction?.startsWith("local-edit:v2:") && !localEditUsesPrompt(editInstruction);
  const promptValue = ignoreLocalPrompt ? null : body.customPrompt;
  const customPromptProvided = body.customPrompt !== undefined && body.customPrompt !== null;
  if (typeof promptValue === "string" && promptValue.length > 2000) {
    throw new ApiError(400, "INVALID_FIELD", "customPrompt 长度必须在 1 到 2000 个字符之间。", { field: "customPrompt" });
  }
  const customPrompt = typeof promptValue === "string"
    ? promptValue.trim() || null
    : optionalString(promptValue, "customPrompt", 2000);
  if (editInstruction === "local-edit:v2:prompt" && !customPrompt) throw new ApiError(400, "CUSTOM_PROMPT_REQUIRED", "提示词修改必须填写提示词。");
  if (selfService && !customPrompt) {
    throw new ApiError(400, "CUSTOM_PROMPT_REQUIRED", "自助工作台必须填写提示词。", {
      field: "customPrompt",
    });
  }
  if (workflowType !== "self-service" && workflowType !== "advanced" && customPromptProvided) {
    throw new ApiError(400, "CUSTOM_PROMPT_NOT_ALLOWED", "customPrompt 仅适用于高级或自助工作台。", {
      field: "customPrompt",
    });
  }
  const selection = additionalReferences.some((entry) => entry.role === "selection");
  const bareShell = isBareShellInstruction(editInstruction);
  if (bareShell && (workflowType !== "advanced" || purpose !== "final" || !sourceAssetId || maskAssetId || depthAssetId || normalAssetId || referenceAssetId || additionalReferences.length || customPromptProvided)) {
    throw new ApiError(400, "INVALID_BARE_SHELL", "毛坯还原只接受一张现场照片，不接受参考图、结构参考图、局部标注或提示词。");
  }
  if (selection && (purpose !== "final" || maskAssetId || depthAssetId || normalAssetId || referenceAssetId || !validLocalEdit(workflowType, ["source", ...additionalReferences.map((entry) => entry.role)], editInstruction))) {
    throw new ApiError(400, "INVALID_LOCAL_EDIT", "局部修改仅支持正式输出，需要一张标注图、有效操作和最多三张局部参考，不接受整屋参考或控制图。");
  }
  if ((maskAssetId && !editInstruction) || (!maskAssetId && editInstruction && !selection && !bareShell)) {
    throw new ApiError(
      400,
      "INCOMPLETE_LOCAL_EDIT",
      "局部修改必须同时提供 maskAssetId 和 editInstruction。",
    );
  }
  if (workflowType === "floorplan" && (maskAssetId || depthAssetId || normalAssetId)) {
    throw new ApiError(
      400,
      "INVALID_FLOORPLAN_CONTROLS",
      "彩色概念平面图工作流不接受蒙版、深度图或法线图。",
    );
  }
  if (selfService && (referenceAssetId || maskAssetId || depthAssetId || normalAssetId || editInstruction)) {
    throw new ApiError(
      400,
      "INVALID_SELF_SERVICE_CONTROLS",
      "自助工作台当前只接受一张参考图或多张有序参考图、提示词和图像质量；不接受风格槽位、蒙版或结构控制图。",
    );
  }

  if (
    typeof body.outputCount !== "number" ||
    !Number.isInteger(body.outputCount) ||
    body.outputCount < 1 ||
    body.outputCount > 4
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "outputCount 必须是 1 到 4 的整数。",
      { field: "outputCount", min: 1, max: 4 },
    );
  }
  const idempotencyKey = requireString(
    body.idempotencyKey,
    "idempotencyKey",
    { min: 8, max: 128 },
  );
  const advancedSettingsProvided = body.advancedSettings !== undefined;
  const advancedSettings = parseAdvancedSettingsObject(body.advancedSettings);
  const canonicalOutputCount = purpose === "preview" ? 1 : body.outputCount;

  const legacyNormalized = {
    sourceAssetId,
    stylePresetId,
    lightingPreset,
    preservationMode,
    providerPreference,
    workflowType,
    resolution: requestedResolution,
    aspectRatio,
    quality: requestedQuality,
    lampState,
    colorTemperatureKelvin,
    referenceAssetId,
    maskAssetId,
    depthAssetId,
    normalAssetId,
    editInstruction,
    customPrompt,
    outputCount: body.outputCount,
    idempotencyKey,
  };
  const normalizedWithoutSpaceType = {
    ...legacyNormalized,
    additionalReferences,
    ...(selfService ? {
      contractVersion: "self-service-v2",
      inputMode: sourceAssetId || additionalReferences.length ? "image" : "text",
    } : {}),
    purpose,
    quality,
    outputCount: canonicalOutputCount,
    advancedSettings,
    visualRealism,
    effectiveResolution: resolution,
  };
  const normalized = {
    ...normalizedWithoutSpaceType,
    ...((workflowType === "concept" || workflowType === "advanced") ? { spaceType } : {}),
    ...(workflowType === "concept" ? { designSchemeId } : {}),
  };
  const legacyStyleId = (workflowType === "advanced" || workflowType === "floorplan") && typeof body.stylePresetId === "string" && getStylePreset(body.stylePresetId) && !customPrompt && !designSchemeProvided
    ? body.stylePresetId
    : null;
  const preNeutralStyleWithoutSpaceType = legacyStyleId ? { ...normalizedWithoutSpaceType, stylePresetId: legacyStyleId } : null;
  const preNeutralStyleNormalized = preNeutralStyleWithoutSpaceType
    ? { ...preNeutralStyleWithoutSpaceType, ...(workflowType === "advanced" ? { spaceType } : {}) }
    : null;
  const preAdditionalReferencesNormalized = {
    ...legacyNormalized,
    purpose,
    quality,
    outputCount: canonicalOutputCount,
    advancedSettings,
    visualRealism,
    effectiveResolution: purpose === "preview" ? "1K" : resolution,
  };
  const preSelfServiceV2Normalized = {
    ...legacyNormalized,
    additionalReferences,
    purpose,
    quality,
    outputCount: canonicalOutputCount,
    advancedSettings,
    visualRealism,
    effectiveResolution: resolution,
  };
  return {
    ...normalized,
    spaceType,
    designSchemeId: designSchemeId ?? null,
    designSchemeProvided,
    requestHash: createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex"),
    preSchemeRequestHash: createHash("sha256").update(JSON.stringify({ ...normalizedWithoutSpaceType, ...((workflowType === "concept" || workflowType === "advanced") ? { spaceType } : {}) })).digest("hex"),
    preV2DefaultSchemeRequestHash: workflowType === "concept" && !designSchemeProvided && firstLegacyDesignScheme(stylePresetId) ? createHash("sha256").update(JSON.stringify({ ...normalized, designSchemeId: firstLegacyDesignScheme(stylePresetId)?.id })).digest("hex") : null,
    preNeutralStyleRequestHash: preNeutralStyleNormalized ? createHash("sha256").update(JSON.stringify(preNeutralStyleNormalized)).digest("hex") : null,
    preNeutralStylePreSpaceTypeRequestHash: preNeutralStyleWithoutSpaceType && spaceType === "unspecified" ? createHash("sha256").update(JSON.stringify(preNeutralStyleWithoutSpaceType)).digest("hex") : null,
    advancedSettingsProvided,
    visualRealismProvided,
    legacyRequestHash: createHash("sha256").update(JSON.stringify(legacyNormalized)).digest("hex"),
    previousRequestHash: createHash("sha256").update(JSON.stringify({ ...legacyNormalized, advancedSettings })).digest("hex"),
    preSpaceTypeRequestHash: createHash("sha256").update(JSON.stringify(normalizedWithoutSpaceType)).digest("hex"),
    preVisualRealismRequestHash: createHash("sha256").update(JSON.stringify({ ...normalizedWithoutSpaceType, visualRealism: undefined })).digest("hex"),
    preSelfServiceV2RequestHash: createHash("sha256").update(JSON.stringify(preSelfServiceV2Normalized)).digest("hex"),
    legacyPreviewRequestHash: createHash("sha256").update(JSON.stringify(preAdditionalReferencesNormalized)).digest("hex"),
  };
}

const additionalReferenceLimits: Record<WorkflowType, Partial<Record<AdditionalReferenceRole, number>>> = {
  concept: { furnishing: 14 },
  advanced: { selection: 1, furnishing: 14, structure: 1, material: 1, "lighting-color": 1, composition: 1 },
  floorplan: { structure: 14 },
  "self-service": { reference: 14 },
};
const additionalReferenceRoleOrder = new Map(additionalReferenceRoles.map((role, index) => [role, index]));

function parseAdditionalReferences(value: unknown, workflowType: WorkflowType, context?: { model?: ProviderPreference; purpose?: JobPurpose; reservePreviewSlot?: boolean }): AdditionalReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", "additionalReferences 必须是数组。", { field: "additionalReferences" });
  const result: AdditionalReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", "参考图条目格式无效。", { field: "additionalReferences" });
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).find((key) => key !== "assetId" && key !== "role");
    if (unknown) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", `additionalReferences 不允许未知字段 ${unknown}。`, { field: "additionalReferences" });
    const assetId = requireString(record.assetId, "additionalReferences.assetId", { max: 100 });
    const role = requireEnum(record.role, "additionalReferences.role", additionalReferenceRoles);
    if (seen.has(assetId)) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", "additionalReferences 不允许重复资产。", { field: "additionalReferences" });
    const limit = workflowType === "self-service" && role === "reference" && context?.model && context.purpose
      ? imageModelMaxReferences(context.model, context.purpose, context.reservePreviewSlot !== false)
      : additionalReferenceLimits[workflowType][role];
    if (!limit) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", `当前工作流不支持 ${role} 参考图。`, { field: "additionalReferences" });
    const count = result.filter((entry) => entry.role === role).length;
    if (count >= limit) throw new ApiError(400, "INVALID_ADDITIONAL_REFERENCES", `${role} 参考图最多${limit}张。`, { field: "additionalReferences" });
    seen.add(assetId);
    result.push({ assetId, role });
  }
  return workflowType === "self-service" ? result : result.sort((left, right) => (additionalReferenceRoleOrder.get(left.role) ?? 0) - (additionalReferenceRoleOrder.get(right.role) ?? 0));
}

export function parseAdditionalReferencesJson(value: unknown, workflowType: WorkflowType): AdditionalReference[] {
  if (value === undefined || value === null || value === "") return [];
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new ApiError(500, "INVALID_PERSISTED_REFERENCES", "任务中的参考图配置无法解析。", { field: "additionalReferencesJson" }); }
  try { return parseAdditionalReferences(parsed, workflowType); } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw new ApiError(500, "INVALID_PERSISTED_REFERENCES", "任务中的参考图配置无效。", { field: "additionalReferencesJson" });
    throw error;
  }
}

export function isCompatibleReplayHash(input: {
  requestHash: string; previousRequestHash: string; legacyRequestHash: string; purpose: JobPurpose;
  advancedSettingsProvided: boolean; additionalReferences?: AdditionalReference[];
  preVisualRealismRequestHash?: string; preSelfServiceV2RequestHash?: string;
  visualRealismProvided?: boolean; legacyPreviewRequestHash?: string;
  workflowType?: WorkflowType; sourceAssetId?: string | null; spaceType?: SpaceType;
  designSchemeId?: string | null; designSchemeProvided?: boolean;
  preSpaceTypeRequestHash?: string;
  preSchemeRequestHash?: string;
  preV2DefaultSchemeRequestHash?: string | null;
  preNeutralStyleRequestHash?: string | null; preNeutralStylePreSpaceTypeRequestHash?: string | null;
}, existingHash: string): boolean {
  if (existingHash === input.requestHash) return true;
  if ((input.workflowType === "advanced" || input.workflowType === "floorplan") && (existingHash === input.preNeutralStyleRequestHash || existingHash === input.preNeutralStylePreSpaceTypeRequestHash)) return true;
  if (input.designSchemeProvided) return false;
  if (input.workflowType === "concept" && input.preV2DefaultSchemeRequestHash === existingHash) return true;
  if (input.workflowType === "concept" && input.preSchemeRequestHash === existingHash) return true;
  if (input.spaceType && input.spaceType !== "unspecified") return false;
  if (input.spaceType === "unspecified" && input.preSpaceTypeRequestHash === existingHash) return true;
  if (input.workflowType === "self-service") {
    return Boolean(input.sourceAssetId && !input.additionalReferences?.length && input.preSelfServiceV2RequestHash === existingHash);
  }
  if (input.additionalReferences?.length) return false;
  return (!input.visualRealismProvided && input.preVisualRealismRequestHash !== undefined && existingHash === input.preVisualRealismRequestHash)
    || (input.purpose === "preview" && input.legacyPreviewRequestHash !== undefined && existingHash === input.legacyPreviewRequestHash)
    || (input.purpose === "final" && !input.visualRealismProvided && (existingHash === input.previousRequestHash || (!input.advancedSettingsProvided && existingHash === input.legacyRequestHash)));
}

export function assertAssetKind(
  asset: PersistedAsset | null,
  expectedKind: AssetKind | readonly AssetKind[],
  field: string,
): asserts asset is PersistedAsset {
  if (!asset) {
    throw new ApiError(404, "ASSET_NOT_FOUND", `${field} 对应的图片不存在。`, {
      field,
    });
  }
  const expectedKinds = Array.isArray(expectedKind)
    ? expectedKind
    : [expectedKind];
  if (!expectedKinds.includes(asset.kind)) {
    throw new ApiError(
      400,
      "ASSET_KIND_MISMATCH",
      `${field} 的图片类型不正确。`,
      { field, expectedKind: expectedKinds },
    );
  }
  if (asset.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) {
    throw new ApiError(
      409,
      "ASSET_SANITIZATION_REQUIRED",
      `${field} 对应的历史图片需要重新上传后才能用于生成。`,
      { field },
    );
  }
  if (asset.moderationStatus === "REJECTED") {
    throw new ApiError(409, "ASSET_REJECTED", `${field} 对应的图片不可用于生成。`, { field });
  }
}
