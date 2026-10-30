import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseStyles } from "../../components/site/api";
import { saveParameterDraft, loadParameterDraft } from "../../components/studio/browser-drafts";
import type { GenerateInteriorImagesRequest } from "../../lib/ai/types";
import { createHash } from "node:crypto";
import { allDesignSchemes, allLegacyDesignSchemes, firstDesignScheme, getDesignScheme, listPublicDesignSchemes } from "../../lib/ai/design-schemes";
import { STYLE_PRESETS, getStylePreset } from "../../lib/ai/styles";
import { compileInteriorPrompt, PROMPT_TEMPLATE_VERSION, V2_PROMPT_TEMPLATE_VERSION, V3_PROMPT_TEMPLATE_VERSION, V4_PROMPT_TEMPLATE_VERSION, MODERN_WALNUT_PROMPT_TEMPLATE_VERSION, FRENCH_SAGE_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V4_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V5_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V6_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V7_PROMPT_TEMPLATE_VERSION } from "../../lib/ai/prompt";
import { isCompatibleReplayHash, parseCreateJobInput } from "../../lib/server/job-contract";
import { V8_SHARED, V8_STYLES, V8_RECIPES } from "../../lib/ai/design-schemes-v8";
import { V9_SHARED, V9_CEILINGS } from "../../lib/ai/design-schemes-v9";
import { V10_LAMPS } from "../../lib/ai/design-schemes-v10";
import { NEW_STYLE_DATA, NEW_SCHEME_DATA } from "../../lib/ai/design-schemes-new-styles";
import { domesticImageModelValues } from "../../lib/domain/domestic-image-models";
import { withInputLegend } from "../../lib/ai/providers/domestic-common";

const oldCurrentSchemes = () => allDesignSchemes().filter((scheme) => Object.hasOwn(V8_STYLES, scheme.styleId));
const v2Schemes = () => oldCurrentSchemes().map((scheme) => getDesignScheme(scheme.id.replace(/-v10$/u, "-v2"))!);
const v8Schemes = () => oldCurrentSchemes().map((scheme) => getDesignScheme(scheme.id.replace(/-v10$/u, "-v8"))!);
const v9Schemes = () => oldCurrentSchemes().map((scheme) => getDesignScheme(scheme.id.replace(/-v10$/u, "-v9"))!);

const base = { workflowType: "concept", sourceAssetId: "source", stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure", providerPreference: "doubao-seedream-4-5-251128", outputCount: 1, idempotencyKey: "scheme-test-key" };
const prompt = (workflowType: "concept" | "advanced" | "floorplan", stylePresetId: string, designSchemeId?: string, scope: "restyle" | "replace-soft-furnishings" = "restyle", spaceType: "living-room" | "kitchen" = "living-room", customPrompt?: string) => compileInteriorPrompt({ sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType, style: { presetId: stylePresetId }, designSchemeId, resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay: "day", lampState: "off", colorTemperatureKelvin: 4000 }, renovationScope: scope, spaceType, customPrompt, outputCount: 1 }, getStylePreset(stylePresetId)!).text;

test("all 17 styles expose six distinct public palette cards without recipe prose", () => {
  assert.equal(allDesignSchemes().length, 102);
  assert.equal(oldCurrentSchemes().length, 72);
  assert.equal(new Set(allDesignSchemes().map((scheme) => scheme.id)).size, 102);
  assert.equal(allLegacyDesignSchemes().length, 72);
  assert.equal(new Set([...allDesignSchemes(), ...allLegacyDesignSchemes()].map((scheme) => scheme.id)).size, 174);
  for (const style of STYLE_PRESETS) {
    const cards = listPublicDesignSchemes(style.id);
    assert.equal(cards.length, 6);
    assert.equal(cards[0].id, firstDesignScheme(style.id)?.id);
    for (const card of cards) {
      assert.equal(getDesignScheme(card.id)?.styleId, style.id);
      assert.equal(card.palette.length, 3);
      assert.ok(card.name && card.description);
      const previous = card.previousVersionId ? getDesignScheme(card.previousVersionId) : undefined;
      for (const id of card.legacyVersionIds ?? []) { assert.equal(getDesignScheme(id)?.styleId, style.id); assert.equal(parseCreateJobInput({ ...base, stylePresetId: style.id, designSchemeId: id }).designSchemeId, id); }
      if (previous) {
        assert.equal(previous.styleId, style.id);
        assert.equal(previous.name, card.name);
        assert.equal(previous.description, card.description);
        assert.deepEqual(previous.palette, card.palette);
        assert.deepEqual(Object.keys(card).sort(), ["description", "id", "name", "palette", "previousVersionId", "legacyVersionIds"].sort());
      } else {
        assert.ok(card.id.endsWith("-v1"));
        assert.deepEqual(card.legacyVersionIds, []);
        assert.deepEqual(Object.keys(card).sort(), ["description", "id", "name", "palette", "legacyVersionIds"].sort());
      }
    }
  }
});

test("concept scheme is parent validated, hashed, and old explicit replay cannot change scheme", () => {
  const old = parseCreateJobInput({ ...base, spaceType: "living-room" });
  assert.equal(old.designSchemeId, "modern-minimalist-01-v2");
  assert.equal(isCompatibleReplayHash(old, old.preSchemeRequestHash), true);
  assert.equal(old.preV2DefaultSchemeRequestHash, parseCreateJobInput({ ...base, spaceType: "living-room", designSchemeId: "modern-minimalist-01-v1" }).requestHash);
  assert.equal(isCompatibleReplayHash(old, old.preV2DefaultSchemeRequestHash!), true);
  assert.equal(isCompatibleReplayHash(parseCreateJobInput({ ...base, spaceType: "living-room", designSchemeId: "modern-minimalist-01-v2" }), old.preV2DefaultSchemeRequestHash!), false);
  assert.equal(isCompatibleReplayHash(parseCreateJobInput({ ...base, spaceType: "bedroom" }), old.preV2DefaultSchemeRequestHash!), false);
  const selected = parseCreateJobInput({ ...base, spaceType: "living-room", designSchemeId: "modern-minimalist-02-v1" });
  assert.notEqual(selected.requestHash, old.requestHash);
  assert.equal(isCompatibleReplayHash(selected, old.requestHash), false);
  assert.throws(() => parseCreateJobInput({ ...base, designSchemeId: "new-chinese-01-v1" }), /不属于当前风格/u);
  assert.throws(() => parseCreateJobInput({ ...base, designSchemeId: "missing" }), /不属于当前风格/u);
  assert.throws(() => parseCreateJobInput({ ...base, depthAssetId: "depth" }), /仅适用于高级工作台/u);
});

test("old advanced and floorplan preset hashes replay without accepting changed semantics", () => {
  const legacy = { ...base, sourceAssetId: "src", stylePresetId: "modern-minimalist", idempotencyKey: "existing-key-123" };
  const oldAdvancedHash = "10e68b9f14f2fc54efb12f8907f23dbcee9e9b2c07b326c4a7c84b16d8380bd9";
  const oldFloorplanHash = "883ed3c2d3b56299e31b37b8f3b8b25840e55819c36b859f9e70ab6061dfb23d";
  const advanced = parseCreateJobInput({ ...legacy, workflowType: "advanced" });
  const floorplan = parseCreateJobInput({ ...legacy, workflowType: "floorplan" });
  assert.equal(advanced.preNeutralStyleRequestHash, oldAdvancedHash);
  assert.equal(floorplan.preNeutralStyleRequestHash, oldFloorplanHash);
  assert.equal(isCompatibleReplayHash(advanced, oldAdvancedHash), true);
  assert.equal(isCompatibleReplayHash(floorplan, oldFloorplanHash), true);
  assert.equal(isCompatibleReplayHash(parseCreateJobInput({ ...legacy, workflowType: "advanced", customPrompt: "new brief" }), oldAdvancedHash), false);
  assert.equal(isCompatibleReplayHash(parseCreateJobInput({ ...legacy, workflowType: "advanced", spaceType: "living-room" }), oldAdvancedHash), false);
  assert.equal(isCompatibleReplayHash(parseCreateJobInput({ ...legacy, workflowType: "floorplan", lightingPreset: "night" }), oldFloorplanHash), false);
  assert.equal(parseCreateJobInput({ ...legacy, workflowType: "advanced", stylePresetId: "unknown" }).preNeutralStyleRequestHash, null);
  assert.throws(() => parseCreateJobInput({ ...legacy, workflowType: "advanced", designSchemeId: "modern-minimalist-01-v1" }), /仅适用于概念工作台/u);
});

