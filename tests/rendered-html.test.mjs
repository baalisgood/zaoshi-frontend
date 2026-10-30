import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let workerPromise;

async function worker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then((module) => module.default);
  }
  return workerPromise;
}

async function render(path = "/") {
  const app = await worker();
  const fetchApp = typeof app === "function" ? app : app.fetch.bind(app);
  return fetchApp(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "share.example.test",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

const routeCases = [
  ["/", "懂设计，<br/><em>就能开始 AI 创作。</em>", "空间灵感库"],
  ["/studio", "把现场照片，变成可讨论的第一版构想", "任务摘要"],
  ["/pro", "把控制交还给设计判断", "出图参数"],
  ["/self-service", "把创作要求直接交给图像模型", "AI 优化提示词"],
  ["/profile", "个人资料", "正在读取个人资料…"],
];

const adminRouteCases = [
  ["/admin", "运营总览"],
  ["/admin/users", "用户管理"],
  ["/admin/credits", "积分账本"],
  ["/admin/tasks", "任务监控"],
  ["/admin/providers", "供应商状态"],
  ["/admin/analytics", "运营分析"],
  ["/admin/audit", "完整审计记录"],
  ["/admin/content", "图片保留与清理"],
];

test("server-renders all public routes with shared navigation and truthful content", async () => {
  for (const [path, heading, marker] of routeCases) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/iu, path);
    const html = await response.text();
    assert.match(html, /<html lang="zh-CN">/u, path);
    assert.match(html, /aria-label="主要导航"/u, path);
    assert.match(html, /href="\/studio"/u, path);
    assert.match(html, /href="\/pro"/u, path);
    assert.doesNotMatch(html, /href="\/floorplan"|平面图工作台/u, path);
    assert.match(html, /href="\/self-service"/u, path);
    assert.match(html, /href="\/products"/u, path);
    assert.match(html, /href="\/login"/u, path);
    assert.match(html, />智能工作台</u, path);
    assert.doesNotMatch(html, />概念工作台</u, path);
    assert.match(html, /aria-label="打开个人资料"/u, path);
    assert.ok(html.includes(heading), `${path} missing ${heading}`);
    assert.ok(html.includes(marker), `${path} missing ${marker}`);
    assert.doesNotMatch(html, /Your site is taking shape|Building your site/u, path);
  }
});

test("retired library URLs redirect to studio", async () => {
  const response = await render("/library");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/studio");
});

test("retired floorplan URLs redirect to self-service without importing old parameters", async () => {
  for (const path of ["/floorplan", "/floorplan?asset=old-plan&template=old-template"]) {
    const response = await render(path);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "/self-service");
  }
});

