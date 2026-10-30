import { NEW_STYLE_DATA, NEW_SCHEME_DATA } from "../../lib/ai/design-schemes-new-styles";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { compileInteriorPrompt, PROMPT_TEMPLATE_VERSION, ADVANCED_PROMPT_TEMPLATE_VERSION, SELF_SERVICE_PROMPT_TEMPLATE_VERSION } from "../../lib/ai/prompt";
import { STYLE_PRESETS } from "../../lib/ai/styles";
import { parseJob } from "../../components/site/api";
import { parseCreateJobInput, isCompatibleReplayHash } from "../../lib/server/job-contract";

const legacyStyles = STYLE_PRESETS.filter(style => !NEW_STYLE_DATA.some(added => added.id === style.id));
assert.equal(legacyStyles.length, 12);
assert.ok(NEW_STYLE_DATA.every(style => NEW_SCHEME_DATA.some(scheme => scheme.styleId === style.id)));

const base = (overrides: Record<string, unknown> = {}) => ({
  workflowType: "concept", purpose: "final", sourceAssetId: "source", stylePresetId: "modern-minimalist",
  lightingPreset: "noon", preservationMode: "structure", providerPreference: "doubao-seedream-5-0-pro-260628", outputCount: 1,
  resolution: "1K", aspectRatio: "4:3", quality: "standard", lampState: "mixed", colorTemperatureKelvin: 4000,
  idempotencyKey: "visual-key-123", ...overrides,
});

test("visual realism defaults to photorealistic and accepts four levels", () => {
  assert.equal(parseCreateJobInput(base()).visualRealism, "photorealistic");
  for (const level of ["conceptual", "rendered", "realistic", "photorealistic"] as const) {
    const parsed = parseCreateJobInput(base({ visualRealism: level }));
    assert.equal(parsed.visualRealism, level);
    assert.equal(parsed.visualRealismProvided, true);
  }
});

test("visual realism rejects invalid and inapplicable workflows", () => {
  assert.throws(() => parseCreateJobInput(base({ visualRealism: "cinematic" })), /visualRealism/u);
  for (const workflowType of ["floorplan", "self-service"]) {
    assert.throws(() => parseCreateJobInput(base({ workflowType, visualRealism: "realistic", ...(workflowType === "self-service" ? { customPrompt: "a room" } : {}) })), /visualRealism/u);
  }
});

test("visual realism participates in hashes and explicit non-default never reuses old hashes", () => {
  const old = parseCreateJobInput(base());
  const selected = parseCreateJobInput(base({ visualRealism: "conceptual" }));
  assert.notEqual(old.requestHash, selected.requestHash);
  assert.equal(isCompatibleReplayHash(selected, old.requestHash), false);
  assert.equal(isCompatibleReplayHash(old, old.preVisualRealismRequestHash), true);
  assert.equal(isCompatibleReplayHash(selected, selected.preVisualRealismRequestHash), false);
});

test("space type never reuses a historical hash for a different room", () => {
  const old = parseCreateJobInput(base());
  const bedroom = parseCreateJobInput(base({ spaceType: "bedroom" }));
  assert.notEqual(old.requestHash, bedroom.requestHash);
  for (const historicalHash of [old.preSpaceTypeRequestHash, old.preVisualRealismRequestHash, old.previousRequestHash, old.legacyRequestHash]) {
    assert.equal(isCompatibleReplayHash(bedroom, historicalHash), false);
  }
  assert.equal(isCompatibleReplayHash(old, old.preSpaceTypeRequestHash), true);
  assert.equal(isCompatibleReplayHash(old, old.preVisualRealismRequestHash), true);
});

test("templates declare visual realism only for concept and advanced", async () => {
  const source = await readFile(new URL("../../lib/server/templates.ts", import.meta.url), "utf8");
  assert.match(source, /visualRealism:\s*\["conceptual", "rendered", "realistic", "photorealistic"\]/u);
  assert.match(source, /config\.visualRealism !== undefined && workflowType !== "concept" && workflowType !== "advanced"/u);
});

test("client job parsing keeps only supported visual realism values", () => {
  assert.equal(parseJob({ id: "job", status: "SUCCEEDED", workflowType: "concept", visualRealism: "realistic", results: [] }).visualRealism, "realistic");
  assert.equal(parseJob({ id: "job", status: "SUCCEEDED", visualRealism: "unknown", results: [] }).visualRealism, undefined);
});