test("selected scheme freezes coordinated materials and obeys room and edit scope", () => {
  const scheme = getDesignScheme("modern-minimalist-02-v1")!;
  const whole = prompt("concept", scheme.styleId, scheme.id);
  assert.match(whole, new RegExp(scheme.walls, "u"));
  assert.match(whole, new RegExp(scheme.floor, "u"));
  assert.match(whole, /original position, size, and proportions/u);
  assert.doesNotMatch(whole, /remove original window frames/u);
  const kitchen = prompt("concept", scheme.styleId, scheme.id, "restyle", "kitchen");
  assert.match(kitchen, new RegExp(scheme.wet, "u"));
  assert.doesNotMatch(kitchen, new RegExp(scheme.floor, "u"));
  assert.doesNotMatch(kitchen, /textiles \(/u);
  const bathroom = compileInteriorPrompt({ sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType: "concept", style: { presetId: scheme.styleId }, designSchemeId: scheme.id, resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay: "day", lampState: "off", colorTemperatureKelvin: 4000 }, renovationScope: "restyle", spaceType: "bathroom", outputCount: 1 }, getStylePreset(scheme.styleId)!).text;
  assert.doesNotMatch(bathroom, new RegExp(scheme.furniture, "u"));
  assert.match(bathroom, /No upholstered furniture, loose textiles, floor lamps or floor planters in wet or cooking zones/u);
  const movable = prompt("concept", scheme.styleId, scheme.id, "replace-soft-furnishings");
  assert.doesNotMatch(movable, new RegExp(scheme.walls, "u"));
  assert.doesNotMatch(movable, new RegExp(scheme.floor, "u"));
});

test("preview promotion purpose survives selected scheme and neutral workflows", () => {
  const sourceImage = { bytes: new Uint8Array([1]), mimeType: "image/png" as const };
  const shared = { sourceImage, resolution: "2K" as const, aspectRatio: "4:3" as const, quality: "standard" as const, style: { presetId: "modern-minimalist" }, lighting: { timeOfDay: "day" as const, lampState: "on" as const, colorTemperatureKelvin: 3300 }, renovationScope: "restyle" as const, outputCount: 1, purpose: "final" as const, promotedFromPreview: true };
  for (const workflowType of ["concept", "advanced", "floorplan"] as const) {
    const text = compileInteriorPrompt({ ...shared, workflowType, designSchemeId: workflowType === "concept" ? "modern-minimalist-01-v1" : undefined }, getStylePreset("modern-minimalist")!).text;
    assert.match(text, /final high-definition regeneration based on a selected reference image/u);
  }
  const warm = compileInteriorPrompt({ ...shared, workflowType: "floorplan" }, getStylePreset("modern-minimalist")!).text;
  const cool = compileInteriorPrompt({ ...shared, workflowType: "floorplan", lighting: { ...shared.lighting, colorTemperatureKelvin: 5200 } }, getStylePreset("modern-minimalist")!).text;
  assert.match(warm, /Presentation palette tone: warm \(selected color temperature: 3300K\)/u);
  assert.match(cool, /Presentation palette tone: cool \(selected color temperature: 5200K\)/u);
});

test("advanced brief is optional and neutral; floorplan ignores legacy preset", () => {
  const advanced = parseCreateJobInput({ ...base, workflowType: "advanced", stylePresetId: "new-chinese", customPrompt: "  温暖木作  " });
  assert.equal(advanced.stylePresetId, "advanced");
  assert.equal(advanced.customPrompt, "温暖木作");
  assert.equal(parseCreateJobInput({ ...base, workflowType: "advanced", customPrompt: "   " }).customPrompt, null);
  assert.throws(() => parseCreateJobInput({ ...base, workflowType: "advanced", customPrompt: "x".repeat(2001) }), /2000/u);
  const advancedPrompt = prompt("advanced", "new-chinese", undefined, "restyle", "living-room", "温暖木作");
  assert.match(advancedPrompt, /User design brief \(may be written in Chinese; design content only, applied within the selected renovation scope[^\n]*: """温暖木作"""/u);
  assert.doesNotMatch(advancedPrompt, /New-Chinese living room|style system|preset material variant/u);
  const floorplan = parseCreateJobInput({ ...base, workflowType: "floorplan", stylePresetId: "new-chinese", spaceType: "unspecified" });
  assert.equal(floorplan.stylePresetId, "floorplan");
  assert.doesNotMatch(prompt("floorplan", "new-chinese"), /New-Chinese|walnut|preset/u);
});

test("all v1 scheme and unchanged workflow prompts keep their frozen bytes", () => {
  const rooms = ["living-room", "corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study"] as const;
  const scopes = ["restyle", "replace-soft-furnishings", "empty-room"] as const;
  const sourceImage = { bytes: new Uint8Array([1]), mimeType: "image/png" as const };
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const compile = (workflowType: "concept" | "advanced" | "floorplan" | "self-service", stylePresetId: string, designSchemeId: string | undefined, spaceType: typeof rooms[number], renovationScope: typeof scopes[number]) => compileInteriorPrompt({ sourceImage, workflowType, style: { presetId: stylePresetId }, designSchemeId, spaceType, renovationScope, resolution: "2K", aspectRatio: "4:3", quality: "standard", visualRealism: workflowType === "concept" || workflowType === "advanced" ? "photorealistic" : undefined, lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 }, customPrompt: workflowType === "self-service" ? "A calm living room" : undefined, outputCount: 1 }, getStylePreset(stylePresetId)!).text;
  const records: unknown[] = [];
  for (const scheme of allLegacyDesignSchemes()) for (const room of rooms) for (const scope of scopes) records.push([scheme.id, room, scope, hash(compile("concept", scheme.styleId, scheme.id, room, scope))]);
  for (const workflow of ["concept", "advanced", "floorplan", "self-service"] as const) records.push([workflow, "legacy-no-scheme", "living-room", "restyle", hash(compile(workflow, "modern-minimalist", undefined, "living-room", "restyle"))]);
  assert.equal(records.length, 1516);
  // interior-concept-v27 / self-service-v2 changed only the advanced and self-service records; all concept and floorplan bytes are unchanged.
  assert.equal(hash(JSON.stringify(records)), "991c908333d6692fe242516f2fafcf2d13161130db881e1eaa23e56fdc2cd9fb");
  assert.equal(PROMPT_TEMPLATE_VERSION, "interior-concept-v12");
});

test("v2 compiles all 72 real style pairs across seven rooms, three scopes and day/night lamp states", () => {
  const rooms = ["living-room", "corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study"] as const;
  const scopes = ["restyle", "replace-soft-furnishings", "empty-room"] as const;
  const heads: Record<string, string> = { "modern-minimalist": "Modern minimalism:", "cream-cozy": "Cream contemporary:", "wabi-sabi": "Wabi-sabi:", "italian-minimalist": "Italian minimalism:", "contemporary-luxury": "Contemporary light luxury:", "nordic-natural": "Nordic natural:", "new-chinese": "Contemporary new-Chinese:", "mid-century-modern": "Mid-century modern:", japandi: "Japandi:", "french-modern": "Modern French:", "industrial-loft": "Refined industrial:", "coastal-relaxed": "Relaxed coastal:" };
  let count = 0;
  let maxWords = 0;
  for (const scheme of v2Schemes()) for (const room of rooms) for (const scope of scopes) for (const timeOfDay of ["day", "night"] as const) for (const lampState of ["on", "off"] as const) {
    const whole = scope === "restyle";
    const wet = room === "kitchen" || room === "bathroom";
    const style = getStylePreset(scheme.styleId)!;
    const compiled = compileInteriorPrompt({ sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType: "concept", style: { presetId: scheme.styleId }, designSchemeId: scheme.id, spaceType: room, renovationScope: scope, resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay, lampState, colorTemperatureKelvin: 4000 }, outputCount: 1 }, style);
    const text = compiled.text;
    count++;
    maxWords = Math.max(maxWords, (text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []).length);
    assert.equal(compiled.templateVersion, V2_PROMPT_TEMPLATE_VERSION);
    assert.ok(text.includes(heads[scheme.styleId]), `${scheme.id} missing its own style directive`);
    assert.ok(text.includes(scheme.paletteDirection!), `${scheme.id} missing its palette direction`);
    assert.ok(!text.includes(style.promptDirective), `${scheme.id} used the legacy style directive`);
    assert.match(text, /Keep the exact camera position[\s\S]*Source geometry and renovation scope take precedence[\s\S]*Lighting:[\s\S]*Selected scheme:/u);
    if (lampState === "off") assert.match(text, /Keep light fixtures present but unlit/u);
    else assert.match(text, /Selected color temperature: 4000K/u);
    if (timeOfDay === "night" && lampState === "off") assert.match(text, /naturally dim scene rather than inventing daylight or artificial glow/u);
    if (wet) {
      assert.doesNotMatch(text, new RegExp(scheme.textiles.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      if (whole) assert.ok(text.includes(scheme.wet));
      else assert.doesNotMatch(text, /Wet-area design:/u);
    } else if (whole) {
      assert.ok(text.includes(scheme.walls) && text.includes(scheme.floor) && text.includes(scheme.ceiling));
    } else {
      assert.doesNotMatch(text, /Finishes: walls/u);
    }
  }
  assert.equal(count, 6048);
  assert.ok(maxWords <= 700, `longest v2 prompt has ${maxWords} English words`);
});

test("v2 local edits stay inside the mask and do not request whole-room furnishings", () => {
  const scheme = v2Schemes()[0];
  const compiled = compileInteriorPrompt({ sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType: "concept", style: { presetId: scheme.styleId }, designSchemeId: scheme.id, spaceType: "bedroom", renovationScope: "local-edit", resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay: "night", lampState: "off", colorTemperatureKelvin: 4000 }, outputCount: 1 }, getStylePreset(scheme.styleId)!);
  assert.match(compiled.text, /inside the supplied mask/u);
  assert.match(compiled.text, /preserve unmasked illumination/u);
  assert.doesNotMatch(compiled.text, /Use one bed|Finishes: walls|Movable furniture language|Wet-area design:/u);
});

