import assert from "node:assert/strict";
import test from "node:test";
import { BARE_SHELL_INSTRUCTION } from "../../lib/domain/bare-shell";
import { compileInteriorPrompt } from "../../lib/ai/prompt";
import { getStylePreset } from "../../lib/ai/styles";
import { parseCreateJobInput } from "../../lib/server/job-contract";
import { serializeJob } from "../../lib/server/serializers";
import type { GenerateInteriorImagesRequest } from "../../lib/ai/types";

const shellPayload = (overrides: Record<string, unknown> = {}) => ({
  workflowType: "advanced", purpose: "final", sourceAssetId: "source", editInstruction: BARE_SHELL_INSTRUCTION,
  stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure",
  providerPreference: "doubao-seedream-5-0-pro-260628", outputCount: 2, resolution: "2K", aspectRatio: "4:3",
  quality: "auto", lampState: "off", colorTemperatureKelvin: 4000, idempotencyKey: "bare-shell-key-123", ...overrides,
});

test("毛坯还原 is an advanced final job with one site photo and nothing else", () => {
  const accepted = parseCreateJobInput(shellPayload());
  assert.equal(accepted.editInstruction, BARE_SHELL_INSTRUCTION);
  assert.equal(accepted.maskAssetId, null);
  for (const invalid of [
    { workflowType: "concept" },
    { purpose: "preview" },
    { customPrompt: "保留木地板" },
    { referenceAssetId: "style" },
    { depthAssetId: "depth" },
    { maskAssetId: "mask" },
    { additionalReferences: [{ assetId: "furnishing", role: "furnishing" }] },
  ]) assert.throws(() => parseCreateJobInput(shellPayload(invalid)), (error: { code?: string }) => error.code === "INVALID_BARE_SHELL", JSON.stringify(invalid));
});

test("毛坯还原 compiles its own prompt that ignores style, lighting and design settings", () => {
  const base: GenerateInteriorImagesRequest = {
    sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType: "advanced", purpose: "final",
    resolution: "2K", aspectRatio: "16:9", quality: "auto", style: { presetId: "advanced" },
    lighting: { timeOfDay: "night", lampState: "on", colorTemperatureKelvin: 2700 }, renovationScope: "restyle",
    outputCount: 2, editInstruction: BARE_SHELL_INSTRUCTION,
  };
  const style = getStylePreset("modern-minimalist")!;
  const prompt = compileInteriorPrompt(base, style);
  assert.equal(prompt.templateVersion, "bare-shell-v1");
  assert.equal(compileInteriorPrompt({ ...base, lighting: { timeOfDay: "day", lampState: "off", colorTemperatureKelvin: 6500 }, renovationScope: "replace-soft-furnishings" }, style).text, prompt.text);
  for (const phrase of [/same room as an unfinished bare shell/u, /When unsure whether an object is fixed, remove it/u, /never reveal a taller room/u, /water inlets, drain outlets/u, /16:9/u]) assert.match(prompt.text, phrase);
  assert.doesNotMatch(prompt.text, /2700K|Lighting: realistic nighttime|modern minimalist/iu);
});

test("job snapshots label 毛坯还原 tasks so the UI can tag them", () => {
  const job = (editInstruction: string | null) => ({ ...parseCreateJobInput(shellPayload({ editInstruction })), id: "job-1", ownerId: "owner-1", status: "SUCCEEDED", completedOutputCount: 0, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, provider: null, model: null, requestId: null, errorCode: null, errorMessage: null, editInstruction }) as unknown as Parameters<typeof serializeJob>[0];
  assert.equal(serializeJob(job(BARE_SHELL_INSTRUCTION), []).taskMode, "bare-shell");
  assert.equal("taskMode" in serializeJob(job(null), []), false);
});

test("毛坯结构图 results offer no follow-up actions; only task-list downloads remain", async () => {
  const { readFile } = await import("node:fs/promises");
  const view = await readFile(new URL("../../components/studio/GenerationView.tsx", import.meta.url), "utf8");
  assert.match(view, /\{bareShell \? <small>请在下方任务列表下载。<\/small> : reusable \? /u);
  const list = await readFile(new URL("../../components/studio/StudioTaskList.tsx", import.meta.url), "utf8");
  assert.match(list, /job\.taskMode !== "bare-shell" && !historical && job\.results\.length > 0 && <button[^>]*onClick=\{\(\) => applyParameters\(job\)\}>使用此图参数/u);
  assert.match(list, /href=\{`\$\{result\.url\}&download=1`\} download>/u);
});

test("the mode token never reaches moderation text, and only the source slot can block 毛坯还原", async () => {
  const { userEditInstruction } = await import("../../lib/domain/bare-shell");
  assert.equal(userEditInstruction(BARE_SHELL_INSTRUCTION), null);
  assert.equal(userEditInstruction("local-edit:v2:replace"), "local-edit:v2:replace");
  assert.equal(userEditInstruction(null), null);
  const { readFile } = await import("node:fs/promises");
  for (const path of ["../../app/api/jobs/route.ts", "../../app/api/jobs/[id]/finalize/route.ts", "../../lib/server/job-processor.ts", "../../lib/server/queued-job-creation.ts"]) {
    assert.match(await readFile(new URL(path, import.meta.url), "utf8"), /userEditInstruction\((input|preview|job|record)\.editInstruction\)/u, path);
  }
  const tray = await readFile(new URL("../../components/studio/ReferenceTray.tsx", import.meta.url), "utf8");
  assert.match(tray, /\(!sourceOnly \|\| name === "source"\) && \(state === "uploading" \|\| state === "error"\)/u);
  const drafts = await readFile(new URL("../../components/studio/browser-drafts.ts", import.meta.url), "utf8");
  assert.match(drafts, /if \(isBareShellInstruction\(payload\.editInstruction\)\) return \["生成内容：毛坯还原"/u);
});
