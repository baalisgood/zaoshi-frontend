import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("private templates retain an advanced brief and concept scheme; shares omit private text", async () => {
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const templates = await server.ssrLoadModule("/lib/server/templates.ts") as typeof import("../../lib/server/templates");
    const owner = `owner-${crypto.randomUUID()}`;
    const advancedInput = templates.parseTemplateInput({ workflowType: "advanced", name: "高级简报", config: { templateVersion: 1, stylePresetId: "new-chinese", customPrompt: "使用温暖木作" } });
    const advanced = await templates.saveTemplate(owner, advancedInput);
    assert.equal((await templates.getTemplate(advanced.id, owner))?.config.customPrompt, "使用温暖木作");
    assert.equal((await templates.getTemplate(advanced.id, owner))?.config.stylePresetId, undefined);
    const advancedShare = await templates.createShare(advanced.id, owner);
    assert.equal((await templates.getSharedTemplate(advancedShare.token))?.config.customPrompt, undefined);

    const legacyAdvanced = await templates.saveTemplate(owner, { workflowType: "advanced", name: "旧高级模板", config: { templateVersion: 1, stylePresetId: "new-chinese", customPrompt: "私有简报" } });
    const legacyAdvancedShare = await templates.createShare(legacyAdvanced.id, owner);
    assert.equal((await templates.getSharedTemplate(legacyAdvancedShare.token))?.config.stylePresetId, undefined);
    assert.equal((await templates.getSharedTemplate(legacyAdvancedShare.token))?.config.customPrompt, undefined);
    const legacyFloorplan = await templates.saveTemplate(owner, { workflowType: "floorplan", name: "旧平面图模板", config: { templateVersion: 1, stylePresetId: "new-chinese", designSchemeId: "new-chinese-01-v1" } });
    const legacyFloorplanShare = await templates.createShare(legacyFloorplan.id, owner);
    assert.equal((await templates.getSharedTemplate(legacyFloorplanShare.token))?.config.stylePresetId, undefined);
    assert.equal((await templates.getSharedTemplate(legacyFloorplanShare.token))?.config.designSchemeId, undefined);

    const conceptInput = templates.parseTemplateInput({ workflowType: "concept", name: "概念方案", config: { templateVersion: 1, stylePresetId: "modern-minimalist", designSchemeId: "modern-minimalist-03-v1" } });
    const concept = await templates.saveTemplate(owner, conceptInput);
    assert.equal((await templates.getTemplate(concept.id, owner))?.config.designSchemeId, "modern-minimalist-03-v1");
    const conceptShare = await templates.createShare(concept.id, owner);
    assert.equal((await templates.getSharedTemplate(conceptShare.token))?.config.designSchemeId, "modern-minimalist-03-v1");
    assert.equal(templates.canonicalizeStoredTemplateConfig({ templateVersion: 1, stylePresetId: "new-chinese" }, "concept").designSchemeId, "new-chinese-01-v1");
    assert.equal(templates.canonicalizeStoredTemplateConfig({ templateVersion: 1, stylePresetId: "new-chinese", designSchemeId: "missing" }, "concept").designSchemeId, "new-chinese-01-v1");
    assert.equal(templates.parseTemplateInput({ workflowType: "concept", name: "新版", config: { templateVersion: 1, stylePresetId: "new-chinese" } }).config.designSchemeId, "new-chinese-01-v2");
    assert.equal(templates.parseTemplateInput({ workflowType: "concept", name: "新增风格", config: { templateVersion: 1, stylePresetId: "art-deco" } }).config.designSchemeId, "art-deco-01-v1");
    assert.equal(templates.canonicalizeStoredTemplateConfig({ templateVersion: 1, stylePresetId: "art-deco" }, "concept").designSchemeId, "art-deco-01-v1");
    assert.equal(templates.parseTemplateInput({ workflowType: "concept", name: "儿童房", config: { templateVersion: 1, stylePresetId: "industrial-loft", spaceType: "children-room" } }).config.spaceType, "children-room");
    assert.throws(() => templates.parseTemplateInput({ workflowType: "advanced", name: "不适用", config: { templateVersion: 1, spaceType: "children-room" } }), /儿童房仅适用于概念工作台/u);
    assert.equal(templates.canonicalizeStoredTemplateConfig({ templateVersion: 1, stylePresetId: "new-chinese" }, "floorplan").stylePresetId, undefined);
    const stylesRoute = await server.ssrLoadModule("/app/api/styles/route.ts") as typeof import("../../app/api/styles/route");
    const response = await stylesRoute.GET();
    assert.equal(response.status, 200);
    const body = await response.json() as { styles: Array<{ id: string; schemes: Array<Record<string, unknown>> }> };
    assert.equal(body.styles.length, 17);
    assert.equal(body.styles.find((style) => style.id === "modern-minimalist")?.schemes.length, 6);
    assert.equal(body.styles.find((style) => style.id === "art-deco")?.schemes.length, 6);
    assert.equal(body.styles.find((style) => style.id === "art-deco")?.schemes[0]?.previousVersionId, undefined);
    assert.deepEqual(Object.keys(body.styles[0].schemes[0]).sort(), ["description", "id", "legacyVersionIds", "name", "palette", "previousVersionId"]);
    assert.equal(body.styles[0].schemes[0].previousVersionId, `${body.styles[0].schemes[0].id}`.replace(/-v10$/u, "-v9"));
    assert.doesNotMatch(JSON.stringify(body), /warm-white fine gray-veined porcelain/u);
  } finally { await server.close(); }
});