const oatRequest: GenerateInteriorImagesRequest = { sourceImage: { bytes: new Uint8Array([1]), mimeType: "image/png" }, workflowType: "concept", style: { presetId: "cream-cozy" }, designSchemeId: "cream-cozy-02-v3", providerPreference: "doubao-seedream-5-0-pro-260628", spaceType: "living-room", renovationScope: "restyle", visualRealism: "photorealistic", resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 }, outputCount: 1 };
const compileOat = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, ...overrides }, getStylePreset("cream-cozy")!);

test("v4 exposes one replacement card and preserves all previous IDs and frozen v2 text", () => {
  const card = listPublicDesignSchemes("cream-cozy").find((card) => card.id === "cream-cozy-02-v10")!;
  assert.equal(card.previousVersionId, "cream-cozy-02-v9");
  assert.deepEqual(card.legacyVersionIds, ["cream-cozy-02-v8", "cream-cozy-02-v4", "cream-cozy-02-v3", "cream-cozy-02-v2", "cream-cozy-02-v1"]);
  for (const id of [card.id, card.previousVersionId, ...card.legacyVersionIds!]) {
    assert.equal(getDesignScheme(id)?.name, "燕麦拿铁");
    assert.equal(parseCreateJobInput({ ...base, stylePresetId: "cream-cozy", designSchemeId: id }).designSchemeId, id);
  }
  const records = oldCurrentSchemes().map((scheme) => {
    const id = scheme.id.replace(/-v10$/u, "-v2");
    return [id, compileInteriorPrompt({ ...oatRequest, style: { presetId: scheme.styleId }, designSchemeId: id, providerPreference: undefined, visualRealism: undefined }, getStylePreset(scheme.styleId)!)];
  });
  assert.equal(createHash("sha256").update(JSON.stringify(records)).digest("hex"), "0be6944c064b3ba433e394cead7fe491a997a96ef596d081e77335e61a30e3a0");
});

test("v3 frozen prose is exclusive to the five selected dimensions and all fallbacks equal v2", () => {
  const frozen = readFileSync(new URL("../../docs/PROMPT_PHOTOREALISTIC_STANDARD_DRAFT_20260927.md", import.meta.url), "utf8").split("## 本轮冻结接线正文：燕麦拿铁 v3")[1].split("```text\n")[1].split("\n```")[0];
  assert.ok(compileOat().text.startsWith(frozen + "\nLighting:"));
  assert.equal(compileOat().templateVersion, V3_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileOat().text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileOat(overrides), compileOat({ ...overrides, designSchemeId: "cream-cozy-02-v2" }));
});

test("v3 obeys selected lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileOat({ lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, V3_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.match(result.text, /Output target: 2K, 16:9, draft quality/u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  assert.match(compileOat({ promotedFromPreview: true }).text, /final high-definition regeneration/u);
});

test("public client metadata and session drafts retain all three older oat-latte IDs", () => {
  const styles = parseStyles({ styles: [{ id: "cream-cozy", name: "奶油风", schemes: listPublicDesignSchemes("cream-cozy") }] });
  const card = styles[0].schemes!.find((scheme) => scheme.id === "cream-cozy-02-v10")!;
  assert.equal(card.previousVersionId, "cream-cozy-02-v9");
  assert.deepEqual(card.legacyVersionIds, ["cream-cozy-02-v8", "cream-cozy-02-v4", "cream-cozy-02-v3", "cream-cozy-02-v2", "cream-cozy-02-v1"]);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    for (const id of [card.previousVersionId, ...card.legacyVersionIds!]) {
      saveParameterDraft("concept", { stylePresetId: "cream-cozy", designSchemeId: id });
      assert.equal(loadParameterDraft("concept")?.designSchemeId, id);
    }
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("v4 frozen prose is exclusive to the five selected dimensions and all fallbacks equal v2", () => {
  const frozen = readFileSync(new URL("../../docs/OAT_LATTE_V4_20260927.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  assert.ok(compileOat({ designSchemeId: "cream-cozy-02-v4" }).text.startsWith(frozen + "\nLighting:"));
  assert.equal(compileOat({ designSchemeId: "cream-cozy-02-v4" }).templateVersion, V4_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileOat({ designSchemeId: "cream-cozy-02-v4" }).text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileOat({ ...overrides, designSchemeId: "cream-cozy-02-v4" }), compileOat({ ...overrides, designSchemeId: "cream-cozy-02-v2" }));
});

test("v4 obeys selected lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileOat({ designSchemeId: "cream-cozy-02-v4", lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, V4_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    assert.match(result.text, /Output target: 2K, 16:9\./u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  for (const quality of ["draft", "standard", "high"] as const) assert.deepEqual(compileOat({ designSchemeId: "cream-cozy-02-v4", quality }), compileOat({ designSchemeId: "cream-cozy-02-v4" }));
  assert.match(compileOat({ designSchemeId: "cream-cozy-02-v4", promotedFromPreview: true }).text, /final high-definition regeneration/u);
});


test("v3 compiled bytes and versions retain the exact deployed baseline", () => {
  const records = [];
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) for (const purpose of ["preview", "final"] as const) records.push(compileOat({ lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose }));
  assert.equal(createHash("sha256").update(JSON.stringify(records)).digest("hex"), "b0ac37575c0819e11a68a521651437cc2e4ee6a3fb88e862f334a5044f613b45");
});

const compileWalnut = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "modern-minimalist" }, designSchemeId: "modern-minimalist-04-v3", ...overrides }, getStylePreset("modern-minimalist")!);

test("modern walnut v3 frozen prose is exclusive to the five selected dimensions and all fallbacks equal v2", () => {
  const frozen = readFileSync(new URL("../../docs/MODERN_WALNUT_V3_20260927.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  assert.ok(compileWalnut({ designSchemeId: "modern-minimalist-04-v3" }).text.startsWith(frozen + "\nLighting:"));
  assert.equal(compileWalnut({ designSchemeId: "modern-minimalist-04-v3" }).templateVersion, MODERN_WALNUT_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileWalnut({ designSchemeId: "modern-minimalist-04-v3" }).text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileWalnut({ ...overrides, designSchemeId: "modern-minimalist-04-v3" }), compileWalnut({ ...overrides, designSchemeId: "modern-minimalist-04-v2" }));
});

test("modern walnut v3 obeys selected lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileWalnut({ designSchemeId: "modern-minimalist-04-v3", lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, MODERN_WALNUT_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    assert.match(result.text, /Output target: 2K, 16:9\./u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  for (const quality of ["draft", "standard", "high"] as const) assert.deepEqual(compileWalnut({ designSchemeId: "modern-minimalist-04-v3", quality }), compileWalnut({ designSchemeId: "modern-minimalist-04-v3" }));
  assert.match(compileWalnut({ designSchemeId: "modern-minimalist-04-v3", promotedFromPreview: true }).text, /final high-definition regeneration/u);
});



test("public client metadata and session drafts retain both older modern walnut IDs", () => {
  const styles = parseStyles({ styles: [{ id: "modern-minimalist", name: "现代简约", schemes: listPublicDesignSchemes("modern-minimalist") }] });
  const card = styles[0].schemes!.find((scheme) => scheme.id === "modern-minimalist-04-v10")!;
  assert.equal(card.previousVersionId, "modern-minimalist-04-v9");
  assert.deepEqual(card.legacyVersionIds, ["modern-minimalist-04-v8", "modern-minimalist-04-v3", "modern-minimalist-04-v2", "modern-minimalist-04-v1"]);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    for (const id of [card.previousVersionId, ...card.legacyVersionIds!]) {
      saveParameterDraft("concept", { stylePresetId: "modern-minimalist", designSchemeId: id });
      assert.equal(loadParameterDraft("concept")?.designSchemeId, id);
    }
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});


test("oat latte v4 compiled bytes retain the deployed baseline", () => {
  const records = [];
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) for (const purpose of ["preview", "final"] as const) records.push(compileOat({ designSchemeId: "cream-cozy-02-v4", lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose }));
  assert.equal(createHash("sha256").update(JSON.stringify(records)).digest("hex"), "74570e166021cd172734afa794f2bfce79ed522f6baba45533f5a1f07248ffb7");
});

