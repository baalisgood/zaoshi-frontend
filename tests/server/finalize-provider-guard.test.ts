import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("finalize rejects legacy providers before persisting a new job", async () => {
  const source = await readFile(new URL("../../app/api/jobs/[id]/finalize/route.ts", import.meta.url), "utf8");
  assert.match(source, /const providerPreference = preview\.providerPreference/u);
  assert.match(source, /不能继续生成成品图/u);
  assert.ok(source.indexOf("!isDomesticImageModel(providerPreference)") < source.indexOf("const result = await createQueuedJobIdempotently"));
  assert.ok(source.indexOf("assertDomesticInputAssets") < source.indexOf("const result = await createQueuedJobIdempotently"));
  assert.doesNotMatch(source, /scheduleBackground|processGenerationJob/u);
  assert.doesNotMatch(source, /providerPreference\s*:\s*"seedream"/u);
});
