import assert from "node:assert/strict";
import test from "node:test";

import { privateTestModeForSubmission, providerInputCount, requiresFreshPaidConfirmation, shouldRecoverPendingSubmissions, submittedParameterSummary } from "../../components/studio/browser-drafts";

test("paid confirmation counts both local and stored provider inputs, not masks", () => {
  assert.equal(providerInputCount({ sourceAssetId: "local:source", referenceAssetId: "asset_stored", maskAssetId: "local:mask", additionalReferences: [{ assetId: "asset_furniture", role: "furnishing" }, { assetId: "local:window", role: "structure" }] }), 4);
  assert.equal(providerInputCount({ sourceAssetId: null, additionalReferences: [] }), 0);
});

test("paid confirmation lists actual submitted controls and preview quality", () => {
  const summary = submittedParameterSummary({ purpose: "preview", quality: "high", spaceType: "bedroom", lightingPreset: "night", advancedSettings: { geometryFidelity: "strict" }, customPrompt: "室内夜景" });
  assert.match(summary, /空间类型：bedroom/u);
  assert.match(summary, /光照时段：night/u);
  assert.match(summary, /质量：draft/u);
  assert.match(summary, /geometryFidelity/u);
  assert.match(summary, /室内夜景/u);
  assert.doesNotMatch(summary, /质量：high/u);
});

test("private mode always requires a fresh confirmation before replay", () => {
  assert.equal(requiresFreshPaidConfirmation(Date.now(), true), true);
  assert.equal(requiresFreshPaidConfirmation(Date.now(), false), false);
  assert.equal(requiresFreshPaidConfirmation(undefined, false), false);
});

test("loopback submission stops if private mode cannot be confirmed", async () => {
  const unavailable = (async () => Response.error()) as typeof fetch;
  await assert.rejects(privateTestModeForSubmission("http://127.0.0.1:3000", undefined, unavailable), /无法确认 SSH 私测状态/u);
  const disconnected = (async () => { throw new Error("offline"); }) as typeof fetch;
  await assert.rejects(privateTestModeForSubmission("http://127.0.0.1:3000", Date.now(), disconnected), /无法确认 SSH 私测状态/u);
});

test("startup recovery is never automatic on the private tunnel or failed mode lookup", () => {
  assert.equal(shouldRecoverPendingSubmissions("http://127.0.0.1:3000", true, "private-test"), false);
  assert.equal(shouldRecoverPendingSubmissions("http://127.0.0.1:3000", false), false);
  assert.equal(shouldRecoverPendingSubmissions("https://zaoshi.net", false), false);
  assert.equal(shouldRecoverPendingSubmissions("https://zaoshi.net", true, "demo"), true);
});