const compileFrench = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "french-modern" }, designSchemeId: "french-modern-05-v3", ...overrides }, getStylePreset("french-modern")!);

test("french sage v3 frozen prose is exclusive to the five selected dimensions and all fallbacks equal v2", () => {
  const frozen = readFileSync(new URL("../../docs/FRENCH_SAGE_V3_20260928.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  assert.ok(compileFrench({ designSchemeId: "french-modern-05-v3" }).text.startsWith(frozen + "\nLighting:"));
  assert.equal(compileFrench({ designSchemeId: "french-modern-05-v3" }).templateVersion, FRENCH_SAGE_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileFrench({ designSchemeId: "french-modern-05-v3" }).text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileFrench({ ...overrides, designSchemeId: "french-modern-05-v3" }), compileFrench({ ...overrides, designSchemeId: "french-modern-05-v2" }));
});

test("french sage v3 obeys selected lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileFrench({ designSchemeId: "french-modern-05-v3", lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, FRENCH_SAGE_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    assert.match(result.text, /Output target: 2K, 16:9\./u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  for (const quality of ["draft", "standard", "high"] as const) assert.deepEqual(compileFrench({ designSchemeId: "french-modern-05-v3", quality }), compileFrench({ designSchemeId: "french-modern-05-v3" }));
  assert.match(compileFrench({ designSchemeId: "french-modern-05-v3", promotedFromPreview: true }).text, /final high-definition regeneration/u);
});




test("public client metadata and session drafts retain both older french sage IDs", () => {
  const styles = parseStyles({ styles: [{ id: "french-modern", name: "法式现代", schemes: listPublicDesignSchemes("french-modern") }] });
  const card = styles[0].schemes!.find((scheme) => scheme.id === "french-modern-05-v10")!;
  assert.equal(card.previousVersionId, "french-modern-05-v9");
  assert.deepEqual(card.legacyVersionIds, ["french-modern-05-v8", "french-modern-05-v3", "french-modern-05-v2", "french-modern-05-v1"]);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    for (const id of [card.previousVersionId, ...card.legacyVersionIds!]) {
      saveParameterDraft("concept", { stylePresetId: "french-modern", designSchemeId: id });
      assert.equal(loadParameterDraft("concept")?.designSchemeId, id);
    }
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});



test("modern walnut v3 compiled bytes retain the deployed baseline", () => {
  const records = [];
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) for (const purpose of ["preview", "final"] as const) records.push(compileWalnut({ lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose }));
  assert.equal(createHash("sha256").update(JSON.stringify(records)).digest("hex"), "008c1765cf9030df2f86fa3ce283bbb3ee40dbe5e341a438ba5ea3d97abd88ac");
});

const compileIndustrial = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v3", ...overrides }, getStylePreset("industrial-loft")!);

test("industrial caramel v3 frozen prose is exclusive to the five selected dimensions and all fallbacks equal v2", () => {
  const frozen = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V3_20260928.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  assert.ok(compileIndustrial({ designSchemeId: "industrial-loft-02-v3" }).text.startsWith(frozen + "\nLighting:"));
  assert.equal(compileIndustrial({ designSchemeId: "industrial-loft-02-v3" }).templateVersion, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileIndustrial({ designSchemeId: "industrial-loft-02-v3" }).text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileIndustrial({ ...overrides, designSchemeId: "industrial-loft-02-v3" }), compileIndustrial({ ...overrides, designSchemeId: "industrial-loft-02-v2" }));
});

test("industrial caramel v3 obeys selected lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileIndustrial({ designSchemeId: "industrial-loft-02-v3", lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    assert.match(result.text, /Output target: 2K, 16:9\./u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  for (const quality of ["draft", "standard", "high"] as const) assert.deepEqual(compileIndustrial({ designSchemeId: "industrial-loft-02-v3", quality }), compileIndustrial({ designSchemeId: "industrial-loft-02-v3" }));
  assert.match(compileIndustrial({ designSchemeId: "industrial-loft-02-v3", promotedFromPreview: true }).text, /final high-definition regeneration/u);
});

