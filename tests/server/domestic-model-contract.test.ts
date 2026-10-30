import assert from "node:assert/strict";
import test from "node:test";
import { parseCreateJobInput } from "../../lib/server/job-contract";

const base = { sourceAssetId: "source", stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure", workflowType: "concept", outputCount: 1, resolution: "2K", aspectRatio: "4:3", quality: "standard", idempotencyKey: "domestic-model-test" };

test("job contract accepts all six domestic image models", () => {
  for (const providerPreference of ["doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro"] as const) {
    assert.equal(parseCreateJobInput({ ...base, providerPreference }).providerPreference, providerPreference);
  }
});

test("job contract rejects legacy and unknown image providers", () => {
  for (const providerPreference of ["auto", "openai", "google", "seedream", "qwen", "hunyuan", "kling", "doubao-seedream-5-0-lite-260128", "unknown"] as const) {
    assert.throws(() => parseCreateJobInput({ ...base, providerPreference }), /providerPreference/u);
  }
});
