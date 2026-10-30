import { createServer } from "vite";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { assertAuthenticatedActor, assertLegalInput, consentStatements, readLegalConsent } from "../../lib/server/legal-consent";
import { LEGAL_VERSION, safeReturnPath } from "../../lib/domain/legal";
import { GET as price } from "../../app/api/prices/route";
import { publicPriceCatalog } from "../../lib/server/public-prices";
import { quoteGenerationPrice } from "../../lib/server/generation-pricing";
import { assertCostBearingActor } from "../../lib/server/runtime-policy";

const actor={ownerId:"user-a",trusted:true,setCookie:null,user:{authenticated:true,displayName:"A"}};
test("real identity and current legal consent fail closed; immutable acceptance is scoped per owner", async()=>{
 assert.throws(()=>assertAuthenticatedActor({...actor,user:{authenticated:false,displayName:"guest"}}));
 assert.throws(()=>assertAuthenticatedActor({...actor,trusted:false}));
 assert.throws(()=>assertCostBearingActor({...actor,user:{authenticated:false,displayName:"guest"}},{BACKEND_PROFILE:"sites-demo"}));
 for(const input of [undefined,{accepted:false,version:LEGAL_VERSION},{accepted:true,version:"old"}]) assert.throws(()=>assertLegalInput(input));
 const database=new DatabaseSync(":memory:");applyMigrations(database);const d1=new TestD1Database(database) as unknown as D1Database;
 try{
  database.exec("INSERT INTO users(id,display_name) VALUES('user-a','A'),('user-b','B')");
  assert.equal(await readLegalConsent(d1,"user-a"),false);
  await d1.batch(consentStatements(d1,"user-a",123));await d1.batch(consentStatements(d1,"user-a",999));
  assert.equal(await readLegalConsent(d1,"user-a"),true);assert.equal(await readLegalConsent(d1,"user-b"),false);
  assert.deepEqual(database.prepare("SELECT accepted_at FROM user_legal_acceptances").all().map(r=>r.accepted_at),[123,123]);
 }finally{database.close();}
});
test("anonymous public domestic quotes and catalog use the same server calculation and expose no overseas prices",async()=>{
 const catalog=publicPriceCatalog();assert.equal(catalog.length,6);
 for(const model of catalog) for(const [index,resolution] of model.resolutions.entries()) for(let inputImageCount=0;inputImageCount<=model.maxInputs;inputImageCount++){
  const response=price(new Request(`http://localhost/api/prices?${new URLSearchParams({modelId:model.modelId,resolution,inputImageCount:String(inputImageCount),outputCount:"3",aspectRatio:"4:3"})}`));
  assert.equal(response.status,200);const body=await response.json() as {quote:{totalCredits:number}};
  assert.equal(body.quote.totalCredits,model.prices[index][inputImageCount]*3);
  assert.equal(body.quote.totalCredits,quoteGenerationPrice({modelId:model.modelId,requestedResolution:resolution,inputImageCount,outputCount:3,purpose:"final"}).totalCredits);
 }
 for(const modelId of ["gpt-image-2","gemini-3-pro-image","bad"]){const response=price(new Request(`http://localhost/api/prices?modelId=${modelId}`));assert.equal(response.status,400);}
 for(const query of ["inputImageCount=-1&outputCount=1","inputImageCount=999&outputCount=1","inputImageCount=1&outputCount=5","inputImageCount=1&outputCount=1&aspectRatio=bad"]){assert.equal(price(new Request(`http://localhost/api/prices?modelId=qwen-image-3.0&resolution=1K&${query}`)).status,400);}
});
test("upload admission precedes picker and file reading; ratio updates request keys; popover is nonmodal",()=>{
 const fields=readFileSync("components/studio/StudioFields.tsx","utf8");
 assert.match(fields,/onClick=\{\(event\) => \{ if \(!requireClientAccess\(\)\) event.preventDefault\(\)/);
 assert.ok(fields.indexOf("if (!requireClientAccess() || !file")<fields.indexOf("const nextUrl = URL.createObjectURL(file)"));
 const api=readFileSync("components/site/api.ts","utf8");assert.ok(api.indexOf("await requireAssetAccess()")<api.indexOf("fetch(`/api/assets/"));
 const shell=readFileSync("components/site/AppShell.tsx","utf8");assert.doesNotMatch(shell,/aria-modal|document.body.style.overflow|event.key === "Tab"/);assert.match(shell,/pointerdown/);assert.match(shell,/Escape/);
});

test("return paths stay internal and server rendering exposes domestic product and legal UI",async()=>{
 for(const target of ["https://foreign.test","//foreign.test","/\\foreign.test","/api/auth/logout","/\nforeign"] ) assert.equal(safeReturnPath(target),"/profile");
 assert.equal(safeReturnPath("/pro?asset=original"),"/pro?asset=original");
 const {createElement}=await import("react"); const {renderToStaticMarkup}=await import("react-dom/server");
 const server=await createServer({configFile:false,logLevel:"silent",server:{middlewareMode:true},resolve:{alias:{"@":resolve("."),"next/image":resolve("node_modules/vinext/dist/shims/image.js")}}});
 try {
 const {ProductsView}=await server.ssrLoadModule("/components/products/ProductsView.tsx"); const {LegalDocument}=await server.ssrLoadModule("/components/legal/LegalDocument.tsx");
 const products=renderToStaticMarkup(createElement(ProductsView,{catalog:publicPriceCatalog()}));
 assert.match(products,/产品|工作台/);assert.match(products,/微信支付|充值/);assert.doesNotMatch(products,/gpt-image|gemini|OpenAI/);assert.match(products,/350/);
 for(const document of ["terms","privacy","usage","recharge"] as const){const html=renderToStaticMarkup(createElement(LegalDocument,{document}));assert.match(html,/本地预览草稿/);assert.doesNotMatch(html,/保证退款|自动现金退款已/);}
 const {AppShell}=await server.ssrLoadModule("/components/site/AppShell.tsx");const shell=renderToStaticMarkup(createElement(AppShell,null,createElement("p",null,"workspace")));
 assert.match(shell,/产品与价格/);assert.match(shell,/header-account-slot/);assert.doesNotMatch(shell,/aria-modal/);
 } finally { await server.close(); }
});