test("public client metadata and session drafts retain all six older industrial caramel IDs", () => {
  const styles = parseStyles({ styles: [{ id: "industrial-loft", name: "工业风", schemes: listPublicDesignSchemes("industrial-loft") }] });
  const card = styles[0].schemes!.find((scheme) => scheme.id === "industrial-loft-02-v10")!;
  assert.equal(card.previousVersionId, "industrial-loft-02-v9");
  assert.deepEqual(card.legacyVersionIds, ["industrial-loft-02-v8", "industrial-loft-02-v7", "industrial-loft-02-v6", "industrial-loft-02-v5", "industrial-loft-02-v4", "industrial-loft-02-v3", "industrial-loft-02-v2", "industrial-loft-02-v1"]);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    for (const id of [card.previousVersionId, ...card.legacyVersionIds!]) {
      saveParameterDraft("concept", { stylePresetId: "industrial-loft", designSchemeId: id });
      assert.equal(loadParameterDraft("concept")?.designSchemeId, id);
    }
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

const compileIndustrialV4 = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v4", ...overrides }, getStylePreset("industrial-loft")!);

test("industrial caramel v4 changes only two frozen paragraphs and preserves v3", () => {
  const oldFrozen = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V3_20260928.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  const frozen = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V4_20260928.md", import.meta.url), "utf8").split("```text\n")[1].split("\n```")[0];
  const oldParagraphs = oldFrozen.split("\n\n");
  const paragraphs = frozen.split("\n\n");
  assert.equal(paragraphs.length, oldParagraphs.length);
  assert.deepEqual(paragraphs.flatMap((paragraph, index) => paragraph === oldParagraphs[index] ? [] : [index]), [4, 5]);
  assert.ok(compileIndustrialV4().text.startsWith(frozen + "\nLighting:"));
  assert.ok(compileIndustrial().text.startsWith(oldFrozen + "\nLighting:"));
  assert.equal(compileIndustrialV4().templateVersion, INDUSTRIAL_CARAMEL_V4_PROMPT_TEMPLATE_VERSION);
  assert.equal(compileIndustrial().templateVersion, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION);
  assert.doesNotMatch(compileIndustrialV4().text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
});

test("industrial caramel v4 uses only five selected dimensions and otherwise equals v2", () => {
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "bedroom", "dining-room", "kitchen", "bathroom", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileIndustrialV4(overrides), compileIndustrialV4({ ...overrides, designSchemeId: "industrial-loft-02-v2" }));
});

test("industrial caramel v4 obeys lighting, lamps, temperature, purpose and output", () => {
  for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileIndustrialV4({ lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "16:9", quality: "draft" });
    assert.equal(result.templateVersion, INDUSTRIAL_CARAMEL_V4_PROMPT_TEMPLATE_VERSION);
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    assert.match(result.text, /Output target: 2K, 16:9\./u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
      if (timeOfDay === "night") assert.match(result.text, /naturally dim scene/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
    if (timeOfDay === "day") assert.match(result.text, /balanced daytime illumination/u);
  }
  for (const quality of ["draft", "standard", "high"] as const) assert.deepEqual(compileIndustrialV4({ quality }), compileIndustrialV4());
  assert.match(compileIndustrialV4({ promotedFromPreview: true }).text, /final high-definition regeneration/u);
});

const compileIndustrialV5 = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v5", ...overrides }, getStylePreset("industrial-loft")!);
const v5Rooms = { "living-room": "客厅 living-room", bedroom: "卧室 bedroom", kitchen: "厨房 kitchen", bathroom: "卫生间 bathroom" } as const;

test("industrial caramel v5 assembles exactly the frozen common, one room and photo sections", () => {
  const doc = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V5_20260928.md", import.meta.url), "utf8");
  const section = (title: string) => {
    const match = doc.split(`## ${title}`);
    assert.equal(match.length, 2, title);
    return match[1].split("```text\n")[1].split("\n```")[0];
  };
  const common = section("共同正文");
  const photo = section("摄影与光照正文");
  for (const [room, title] of Object.entries(v5Rooms)) {
    const compiled = compileIndustrialV5({ spaceType: room as GenerateInteriorImagesRequest["spaceType"] });
    assert.equal(compiled.templateVersion, INDUSTRIAL_CARAMEL_V5_PROMPT_TEMPLATE_VERSION);
    assert.ok(compiled.text.startsWith(`${common}\n${section(title)}\n${photo}\nLighting:`), room);
    for (const [otherRoom, otherTitle] of Object.entries(v5Rooms)) if (otherRoom !== room) assert.ok(!compiled.text.includes(section(otherTitle)), `${room} must exclude ${otherRoom}`);
    assert.doesNotMatch(compiled.text, /Finishes: walls|Selected scheme:|flat warm-white ceiling/u);
  }
});

test("industrial caramel v5 requires all five dimensions and otherwise equals v2", () => {
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "dining-room", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileIndustrialV5(overrides), compileIndustrialV5({ ...overrides, designSchemeId: "industrial-loft-02-v2" }));
});

test("industrial caramel v5 keeps dynamic lighting, purpose, output and count semantics", () => {
  for (const spaceType of Object.keys(v5Rooms) as (keyof typeof v5Rooms)[]) for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) for (const colorTemperatureKelvin of [2700, 6500]) {
    const result = compileIndustrialV5({ spaceType, lighting: { timeOfDay, lampState, colorTemperatureKelvin }, purpose: "preview", resolution: "2K", aspectRatio: "9:16", quality: "draft" });
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.match(result.text, /Output target: 2K, 9:16\./u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    if (lampState === "off") {
      assert.match(result.text, /must be completely unlit: no glow/u);
      assert.doesNotMatch(result.text, /Selected color temperature:|switched on/u);
    } else assert.ok(result.text.includes(`Selected color temperature: ${colorTemperatureKelvin}K`));
    if (timeOfDay === "night") assert.match(result.text, /realistic nighttime ambience/u);
  }
  assert.deepEqual(compileIndustrialV5({ outputCount: 4 }), compileIndustrialV5({ outputCount: 1 }));
  assert.match(compileIndustrialV5({ promotedFromPreview: true }).text, /final high-definition regeneration/u);
});

const compileIndustrialV6 = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v6", ...overrides }, getStylePreset("industrial-loft")!);

test("industrial caramel v6 assembles the six complete frozen blocks, preserving unchanged living and photo prose", () => {
  const doc = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V6_20260928.md", import.meta.url), "utf8");
  const oldDoc = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V5_20260928.md", import.meta.url), "utf8");
  const section = (body: string, title: string, heading = "###") => body.split(`${heading} ${title}`)[1].split("```text\n")[1].split("\n```")[0];
  const common = section(doc, "共同正文");
  const photo = section(doc, "摄影与光照正文");
  assert.equal(section(doc, "客厅 living-room"), section(oldDoc, "客厅 living-room", "##"));
  assert.equal(photo, section(oldDoc, "摄影与光照正文", "##"));
  for (const [room, title] of Object.entries(v5Rooms)) {
    const compiled = compileIndustrialV6({ spaceType: room as GenerateInteriorImagesRequest["spaceType"] });
    assert.equal(compiled.templateVersion, INDUSTRIAL_CARAMEL_V6_PROMPT_TEMPLATE_VERSION);
    assert.ok(compiled.text.startsWith(`${common}\n${section(doc, title)}\n${photo}\nLighting:`), room);
    for (const [otherRoom, otherTitle] of Object.entries(v5Rooms)) if (otherRoom !== room) assert.ok(!compiled.text.includes(section(doc, otherTitle)), `${room} must exclude ${otherRoom}`);
  }
  assert.doesNotMatch(common, /可见立管和固定设备保留原位置|原有固定设备仍可辨认/u);
  assert.doesNotMatch(section(doc, "厨房 kitchen"), /不默认增加岛台/u);
});

test("industrial caramel v6 keeps five-dimensional gate, exact v2 fallback and dynamic parameters", () => {
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "dining-room", "study", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileIndustrialV6(overrides), compileIndustrialV6({ ...overrides, designSchemeId: "industrial-loft-02-v2" }));
  for (const spaceType of Object.keys(v5Rooms) as (keyof typeof v5Rooms)[]) for (const lampState of ["on", "off"] as const) {
    const result = compileIndustrialV6({ spaceType, lighting: { timeOfDay: "night", lampState, colorTemperatureKelvin: 2700 }, purpose: "preview", resolution: "2K", aspectRatio: "9:16", quality: "draft" });
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.match(result.text, /Output target: 2K, 9:16\./u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    if (lampState === "off") { assert.match(result.text, /must be completely unlit: no glow/u); assert.doesNotMatch(result.text, /Selected color temperature:/u); }
    else assert.match(result.text, /Selected color temperature: 2700K/u);
  }
  assert.deepEqual(compileIndustrialV6({ outputCount: 4 }), compileIndustrialV6({ outputCount: 1 }));
  assert.match(compileIndustrialV6({ promotedFromPreview: true }).text, /final high-definition regeneration/u);
});

const compileIndustrialV7 = (overrides: Partial<GenerateInteriorImagesRequest> = {}) => compileInteriorPrompt({ ...oatRequest, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v7", ...overrides }, getStylePreset("industrial-loft")!);
const v7Rooms = { ...v5Rooms, study: "书房 study", "children-room": "儿童房 children-room" } as const;

test("industrial caramel v7 assembles eight frozen blocks for six rooms without changing v6", () => {
  const doc = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V7_20260928.md", import.meta.url), "utf8");
  const v6 = readFileSync(new URL("../../docs/INDUSTRIAL_CARAMEL_V6_20260928.md", import.meta.url), "utf8");
  const block = (body: string, title: string) => body.split(`### ${title}\n`)[1].split("```text\n")[1].split("\n```")[0];
  const common = block(doc, "共同正文"), photo = block(doc, "摄影与光照正文");
  assert.equal(block(doc, "客厅 living-room"), block(v6, "客厅 living-room"));
  assert.equal(photo, block(v6, "摄影与光照正文"));
  for (const [spaceType, title] of Object.entries(v7Rooms)) {
    const compiled = compileIndustrialV7({ spaceType: spaceType as GenerateInteriorImagesRequest["spaceType"] });
    assert.equal(compiled.templateVersion, INDUSTRIAL_CARAMEL_V7_PROMPT_TEMPLATE_VERSION);
    assert.ok(compiled.text.startsWith(`${common}\n${block(doc, title)}\n${photo}\nLighting:`), spaceType);
    for (const [otherRoom, otherTitle] of Object.entries(v7Rooms)) if (otherRoom !== spaceType) assert.ok(!compiled.text.includes(block(doc, otherTitle)), `${spaceType} excludes ${otherRoom}`);
  }
  assert.equal(compileIndustrialV6().templateVersion, INDUSTRIAL_CARAMEL_V6_PROMPT_TEMPLATE_VERSION);
});

test("industrial caramel v7 gates six rooms, preserves v2 fallback and dynamic output", () => {
  const cases: Partial<GenerateInteriorImagesRequest>[] = [
    ...["advanced", "floorplan", "self-service"].map((workflowType) => ({ workflowType } as Partial<GenerateInteriorImagesRequest>)),
    ...["doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128", "qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro", undefined].map((providerPreference) => ({ providerPreference } as Partial<GenerateInteriorImagesRequest>)),
    ...["corridor", "dining-room", "unspecified", undefined].map((spaceType) => ({ spaceType } as Partial<GenerateInteriorImagesRequest>)),
    ...["replace-soft-furnishings", "empty-room", "local-edit"].map((renovationScope) => ({ renovationScope } as Partial<GenerateInteriorImagesRequest>)),
  ];
  for (const overrides of cases) assert.deepEqual(compileIndustrialV7(overrides), compileIndustrialV7({ ...overrides, designSchemeId: "industrial-loft-02-v2" }));
  for (const spaceType of Object.keys(v7Rooms) as (keyof typeof v7Rooms)[]) for (const lampState of ["on", "off"] as const) {
    const result = compileIndustrialV7({ spaceType, lighting: { timeOfDay: "night", lampState, colorTemperatureKelvin: 2700 }, purpose: "preview", resolution: "2K", aspectRatio: "9:16", quality: "draft" });
    assert.match(result.text, /low-cost composition preview draft/u);
    assert.match(result.text, /Output target: 2K, 9:16\./u);
    assert.doesNotMatch(result.text, /standard quality|draft quality|high quality/u);
    if (lampState === "off") { assert.match(result.text, /must be completely unlit: no glow/u); assert.doesNotMatch(result.text, /Selected color temperature:/u); }
    else assert.match(result.text, /Selected color temperature: 2700K/u);
  }
  assert.deepEqual(compileIndustrialV7({ outputCount: 4 }), compileIndustrialV7({ outputCount: 1 }));
});

test("children-room is a real concept room through contract and non-special prompts", () => {
  const child = parseCreateJobInput({ ...base, spaceType: "children-room" });
  assert.equal(child.spaceType, "children-room");
  for (const workflowType of ["advanced", "floorplan", "self-service"]) assert.throws(() => parseCreateJobInput({ ...base, workflowType, spaceType: "children-room" }), /儿童房仅适用于概念工作台/u);
  const common = "尺度合适的单人床、学习桌椅、衣物收纳及书本玩具收纳";
  for (const designSchemeId of [undefined, "industrial-loft-02-v1", "industrial-loft-02-v2", "industrial-loft-02-v7"]) for (const renovationScope of ["restyle", "replace-soft-furnishings", "empty-room", "local-edit"] as const) {
    const compiled = compileIndustrialV7({ designSchemeId, spaceType: "children-room", providerPreference: "qwen-image-3.0-pro", renovationScope });
    assert.match(compiled.text, new RegExp(common, "u"));
    assert.doesNotMatch(compiled.text, /undefined|low modular sofa|worn leather sofa/u);
  }
  assert.match(compileIndustrialV7({ spaceType: "children-room", designSchemeId: "industrial-loft-02-v2", providerPreference: "qwen-image-3.0-pro" }).text, /Furnish a growing child's bedroom/u);
});

const v8SourceImage = { bytes: new Uint8Array([1]), mimeType: "image/png" as const };
const v8Request = (designSchemeId: string, stylePresetId: string): GenerateInteriorImagesRequest => ({ sourceImage: v8SourceImage, workflowType: "concept", style: { presetId: stylePresetId }, designSchemeId, providerPreference: "doubao-seedream-5-0-pro-260628", spaceType: "living-room", renovationScope: "restyle", visualRealism: "photorealistic", resolution: "2K", aspectRatio: "4:3", quality: "standard", lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 }, outputCount: 1 });

test("v8 freezes all Astra data and remains addressable after v9", () => {
  assert.equal(V8_RECIPES.length, 72);
  assert.equal(Object.keys(V8_STYLES).length, 12);
  assert.equal(createHash("sha256").update(JSON.stringify({ ...V8_SHARED, styles: V8_STYLES, recipes: V8_RECIPES })).digest("hex"), "9c53e270a58a3dccfe93bcb874455342a3a22d6f79b1832fe35f6f627af01c82");
  assert.deepEqual(new Set(v8Schemes().map((scheme) => scheme.id)), new Set(V8_RECIPES.map((recipe) => recipe.id)));
  for (const scheme of v8Schemes()) {
    const oldId = scheme.id.replace(/-v8$/u, "-v2");
    const previousId = oldId === "cream-cozy-02-v2" ? "cream-cozy-02-v4" : oldId === "modern-minimalist-04-v2" || oldId === "french-modern-05-v2" ? oldId.replace(/-v2$/u, "-v3") : oldId === "industrial-loft-02-v2" ? "industrial-loft-02-v7" : oldId;
    const card = listPublicDesignSchemes(scheme.styleId).find((item) => item.id === scheme.id.replace(/-v8$/u, "-v10"))!;
    assert.equal(card.previousVersionId, scheme.id.replace(/-v8$/u, "-v9"));
    assert.equal(card.legacyVersionIds[0], scheme.id);
    assert.ok(card.legacyVersionIds.includes(previousId));
    assert.ok(card.legacyVersionIds.includes(oldId.replace(/-v2$/u, "-v1")));
    assert.equal(scheme.name, getDesignScheme(previousId)?.name);
    assert.equal(scheme.description, getDesignScheme(previousId)?.description);
    assert.deepEqual(scheme.palette, getDesignScheme(previousId)?.palette);
    assert.equal(parseCreateJobInput({ ...base, stylePresetId: scheme.styleId, designSchemeId: scheme.id }).designSchemeId, scheme.id);
  }
  assert.equal(parseCreateJobInput({ ...base, stylePresetId: "industrial-loft" }).designSchemeId, "industrial-loft-01-v2");
});

test("v8 compiles seven rooms, three UI scopes and all six models without leaking fixed wet work into movable scopes", () => {
  const rooms = Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[];
  const scopes = ["restyle", "replace-soft-furnishings", "empty-room"] as const;
  let count = 0;
  let maxCompactBytes = 0;
  for (const scheme of v8Schemes()) for (const spaceType of rooms) for (const renovationScope of scopes) for (const providerPreference of domesticImageModelValues) {
    const request = { ...v8Request(scheme.id, scheme.styleId), spaceType, renovationScope, providerPreference };
    const result = compileInteriorPrompt(request, getStylePreset(scheme.styleId)!);
    assert.equal(result.templateVersion, "interior-concept-v23");
    assert.equal(result.styleTemplateVersion, "interior-styles-v5");
    count++;
    if (providerPreference === "qwen-image-2.0-pro") {
      assert.ok(Buffer.from(result.text).every((byte) => byte < 128));
      assert.ok(result.text.includes(V8_SHARED.compactCommon));
      assert.ok(result.text.includes(scheme.compact!));
      assert.ok(result.text.includes(renovationScope === "restyle" ? V8_SHARED.compactRooms[spaceType] : V8_SHARED.compactMovableRooms[spaceType]));
      const payload = withInputLegend(result.text, [{ image: v8SourceImage, role: "primary room or plan input" }]);
      maxCompactBytes = Math.max(maxCompactBytes, Buffer.byteLength(payload));
      assert.ok(Buffer.byteLength(payload) <= 1200, `${scheme.id}/${spaceType}/${renovationScope}: ${Buffer.byteLength(payload)} bytes`);
    } else {
      assert.ok(result.text.includes(V8_SHARED.common));
      assert.ok(result.text.includes(V8_STYLES[scheme.styleId as keyof typeof V8_STYLES]));
      assert.ok(result.text.includes(V8_SHARED.scopes[renovationScope]));
      assert.ok(result.text.includes(renovationScope === "restyle" ? V8_SHARED.rooms[spaceType] : V8_SHARED.movableRooms[spaceType]));
      if (renovationScope !== "restyle") {
        assert.ok(result.text.includes(V8_SHARED.movablePalettePrefix));
        assert.ok(!result.text.includes(scheme.wet));
        assert.ok(!result.text.includes(scheme.walls));
      } else if (spaceType === "kitchen" || spaceType === "bathroom") {
        assert.ok(result.text.includes(scheme.wet));
        assert.ok(result.text.includes(V8_SHARED.wetDirection));
        assert.ok(!result.text.includes(scheme.floor));
        assert.ok(!result.text.includes(scheme.lighting));
      } else {
        assert.ok(result.text.includes(scheme.walls));
        assert.ok(result.text.includes(scheme.floor));
        if (spaceType === "study" || spaceType === "children-room") assert.ok(!result.text.includes(scheme.lighting));
      }
    }
  }
  assert.equal(count, 72 * 7 * 3 * 6);
  assert.ok(maxCompactBytes <= 1200);
});

test("v8 gates historic inputs to exact v2 and keeps visual, lamp and purpose branches separate", () => {
  const scheme = getDesignScheme("industrial-loft-02-v8")!;
  const baseRequest = v8Request(scheme.id, scheme.styleId);
  const fallback = (overrides: Partial<GenerateInteriorImagesRequest>) => {
    const request = { ...baseRequest, ...overrides };
    assert.deepEqual(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!), compileInteriorPrompt({ ...request, designSchemeId: "industrial-loft-02-v2" }, getStylePreset(scheme.styleId)!));
  };
  for (const spaceType of ["corridor", "unspecified", undefined] as const) fallback({ spaceType });
  fallback({ sourceImage: undefined });
  fallback({ renovationScope: "local-edit" });
  fallback({ providerPreference: "auto" });
  fallback({ providerPreference: undefined });
  fallback({ referenceImages: [{ role: "style", image: v8SourceImage }] });
  fallback({ controlImages: [{ kind: "depth", image: v8SourceImage }] });
  fallback({ mask: v8SourceImage });
  fallback({ editInstruction: "只改窗边" });
  fallback({ customPrompt: "额外说明" });
  for (const providerPreference of domesticImageModelValues) for (const visualRealism of ["conceptual", "rendered", "realistic", "photorealistic"] as const) for (const lampState of ["on", "off", "mixed"] as const) {
    const request = { ...baseRequest, providerPreference, visualRealism, lighting: { timeOfDay: "night" as const, lampState, colorTemperatureKelvin: 2700 }, purpose: "final" as const, promotedFromPreview: true };
    const text = compileInteriorPrompt(request, getStylePreset(scheme.styleId)!).text;
    // Every legacy realism level now compiles to the photo-level block.
    assert.ok(text.includes(providerPreference === "qwen-image-2.0-pro" ? V8_SHARED.compactPhoto : V8_SHARED.photo));
    if (lampState === "off") assert.doesNotMatch(text, /2700K/u);
    else assert.match(text, /2700K/u);
    assert.ok(text.includes(providerPreference === "qwen-image-2.0-pro" ? V8_SHARED.compactPurpose.promoted : "final high-definition regeneration"));
  }
});

test("all Qwen 2.0 Pro v8 UI combinations stay ASCII and within the conservative byte budget", () => {
  const roles = [{ image: v8SourceImage, role: "primary room or plan input" }];
  let max = 0;
  let count = 0;
  for (const scheme of v8Schemes()) for (const spaceType of Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[]) for (const renovationScope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const visualRealism of ["conceptual", "rendered", "realistic", "photorealistic"] as const) for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), providerPreference: "qwen-image-2.0-pro" as const, spaceType, renovationScope, visualRealism, lighting: { timeOfDay, lampState, colorTemperatureKelvin: 6500 }, aspectRatio: "16:9" as const, promotedFromPreview: true };
    const payload = withInputLegend(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!).text, roles);
    const bytes = Buffer.byteLength(payload);
    assert.ok(Buffer.from(payload).every((byte) => byte < 128));
    assert.ok(bytes <= 1200, `${scheme.id}/${spaceType}/${renovationScope}/${visualRealism}/${timeOfDay}/${lampState}: ${bytes} bytes`);
    max = Math.max(max, bytes);
    count++;
  }
  assert.equal(count, 72 * 7 * 3 * 4 * 5 * 3);
  assert.equal(max, 1158);
});

