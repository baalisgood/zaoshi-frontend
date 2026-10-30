import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseGenerationWorkSpec,
  type GenerationWorkSpec,
} from "../../lib/domain/generation-work";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const TICKET = "t".repeat(64);

test("generation work parser accepts one exact frozen domestic item", () => {
  const work = validWork();
  assert.deepEqual(parseGenerationWorkSpec(work), work);
  assert.equal(parseGenerationWorkSpec({ ...work, spaceType: "bedroom" }).spaceType, "bedroom");
  assert.equal(parseGenerationWorkSpec({ ...work, spaceType: "children-room" }).spaceType, "children-room");
  assert.throws(() => parseGenerationWorkSpec({ ...work, workflowType: "advanced", spaceType: "children-room" }), /CONTROL_PLANE_WORK_INVALID/u);
  const historical = { ...work };
  delete historical.spaceType;
  assert.equal(parseGenerationWorkSpec(historical).spaceType, "unspecified");
  assert.throws(() => parseGenerationWorkSpec({ ...work, spaceType: "garage" }), /CONTROL_PLANE_WORK_INVALID/u);
  assert.equal(parseGenerationWorkSpec({ ...work, designSchemeId: "modern-minimalist-02-v1" }).designSchemeId, "modern-minimalist-02-v1");
  assert.equal(parseGenerationWorkSpec({ ...historical, designSchemeId: "modern-minimalist-02-v1" }).designSchemeId, "modern-minimalist-02-v1");
  assert.throws(() => parseGenerationWorkSpec({ ...work, workflowType: "advanced", designSchemeId: "modern-minimalist-02-v1" }), /CONTROL_PLANE_WORK_INVALID/u);
});

test("generation work parser rejects unknown fields and sparse input indexes", () => {
  assert.throws(
    () => parseGenerationWorkSpec({ ...validWork(), endpoint: "https://example.com" }),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
  const sparse = validWork();
  sparse.inputs[0] = { ...sparse.inputs[0]!, index: 1 };
  assert.throws(
    () => parseGenerationWorkSpec(sparse),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
});

test("generation work parser enforces role uniqueness, workflow and control ordering", () => {
  const duplicateSource = validWork();
  duplicateSource.inputs.push({ ...duplicateSource.inputs[0]!, index: 1 });
  assert.throws(
    () => parseGenerationWorkSpec(duplicateSource),
    /CONTROL_PLANE_WORK_INVALID/u,
  );

  const conceptControl = validWork();
  conceptControl.inputs.push(input("depth", 1));
  assert.throws(
    () => parseGenerationWorkSpec(conceptControl),
    /CONTROL_PLANE_WORK_INVALID/u,
  );

  const advanced = validWork({ workflowType: "advanced" });
  advanced.advancedSettings = {
    version: 1,
    geometryFidelity: "balanced",
    cameraPolicy: "locked",
    furnishingDensity: "balanced",
    materialExpression: "natural",
    lightingContrast: "balanced",
  };
  advanced.inputs.push(input("normal", 1), input("depth", 2));
  assert.throws(
    () => parseGenerationWorkSpec(advanced),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
});

test("generation work parser permits self-service text-only work but requires source elsewhere", () => {
  const selfService = validWork({ workflowType: "self-service" });
  selfService.stylePresetId = "self-service";
  selfService.customPrompt = "明亮的现代住宅客厅";
  selfService.inputs = [];
  assert.deepEqual(parseGenerationWorkSpec(selfService), selfService);

  const concept = validWork();
  concept.inputs = [];
  assert.throws(
    () => parseGenerationWorkSpec(concept),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
});

test("generation work parser enforces provider resolution and ticket boundaries", () => {
  const unsupported = validWork();
  unsupported.resolution = "1K";
  assert.throws(
    () => parseGenerationWorkSpec(unsupported),
    /CONTROL_PLANE_WORK_INVALID/u,
  );

  const shortTicket = validWork();
  shortTicket.inputs[0] = { ...shortTicket.inputs[0]!, ticket: "short" };
  assert.throws(
    () => parseGenerationWorkSpec(shortTicket),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
});

test("generation work parser admits only the fixed acceptance fixture contract", () => {
  const acceptance = validWork({
    executionKind: "acceptance",
    providerPreference: "acceptance-fixture-v1",
    purpose: "final",
    resolution: "0.5K",
    aspectRatio: "1:1",
    quality: "draft",
    visualRealism: "conceptual",
    stylePresetId: "acceptance-fixture-v1",
    lightingPreset: "noon",
    lampState: "off",
    colorTemperatureKelvin: 4000,
    renovationScope: "restyle",
  });
  assert.deepEqual(parseGenerationWorkSpec(acceptance), acceptance);
  assert.throws(
    () => parseGenerationWorkSpec({ ...acceptance, quality: "high" }),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
  assert.throws(
    () =>
      parseGenerationWorkSpec({
        ...acceptance,
        providerPreference: "doubao-seedream-4-5-251128",
      }),
    /CONTROL_PLANE_WORK_INVALID/u,
  );
});

function validWork(
  overrides: Partial<GenerationWorkSpec> = {},
): GenerationWorkSpec {
  return {
    version: 1,
    executionKind: "provider",
    itemId: "qitem-work-1",
    attemptId: "attempt-work-1",
    outputOrdinal: 0,
    totalOutputs: 1,
    providerPreference: "doubao-seedream-4-5-251128",
    workflowType: "concept",
    spaceType: "unspecified",
    purpose: "final",
    resolution: "2K",
    aspectRatio: "4:3",
    quality: "standard",
    visualRealism: "photorealistic",
    stylePresetId: "modern-minimalist",
    lightingPreset: "noon",
    lampState: "mixed",
    colorTemperatureKelvin: 4000,
    renovationScope: "restyle",
    promotedFromPreview: false,
    editInstruction: null,
    customPrompt: null,
    advancedSettings: null,
    outputCount: 1,
    inputs: [input("source", 0)],
    ...overrides,
  };
}

function input(role: string, index: number) {
  return {
    role,
    index,
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
    ticket: TICKET,
  };
}
