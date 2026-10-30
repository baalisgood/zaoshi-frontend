import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  domesticImageModelCapabilities,
  domesticImageModelOptions,
  domesticImageModelResolutionOptions,
  normalizeKnownDomesticImageModel,
  normalizeDomesticImageResolution,
} from "../../lib/domain/domestic-image-models";

test("domestic model resolution options match the server capability matrix", () => {
  assert.deepEqual(domesticImageModelOptions.slice(0, 6).map((item) => item.label), ["Seedream 5.0 Pro", "Seedream 5.0 Lite", "Seedream 4.5", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro"]);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-260128"].maxInputImages, 14);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-4-5-251128"].maxInputImages, 14);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-pro-260628"].maxInputImages, 10);
  assert.equal(domesticImageModelCapabilities["qwen-image-3.0-pro"].maxInputImages, 3);
  assert.deepEqual(domesticImageModelCapabilities["doubao-seedream-5-0-pro-260628"].officialResolutions, ["1K", "1.5K", "2K"]);
  assert.deepEqual(domesticImageModelCapabilities["doubao-seedream-5-0-260128"].officialResolutions, ["2K", "3K", "4K"]);
  assert.deepEqual(domesticImageModelCapabilities["qwen-image-3.0-pro"].officialResolutions, ["总像素512×512—2048×2048，可自定义宽高"]);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-pro-260628"].inputDimensions?.minRatio, 1 / 16);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-pro-260628"].inputDimensions?.maxRatio, 16);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-pro-260628"].nativeInteractiveEdit, true);
  assert.equal(domesticImageModelCapabilities["doubao-seedream-5-0-260128"].nativeSequenceOutput, true);
  assert.equal(domesticImageModelCapabilities["qwen-image-3.0-pro"].nativeSequenceOutput, false);
  assert.deepEqual(domesticImageModelResolutionOptions("doubao-seedream-5-0-pro-260628").map((item) => item.value), ["2K"]);
  assert.deepEqual(domesticImageModelResolutionOptions("qwen-image-3.0-pro").map((item) => item.value), ["1K", "2K"]);
  assert.match(domesticImageModelResolutionOptions("doubao-seedream-4-5-251128")[0].note ?? "", /官方仅支持 2K \/ 4K/u);
  assert.match(domesticImageModelResolutionOptions("doubao-seedream-4-5-251128")[0].note ?? "", /切换 Qwen Image 2.0 Pro/u);
  assert.equal(normalizeDomesticImageResolution("doubao-seedream-5-0-pro-260628", "4K"), "2K");
  const legacyTemplateModel = normalizeKnownDomesticImageModel("seedream") ?? "doubao-seedream-5-0-pro-260628";
  assert.equal(normalizeDomesticImageResolution(legacyTemplateModel, "1K"), "2K");
});