test("v9 freezes 72 Astra ceiling overlays and retains every v8 card", () => {
  assert.equal(V9_CEILINGS.length, 72);
  assert.equal(createHash("sha256").update(JSON.stringify({ shared: V9_SHARED, ceilings: V9_CEILINGS })).digest("hex"), "148d776465e4c0cf8eeed5950cbdc5152079e69181e04415bbeb37068db973b9");
  assert.deepEqual(new Set(v9Schemes().map((scheme) => scheme.id)), new Set(V9_CEILINGS.map((entry) => entry.id)));
  for (const entry of V9_CEILINGS) {
    const current = getDesignScheme(entry.id)!;
    const previous = getDesignScheme(entry.id.replace(/-v9$/u, "-v8"))!;
    const card = listPublicDesignSchemes(current.styleId).find((item) => item.id === entry.id.replace(/-v9$/u, "-v10"))!;
    assert.deepEqual(current, { ...previous, id: entry.id, ceiling: entry.ceiling });
    assert.equal(card.previousVersionId, entry.id);
    assert.ok(card.legacyVersionIds.includes(entry.id.replace(/-v9$/u, "-v1")));
    assert.equal(parseCreateJobInput({ ...base, stylePresetId: current.styleId, designSchemeId: entry.id }).designSchemeId, entry.id);
  }
});

