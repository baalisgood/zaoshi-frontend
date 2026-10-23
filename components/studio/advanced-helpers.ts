import { localEditInstruction, type LocalEditOperation } from "@/lib/domain/local-edit";

export type VisionArtifactLike = { artifactType?: string; kind?: string };
export type VisionClassification<T extends VisionArtifactLike> = {
  depth?: T;
  normal?: T;
  state: "complete" | "partial" | "empty";
};

export function classifyVisionArtifacts<T extends VisionArtifactLike>(existing: { depth?: T; normal?: T }, artifacts: T[]): VisionClassification<T> {
  const depth = artifacts.find((item) => item.artifactType === "depth" || item.kind === "depth");
  const normal = artifacts.find((item) => item.artifactType === "normal" || item.kind === "normal");
  return {
    depth: depth ?? existing.depth,
    normal: normal ?? existing.normal,
    state: depth && normal ? "complete" : depth || normal ? "partial" : "empty",
  };
}

export type AdvancedSettingsLike = {
  version: 1;
  geometryFidelity: "strict" | "balanced";
  cameraPolicy: "locked" | "correct-verticals";
  furnishingDensity: "sparse" | "balanced" | "layered";
  materialExpression: "clean" | "natural" | "tactile";
  lightingContrast: "soft" | "balanced" | "dramatic";
};

export function mergeAdvancedSettings<T extends AdvancedSettingsLike>(current: T, incoming: unknown): T {
  if (!incoming || typeof incoming !== "object") return current;
  const value = incoming as Record<string, unknown>;
  return {
    ...current,
    ...(value.geometryFidelity === "strict" || value.geometryFidelity === "balanced" ? { geometryFidelity: value.geometryFidelity } : {}),
    ...(value.cameraPolicy === "locked" || value.cameraPolicy === "correct-verticals" ? { cameraPolicy: value.cameraPolicy } : {}),
    ...(value.furnishingDensity === "sparse" || value.furnishingDensity === "balanced" || value.furnishingDensity === "layered" ? { furnishingDensity: value.furnishingDensity } : {}),
    ...(value.materialExpression === "clean" || value.materialExpression === "natural" || value.materialExpression === "tactile" ? { materialExpression: value.materialExpression } : {}),
    ...(value.lightingContrast === "soft" || value.lightingContrast === "balanced" || value.lightingContrast === "dramatic" ? { lightingContrast: value.lightingContrast } : {}),
  } as T;
}

export type AdvancedControlMode = "none" | "depth" | "depth-normal";
export type AdvancedGenerationPayloadInput = {
  localEdit?: { operation: LocalEditOperation; sourceAssetId: string; annotationAssetId: string; referenceAssetIds: string[] };
  workflowType: "advanced";
  purpose: "preview" | "final";
  sourceAssetId: string;
  customPrompt?: string;
  lightingPreset: string;
  preservationMode: string;
  providerPreference: string;
  referenceAssetId?: string;
  additionalReferences?: { assetId: string; role: "furnishing" | "structure" | "material" | "lighting-color" | "composition" }[];
  depthAssetId?: string;
  normalAssetId?: string;
  controlMode: AdvancedControlMode;
  outputCount: number;
  advancedSettings: AdvancedSettingsLike;
  resolution: string;
  aspectRatio: string;
  quality: string;
  visualRealism?: "conceptual" | "rendered" | "realistic" | "photorealistic";
  lampState: string;
  colorTemperatureKelvin: number;
  spaceType?: string;
  billingMode?: "private-test-reservation";
  expectedPriceVersion: string;
  expectedTotalCredits: number;
  idempotencyKey: string;
};

/** Builds the Advanced API contract; only uploaded, role-labelled assets are included. */
export function buildAdvancedGenerationPayload(input: AdvancedGenerationPayloadInput): Record<string, unknown> {
  const { controlMode, depthAssetId, normalAssetId } = input;
  if (input.localEdit) {
    const local = input.localEdit;
    if (local.referenceAssetIds.length > 3) throw new Error("局部参考图最多三张。");
    return {
      workflowType: "advanced", purpose: input.purpose, sourceAssetId: local.sourceAssetId,
      additionalReferences: [{ assetId: local.annotationAssetId, role: "selection" }, ...local.referenceAssetIds.map((assetId) => ({ assetId, role: "furnishing" }))],
      editInstruction: localEditInstruction(local.operation), customPrompt: local.operation === "prompt" ? input.customPrompt ?? "" : "",
      lightingPreset: "noon", preservationMode: "structure", spaceType: "unspecified",
      providerPreference: input.providerPreference, resolution: input.resolution, aspectRatio: input.aspectRatio, quality: input.quality, outputCount: input.outputCount,
      ...(input.billingMode ? { billingMode: input.billingMode } : {}),
      expectedPriceVersion: input.expectedPriceVersion, expectedTotalCredits: input.expectedTotalCredits, idempotencyKey: input.idempotencyKey,
    };
  }
  return {
    workflowType: input.workflowType,
    purpose: input.purpose,
    sourceAssetId: input.sourceAssetId,
    customPrompt: input.customPrompt ?? "",
    lightingPreset: input.lightingPreset,
    preservationMode: input.preservationMode,
    providerPreference: input.providerPreference,
    ...(input.referenceAssetId ? { referenceAssetId: input.referenceAssetId } : {}),
    ...(input.additionalReferences?.length ? { additionalReferences: input.additionalReferences } : {}),
    outputCount: input.outputCount,
    advancedSettings: input.advancedSettings,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    quality: input.quality,
    ...(input.visualRealism ? { visualRealism: input.visualRealism } : {}),
    lampState: input.lampState,
    colorTemperatureKelvin: input.colorTemperatureKelvin,
    spaceType: input.spaceType ?? "living-room",
    ...(input.billingMode ? { billingMode: input.billingMode } : {}),
    expectedPriceVersion: input.expectedPriceVersion,
    expectedTotalCredits: input.expectedTotalCredits,
    idempotencyKey: input.idempotencyKey,
    ...(controlMode !== "none" && depthAssetId ? { depthAssetId } : {}),
    ...(controlMode === "depth-normal" && normalAssetId ? { normalAssetId } : {}),
  };
}
