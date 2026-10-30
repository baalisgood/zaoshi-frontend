import assert from "node:assert/strict";
import test from "node:test";
import { parseAdvancedSettingsJson, parseCreateJobInput } from "../../lib/server/job-contract";
import { compileInteriorPrompt } from "../../lib/ai/prompt";
import { getStylePreset } from "../../lib/ai/styles";
import { mapPreservation } from "../../lib/server/job-contract";

const base = {
  sourceAssetId: "asset_source",
  stylePresetId: "modern-minimalist",
  lightingPreset: "noon",
  preservationMode: "structure",
  providerPreference: "doubao-seedream-5-0-pro-260628",
  workflowType: "advanced",
  outputCount: 1,
  idempotencyKey: "advanced-settings-test",
};

test("advanced settings default, strict validation and hash participation", () => {
  const first = parseCreateJobInput(base);
  assert.equal(first.advancedSettings.version, 1);
  assert.equal(first.advancedSettings.geometryFidelity, "balanced");
  const second = parseCreateJobInput({ ...base, advancedSettings: { ...first.advancedSettings, geometryFidelity: "strict" } });
  assert.notEqual(first.requestHash, second.requestHash);
  assert.throws(() => parseCreateJobInput({ ...base, advancedSettings: { ...first.advancedSettings, cameraPolicy: "invalid" } }), /不受支持/u);
  assert.throws(() => parseCreateJobInput({ ...base, workflowType: "concept", advancedSettings: first.advancedSettings }), /仅适用于 advanced/u);
});

test("persisted advanced settings parse strings, default undefined, and reject corruption", () => {
  const custom = { version: 1, geometryFidelity: "strict", cameraPolicy: "locked", furnishingDensity: "layered", materialExpression: "tactile", lightingContrast: "dramatic" } as const;
  assert.deepEqual(parseAdvancedSettingsJson(JSON.stringify(custom)), custom);
  assert.equal(parseAdvancedSettingsJson(undefined).geometryFidelity, "balanced");
  assert.throws(() => parseAdvancedSettingsJson("{broken"), /无法解析/u);
  assert.throws(() => parseCreateJobInput({ ...base, advancedSettings: JSON.stringify(custom) }), /对象/u);
});

test("ordinary concept prompt remains unchanged by advanced settings", () => {
  const request = {
    sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const,
    resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const,
    style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 },
    renovationScope: "replace-soft-furnishings" as const, outputCount: 1,
  };
  const prompt = compileInteriorPrompt(request, getStylePreset("modern-minimalist")!);
  assert.doesNotMatch(prompt.text, /Advanced studio direction|maximum fidelity/u);
});

test("preservation mapping keeps historical concept and advanced task semantics", () => {
  assert.equal(mapPreservation("structure", "concept"), "replace-soft-furnishings");
  assert.equal(mapPreservation("furniture", "concept"), "restyle");
  assert.equal(mapPreservation("structure", "advanced"), "restyle");
  assert.equal(mapPreservation("furniture", "advanced"), "replace-soft-furnishings");
});

test("advanced settings compile to internal English directions only", () => {
  const prompt = compileInteriorPrompt({
    sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" },
    workflowType: "advanced", resolution: "1K", aspectRatio: "4:3", quality: "standard",
    style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 },
    renovationScope: "restyle", outputCount: 1,
    advancedSettings: { version: 1, geometryFidelity: "strict", cameraPolicy: "correct-verticals", furnishingDensity: "layered", materialExpression: "tactile", lightingContrast: "dramatic" },
  }, getStylePreset("modern-minimalist")!);
  for (const phrase of ["maximum fidelity", "correct converging verticals", "layered", "tactile", "dramatic"]) assert.match(prompt.text, new RegExp(phrase, "u"));
  assert.match(prompt.text, /allow only minimal optical correction of converging verticals/u);
  assert.doesNotMatch(prompt.text, /Lock the original camera viewpoint, direction, perspective/u);
  assert.doesNotMatch(prompt.text, /advancedSettings|geometryFidelity|cameraPolicy/u);
});