test("v9 changes only living-room restyle ceilings across six models and leaves v8 fallbacks exact", () => {
  const source = v8SourceImage;
  for (const scheme of v9Schemes()) {
    const oldId = scheme.id.replace(/-v9$/u, "-v8");
    const old = getDesignScheme(oldId)!;
    const entry = V9_CEILINGS.find((item) => item.id === scheme.id)!;
    for (const providerPreference of domesticImageModelValues) {
      const request = { ...v8Request(scheme.id, scheme.styleId), providerPreference };
      const compiled = compileInteriorPrompt(request, getStylePreset(scheme.styleId)!);
      assert.equal(compiled.templateVersion, "interior-concept-v24");
      assert.equal(compiled.styleTemplateVersion, "interior-styles-v6");
      if (providerPreference === "qwen-image-2.0-pro") {
        assert.ok(compiled.text.includes(V9_SHARED.compactScope));
        assert.ok(compiled.text.includes(entry.compactCeiling));
        assert.ok(compiled.text.includes(old.compact!));
        assert.ok(!compiled.text.includes(V8_SHARED.compactScopes.restyle));
      } else {
        assert.ok(compiled.text.includes(V9_SHARED.scope));
        assert.ok(compiled.text.includes(V9_SHARED.ceilingRule));
        assert.ok(compiled.text.includes(entry.ceiling));
        assert.ok(!compiled.text.includes(old.ceiling));
        assert.ok(!compiled.text.includes(V8_SHARED.scopes.restyle));
      }
      for (const overrides of [
        { workflowType: "advanced" as const }, { workflowType: "floorplan" as const },
        { spaceType: "bedroom" as const }, { spaceType: "kitchen" as const }, { spaceType: "unspecified" as const },
        { renovationScope: "replace-soft-furnishings" as const }, { renovationScope: "empty-room" as const },
        { providerPreference: "auto" as const }, { sourceImage: undefined }, { referenceImages: [{ role: "style" as const, image: source }] },
        { controlImages: [{ kind: "depth" as const, image: source }] }, { mask: source },
        { editInstruction: "仅改窗边" }, { customPrompt: "额外说明" },
      ]) {
        const other = { ...request, ...overrides };
        assert.deepEqual(compileInteriorPrompt(other, getStylePreset(scheme.styleId)!), compileInteriorPrompt({ ...other, designSchemeId: oldId }, getStylePreset(scheme.styleId)!));
      }
    }
  }
});

test("Qwen 2.0 Pro v9 living-room ceilings fit the complete ASCII legend budget", () => {
  let max = 0;
  for (const scheme of v9Schemes()) for (const visualRealism of ["conceptual", "rendered", "realistic", "photorealistic"] as const) for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off", "mixed"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), providerPreference: "qwen-image-2.0-pro" as const, visualRealism, lighting: { timeOfDay, lampState, colorTemperatureKelvin: 6500 }, aspectRatio: "16:9" as const, promotedFromPreview: true };
    const payload = withInputLegend(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!).text, [{ image: v8SourceImage, role: "primary room or plan input" }]);
    const bytes = Buffer.byteLength(payload);
    assert.ok(Buffer.from(payload).every((byte) => byte < 128));
    assert.ok(bytes <= 1200, `${scheme.id}/${visualRealism}/${timeOfDay}/${lampState}: ${bytes}`);
    max = Math.max(max, bytes);
  }
  assert.equal(max, 1144);
});

test("v10 publishes 72 lamp cards while preserving v9 and frozen Astra directions", () => {
  assert.equal(createHash("sha256").update(JSON.stringify(V10_LAMPS)).digest("hex"), "4778c750328f8d4f5d26457287def846487f0a610df09738d4a9e583295e7d0e");
  assert.equal(oldCurrentSchemes().length, 72);
  for (const current of oldCurrentSchemes()) {
    const previous = getDesignScheme(current.id.replace(/-v10$/u, "-v9"))!;
    const card = listPublicDesignSchemes(current.styleId).find((item) => item.id === current.id)!;
    assert.deepEqual(current, { ...previous, id: current.id });
    assert.equal(card.previousVersionId, previous.id);
    assert.ok(card.legacyVersionIds.includes(previous.id.replace(/-v9$/u, "-v8")));
    assert.equal(parseCreateJobInput({ ...base, stylePresetId: current.styleId, designSchemeId: current.id }).designSchemeId, current.id);
  }
  const ui = readFileSync(new URL("../../components/studio/InteriorStudio.tsx", import.meta.url), "utf8");
  assert.match(ui, /useState<LampState>\("on"\)/u);
  assert.match(ui, /setLampState\(config\.lampState === "off" \? "off" : "on"\)/u);
  assert.match(ui, /setLegacyLampNotice\(config\.lampState === "mixed"\)/u);
  assert.match(ui, /原混合灯态已调整为开灯/u);
  assert.doesNotMatch(ui, /value: "mixed", label: "混合"/u);
  assert.match(ui, /disabled=\{lampState === "off"\}/u);
});

test("v10 changes lamps only across all seven rooms, three scopes, six models and two states", () => {
  let count = 0;
  for (const scheme of oldCurrentSchemes()) for (const spaceType of Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[]) for (const renovationScope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const providerPreference of domesticImageModelValues) for (const lampState of ["on", "off"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), spaceType, renovationScope, providerPreference, lighting: { timeOfDay: "night" as const, lampState, colorTemperatureKelvin: 4000 } };
    const result = compileInteriorPrompt(request, getStylePreset(scheme.styleId)!);
    assert.equal(result.templateVersion, "interior-concept-v25");
    assert.equal(result.styleTemplateVersion, "interior-styles-v7");
    if (providerPreference === "qwen-image-2.0-pro") {
      assert.ok(result.text.includes(V10_LAMPS.compactLamps[lampState]));
      assert.ok(!result.text.includes(V8_SHARED.compactLamps[lampState]));
    } else {
      assert.ok(result.text.includes(V10_LAMPS.directions[lampState]));
      assert.ok(!result.text.includes(lampState === "on" ? "practical lamps visibly switched on" : "all artificial light sources (bulbs"));
      if (spaceType === "living-room" && renovationScope === "restyle") assert.ok(result.text.includes(V9_SHARED.ceilingRule));
    }
    if (lampState === "off") assert.doesNotMatch(result.text, /4000K/u);
    else assert.match(result.text, /4000K/u);
    count++;
  }
  assert.equal(count, 72 * 7 * 3 * 6 * 2);
});