test("concept ignores legacy visual realism levels and always compiles the photo-level directive", () => {
  const request = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const, resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 }, renovationScope: "restyle" as const, outputCount: 1 };
  const style = { id: "modern-minimalist", name: "现代", description: "", preview: "", promptDirective: "modern" };
  const prompts = ["conceptual", "rendered", "realistic", "photorealistic"].map((visualRealism) => compileInteriorPrompt({ ...request, visualRealism: visualRealism as never }, style).text);
  assert.equal(new Set(prompts).size, 1);
  assert.match(prompts[0]!, /photograph-level|实景摄影|室内摄影/u);
});

test("lamp-off prompt forbids artificial glow and omits conflicting color temperature", () => {
  const request = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const, resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day" as const, lampState: "off" as const, colorTemperatureKelvin: 4000 }, renovationScope: "restyle" as const, outputCount: 1 };
  const style = { id: "modern-minimalist", name: "现代", description: "", preview: "", promptDirective: "modern" };
  const offPrompts = (["dawn", "day", "overcast", "dusk", "night"] as const).map((timeOfDay) => compileInteriorPrompt({ ...request, lighting: { ...request.lighting, timeOfDay } }, style).text);
  const on = compileInteriorPrompt({ ...request, lighting: { ...request.lighting, lampState: "on" as const } }, style).text;
  for (const off of offPrompts) {
    assert.match(off, /completely unlit:[^\n]*no glow[^\n]*only with the selected natural-light condition/u);
    assert.doesNotMatch(off, /interior lighting|practical interior lighting|target color temperature|4000K/u);
  }
  assert.match(on, /target color temperature 4000K/u);
});

test("v12 concept keeps style identity while advanced is neutral and both preserve windows", () => {
  const common = {
    sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const },
    purpose: "final" as const, resolution: "1K" as const, aspectRatio: "4:3" as const,
    quality: "standard" as const, lighting: { timeOfDay: "day" as const, lampState: "off" as const, colorTemperatureKelvin: 4000 },
    renovationScope: "restyle" as const, outputCount: 1,
  };
  for (const style of STYLE_PRESETS) {
    const concept = compileInteriorPrompt({ ...common, workflowType: "concept", style: { presetId: style.id } }, style);
    const advanced = compileInteriorPrompt({ ...common, workflowType: "advanced", style: { presetId: style.id } }, style);
    assert.match(concept.text, new RegExp(style.promptDirective, "u"));
    assert.doesNotMatch(advanced.text, new RegExp(style.promptDirective, "u"));
    for (const prompt of [concept, advanced]) {
      assert.match(prompt.text, /Keep every existing door and window opening at its original position, size, and proportions/u);
      assert.match(prompt.text, /Retain any necessary fall-protection function/u);
      assert.doesNotMatch(prompt.text, /remove original window frames|remove old frames or visible iron bars|watermark/iu);
      assert.equal(prompt.templateVersion, prompt === advanced ? ADVANCED_PROMPT_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION);
    }
  }
  const floorplan = compileInteriorPrompt({ ...common, workflowType: "floorplan", style: { presetId: "modern-minimalist" } }, STYLE_PRESETS[0]);
  const selfService = compileInteriorPrompt({ ...common, workflowType: "self-service", style: { presetId: "modern-minimalist" }, customPrompt: "a room" }, STYLE_PRESETS[0]);
  assert.doesNotMatch(floorplan.text, /style system|room-specific completion/u);
  assert.equal(floorplan.templateVersion, "interior-floorplan-v7");
  assert.equal(PROMPT_TEMPLATE_VERSION, "interior-concept-v12");
  assert.equal(selfService.templateVersion, SELF_SERVICE_PROMPT_TEMPLATE_VERSION);
});

