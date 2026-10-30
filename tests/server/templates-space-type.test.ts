import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../../lib/server/templates.ts", import.meta.url), "utf8");

test("concept and advanced templates accept concrete space types", () => {
  assert.match(source, /spaceType/);
  assert.match(source, /workflowType !== "concept" && workflowType !== "advanced"/);
});

test("templates reject space types for frozen workflows or unspecified", () => {
  assert.match(source, /spaceType === "unspecified"/);
  assert.match(source, /仅适用于概念和高级工作台/);
});
