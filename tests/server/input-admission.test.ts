import assert from "node:assert/strict";
import test from "node:test";
import { canSelectControlMode, createUploadAdmission, imageFitsModel, summarizeGenerationInputs } from "../../components/studio/input-limits";
import { domesticImageModelCapabilities, domesticImageModelValues } from "../../lib/domain/domestic-image-models";

const file = (size: number) => ({ size }) as File;
const image = (size = 1, width = 100, height = 100) => ({ byteSize: size, width, height });

test("all six models reserve the required source and accept exactly their published input counts", () => {
  for (const model of domesticImageModelValues) {
    const max = domesticImageModelCapabilities[model].maxInputImages;
    const gate = createUploadAdmission();
    gate.update(model, max - 1, 1, 0);
    assert.equal(gate.field("extra", false).begin(file(1)), false, model);
    assert.equal(gate.field("source", false, true, true).begin(file(1)), true, model);
    gate.field("source", false, true, true).finish(false);
    gate.update(model, max, 0, 0);
    assert.equal(gate.field("occupied", true).begin(file(1)), true, model);
    gate.field("occupied", true).finish(false);
    assert.equal(gate.field("empty", false).begin(file(1)), false, model);
  }
});

test("pending uploads, replacement and model downgrade never free another slot early", () => {
  const gate = createUploadAdmission();
  gate.update("qwen-image-3.0", 1, 1, 0);
  const first = gate.field("first", false);
  assert.equal(first.begin(file(1)), true);
  assert.equal(gate.field("second", false).begin(file(1)), false);
  first.finish(false);
  assert.equal(gate.field("second", false).begin(file(1)), true);
  gate.field("second", false).finish(true);
  gate.update("qwen-image-3.0", 2, 1, 1);
  assert.equal(gate.field("third", false).begin(file(1)), false);
  gate.settle("second");
  assert.equal(gate.field("third", false).begin(file(1)), false);
  gate.update("doubao-seedream-5-0-260128", 4, 0, 4);
  gate.update("qwen-image-3.0", 4, 0, 4);
  assert.equal(gate.field("new", false).begin(file(1)), false);
  assert.equal(gate.field("replace", true).begin(file(1)), false);
  gate.update("qwen-image-3.0", 2, 0, 2, true); // a retained image is invalid for the downgraded model
  assert.equal(gate.canAdd(), false);
  assert.equal(gate.field("new", false).begin(file(1)), false);
  assert.equal(gate.field("replace", true).begin(file(1)), true);
});

test("replacement cannot lend its uncommitted byte savings to a second upload", () => {
  const mib = 1024 * 1024;
  const gate = createUploadAdmission();
  gate.update("doubao-seedream-4-5-251128", 4, 0, 31 * mib);
  const replace = gate.field("old", true, false, false, 9 * mib);
  assert.equal(replace.begin(file(1 * mib)), true);
  assert.equal(gate.field("new", false).begin(file(9 * mib)), false);
  replace.finish(false);
  assert.equal(gate.field("new", false).begin(file(9 * mib)), false);
  gate.update("doubao-seedream-4-5-251128", 4, 0, 23 * mib);
  assert.equal(gate.field("new", false).begin(file(9 * mib)), true);
});

test("required source keeps its image slot but cannot bypass the aggregate byte cap", () => {
  const mib = 1024 * 1024;
  const gate = createUploadAdmission();
  gate.update("doubao-seedream-4-5-251128", 3, 1, 31 * mib);
  assert.equal(gate.field("source", false, true, true).begin(file(9 * mib)), false);
  assert.equal(gate.field("source", false, true, true).begin(file(1 * mib)), true);
  gate.update("qwen-image-3.0", 3, 1, 31 * mib);
  assert.equal(gate.field("source", false, true, true).complete(), false);
});

test("source selection respects the effective count after model downgrade", () => {
  const gate = createUploadAdmission();
  gate.update("qwen-image-3.0", 4, 0, 4, true);
  assert.equal(gate.field("source", true, true, true, 1).begin(file(1)), false);
  gate.update("qwen-image-3.0", 3, 1, 3, true);
  assert.equal(gate.field("source", false, true, true).begin(file(1)), false);
  gate.update("qwen-image-3.0", 5, 0, 5, true, 2, 2); // replacing source clears active Depth and Normal, leaving 3
  assert.equal(gate.field("source", true, true, true, 1).begin(file(1)), true);
  assert.equal(gate.field("source", true, true, true, 1).complete(), true);
});