test("all three workbenches derive resolution choices from the selected model", async () => {
  const paths = [
    "../../components/studio/InteriorStudio.tsx",
    "../../components/studio/AdvancedStudio.tsx",
    "../../components/studio/SelfServiceStudio.tsx",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.ok(sources.every((source) => /imageModelResolutionOptions/u.test(source) && /normalizeImageResolution/u.test(source)));
  assert.ok(sources.slice(0, 2).every((source) => /normalizeKnownImageModel/u.test(source) && /normalizeImageResolution\(templateProvider,\s*config\.resolution\)/u.test(source) && !/normalizeDomesticImageModel\(/u.test(source)));
  for (const source of sources) {
    assert.match(source, /<Segmented label="清晰度"/u);
    assert.match(source, /<Segmented label="画面比例"/u);
    assert.doesNotMatch(source, /<SelectField label="清晰度"|<SelectField label="画面比例"/u);
    assert.match(source, /disabledDescription="当前模型不支持的清晰度已禁用。"/u);
  }
  assert.match(sources[2], /nearestAspectRatio\(references\[0\]\)/u);
  assert.match(sources[2], /label="画面比例"[\s\S]*disabled: true[\s\S]*当前自动比例[\s\S]*画面比例自动匹配，不可手动修改/u);
  assert.ok(sources.every((source) => /ImageModelSelect value=\{provider\}/u.test(source) && /QualityField model=\{provider\}/u.test(source)));
  const fields = await readFile(new URL("../../components/studio/StudioFields.tsx", import.meta.url), "utf8");
  assert.match(fields, /ImageModelSelect[\s\S]*ModelCapabilityDetails model=\{value\}/u);
  assert.match(sources[2], /restoreSelfServiceResolution\(nextProvider, config\)/u);
  assert.doesNotMatch(sources[2], /domesticImageModelQualityResolution/u);
  assert.match(fields, /imageModelOptions\.filter\(option => privateTest === true \|\| isDomesticImageModel\(option\.value\)\)/u);
  assert.match(fields, /available\.map/u);
  assert.match(fields, /disabled=\{privateTest === undefined\}/u);
  assert.doesNotMatch(fields, /onChange\("doubao-seedream-4-5-251128"\)/u);
  assert.ok(sources.every((source) => !/setProvider\("doubao-seedream-4-5-251128"\)/u.test(source)));
});

test("reference files stay browser-local until generation submission", async () => {
  const [field, drafts, tray, uploadRoute, appShell, meRoute] = await Promise.all([
    readFile(new URL("../../components/studio/StudioFields.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/studio/browser-drafts.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/studio/ReferenceTray.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/assets/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../components/site/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/me/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(field, /uploadAsset/u);
  assert.match(field, /saveDraftImage[\s\S]*image\/jpeg,image\/png,image\/webp/u);
  assert.match(drafts, /submitGenerationDraft[\s\S]*uploadAsset[\s\S]*submitGeneration/u);
  assert.match(drafts, /sessionStorage[\s\S]*indexedDB/u);
  assert.match(drafts, /function sessionId\(\)[\s\S]*sessionStorage\.getItem\(SESSION_KEY\)[\s\S]*return id/u);
  assert.doesNotMatch(drafts, /window\.name|TAB_NAME_PREFIX/u);
  assert.match(drafts, /loadDraftImage[\s\S]*!value\.savedAt[\s\S]*DRAFT_TTL_MS[\s\S]*store\.delete\(id\)[\s\S]*return undefined/u);
  assert.match(drafts, /clearBrowserDrafts[\s\S]*key\.startsWith\(PENDING_PREFIX\)[\s\S]*localStorage\.removeItem\(key\)/u);
  assert.match(drafts, /pending\.draftScope !== scope[\s\S]*localStorage\.removeItem\(key\)[\s\S]*continue/u);
  assert.match(drafts, /if \(!scope \|\| pending\.draftScope !== scope\)[\s\S]*clearPending\(submitFingerprint\)/u);
  assert.match(drafts, /assetFields[\s\S]*additionalReferences/u);
  assert.doesNotMatch(drafts, /Object\.values\(value\)/u);
  assert.match(drafts, /forgetUploads\(id\)/u);
  assert.match(drafts, /for \(const item of created\) uploaded\.delete\(cacheKey\(item\.localId, variant\)\)/u);
  assert.match(drafts, /cacheKey\(id, variant\)[\s\S]*pngCopy/u);
  assert.match(drafts, /pending\.resolvedPayload[\s\S]*idempotencyKey/u);
  assert.match(drafts, /recoverPendingSubmissions[\s\S]*draftScope[\s\S]*definiteSubmissionRejection/u);
  assert.match(drafts, /if \(!scope \|\| pending\.draftScope !== scope\)[\s\S]*clearPending\(submitFingerprint\)[\s\S]*crypto\.randomUUID/u);
  assert.match(drafts, /pending\.resolvedPayload[\s\S]*draftScope: pending\.draftScope/u);
  assert.match(drafts, /definiteSubmissionRejection[\s\S]*deleteAsset/u);
  assert.match(uploadRoute, /idempotency-key[\s\S]*createHash[\s\S]*sameUpload/u);
  assert.match(meRoute, /draftScope:\s*hashIdentifier/u);
  assert.match(appShell, /syncBrowserDraftScope[\s\S]*recoverPendingSubmissions/u);
  assert.match(tray, /maxInputImages[\s\S]*添加参考图[\s\S]*inputCount > maxInputImages/u);
  assert.match(tray, /局部选区[\s\S]*尚不会随任务发送[\s\S]*不参与本次生成/u);
  assert.match(tray, /selection-example[\s\S]*标注示意/u);
});

test("official preview templates use a Seedream-supported resolution", async () => {
  const source = await readFile(new URL("../../app/api/templates/route.ts", import.meta.url), "utf8");
  assert.match(source, /providerPreference: "doubao-seedream-5-0-pro-260628", resolution: "2K"/u);
});
