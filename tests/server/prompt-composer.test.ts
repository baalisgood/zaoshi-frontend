import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { optimizeCurrentPrompt, PromptComposer } from "../../components/studio/PromptComposer";
import { readFile } from "node:fs/promises";

test("prompt optimization applies only the still-current snapshot and keeps failures explicit", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const current of [true, false]) {
      let complete!: (response: Response) => void;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "/api/prompts/optimize");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), { action: "optimize", prompt: "空间要求", quoteId: "quote-1", context: "ordinary" });
        return new Promise<Response>((resolve) => { complete = resolve; });
      };
      const pending = optimizeCurrentPrompt(" 空间要求 ", () => current, "quote-1");
      complete(new Response(JSON.stringify({ status: "SUCCEEDED", optimizedPrompt: "优化后的要求", chargedCredits: 1 })));
      assert.deepEqual(await pending, current ? {status:"SUCCEEDED", optimizedPrompt:"优化后的要求",chargedCredits:1} : undefined);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "暂不可用" }), { status: 503 });
    await assert.rejects(optimizeCurrentPrompt("原要求", () => true, "quote-1"));
  } finally { globalThis.fetch = originalFetch; }
});

test("both workflows share bounded explicit prompt actions and disabled-state preservation", () => {
  const render = (value: string, privateTest?: boolean) => renderToStaticMarkup(createElement(PromptComposer, { id: "prompt", value, privateTest, onChange() {} }));
  assert.match(render("原要求", false), /maxLength="2000"/u);
  assert.match(render("原要求", false), /AI 优化提示词/u);
  assert.match(render("原要求", true), /AI 优化提示词/u);
  assert.match(renderToStaticMarkup(createElement(PromptComposer, {id:"disabled",value:"保留文字",disabled:true,privateTest:false,onChange(){}})), /<textarea[^>]*disabled=""[^>]*>保留文字/u);
  for (const [value, mode] of [["", false], ["原要求", undefined], ["长".repeat(2001), false]] as const) {
    assert.match(render(value, mode), /<button[^>]*disabled=""[^>]*>AI 优化提示词/u);
  }
});

test("Pro ignores removed legacy draft settings while manual controls remain and Self tools are hidden", async () => {
  const read = (file: string) => readFile(new URL(`../../components/studio/${file}.tsx`, import.meta.url), "utf8");
  const [pro, self, tools, composer, tray] = await Promise.all([read("AdvancedStudio"), read("SelfServiceStudio"), read("StructureReferenceTools"), read("PromptComposer"), read("ReferenceTray")]);
  assert.doesNotMatch(pro, /config\.preservationMode|config\.editingIntent|EditingIntentFields|setPreservation|setEditIntent|generateVision|afterSource/u);
  assert.match(pro, /preservationMode: "structure"/u);
  assert.match(pro, /removeDraftImage\(`advanced:depth:\$\{previousVersion\}`\)[\s\S]*removeDraftImage\(`advanced:normal:\$\{previousVersion\}`\)/u);
  assert.match(pro, /depthAssetId: depth\?\.id, normalAssetId: normal\?\.id, controlMode/u);
  assert.match(pro, /<section className="advanced-settings"><h3>高级设计判断/u);
  assert.match(self, /studio-results[\s\S]*<StudioTaskList[\s\S]*<\/section>/u);
  assert.doesNotMatch(self, /StructureReferenceTools/u);
  assert.match(tools, /<section className="structure-reference-tools studio-panel" aria-labelledby="structure-tools-title"/u);
  assert.match(tools, /<h2 id="structure-tools-title">结构参考图工具<\/h2>/u);
  assert.doesNotMatch(tools, /<details\b|<summary\b/u);
  assert.match(tools, /draftKey="self-service:structure-tool:source"[\s\S]*kind="source"/u);
  assert.match(tools, /if \(!source \|\| loading\.current \|\| privateTest !== false\) return/u);
  assert.match(tools, /ensureUploadedDraftImage\(source\)[\s\S]*requestId !== visionRequest\.current[\s\S]*generateVision\(sourceAsset.id\)[\s\S]*requestId !== visionRequest\.current/u);
  assert.match(composer, /active\.current && version\.current === started && current\.current === original/u);
  assert.match(composer, /value === before\.optimized/u);
  assert.doesNotMatch(tray, /afterSource/u);
});

test("paid receipt is retained for post-completion authentication/consent failure", async () => {
  const { optimizeImagePrompt, PromptOptimizationError, readPromptOptimization } = await import("../../components/site/api");
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, code] of [[401,"AUTHENTICATION_REQUIRED"],[409,"LEGAL_CONSENT_REQUIRED"]] as const) {
      globalThis.fetch = async () => Response.json({error:{code,message:"重新登录后查询"}},{status});
      await assert.rejects(optimizeImagePrompt("原要求","optimization_00000000-0000-0000-0000-000000000000","ordinary"),error=>error instanceof PromptOptimizationError && !error.terminal);
    }
    let posts=0;
    globalThis.fetch=async(_url,init)=>{posts++;assert.deepEqual(JSON.parse(String(init?.body)),{action:"result",quoteId:"optimization_00000000-0000-0000-0000-000000000000"});return Response.json({status:"SUCCEEDED",optimizedPrompt:"已付费结果",chargedCredits:1});};
    assert.deepEqual(await readPromptOptimization("optimization_00000000-0000-0000-0000-000000000000"),{status:"SUCCEEDED",optimizedPrompt:"已付费结果",chargedCredits:1});assert.equal(posts,1);
  }finally{globalThis.fetch=originalFetch;}
});