test("new-Chinese room styling is modern, room-specific, and limited to full restyle", () => {
  const style = STYLE_PRESETS.find((preset) => preset.id === "new-chinese")!;
  const base = {
    sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const,
    resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const,
    style: { presetId: style.id }, lighting: { timeOfDay: "day" as const, lampState: "off" as const, colorTemperatureKelvin: 4000 }, outputCount: 1,
  };
  const living = compileInteriorPrompt({ ...base, spaceType: "living-room", renovationScope: "restyle" }, style).text;
  const bedroom = compileInteriorPrompt({ ...base, spaceType: "bedroom", renovationScope: "restyle" }, style).text;
  const soft = compileInteriorPrompt({ ...base, spaceType: "bedroom", renovationScope: "replace-soft-furnishings" }, style).text;
  for (const prompt of [living, bedroom]) {
    assert.match(prompt, /original position, size, and proportions/u);
    assert.match(prompt, /Retain any necessary fall-protection function/u);
    assert.doesNotMatch(prompt, /dark wood lattice|lantern pendant|simplified Ming-frame bed/u);
    assert.match(prompt, /fixtures remain physically present but emit no light/u);
  }
  assert.match(living, /lounge chair and sofa-side table/u);
  assert.match(living, /art above the sofa[^\n]*TV wall\/media console/u);
  assert.match(bedroom, /modern main ceiling light, matching bedside lamps on both sides of the bed/u);
  assert.match(bedroom, /artwork above the headboard/u);
  assert.doesNotMatch(soft, /New-Chinese windows|modern main ceiling light|lighting \(/u);
  assert.match(soft, /Preserve the existing walls, wainscoting, ceiling, floor, window frames/u);
});

test("all twelve styles provide room-specific furnishings and compile only the selected room", () => {
  const rooms = ["living-room", "corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study"] as const;
  for (const style of legacyStyles) for (const room of rooms) {
    const candidates = style.roomFurniture?.[room];
    assert.ok(candidates && candidates.length >= 3 && candidates.length <= 6, `${style.id}/${room}`);
    if (room === "bedroom") assert.ok(candidates.slice(0, 3).every((candidate) => candidate.includes("bed")), `${style.id} needs bed alternatives`);
  }
  const style = STYLE_PRESETS[0];
  const base = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const, resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: style.id }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 }, renovationScope: "restyle" as const, outputCount: 1 };
  const bedroom = compileInteriorPrompt({ ...base, spaceType: "bedroom" }, style).text;
  assert.match(bedroom, /low upholstered platform bed/u);
  assert.doesNotMatch(bedroom, /flush media cabinet|handleless base cabinets/u);
  const kitchen = compileInteriorPrompt({ ...base, spaceType: "kitchen" }, style).text;
  assert.match(kitchen, /handleless base cabinets/u);
  assert.doesNotMatch(kitchen, /low upholstered platform bed/u);
});

test("advanced renovation scope limits hard finishes and window changes without a hidden preset", () => {
  const style = STYLE_PRESETS[0];
  const base = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "advanced" as const, resolution: "1K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: style.id }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 }, outputCount: 1 };
  const restyle = compileInteriorPrompt({ ...base, renovationScope: "restyle" }, style).text;
  assert.match(restyle, /Complete all editable wall, ceiling, and floor finishes coherently/u);
  assert.match(restyle, /Update frame finishes or detailing only within the existing opening/u);
  for (const renovationScope of ["replace-soft-furnishings", "empty-room", "local-edit"] as const) {
    const text = compileInteriorPrompt({ ...base, renovationScope }, style).text;
    assert.match(text, /Preserve existing frames and safety guards outside the permitted edit area/u);
    assert.doesNotMatch(text, /Update frame finishes|warm-white paint|style system/u);
  }
});

