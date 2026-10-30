import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvancedGenerationPayload, classifyVisionArtifacts, mergeAdvancedSettings } from "../../components/studio/advanced-helpers";

const image = (kind: string, id: string) => ({ kind, id });
const settings = { version: 1 as const, geometryFidelity: "balanced" as const, cameraPolicy: "locked" as const, furnishingDensity: "balanced" as const, materialExpression: "natural" as const, lightingContrast: "balanced" as const };
const payloadInput = (controlMode: "none" | "depth" | "depth-normal") => ({ workflowType: "advanced" as const, purpose: "final" as const, sourceAssetId: "source", stylePresetId: "style", lightingPreset: "noon", preservationMode: "structure", providerPreference: "auto", referenceAssetId: "style-ref", depthAssetId: "depth", normalAssetId: "normal", controlMode, outputCount: 1, advancedSettings: settings, resolution: "2K", aspectRatio: "4:3", quality: "high", visualRealism: "realistic" as const, lampState: "mixed", colorTemperatureKelvin: 4000, expectedPriceVersion: "price-v1", expectedTotalCredits: 100, idempotencyKey: "key" });

test("classifyVisionArtifacts distinguishes complete, partial, and empty without clearing existing images", () => {
  const existing = { depth: image("depth", "old-depth"), normal: image("normal", "old-normal") };
  assert.equal(classifyVisionArtifacts({}, [image("depth", "depth"), image("normal", "normal")]).state, "complete");
  const partial = classifyVisionArtifacts(existing, [image("depth", "new-depth")]);
  assert.equal(partial.state, "partial");
  assert.equal(partial.depth?.id, "new-depth");
  assert.equal(partial.normal?.id, "old-normal");
  const empty = classifyVisionArtifacts(existing, []);
  assert.equal(empty.state, "empty");
  assert.equal(empty.depth?.id, "old-depth");
  assert.equal(empty.normal?.id, "old-normal");
});

test("mergeAdvancedSettings applies valid fields and ignores invalid values", () => {
  const merged = mergeAdvancedSettings(settings, { geometryFidelity: "strict", furnishingDensity: "layered", cameraPolicy: "invalid", lightingContrast: "nope" });
  assert.equal(merged.geometryFidelity, "strict");
  assert.equal(merged.furnishingDensity, "layered");
  assert.equal(merged.cameraPolicy, "locked");
  assert.equal(merged.lightingContrast, "balanced");
});

test("buildAdvancedGenerationPayload includes role references but excludes UI-only tray state", () => {
  const additionalReferences = [{ assetId: "furnishing", role: "furnishing" as const }, { assetId: "material", role: "material" as const }];
  const runtimeInput = { ...payloadInput("none"), additionalReferences, materialReferences: [{ id: "material" }], selectionMask: { id: "mask" }, editIntent: { action: "replace" } } as Parameters<typeof buildAdvancedGenerationPayload>[0];
  const none = buildAdvancedGenerationPayload(runtimeInput);
  assert.equal(none.referenceAssetId, "style-ref");
  assert.deepEqual(none.additionalReferences, additionalReferences);
  assert.equal(none.visualRealism, "realistic");
  assert.equal(none.expectedPriceVersion, "price-v1");
  assert.equal(none.expectedTotalCredits, 100);
  assert.equal("depthAssetId" in none, false);
  assert.equal("normalAssetId" in none, false);
  const depth = buildAdvancedGenerationPayload(payloadInput("depth"));
  assert.equal(depth.depthAssetId, "depth");
  assert.equal("normalAssetId" in depth, false);
  const both = buildAdvancedGenerationPayload(payloadInput("depth-normal"));
  assert.equal(both.depthAssetId, "depth");
  assert.equal(both.normalAssetId, "normal");
  for (const key of ["softReferences", "materialReferences", "colorReferences", "compositionReferences", "selection", "selectionMask", "editIntent", "editInstruction"]) {
    assert.equal(key in none, false, key);
  }
});