test("v10 mixed and out-of-scope inputs compile to the complete v9 object", () => {
  for (const scheme of oldCurrentSchemes()) {
    const oldId = scheme.id.replace(/-v10$/u, "-v9");
    const baseRequest = v8Request(scheme.id, scheme.styleId);
    for (const overrides of [
      { lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 } },
      { workflowType: "advanced" as const }, { workflowType: "floorplan" as const },
      { spaceType: "corridor" as const }, { spaceType: "unspecified" as const },
      { providerPreference: "auto" as const }, { sourceImage: undefined },
      { renovationScope: "local-edit" as const },
      { referenceImages: [{ role: "style" as const, image: v8SourceImage }] },
      { controlImages: [{ kind: "depth" as const, image: v8SourceImage }] },
      { mask: v8SourceImage }, { editInstruction: "只改局部" }, { customPrompt: "额外指示" },
    ]) {
      const request = { ...baseRequest, ...overrides };
      assert.deepEqual(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!), compileInteriorPrompt({ ...request, designSchemeId: oldId }, getStylePreset(scheme.styleId)!));
    }
  }
});

test("Qwen 2.0 Pro v10 on/off prompts fit the complete ASCII legend budget", () => {
  let max = 0;
  let count = 0;
  for (const scheme of oldCurrentSchemes()) for (const spaceType of Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[]) for (const renovationScope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const visualRealism of ["conceptual", "rendered", "realistic", "photorealistic"] as const) for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), providerPreference: "qwen-image-2.0-pro" as const, spaceType, renovationScope, visualRealism, lighting: { timeOfDay, lampState, colorTemperatureKelvin: 6500 }, aspectRatio: "16:9" as const, promotedFromPreview: true };
    const payload = withInputLegend(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!).text, [{ image: v8SourceImage, role: "primary room or plan input" }]);
    const bytes = Buffer.byteLength(payload);
    assert.ok(Buffer.from(payload).every((byte) => byte < 128));
    assert.ok(bytes <= 1200, `${scheme.id}/${spaceType}/${renovationScope}/${visualRealism}/${timeOfDay}/${lampState}: ${bytes}`);
    max = Math.max(max, bytes);
    count++;
  }
  assert.equal(count, 72 * 7 * 3 * 4 * 5 * 2);
  assert.ok(max <= 1200);
});

test("five Astra styles expose thirty first-version cards without inventing history", () => {
  assert.equal(NEW_STYLE_DATA.length, 5);
  assert.equal(NEW_SCHEME_DATA.length, 30);
  assert.equal(createHash("sha256").update(JSON.stringify({ styles: NEW_STYLE_DATA, schemes: NEW_SCHEME_DATA })).digest("hex"), "b241731a379d4c4962ed2895f3dd8c705288f08daad4e63af4d824a7d0f1d4c9");
  for (const style of NEW_STYLE_DATA) {
    const cards = listPublicDesignSchemes(style.id);
    assert.equal(cards.length, 6);
    assert.deepEqual(cards.map((card) => card.id), NEW_SCHEME_DATA.filter((scheme) => scheme.styleId === style.id).map((scheme) => scheme.id));
    assert.ok(cards.every((card) => card.previousVersionId === undefined && card.legacyVersionIds.length === 0));
    assert.deepEqual(parseStyles({ styles: [{ id: style.id, name: style.name, schemes: cards }] })[0]?.schemes?.map((card) => card.id), cards.map((card) => card.id));
    const omitted = parseCreateJobInput({ ...base, stylePresetId: style.id });
    assert.equal(omitted.designSchemeId, cards[0].id);
    assert.equal(omitted.preV2DefaultSchemeRequestHash, null);
    assert.equal(getStylePreset(style.id)?.promptDirective, style.promptDirective);
    assert.throws(() => parseCreateJobInput({ ...base, stylePresetId: style.id, designSchemeId: "modern-minimalist-01-v10" }), /不属于当前风格/u);
  }
  assert.equal(createHash("sha256").update(JSON.stringify(oldCurrentSchemes())).digest("hex"), "f7f470b5be226a7208b382d01e1ed540c226389ad12ca5d678b4730750b3b1af");
});

test("old 72 compiled objects remain byte-identical across rooms, scopes, models and lamps", () => {
  const hash = createHash("sha256");
  let count = 0;
  for (const scheme of oldCurrentSchemes()) for (const room of ["living-room", "bedroom", "dining-room", "kitchen", "bathroom", "study", "children-room"] as const) for (const scope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const model of domesticImageModelValues) for (const lamp of ["on", "off"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), spaceType: room, renovationScope: scope, providerPreference: model, lighting: { timeOfDay: "day" as const, lampState: lamp, colorTemperatureKelvin: 4000 } };
    hash.update(JSON.stringify({ id: scheme.id, room, scope, model, lamp, result: compileInteriorPrompt(request, getStylePreset(scheme.styleId)!) }));
    count++;
  }
  assert.equal(count, 18144);
  assert.equal(hash.digest("hex"), "2bef9a0b1ae7da7a0c4b011b86936d277636bfac4c65e3a1fd703589188ecbd0");
});

test("new styles compile all seven rooms, three scopes, six models and two lamp states", () => {
  let count = 0;
  for (const scheme of NEW_SCHEME_DATA) for (const room of Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[]) for (const scope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const model of domesticImageModelValues) for (const lamp of ["on", "off"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), spaceType: room, renovationScope: scope, providerPreference: model, lighting: { timeOfDay: "day" as const, lampState: lamp, colorTemperatureKelvin: 4000 } };
    const result = compileInteriorPrompt(request, getStylePreset(scheme.styleId)!);
    assert.equal(result.templateVersion, "interior-concept-v26");
    assert.equal(result.styleTemplateVersion, "interior-styles-v8");
    if (model === "qwen-image-2.0-pro") {
      assert.ok(result.text.includes(NEW_STYLE_DATA.find((style) => style.id === scheme.styleId)!.compactStyleName));
      assert.ok(result.text.includes(V10_LAMPS.compactLamps[lamp]));
      assert.equal(result.text.includes(scheme.compactCeiling), room === "living-room" && scope === "restyle");
    } else {
      assert.ok(result.text.includes(NEW_STYLE_DATA.find((style) => style.id === scheme.styleId)!.styleDirection));
      assert.ok(result.text.includes(V10_LAMPS.directions[lamp]));
      assert.equal(result.text.includes(scheme.livingCeiling), room === "living-room" && scope === "restyle");
      if (scope !== "restyle") assert.ok(!result.text.includes(scheme.walls));
      if (scope === "restyle" && (room === "kitchen" || room === "bathroom")) assert.ok(!result.text.includes(scheme.lighting));
    }
    count++;
  }
  assert.equal(count, 30 * 7 * 3 * 6 * 2);
});

test("new styles preserve explicit IDs and extra inputs through generic compilation", () => {
  for (const scheme of NEW_SCHEME_DATA) {
    const baseRequest = v8Request(scheme.id, scheme.styleId);
    for (const overrides of [
      { spaceType: "corridor" as const },
      { renovationScope: "local-edit" as const, editInstruction: "仅改遮罩范围" },
      { referenceImages: [{ role: "style" as const, image: v8SourceImage }] },
      { lighting: { timeOfDay: "day" as const, lampState: "mixed" as const, colorTemperatureKelvin: 4000 } },
    ]) {
      const result = compileInteriorPrompt({ ...baseRequest, ...overrides }, getStylePreset(scheme.styleId)!);
      assert.notEqual(result.templateVersion, "interior-concept-v26");
      assert.ok(result.text.includes(scheme.id));
      if ("editInstruction" in overrides && overrides.editInstruction) assert.ok(result.text.includes(overrides.editInstruction));
      if ("referenceImages" in overrides) assert.ok(result.text.includes("reference"));
    }
  }
});

test("Qwen 2.0 Pro new-style prompts with input legend stay ASCII within 1200 bytes", () => {
  let max = 0;
  let count = 0;
  for (const scheme of NEW_SCHEME_DATA) for (const spaceType of Object.keys(V8_SHARED.rooms) as (keyof typeof V8_SHARED.rooms)[]) for (const renovationScope of ["restyle", "replace-soft-furnishings", "empty-room"] as const) for (const visualRealism of ["conceptual", "rendered", "realistic", "photorealistic"] as const) for (const timeOfDay of ["dawn", "day", "overcast", "dusk", "night"] as const) for (const lampState of ["on", "off"] as const) {
    const request = { ...v8Request(scheme.id, scheme.styleId), providerPreference: "qwen-image-2.0-pro" as const, spaceType, renovationScope, visualRealism, lighting: { timeOfDay, lampState, colorTemperatureKelvin: 6500 }, aspectRatio: "16:9" as const, promotedFromPreview: true };
    const payload = withInputLegend(compileInteriorPrompt(request, getStylePreset(scheme.styleId)!).text, [{ image: v8SourceImage, role: "primary room or plan input" }]);
    const bytes = Buffer.byteLength(payload);
    assert.ok(Buffer.from(payload).every((byte) => byte < 128));
    assert.ok(bytes <= 1200, `${scheme.id}/${spaceType}/${renovationScope}/${visualRealism}/${timeOfDay}/${lampState}: ${bytes}`);
    max = Math.max(max, bytes);
    count++;
  }
  assert.equal(count, 30 * 7 * 3 * 4 * 5 * 2);
  assert.equal(max, 1174);
});