test("server-renders the unified admin console without claiming unavailable payment or provider data", async () => {
  for (const [path, heading] of adminRouteCases) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /正在确认管理员身份/u, path);
    assert.doesNotMatch(html, /aria-label="管理员导航"/u, path);
    const adminShell = await readFile(new URL("../components/admin/AdminShell.tsx", import.meta.url), "utf8");
    assert.ok(adminShell.includes(`"${path}"`), `${path} missing navigation route`);
    assert.match(await readFile(new URL(path === "/admin/content" ? "../app/admin/content/page.tsx" : "../components/admin/AdminConsoleView.tsx", import.meta.url), "utf8"), new RegExp(heading, "u"));
    assert.match(adminShell, /aria-label="管理员导航"/u);
  }

  const [consoleSource, analyticsSource, trackerSource, contentSource] = await Promise.all([
    readFile(new URL("../components/admin/AdminConsoleView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/site/AnalyticsTracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/content/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(consoleSource, /充值统计基于已验证到账订单[\s\S]*人工赠送积分不计作支付充值/u);
  assert.match(consoleSource, /供应商实时余额与探测尚未接入/u);
  assert.match(consoleSource, /生产队列监控[\s\S]*已到调度时间（不代表最终可领取）[\s\S]*过期租约/u);
  assert.match(consoleSource, /30_000[\s\S]*visibilitychange/u);
  assert.match(consoleSource, /AdminPagination[\s\S]*nextCursor/u);
  assert.match(analyticsSource, /visitor_hash[\s\S]*recharge: await rechargeSummary\(d1,start,now\)/u);
  assert.doesNotMatch(analyticsSource, /user-agent|referer|x-forwarded-for/iu);
  assert.match(trackerSource, /visibilitychange[\s\S]*pagehide[\s\S]*keepalive/u);
  assert.doesNotMatch(contentSource, /扫描到期图片|执行文件清理/u);
  assert.match(contentSource, /重试阻塞项/u);
});

test("visual realism appears only in concept and advanced workbench sources", async () => {
  const [concept, advanced, selfService] = await Promise.all([
    readFile(new URL("../components/studio/InteriorStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/studio/AdvancedStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/studio/SelfServiceStudio.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(concept, /视觉表现/u);
  assert.match(advanced, /视觉表现/u);
  assert.doesNotMatch(selfService, /visualRealism|视觉表现/u);
});

test("home gallery exposes truthful prompt details and three design categories", async () => {
  const [home, shell, css] = await Promise.all([
    readFile(new URL("../components/home/HomePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/site/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(home, /室内设计[\s\S]*景观环境[\s\S]*建筑外观/u);
  assert.match(home, /masonry-gallery[\s\S]*gallery-card/u);
  assert.match(home, /<dialog[\s\S]*构图分析提示词[\s\S]*复制提示词/u);
  assert.match(home, /listPublicGallery|\/api\/gallery/u);
  assert.match(home, /gallery-sentinel|IntersectionObserver/u);
  assert.match(home, /造室精选.*摄影参考与造室风格示例.*非客户案例/u);
  assert.doesNotMatch(home, /社区精选作品|用户授权并经审核|提示词由创作者选择公开/u);
  assert.doesNotMatch(home, /gallery-workbench/u);
  assert.match(shell, /aria-pressed=\{theme === "dark"\}/u);
  assert.match(shell, /localStorage\.setItem\("zaoshi-theme"/u);
  assert.match(shell, /pointermove[\s\S]*scroll[\s\S]*focusin/u);
  assert.match(shell, /site-header\$\{headerHidden \? " is-hidden"/u);
  assert.match(css, /html\[data-theme="dark"\]/u);
  assert.match(css, /\.masonry-gallery \{ columns:3;/u);
  assert.match(css, /@media\(max-width:599px\)[^\n]*columns:1/u);
});

test("studio route boundaries keep structure controls in Advanced only", async () => {
  const studioHtml = await (await render("/studio")).text();
  const proHtml = await (await render("/pro")).text();
  const conceptSource = await readFile(new URL("../components/studio/InteriorStudio.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(conceptSource, /Depth|Normal|结构控制/u);
  assert.match(studioHtml, /CONCEPT STUDIO/u);
  assert.match(proHtml, /Depth|Normal/u);
  assert.match(proHtml, /现场 \/ 方案基底|风格参考|家具 \/ 软装|材质|色彩 \/ 灯光|构图/u);
  assert.match(proHtml, /图片先保存在当前标签页，点击生成后才上传/u);
});

test("every rendered route includes absolute 1200x630 social metadata", async () => {
  for (const [path] of routeCases) {
    const response = await render(path);
    const html = await response.text();
    assert.match(html, /property="og:image" content="https:\/\/share\.example\.test\/og\.png"/u, path);
    assert.match(html, /property="og:image:width" content="1200"/u, path);
    assert.match(html, /property="og:image:height" content="630"/u, path);
    assert.match(html, /name="twitter:card" content="summary_large_image"/u, path);
    assert.match(html, /name="twitter:image" content="https:\/\/share\.example\.test\/og\.png"/u, path);
  }

  const og = await readFile(new URL("../public/og.png", import.meta.url));
  assert.equal(og.readUInt32BE(16), 1200);
  assert.equal(og.readUInt32BE(20), 630);
});

test("client source keeps responsive, asset-kind and secret boundaries explicit", async () => {
  const [shell, fields, concept, advanced, selfService, taskList, library, css, layout, tray, api, promptComposer, tools] =
    await Promise.all([
      readFile(new URL("../components/site/AppShell.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/StudioFields.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/InteriorStudio.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/AdvancedStudio.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/SelfServiceStudio.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/StudioTaskList.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/library/AssetLibrary.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/ReferenceTray.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/site/api.ts", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/PromptComposer.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/studio/StructureReferenceTools.tsx", import.meta.url), "utf8"),
    ]);
  const clientSource = [shell, fields, concept, advanced, selfService, taskList, library].join("\n");

  assert.match(shell, /href === "\/" \? path === "\/" : path === href/u);
  assert.match(shell, /ProfileView compact/u);
  assert.match(await readFile(new URL("../components/profile/ProfileView.tsx", import.meta.url), "utf8"), /snapshot\.stats\.today/u);
  assert.match(fields, /readImageDimensions/u);
  assert.match(fields, /displayDimensions\.width[^\n]*displayDimensions\.height/u);
  assert.match(concept, /asset\.kind !== "source"/u);
  assert.match(advanced, /asset\.kind !== "reference" && asset\.kind !== "output"/u);
  assert.match(selfService, /kind="reference"[\s\S]*PromptComposer[\s\S]*模型质量/u);
  assert.doesNotMatch(selfService, /StylePicker|Depth|Normal/u);
  assert.match(promptComposer, /AI 优化提示词[\s\S]*撤销优化/u);
  for (const [studio, workflow] of [[concept, "concept"], [advanced, "advanced"], [selfService, "self-service"]]) {
    assert.match(studio, new RegExp(`StudioTaskList workflowType="${workflow}"`, "u"));
  }
  assert.match(taskList, /下载已选结果/u);
  assert.match(taskList, /序号[\s\S]*参考图[\s\S]*提交时间[\s\S]*状态/u);
  assert.match(taskList, /结果[\s\S]*输出图/u);
  assert.match(taskList, /job\.results\.map\(\(result, resultIndex\) => result\.url/u);
  assert.match(taskList, /visibilitychange[\s\S]*zaoshi:jobs-changed/u);
  assert.match(taskList, /download=1/u);
  assert.match(library, /asset\.kind === "output"[\s\S]*`\/pro\?reference=/u);
  assert.match(library, /const usable = asset\.moderationStatus !== "REJECTED"/u);
  assert.doesNotMatch(library, /等待内容审核/u);

  assert.match(css, /\.studio-workspace[^}]*grid-template-areas:"primary inspector" "results inspector"/u);
  assert.match(css, /\.studio-workspace \{[^}]*grid-template-columns:minmax\(0,1fr\) clamp\(360px,28vw,480px\)/u);
  assert.match(css, /\.studio-results[^}]*min-height:clamp\(420px,46vh,620px\)/u);
  assert.match(css, /\.result-empty[^}]*min-height:clamp\(360px,40vh,540px\)/u);
  assert.match(css, /\.generated-image[^}]*height:clamp\(340px,34vw,520px\)/u);
  assert.match(css, /\.task-summary[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(css, /\.upload-pair \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*align-items:start/u);
  assert.match(css, /\.parameter-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*align-items:start/u);
  assert.match(css, /\.upload-field-head>div \{[^}]*min-width:0/u);
  assert.match(css, /\.upload-field-head h3,\.upload-field-head p \{[^}]*overflow-wrap:anywhere/u);
  assert.match(css, /\.segmented-control \{[^}]*justify-content:flex-start/u);
  assert.match(css, /\.segmented-control button \{[^}]*flex:0 0 auto[^}]*width:auto/u);
  assert.doesNotMatch(css, /\.segmented-control button \{[^}]*flex:1/u);
  assert.doesNotMatch(css, /\.segmented-control \{[^}]*flex-wrap:nowrap/u);
  assert.doesNotMatch(css, /\.segmented-control \{[^}]*overflow-x:auto/u);
  for (const studio of [concept, advanced, selfService]) {
    assert.match(studio, /ImageModelSelect value=\{provider\}/u);
    assert.doesNotMatch(studio, /Segmented label="图像模型"/u);
  }
  assert.match(fields, /export function ImageModelSelect[\s\S]*className="select-field image-model-field"[\s\S]*<select/u);
  assert.match(css, /\.studio-workspace \{ display:grid; min-width:0; align-items:start;/u);
  assert.match(css, /\.task-table \{[^}]*min-width:900px/u);
  assert.match(css, /\.studio-inspector[^}]*grid-area:inspector/u);
  assert.match(css, /\.studio-inspector[^}]*position:sticky/u);
  for (const studio of [concept, advanced, selfService]) {
    assert.doesNotMatch(studio, /TemplateProvider|TemplateQuickPicker|SaveTemplateAction/u);
    assert.match(studio, /useStudioParameterDraft/u);
  }
  assert.doesNotMatch(clientSource, /TemplatePicker|\?template=/u);
  assert.doesNotMatch(api, /\/api\/templates/u);
  assert.doesNotMatch(taskList, /saveTemplate|保存参数模板|zaoshi:templates-changed/u);
  assert.match(taskList, /zaoshi:apply-job-parameters[\s\S]*使用此图参数/u);
  assert.match(tray, /images\.unsplash\.com\/photo-1600210492486-724fe5c67fb0\?auto=format&fit=crop&w=760&q=82/u);
  assert.match(tray, /操作示意：圈选沙发；本地标注当前不参与生成/u);
  assert.match(tray, /<span>圈选沙发<\/span>/u);
  assert.match(tools, /Depth 用明暗表示相对远近[\s\S]*Normal 用颜色表示表面朝向/u);
  assert.match(tray, /图片先保存在当前标签页，点击生成后才上传/u);
  assert.doesNotMatch(tray, /图片角色/u);
  assert.match(advanced, /ReferenceTray workflow="advanced"/u);
  assert.match(tray, /现场 \/ 方案基底[\s\S]*风格参考[\s\S]*家具 \/ 软装[\s\S]*材质[\s\S]*色彩 \/ 灯光[\s\S]*构图[\s\S]*门窗 \/ 结构参考[\s\S]*Depth 深度参考[\s\S]*Normal 法线参考/u);
  assert.match(tray, /门窗 \/ 结构参考[\s\S]*门、窗、楼梯/u);
  assert.match(advanced, /structureReference[\s\S]*role: "structure"/u);
  assert.doesNotMatch(concept, /家具、灯具、门窗/u);
  assert.match(tray, /参与本次生成[\s\S]*启用对应结构模式后参与/u);
  assert.doesNotMatch(tray, /已上传保存但当前不随任务发送/u);
  assert.match(tray, /已加入家具 \/ 软装参考，本次任务将一并发送/u);
  assert.doesNotMatch(concept, /additionalReferences|referenceAssetId|onLocalEdit|ReferenceTray/u);
  assert.match(concept, /ImageUploadField[\s\S]*draftKey="concept:source"/u);
  assert.match(advanced, /additionalReferences[\s\S]*material[\s\S]*lighting-color[\s\S]*composition/u);
  assert.match(selfService, /additionalReferences[\s\S]*role: "reference" as const/u);
  assert.doesNotMatch(selfService, /maskAssetId|depthAssetId|normalAssetId/u);
  assert.doesNotMatch(concept, /Depth|Normal|结构控制/u);
  assert.match(advanced, /studio-workspace advanced-workspace/u);
  assert.match(advanced, /type LampState = "on" \| "off";/u);
  assert.match(advanced, /lamp: \[\{ value: "on", label: "开灯" \}, \{ value: "off", label: "关灯" \}\]/u);
  assert.match(advanced, /useState<LampState>\("on"\)/u);
  assert.match(advanced, /setLampState\(config\.lampState === "off" \? "off" : "on"\); setLegacyLampNotice\(config\.lampState === "mixed"\)/u);
  assert.match(advanced, /setLampState\(value\); setLegacyLampNotice\(false\)/u);
  assert.match(advanced, /legacyLampNotice && <p className="summary-note" role="status">原混合灯态已调整为开灯/u);
  const judgement = advanced.match(/<section className="advanced-settings"><h3>高级设计判断<\/h3><div className="parameter-grid">([\s\S]*?)<\/div><\/section>/u)?.[1];
  assert.ok(judgement);
  assert.deepEqual([...judgement.matchAll(/<Segmented label="([^"]+)"/gu)].map((match) => match[1]), ["几何保真", "相机策略", "陈设密度", "材质表达", "光照对比"]);
  assert.doesNotMatch(judgement, /<details|<summary/u);
  assert.match(advanced, /className="task-summary"[\s\S]*提示词补充[\s\S]*结构策略[\s\S]*光照氛围[\s\S]*输出规格/u);
  assert.doesNotMatch(advanced, /options\.preservation|config\.preservationMode|EditingIntentFields|config\.editingIntent/u);
  assert.match(advanced, /preservationMode: "structure"/u);
  assert.doesNotMatch(advanced, /设计风格<\/span>/u);
  assert.match(concept, /scheme-picker[\s\S]*scheme\.palette/u);
  assert.match(advanced, /studio-primary[\s\S]*studio-inspector[\s\S]*提交生图/u);
  assert.doesNotMatch(advanced, /advanced-linear|<main\b|<aside className="studio-inspector"[^>]*>\s*<\/aside>/u);
  assert.match(tools, /type CanvasMode = "source" \| "reference" \| "depth" \| "normal" \| "latest"/u);
  assert.match(tools, /role="tablist"[\s\S]*tabs\.map[\s\S]*role="tab"/u);
  assert.doesNotMatch(selfService, /StructureReferenceTools/u);
  assert.match(tools, /canvasMode === "latest" \? latestUrl : canvasImage\?\.url/u);
  assert.match(tools, /aria-selected=\{canvasMode === mode\}/u);
  assert.match(tools, /tabIndex=\{canvasMode === mode \? 0 : -1\}/u);
  assert.match(tools, /structure-tool-tab-\$\{mode\}/u);
  assert.match(tools, /aria-controls="structure-tool-canvas-panel"/u);
  assert.match(tools, /id="structure-tool-canvas-panel"/u);
  assert.doesNotMatch(tools, /aria-controls=\{`advanced-panel-\$\{mode\}`\}/u);
  assert.match(tools, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/u);
  assert.match(tools, /visionRequest[\s\S]*sourceRef[\s\S]*requestId !== visionRequest\.current[\s\S]*sourceRef\.current !== sourceKey/u);
  assert.match(advanced, /handleSourceChange[\s\S]*sourceRef\.current[\s\S]*setDepth\(undefined\)[\s\S]*setNormal\(undefined\)/u);
  assert.match(advanced, /fetchAsset\(id\)[\s\S]*handleSourceChange\(asset\)/u);
  assert.match(advanced, /ReferenceTray workflow="advanced"[\s\S]*onSourceChange=\{handleSourceChange\}/u);
  assert.match(clientSource, /StudioImageEditor/u);
  assert.match(await readFile(new URL("../components/studio/StudioImageEditor.tsx", import.meta.url), "utf8"), /画笔[\s\S]*橡皮擦[\s\S]*应用裁剪/u);
  assert.match(selfService, /参考图（可选）[\s\S]*可不上传图片进行纯文生图[\s\S]*按顺序添加最多/u);
  assert.doesNotMatch(selfService, /必须上传一张|暂不支持纯文生图和多参考图/u);
  assert.match(await readFile(new URL("../components/studio/StudioImageEditor.tsx", import.meta.url), "utf8"), /saveDraftImage\("editor:source:base", "source"/u);
  assert.doesNotMatch(concept, /submitLocalEdit[\s\S]*maskAssetId[\s\S]*outputCount: 1/u);
  assert.doesNotMatch(concept, /maskAssetId|StudioImageEditor|className="edit-dialog"/u);
  assert.doesNotMatch(await readFile(new URL("../components/studio/StudioImageEditor.tsx", import.meta.url), "utf8"), /Array\.from\(\{ length: pixels\.length/u);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.canvas-tabs button[^}]*min-height:44px/u);
  assert.match(tools, /软参考：非硬约束/u);
  assert.match(tools, /visionState.*partial/u);
  assert.match(advanced, /sourceMessage[\s\S]*referenceMessage[\s\S]*workflowMessage/u);
  for (const studio of [concept]) {
    assert.match(studio, /studio-workspace[\s\S]*studio-primary[\s\S]*studio-inspector[\s\S]*studio-results/u);
    assert.doesNotMatch(studio, /workbench-grid|studio-controls|studio-summary/u);
  }
  for (const studio of [concept, advanced, selfService]) {
    assert.match(studio, /useGenerationPricing/u);
    assert.match(studio, /useGenerationJob\(privateTest\)/u);
    assert.match(studio, /<div className="generation-actions">\s*<button className="primary-button(?: wide)?"[\s\S]*?\{privateTest \? "提交生图"/u);
    assert.doesNotMatch(studio, /生成参考图|生成成品图|pricing\.preview|generate\("preview"\)/u);
    assert.match(studio, /purpose: "final"/u);
    assert.match(studio, /expectedPriceVersion[\s\S]*expectedTotalCredits/u);
  }
  const generationView = await readFile(new URL("../components/studio/GenerationView.tsx", import.meta.url), "utf8");
  assert.match(generationView, /useFinalizeGenerationPricing[\s\S]*生成高清成品 ·/u);
  assert.match(generationView, /expectedPriceVersion[\s\S]*expectedTotalCredits/u);
  assert.match(concept, /className="task-summary"[\s\S]*设计风格[\s\S]*改造策略[\s\S]*光照氛围[\s\S]*输出规格/u);
  assert.match(concept, /<small>\{outputCount\}张输出<\/small>/u);
  assert.match(tools, /classifyVisionArtifacts/u);
  assert.match(advanced, /mergeAdvancedSettings/u);
  assert.doesNotMatch(advanced, /pro-parameters[^}]*max-height/u);
  assert.match(css, /\.image-drop img[^}]*object-fit:contain/u);
  assert.match(css, /\.image-drop img[^}]*position:absolute[^}]*inset:12px[^}]*width:calc\(100% - 24px\)[^}]*height:calc\(100% - 24px\)/u);
  assert.match(css, /\.selection-example-canvas[^}]*background-size:contain/u);
  assert.match(css, /\.summary-preview img[^}]*position:absolute[^}]*inset:12px[^}]*width:calc\(100% - 24px\)[^}]*height:calc\(100% - 24px\)/u);
  assert.doesNotMatch(generationView, /<code[^>]*>\{job\.id\}<\/code>/u);
  assert.match(concept, /lampState === "off" \? "自然光"/u);
  assert.match(fields, /<select[^>]*[\s\S]*available\.map/u);
  assert.match(css, /\.generation-actions \{[^}]*grid-template-columns:minmax\(0,180px\);[^}]*justify-content:start;[^}]*gap:8px;/u);
  assert.doesNotMatch(css, /\.generation-actions[^}]*grid-template-columns:repeat\(2,/u);
  assert.match(css, /@media \(max-width:1100px\)[\s\S]*\.studio-page,.pro-workbench \{ width:calc\(100% - 32px\); \}/u);
  assert.match(css, /@media \(max-width:899px\)[\s\S]*\.studio-page,.pro-workbench \{ width:calc\(100% - 32px\); \}/u);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.studio-page,.pro-workbench \{ width:calc\(100% - 24px\); \}/u);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.page-shell \{ width:calc\(100% - 24px\); \}/u);

  assert.match(layout, /width:\s*1200,\s*height:\s*630/u);
  assert.doesNotMatch(
    clientSource,
    /OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|VISION_PIPELINE_API_KEY|NEXT_PUBLIC_[A-Z_]*KEY/u,
  );
  assert.doesNotMatch(clientSource, /本次任务不会计费|本次不会扣费|自动退款/u);
  assert.doesNotMatch(clientSource, /promptDirective|PROMPT_TEMPLATE_VERSION/u);
});
