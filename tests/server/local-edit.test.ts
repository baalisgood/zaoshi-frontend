import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharpRuntime from "sharp";
const sharp = sharpRuntime as unknown as (input: { create: { width: number; height: number; channels: 3; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };
import { buildAdvancedGenerationPayload } from "../../components/studio/advanced-helpers";
import { parseCreateJobInput, defaultAdvancedSettings } from "../../lib/server/job-contract";
import { localEditInstruction, localEditOptions } from "../../lib/domain/local-edit";
import { parseGenerationWorkSpec, type GenerationWorkSpec } from "../../lib/domain/generation-work";
import { compileInteriorPrompt } from "../../lib/ai/prompt";
import { createDomesticGenerationExecutor } from "../../lib/consumer/domestic-executor";
import { submittedParameterSummary, providerInputCount } from "../../components/studio/browser-drafts";
import type { GenerateInteriorImagesRequest } from "../../lib/ai/types";
import type { ImageModel } from "../../lib/domain/image-models";

const ordinary = { workflowType: "advanced" as const, purpose: "final" as const, sourceAssetId: "source", customPrompt: "black lacquer", lightingPreset: "night", preservationMode: "clear", providerPreference: "doubao-seedream-5-0-pro-260628", referenceAssetId: "whole-style", depthAssetId: "depth", normalAssetId: "normal", controlMode: "depth-normal" as const, outputCount: 1, advancedSettings: defaultAdvancedSettings, resolution: "2K", aspectRatio: "4:3", quality: "auto", visualRealism: "conceptual" as const, lampState: "off", colorTemperatureKelvin: 6500, spaceType: "corridor", expectedPriceVersion: "price-v1", expectedTotalCredits: 10, idempotencyKey: "local-edit-test" };
const local = { operation: "replace" as const, sourceAssetId: "local-original", annotationAssetId: "annotation", referenceAssetIds: ["ref-1"] };
const payload = () => buildAdvancedGenerationPayload({ ...ordinary, localEdit: local });

test("six local operations produce distinct persisted requests, with independent original and counted references", () => {
  const hashes = new Set<string>();
  for (const option of localEditOptions) {
    const body = buildAdvancedGenerationPayload({ ...ordinary, customPrompt: option.value === "prompt" ? "修改选区" : "", localEdit: { ...local, operation: option.value } });
    const job = parseCreateJobInput(body); hashes.add(job.requestHash);
    assert.equal(job.sourceAssetId, local.sourceAssetId);
    assert.equal(job.editInstruction, localEditInstruction(option.value));
    assert.deepEqual(job.additionalReferences.map((entry) => entry.role), ["selection", "furnishing"]);
    assert.equal(providerInputCount(body), 3);
    assert.equal(job.maskAssetId, null); assert.equal(job.depthAssetId, null); assert.equal(job.referenceAssetId, null);
    const summary = submittedParameterSummary(body);
    assert.ok(summary.includes(option.label)); assert.doesNotMatch(summary, /空间类型|光照时段|保留策略|高级设置/u);
  }
  assert.equal(hashes.size, 6);
  const normal = buildAdvancedGenerationPayload(ordinary);
  assert.equal(normal.sourceAssetId, "source"); assert.equal(normal.normalAssetId, "normal"); assert.equal(normal.editInstruction, undefined);
});

test("local contract rejects incomplete, mixed and over-limit requests, preserving old free-text mask contract", () => {
  for (const changes of [
    { purpose: "preview" }, { workflowType: "concept", stylePresetId: "modern-minimalist" }, { editInstruction: undefined }, { editInstruction: "local-edit:v2:unknown" }, { editInstruction: "local-edit:v1:unknown" },
    { additionalReferences: [] }, { maskAssetId: "mask" }, { depthAssetId: "depth" }, { normalAssetId: "normal" }, { referenceAssetId: "style" },
    { additionalReferences: [{ assetId: "annotation", role: "selection" }, { assetId: "annotation2", role: "selection" }] },
    { additionalReferences: [{ assetId: "annotation", role: "selection" }, { assetId: "structure", role: "structure" }] },
    { additionalReferences: [{ assetId: "annotation", role: "selection" }, ...[1, 2, 3, 4].map((i) => ({ assetId: `f${i}`, role: "furnishing" }))] },
  ]) assert.throws(() => parseCreateJobInput({ ...payload(), ...changes }));
  const legacy = { ...ordinary, sourceAssetId: "source", editInstruction: "change the chair", maskAssetId: "mask" };
  assert.equal(parseCreateJobInput(legacy).editInstruction, legacy.editInstruction);
  assert.throws(() => parseCreateJobInput({ ...legacy, maskAssetId: undefined }));
});

const tiny = await sharp({ create: { width: 512, height: 512, channels: 3, background: "white" } }).png().toBuffer();
const image = { bytes: new Uint8Array(tiny), mimeType: "image/png" as const };
const request: GenerateInteriorImagesRequest = { sourceImage: image, workflowType: "advanced", style: { presetId: "advanced" }, purpose: "final", resolution: "2K", aspectRatio: "4:3", quality: "auto", lighting: { timeOfDay: "night", lampState: "off", colorTemperatureKelvin: 6500 }, renovationScope: "empty-room", advancedSettings: defaultAdvancedSettings, outputCount: 1, editInstruction: localEditInstruction("rematerial"), customPrompt: "black lacquer", referenceImages: [{ role: "selection", image }, { role: "furnishing", image }] };
const style = { id: "advanced", name: "", description: "", preview: "", promptDirective: "" };
test("local prompt ignores all global controls and never misclassifies ordinary free text", () => {
  const original = compileInteriorPrompt(request, style).text;
  const changed = compileInteriorPrompt({ ...request, spaceType: "corridor", visualRealism: "conceptual", renovationScope: "restyle", lighting: { ...request.lighting, timeOfDay: "dawn", lampState: "on", colorTemperatureKelvin: 2700 }, advancedSettings: { ...defaultAdvancedSettings, geometryFidelity: "strict", cameraPolicy: "correct-verticals", furnishingDensity: "layered", materialExpression: "tactile", lightingContrast: "dramatic" } }, style).text;
  assert.equal(changed, original); assert.doesNotMatch(original, /black lacquer/u); assert.match(original, /Change only the surface material/u); assert.doesNotMatch(original, /6500K|Advanced settings:|Lighting:/u);
  assert.throws(() => compileInteriorPrompt({ ...request, editInstruction: "change" }, style));
  assert.notEqual(compileInteriorPrompt({ ...request, referenceImages: undefined, editInstruction: "change" }, style).templateVersion, "local-edit-v2");
});

test("v2 shortcuts ignore preserved prompt before hash and compilation; explicit prompt mode requires it; v1 history keeps overrides", () => {
  const prompt = "只移除标注的茶几，不添加新家具";
  for (const {value} of localEditOptions) {
    const editInstruction = localEditInstruction(value);
    if (value === "prompt") {
      assert.throws(() => parseCreateJobInput(buildAdvancedGenerationPayload({...ordinary, customPrompt:"",localEdit:{...local,operation:value}})));
      assert.throws(() => compileInteriorPrompt({...request,editInstruction,customPrompt:""},style));
      assert.match(compileInteriorPrompt({...request,editInstruction,customPrompt:prompt},style).text,/只移除标注的茶几/u);
      continue;
    }
    const body=buildAdvancedGenerationPayload({...ordinary,customPrompt:prompt,localEdit:{...local,operation:value}});
    const accepted=parseCreateJobInput(body);
    assert.equal(accepted.customPrompt,null);
    assert.equal(parseCreateJobInput({...body,customPrompt:"恶意".repeat(3000)}).requestHash,accepted.requestHash);
    assert.equal(parseCreateJobInput({...body,customPrompt:{ignored:true}}).requestHash,accepted.requestHash);
    assert.equal(compileInteriorPrompt({...request,editInstruction,customPrompt:prompt},style).text,compileInteriorPrompt({...request,editInstruction,customPrompt:""},style).text);
    const legacy=compileInteriorPrompt({...request,editInstruction:`local-edit:v1:${value}`,customPrompt:prompt},style);
    assert.equal(legacy.templateVersion,"local-edit-v2");assert.match(legacy.text,/只移除标注的茶几/u);
  }
});

function work(model: ImageModel, count = 3): GenerationWorkSpec {
  return { version: 1, executionKind: "provider", itemId: "item_local", attemptId: "attempt_local", outputOrdinal: 0, totalOutputs: 1, providerPreference: model, workflowType: "advanced", spaceType: "unspecified", purpose: "final", resolution: "2K", aspectRatio: "4:3", quality: "auto", visualRealism: "photorealistic", stylePresetId: "advanced", lightingPreset: "noon", lampState: "mixed", colorTemperatureKelvin: 4000, renovationScope: "restyle", promotedFromPreview: false, editInstruction: "local-edit:v1:replace", customPrompt: "one black table", advancedSettings: defaultAdvancedSettings, outputCount: 1, inputs: Array.from({ length: count }, (_, index) => ({ role: index === 0 ? "source" : index === 1 ? "selection" : "furnishing", index, mimeType: "image/png", byteSize: tiny.length, sha256: createHash("sha256").update(tiny).digest("hex"), ticket: "x".repeat(100) })) };
}
test("work parser enforces local operation/role pairing and exact model input capacity", () => {
  assert.equal(parseGenerationWorkSpec(work("qwen-image-3.0")).inputs.length, 3);
  assert.throws(() => parseGenerationWorkSpec(work("qwen-image-3.0", 4)));
  assert.throws(() => parseGenerationWorkSpec({ ...work("qwen-image-3.0"), purpose: "preview" }));
  assert.throws(() => parseGenerationWorkSpec({ ...work("qwen-image-3.0"), promotedFromPreview: true }));
  assert.throws(() => parseGenerationWorkSpec({ ...work("gpt-image-2"), editInstruction: "untrusted" }));
  assert.throws(() => parseGenerationWorkSpec({ ...work("gpt-image-2"), workflowType: "concept" }));
});

test("actual consumer sends original, annotation and reference through all four provider protocols with one POST and no retry", async () => {
  for (const model of ["doubao-seedream-5-0-pro-260628", "qwen-image-3.0", "gpt-image-2", "gemini-3.1-flash-image"] as const) {
    let posts = 0;
    let submittedPrompt = "";
    let submittedImages = 0;
    let submittedMethod: string | undefined;
    const mockFetch: typeof fetch = async (_url, init) => {
      submittedMethod = init?.method; posts++;
      let prompt: string;
      if (init?.body instanceof FormData) { submittedImages = init.body.getAll("image[]").length; prompt = String(init.body.get("prompt")); }
      else {
        const body = JSON.parse(String(init?.body));
        if (model.startsWith("doubao")) { submittedImages = body.image.length; prompt = body.prompt; }
        else if (model.startsWith("qwen")) { const content = body.input.messages.flatMap((message: { content: { image?: string; text?: string }[] }) => message.content); submittedImages = content.filter((part: { image?: string }) => part.image).length; prompt = content.find((part: { text?: string }) => part.text).text; }
        else { submittedImages = body.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData).length; prompt = body.contents[0].parts[0].text; }
      }
      submittedPrompt = prompt;
      return Response.json({ error: { message: "controlled failure" } }, { status: 400 });
    };
    const executor = createDomesticGenerationExecutor({ slots: { seedream: { id: "seedream-test", provider: "seedream", apiKey: "test-key" }, qwen: { id: "qwen-test", provider: "qwen", apiKey: "test-key", workspaceId: "test-workspace" }, openai: { id: "openai-test", provider: "openai", apiKey: "test-key" }, google: { id: "google-test", provider: "google", apiKey: "test-key" } }, fetch: mockFetch, overseasTransport: { fetch: mockFetch, assertReady: async () => undefined }, privateTestExpiresAt: Math.floor(Date.now() / 1000) + 600, sanitizer: { sanitize: async () => { throw new Error("unexpected output"); } } });
    const spec = work(model); const downloaded = spec.inputs.map((input) => ({ ...input, bytes: new Uint8Array(tiny) }));
    const prepared = await executor.prepare(spec, downloaded);
    await assert.rejects(prepared.execute()); assert.equal(posts, 1);
    assert.equal(submittedMethod, "POST"); assert.equal(submittedImages, 3);
    assert.match(submittedPrompt, /SECOND image.*red brush/u); assert.match(submittedPrompt, /one black table/u);
    assert.doesNotMatch(submittedPrompt, /Replace the marked furniture|Advanced settings:|Target color temperature:/u);
    await assert.rejects(prepared.execute()); assert.equal(posts, 1);
    const bad = downloaded.map((input) => ({ ...input })); bad[1].bytes = new Uint8Array(tiny.slice(0, -1));
    await assert.rejects(executor.prepare(spec, bad)); assert.equal(posts, 1);
    const malformed = new Uint8Array([1]);
    const missingDimensions = { ...spec, inputs: spec.inputs.map((input) => ({ ...input, byteSize: 1, sha256: createHash("sha256").update(malformed).digest("hex") })) };
    await assert.rejects(executor.prepare(missingDimensions, missingDimensions.inputs.map((input) => ({ ...input, bytes: malformed }))), /LOCAL_EDIT_DIMENSIONS/u); assert.equal(posts, 1);
  }
});

test("v2 prompt-mode local edits fence user text while v1 history keeps its frozen wording", () => {
  const prompt = "只移除标注的茶几";
  const current = compileInteriorPrompt({ ...request, editInstruction: localEditInstruction("prompt"), customPrompt: prompt }, style);
  assert.equal(current.templateVersion, "local-edit-v4");
  assert.match(current.text, /never widen the edit to the whole room\): """只移除标注的茶几"""/u);
  const legacy = compileInteriorPrompt({ ...request, editInstruction: "local-edit:v1:rematerial", customPrompt: prompt }, style);
  assert.match(legacy.text, /User instructions for the marked target: 只移除标注的茶几\n/u);
});
