import assert from "node:assert/strict";
import test from "node:test";
import { requirePublicModelOption } from "../../lib/server/public-model-option";
test("new finalize requires an explicit approved actual tuple instead of guessing a historical provider", () => {
  assert.throws(() => requirePublicModelOption({ modelId: "openai", resolution: "2K", quality: "medium" }));
  assert.deepEqual(requirePublicModelOption({ optionId: "sunburst-medium-2k", modelId: "gpt-image-2.5-sunburst", resolution: "2K", quality: "medium" }), { model: "gpt-image-2.5-sunburst", resolution: "2K", quality: "medium" });
  assert.throws(() => requirePublicModelOption({ optionId: "sunburst-medium-2k", modelId: "gpt-image-2", resolution: "2K", quality: "medium" }));
});