test("advanced source replacement may use bytes freed by its own control-image reset only", () => {
  const mib = 1024 * 1024;
  const gate = createUploadAdmission();
  gate.update("doubao-seedream-4-5-251128", 4, 0, 32 * mib, false, 16 * mib);
  const source = gate.field("source", true, true, true, 8 * mib);
  assert.equal(source.begin(file(9 * mib)), true); // source 9 + style 8 remain after depth/normal clear
  assert.equal(gate.field("new-reference", false).begin(file(1 * mib)), false); // other slots cannot borrow that saving
  assert.equal(source.complete(), true);
  gate.update("doubao-seedream-4-5-251128", 4, 0, 32 * mib, false, 0);
  assert.equal(source.complete(), false); // mode changed, controls are no longer credited
  source.finish(false);
});

test("an old occupied slot cannot settle a replacement before its new image is counted", () => {
  const mib = 1024 * 1024;
  const gate = createUploadAdmission();
  gate.update("doubao-seedream-4-5-251128", 3, 0, 27 * mib);
  const replacement = gate.field("style", true, false, false, 3 * mib);
  assert.equal(replacement.begin(file(7 * mib)), true);
  gate.update("doubao-seedream-4-5-251128", 3, 0, 27 * mib); // unrelated render still has the old style image
  assert.equal(gate.field("soft", false).begin(file(2 * mib)), false);
  replacement.finish(true);
  assert.equal(gate.field("soft", false).begin(file(2 * mib)), false);
  gate.update("doubao-seedream-4-5-251128", 3, 0, 31 * mib); // new style image reached parent state
  replacement.settle();
  assert.equal(gate.field("soft", false).begin(file(2 * mib)), false);
});

test("all six models enforce the same boundary for the four workflow input shapes", () => {
  for (const model of domesticImageModelValues) {
    const max = domesticImageModelCapabilities[model].maxInputImages;
    const refs = (count: number) => Array.from({ length: count }, () => image() as never);
    const source = image() as never;
    const workflows = [
      { name: "concept", input: { source }, extra: { source: image(11 * 1024 * 1024) as never } },
      { name: "advanced", input: { source, additionalReferences: refs(max - 1) }, extra: { source, additionalReferences: refs(max), useDepth: false } },
      { name: "floorplan", input: { source, additionalReferences: refs(max - 1) }, extra: { source, additionalReferences: refs(max) } },
      { name: "self-service", input: { additionalReferences: refs(max) }, extra: { additionalReferences: refs(max + 1) } },
    ];
    for (const { name, input, extra } of workflows) {
      assert.equal(summarizeGenerationInputs(model, input).allowed, true, `${model}/${name} within limit`);
      assert.equal(summarizeGenerationInputs(model, extra).allowed, false, `${model}/${name} beyond limit`);
    }
  }
});

test("advanced control modes reserve depth and normal; inactive images remain drafts", () => {
  for (const model of domesticImageModelValues) {
    const max = domesticImageModelCapabilities[model].maxInputImages;
    assert.equal(canSelectControlMode(model, max - 2, "depth-normal"), true);
    assert.equal(canSelectControlMode(model, max - 1, "depth-normal"), false);
    const gate = createUploadAdmission();
    gate.update(model, max - 2, 2, 0);
    assert.equal(gate.field("style", false).begin(file(1)), false);
    assert.equal(gate.field("depth", false, true).begin(file(1)), true);
    assert.equal(gate.field("normal", false, true).begin(file(1)), true);
  }
  const qwen = "qwen-image-3.0-pro";
  assert.equal(summarizeGenerationInputs(qwen, { source: image() as never, depth: image() as never, normal: image() as never, useDepth: false, useNormal: false }).count, 1);
  assert.equal(summarizeGenerationInputs(qwen, { source: image() as never, depth: image() as never, normal: image() as never, useDepth: true, useNormal: true }).count, 3);
});

test("model byte and hard dimension limits apply before submission without treating WebP as forbidden", () => {
  const seedream = "doubao-seedream-5-0-pro-260628";
  const qwen = "qwen-image-3.0-pro";
  assert.equal(imageFitsModel(seedream, image(1, 14, 100)), false);
  assert.equal(imageFitsModel(seedream, image(1, 15, 100)), true);
  assert.equal(imageFitsModel(seedream, image(1, 100, 1700)), false);
  assert.equal(imageFitsModel(qwen, image(1, 14, 100)), true);
  assert.equal(imageFitsModel(qwen, image(11 * 1024 * 1024)), false);
  assert.equal(summarizeGenerationInputs(qwen, { additionalReferences: [image(10 * 1024 * 1024) as never, image(10 * 1024 * 1024) as never, image(10 * 1024 * 1024) as never] }).allowed, true);
  assert.equal(summarizeGenerationInputs(qwen, { additionalReferences: [image(10 * 1024 * 1024) as never, image(10 * 1024 * 1024) as never, image(10 * 1024 * 1024) as never, image(1) as never] }).allowed, false);
});
