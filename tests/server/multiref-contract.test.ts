import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isCompatibleReplayHash, parseAdditionalReferencesJson, parseCreateJobInput } from "@/lib/server/job-contract";

const base = {
  sourceAssetId: "source",
  stylePresetId: "modern-minimalist",
  lightingPreset: "noon",
  preservationMode: "structure",
  providerPreference: "doubao-seedream-5-0-pro-260628",
  workflowType: "concept",
  outputCount: 1,
  resolution: "2K",
  aspectRatio: "4:3",
  quality: "standard",
  idempotencyKey: "multiref-key",
};

test("additional reference roles are workflow-scoped and canonicalized", () => {
  const parsed = parseCreateJobInput({
    ...base,
    additionalReferences: [
      { assetId: "furnishing-2", role: "furnishing" },
      { assetId: "furnishing-1", role: "furnishing" },
    ],
  });
  assert.deepEqual(parsed.additionalReferences, [
    { assetId: "furnishing-2", role: "furnishing" },
    { assetId: "furnishing-1", role: "furnishing" },
  ]);
  assert.throws(() => parseCreateJobInput({ ...base, additionalReferences: [{ assetId: "x", role: "structure" }] }), /当前工作流不支持/u);
  assert.throws(() => parseCreateJobInput({ ...base, additionalReferences: [{ assetId: "x", role: "furnishing" }, { assetId: "x", role: "furnishing" }] }), /重复资产/u);
  assert.throws(() => parseCreateJobInput({ ...base, additionalReferences: [{ assetId: "x".repeat(101), role: "furnishing" }] }), /100/u);
  assert.throws(() => parseCreateJobInput({ ...base, additionalReferences: [{ assetId: "x", role: "furnishing", extra: true }] }), /未知字段/u);
  const advanced = parseCreateJobInput({ ...base, workflowType: "advanced", additionalReferences: [{ assetId: "s", role: "structure" }, { assetId: "m", role: "material" }, { assetId: "l", role: "lighting-color" }, { assetId: "c", role: "composition" }] });
  assert.equal(advanced.additionalReferences.length, 4);
  const floorplan = parseCreateJobInput({ ...base, workflowType: "floorplan", stylePresetId: "modern-minimalist", additionalReferences: [{ assetId: "s", role: "structure" }] });
  assert.equal(floorplan.additionalReferences[0]?.role, "structure");
  const selfService = parseCreateJobInput({ ...base, workflowType: "self-service", customPrompt: "把空间变成自然风", additionalReferences: undefined });
  assert.deepEqual(selfService.additionalReferences, []);
  assert.throws(() => parseCreateJobInput({ ...base, workflowType: "self-service", customPrompt: "x", additionalReferences: [{ assetId: "x", role: "furnishing" }] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ADDITIONAL_REFERENCES");
  assert.throws(() => parseCreateJobInput({ ...base, additionalReferences: Array.from({ length: 15 }, (_, index) => ({ assetId: `f-${index}`, role: "furnishing" })) }), /最多14张/u);
  assert.throws(() => parseCreateJobInput({ ...base, workflowType: "floorplan", additionalReferences: Array.from({ length: 15 }, (_, index) => ({ assetId: `s-${index}`, role: "structure" })) }), /最多14张/u);
  assert.throws(() => parseCreateJobInput({ ...base, workflowType: "advanced", additionalReferences: [{ assetId: "s-1", role: "structure" }, { assetId: "s-2", role: "structure" }] }), /最多1张/u);
});

test("persisted additional references reject malformed JSON and preserve empty legacy rows", () => {
  assert.deepEqual(parseAdditionalReferencesJson(undefined, "concept"), []);
  assert.throws(() => parseAdditionalReferencesJson("{broken", "concept"), /无法解析/u);
  assert.throws(() => parseAdditionalReferencesJson(JSON.stringify([{ assetId: "x", role: "structure" }]), "concept"), /无效/u);
});

test("non-empty additional references never replay against an older hash", () => {
  const withReference = parseCreateJobInput({ ...base, additionalReferences: [{ assetId: "f", role: "furnishing" }] });
  assert.equal(isCompatibleReplayHash(withReference, withReference.requestHash), true);
  assert.equal(isCompatibleReplayHash(withReference, withReference.legacyRequestHash), false);
  assert.equal(isCompatibleReplayHash(withReference, withReference.previousRequestHash), false);
});

test("legacy Seedream preview hash without additionalReferences remains replayable", () => {
  const input = parseCreateJobInput({ ...base, purpose: "preview", resolution: "4K", quality: "high", visualRealism: "realistic" });
  const oldShape = {
    sourceAssetId: input.sourceAssetId, stylePresetId: input.stylePresetId, lightingPreset: input.lightingPreset,
    preservationMode: input.preservationMode, providerPreference: input.providerPreference, workflowType: input.workflowType,
    resolution: input.resolution, aspectRatio: input.aspectRatio, quality: "draft", lampState: input.lampState,
    colorTemperatureKelvin: input.colorTemperatureKelvin, referenceAssetId: input.referenceAssetId, maskAssetId: input.maskAssetId,
    depthAssetId: input.depthAssetId, normalAssetId: input.normalAssetId, editInstruction: input.editInstruction,
    customPrompt: input.customPrompt, outputCount: 1, idempotencyKey: input.idempotencyKey, purpose: "preview",
    advancedSettings: input.advancedSettings, visualRealism: input.visualRealism, effectiveResolution: "1K",
  };
  const oldHash = createHash("sha256").update(JSON.stringify(oldShape)).digest("hex");
  assert.equal(isCompatibleReplayHash(input, oldHash), true);
  const withReference = parseCreateJobInput({ ...base, purpose: "preview", resolution: "4K", quality: "high", visualRealism: "realistic", additionalReferences: [{ assetId: "f", role: "furnishing" }] });
  assert.equal(isCompatibleReplayHash(withReference, oldHash), false);
});
