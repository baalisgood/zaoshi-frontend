import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all generation layers persist and validate additional references as reference assets", async () => {
  const [create, finalize, processor] = await Promise.all([
    readFile("app/api/jobs/route.ts", "utf8"),
    readFile("app/api/jobs/[id]/finalize/route.ts", "utf8"),
    readFile("lib/server/job-processor.ts", "utf8"),
  ]);
  assert.match(create, /additionalReferencesJson:\s*JSON\.stringify\(input\.additionalReferences\)/u);
  assert.match(create, /assertAssetKind\(reference, "reference", `additionalReferences/u);
  assert.match(finalize, /additionalReferencesJson:\s*JSON\.stringify\(additionalReferences\)/u);
  assert.match(finalize, /assertAssetKind\(asset, "reference", `additionalReferences/u);
  assert.match(processor, /requiredAsset\(entry\.assetId, job\.ownerId, \["reference"\]\)/u);
});
