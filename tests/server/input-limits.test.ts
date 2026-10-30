import assert from "node:assert/strict";
import test from "node:test";
import { countGenerationInputs, summarizeGenerationInputs } from "../../components/studio/input-limits";

const image = (id: string) => ({ id, kind: "reference", url: `/assets/${id}` });

test("counts source, style, additional references and enabled controls", () => {
  assert.equal(countGenerationInputs({ source: image("source"), styleReference: image("style"), additionalReferences: [image("one")] }), 3);
  assert.equal(countGenerationInputs({ source: image("source"), depth: image("depth"), normal: image("normal"), useDepth: false, useNormal: false }), 1);
  assert.equal(countGenerationInputs({ source: image("source"), depth: image("depth"), normal: image("normal"), useDepth: true, useNormal: true }), 3);
});

test("uses provider capability limits without truncating references", () => {
  const three = { source: image("source"), additionalReferences: [image("a"), image("b")] };
  const four = { source: image("source"), additionalReferences: [image("a"), image("b"), image("c")] };
  assert.deepEqual(summarizeGenerationInputs("qwen-image-3.0-pro", three), { count: 3, max: 3, allowed: true, bytes: 0 });
  assert.equal(summarizeGenerationInputs("qwen-image-3.0-pro", four).allowed, false);
  assert.equal(summarizeGenerationInputs("qwen-image-2.0-pro", four).allowed, false);
  assert.equal(summarizeGenerationInputs("doubao-seedream-5-0-pro-260628", { source: image("source"), additionalReferences: Array.from({ length: 9 }, (_, i) => image(String(i))) }).allowed, true);
});

test("Seedream Lite and 4.5 allow 14 total inputs and reject 15", () => {
  for (const model of ["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128"] as const) {
    const references = (count: number) => ({ source: image("source"), additionalReferences: Array.from({ length: count }, (_, index) => image(`${model}-${index}`)) });
    assert.equal(summarizeGenerationInputs(model, references(13)).allowed, true);
    assert.equal(summarizeGenerationInputs(model, references(14)).allowed, false);
  }
});