test("queue items vary within each style, while style references and room constraints take precedence", () => {
  const base = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" as const }, workflowType: "concept" as const, resolution: "2K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: "new-chinese" }, lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 }, renovationScope: "restyle" as const, outputCount: 1 };
  for (const style of legacyStyles) {
    const prompts = ["a", "b", "c"].map((variationKey) => compileInteriorPrompt({ ...base, variationKey, style: { presetId: style.id }, spaceType: "living-room" }, style).text);
    assert.equal(new Set(prompts).size, 3, style.id);
    assert.equal(new Set(prompts.map((prompt) => prompt.match(/walls \(([^)]*)\), floors \(([^)]*)\), ceilings \(([^)]*)\)/u)?.[0])).size, 3, `${style.id} needs distinct finish sets`);
    assert.ok(new Set(prompts.map((prompt) => prompt.match(/reinterpret these room-appropriate functional roles with ([^,]+)/u)?.[1])).size >= 2, `${style.id} needs furniture-form variation`);
    for (const prompt of prompts) assert.match(prompt, /TV wall|电视柜两侧/u);
    for (const prompt of prompts) assert.match(prompt, /accent lighting only, plus a style-matched main ceiling fixture and room-appropriate auxiliary or task lighting/u);
    const bedroom = compileInteriorPrompt({ ...base, variationKey: "b", style: { presetId: style.id }, spaceType: "bedroom" }, style).text;
    assert.doesNotMatch(bedroom, /selected furniture emphasis:|furniture \([^)]*\bsofa\b/u, `${style.id} bedroom must not inherit living-room furniture`);
    for (const room of ["kitchen", "bathroom"] as const) for (const variationKey of ["a", "b", "c"]) {
      const wet = compileInteriorPrompt({ ...base, variationKey, style: { presetId: style.id }, spaceType: room }, style).text;
      assert.match(wet, /walls \([^)]*marble-look porcelain[^)]*tile\), floors \([^)]*marble-look porcelain[^)]*tile\)/u, `${style.id}/${room}/${variationKey}`);
      assert.match(wet, /Floor finish must be matte, slip-resistant, and suitable for water exposure; never polished or slippery/u);
      assert.doesNotMatch(wet, /floors \([^)]*(?:wood|timber|ceramic|travertine|terrazzo|polished)/iu);
    }
  }
  const style = STYLE_PRESETS.find((preset) => preset.id === "new-chinese")!;
  assert.equal(compileInteriorPrompt({ ...base, variationKey: "a", spaceType: "living-room" }, style).text, compileInteriorPrompt({ ...base, variationKey: "a", spaceType: "living-room" }, style).text);
  const kitchen = compileInteriorPrompt({ ...base, variationKey: "a", spaceType: "kitchen" }, style).text;
  assert.match(kitchen, /墙面与地面必须是适合厨房的大理石或大理石纹瓷砖/u);
  assert.match(kitchen, /防潮石膏板平吊顶和多个嵌入式射灯/u);
  assert.doesNotMatch(kitchen, /floors \(natural oak\)|floors \(dark timber\)/u);
  assert.doesNotMatch(kitchen, /lighting \([^)]*floor lamp|textiles \(/u);
  assert.match(kitchen, /wet-room requirements override conflicting style defaults or style-reference materials/u);
  assert.doesNotMatch(kitchen, /Include a style-matched main light or primary fixture and restrained flowers, decor, floor lamps/u);
  const bathroom = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "bathroom" }, style).text;
  assert.match(bathroom, /洗手台正上方必须是镜子而不是挂画/u);
  assert.match(bathroom, /内嵌暖风\/排风设备/u);
  assert.doesNotMatch(bathroom, /lighting \([^)]*floor lamp|textiles \(/u);
  const study = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "study" }, style).text;
  assert.match(study, /至少一面满墙通高书柜/u);
  assert.match(study, /furniture \([^)]*full-height wall bookcase/u);
  assert.doesNotMatch(study, /open timber bookshelves/u);
  const dining = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "dining-room" }, style).text;
  assert.match(dining, /不添加窗帘/u);
  assert.doesNotMatch(dining, /tailored sheer curtains/u);
  const referenced = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "living-room", referenceImages: [{ role: "style", image: base.sourceImage }] }, style).text;
  assert.match(referenced, /style-reference image is the primary guide/u);
  assert.doesNotMatch(referenced, /Coordinate a restrained selection of finishes and objects/u);
  const legacyReferenced = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "living-room", referenceImages: [base.sourceImage] }, style).text;
  assert.match(legacyReferenced, /style-reference image is the primary guide/u);
  assert.doesNotMatch(legacyReferenced, /Coordinate a restrained selection of finishes and objects/u);
  const furnishingOnly = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "living-room", referenceImages: [{ role: "furnishing", image: base.sourceImage }] }, style).text;
  assert.match(furnishingOnly, /Coordinate a restrained selection of finishes and objects/u);
  const referencedBathroom = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "bathroom", referenceImages: [{ role: "style", image: base.sourceImage }] }, style).text;
  assert.match(referencedBathroom, /derive coordinated marble or marble-look porcelain tile colors and veining from the supplied style reference/u);
  assert.doesNotMatch(referencedBathroom, /ink-gray subtle-white-veined marble-look porcelain|beige flowing-gray-veined marble-look porcelain/u);
  const restricted = compileInteriorPrompt({ ...base, variationKey: "b", spaceType: "bathroom", renovationScope: "replace-soft-furnishings" }, style).text;
  assert.doesNotMatch(restricted, /Wet-room finish selection|防潮石膏板平吊顶/u);
});
