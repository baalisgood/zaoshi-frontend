import assert from "node:assert/strict";
import test from "node:test";
import { isCompatibleReplayHash, parseCreateJobInput } from "@/lib/server/job-contract";
import { sourceAssetKindsForWorkflow } from "@/lib/server/job-contract";
import { readFile } from "node:fs/promises";
import { compileInteriorPrompt } from "@/lib/ai/prompt";
import { getStylePreset } from "@/lib/ai";
import { chooseFinalizeAttemptKey } from "@/components/studio/useGenerationJob";
import { normalizeKnownDomesticImageModel } from "@/lib/domain/domestic-image-models";

test("template contract preserves outputCount and rejects asset identity fields", async () => {
  const source = await readFile(new URL("../../lib/server/templates.ts", import.meta.url), "utf8");
  assert.match(source, /outputCount/);
  assert.match(source, /endsWith\("AssetId"\)/);
  assert.match(source, /config:\s*canonicalizeStoredTemplateConfig\(JSON\.parse/u);
  assert.match(source, /\.map\(canonicalizeRow\)/u);
});

test("stored templates migrate known legacy aliases without rewriting unknown values", () => {
  assert.equal(normalizeKnownDomesticImageModel("seedream"), "doubao-seedream-5-0-pro-260628");
  assert.equal(normalizeKnownDomesticImageModel("qwen"), "qwen-image-3.0-pro");
  assert.equal(normalizeKnownDomesticImageModel("doubao-seedream-5-0-lite-260128"), undefined);
  assert.equal(normalizeKnownDomesticImageModel("unknown-model"), undefined);
});

test("self-service templates keep prompt text but never image identity", async () => {
  const [source, studio, taskList] = await Promise.all([
    readFile(new URL("../../lib/server/templates.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/studio/SelfServiceStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/studio/StudioTaskList.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /allowed = new Set\([^\n]*"customPrompt"/u);
  assert.match(source, /config\.customPrompt[\s\S]*workflowType !== "self-service" && workflowType !== "advanced"[\s\S]*2000/u);
  assert.match(source, /sourceAssetId[\s\S]*key\.endsWith\("AssetId"\)/u);
  assert.match(source, /Object\.keys\(item\)[\s\S]*key !== "role"[\s\S]*delete sharedConfig\.customPrompt/u);
  assert.doesNotMatch(studio, /TemplateProvider|TemplateQuickPicker|SaveTemplateAction/u);
  assert.match(studio, /useStudioParameterDraft[\s\S]*applyConfig/u);
  assert.match(taskList, /job\.workflowType === "concept" \? job\.stylePresetId : undefined/u);
});

test("preview purpose canonicalizes draft and provider effective resolution", () => {
  const input = parseCreateJobInput({ sourceAssetId: "src", stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure", providerPreference: "doubao-seedream-5-0-pro-260628", workflowType: "concept", outputCount: 3, resolution: "4K", quality: "high", idempotencyKey: "preview-key-123" });
  assert.equal(input.purpose, "final");
  const preview = parseCreateJobInput({ sourceAssetId: "src", stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure", providerPreference: "doubao-seedream-5-0-pro-260628", workflowType: "concept", purpose: "preview", outputCount: 1, resolution: "4K", quality: "high", idempotencyKey: "preview-key-456" });
  assert.equal(preview.effectiveResolution, "2K");
  assert.equal(preview.quality, "draft");
});

test("prompt distinguishes promoted preview from ordinary style reference", () => {
  const style = getStylePreset("modern-minimalist"); assert.ok(style);
  const base = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const, resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 }, renovationScope: "restyle" as const, outputCount: 1 };
  assert.match(compileInteriorPrompt({ ...base, referenceImages: [base.sourceImage] }, style).text, /style-reference|style-reference image/i);
  assert.match(compileInteriorPrompt({ ...base, purpose: "final", promotedFromPreview: true, referenceImages: [base.sourceImage] }, style).text, /final high-definition regeneration/i);
});

test("legacy replay compatibility accepts previous hashes but not changed requests", () => {
  const base = { requestHash: "current", previousRequestHash: "old-v2", legacyRequestHash: "old-v1", advancedSettingsProvided: false, purpose: "final" as const };
  assert.equal(isCompatibleReplayHash(base, "old-v2"), true);
  assert.equal(isCompatibleReplayHash(base, "old-v1"), true);
  assert.equal(isCompatibleReplayHash({ ...base, advancedSettingsProvided: true }, "old-v1"), false);
  assert.equal(isCompatibleReplayHash({ ...base, purpose: "preview" }, "old-v2"), false);
  assert.equal(isCompatibleReplayHash({ ...base, purpose: "preview" }, "old-v1"), false);
  assert.equal(isCompatibleReplayHash({ ...base, purpose: "preview", requestHash: "preview-current" }, "preview-current"), true);
  assert.equal(isCompatibleReplayHash(base, "changed"), false);
});

test("finalize attempt key preserves unknown retries and rotates confirmed failures", () => {
  assert.equal(chooseFinalizeAttemptKey("base", undefined, undefined, false), "base");
  assert.equal(chooseFinalizeAttemptKey("base", "base", "attempt", false), "attempt");
  assert.notEqual(chooseFinalizeAttemptKey("base", "base", "attempt", true), "attempt");
  assert.equal(chooseFinalizeAttemptKey("new", "base", "attempt", false), "new");
});

test("promoted floorplan final accepts output while ordinary floorplan stays strict", () => {
  assert.deepEqual(sourceAssetKindsForWorkflow("floorplan", false, "preview", false), ["floorplan"]);
  assert.deepEqual(sourceAssetKindsForWorkflow("floorplan", false, "final", true), ["output"]);
  assert.equal(sourceAssetKindsForWorkflow("concept", false, "preview", false).includes("output"), false);
});
