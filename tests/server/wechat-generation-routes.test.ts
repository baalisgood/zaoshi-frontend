import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";
import { activeVerifiedIdentityPolicy } from "../../lib/server/wechat-auth-config-core";

const config={AUTH_MODE:"email",WECHAT_LOGIN_ENABLED:"1",WECHAT_OPEN_APP_ID:"website-synthetic",WECHAT_OPEN_SECRET:"fake-website-secret",WECHAT_OPEN_REDIRECT_URI:"https://example.test/api/auth/wechat/callback",SESSION_SECRET:"s".repeat(32),AUTH_IDENTITY_PEPPER:"p".repeat(32),BACKEND_PROFILE:"cn-production",PUBLIC_IMAGE_GENERATION_ENABLED:"1",GENERATION_INTERNAL_API_ENABLED:"1",DASHSCOPE_API_KEY:"fake-provider-key",DASHSCOPE_WORKSPACE_ID:"synthetic",TENCENT_MODERATION_ENABLED:"0",WECHAT_PAY_ENABLED:"0"};
function cookie(response:Response,name:string){const match=response.headers.get("set-cookie")!.match(new RegExp(`${name}=([^;,]+)`));assert.ok(match);return `${name}=${match[1]}`;}
test("real routes: first WeChat OAuth → consent 350 → quote → queue reservation, with no verified email or real provider dispatch",async()=>{
 const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");applyMigrations(db);const d1=new TestD1Database(db) as unknown as D1Database;
 const key=Symbol.for("zaoshi.test.cloudflare.bindings"),scope=globalThis as typeof globalThis&{[key]?:Record<string,unknown>},bindings=scope[key]??={};Object.assign(bindings,{...config,DB:d1,ASSETS_BUCKET:new TestR2Bucket()});
 const server=await createServer({configFile:false,logLevel:"silent",server:{middlewareMode:true},resolve:{alias:{"@":resolve("."),"cloudflare:workers":resolve("tests/helpers/cloudflare-workers.ts")}}});const oldFetch=globalThis.fetch,oldPublic=process.env.PUBLIC_IMAGE_GENERATION_ENABLED;process.env.PUBLIC_IMAGE_GENERATION_ENABLED="1";let providerCalls=0,optimizerCalls=0;
 const request=(path:string,body?:unknown,session="")=>new Request(`https://example.test${path}`,{method:body?"POST":"GET",headers:{origin:"https://example.test",cookie:session,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const start=await server.ssrLoadModule("/app/api/auth/wechat/start/route.ts"),callback=await server.ssrLoadModule("/app/api/auth/wechat/callback/route.ts"),me=await server.ssrLoadModule("/app/api/me/route.ts"),accept=await server.ssrLoadModule("/app/api/legal/accept/route.ts"),quote=await server.ssrLoadModule("/app/api/jobs/quote/route.ts"),jobs=await server.ssrLoadModule("/app/api/jobs/route.ts"),optimizer=await server.ssrLoadModule("/app/api/prompts/optimize/route.ts");
  const begun=await start.GET(request("/api/auth/wechat/start"));assert.equal(begun.status,302);const state=new URL(begun.headers.get("location")!).searchParams.get("state");
  globalThis.fetch=async input=>{providerCalls++;const url=new URL(String(input));assert.equal(url.origin,"https://api.weixin.qq.com");return Response.json(url.pathname.endsWith("/access_token")?{access_token:"synthetic-only",openid:"synthetic-only"}:{nickname:"微信新用户"});};
  const signed=await callback.GET(request(`/api/auth/wechat/callback?code=synthetic&state=${state}`,undefined,cookie(begun,"__Host-zaoshi_oauth")));assert.equal(signed.status,303);const session=cookie(signed,"__Host-zaoshi_session");assert.equal(providerCalls,2);globalThis.fetch=async()=>{throw Error("No model or payment request may be dispatched by queue/quote tests");};
  let account=await (await me.GET(request("/api/me",undefined,session))).json();assert.equal(account.user.email,undefined);assert.equal(account.user.verifiedIdentity,"wechat");assert.equal(account.credits.available,0);assert.equal(account.legal.accepted,false);assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_email_credentials").get()!.n,0);
  const base={workflowType:"self-service",purpose:"final",providerPreference:"qwen-image-3.0",resolution:"2K",quality:"standard",aspectRatio:"1:1",outputCount:1,customPrompt:"明亮客厅，保留窗户与结构",idempotencyKey:"wechat-new-first",draftScope:account.draftScope};
  assert.equal((await jobs.POST(request("/api/jobs",base,session))).status,409);
  assert.equal((await accept.POST(request("/api/legal/accept",{accepted:true,version:account.legal.version},session))).status,200);account=await (await me.GET(request("/api/me",undefined,session))).json();assert.equal(account.credits.available,350);
  const quoted=await quote.POST(request("/api/jobs/quote",{modelId:base.providerPreference,purpose:base.purpose,resolution:base.resolution,quality:base.quality,aspectRatio:base.aspectRatio,inputImageCount:0,outputCount:1},session));assert.equal(quoted.status,200);const price=(await quoted.json()).quote;
  const body={...base,expectedPriceVersion:price.priceVersion,expectedTotalCredits:price.totalCredits};const submitted=await jobs.POST(request("/api/jobs",body,session));const accepted=await submitted.json();assert.equal(submitted.status,202,JSON.stringify(accepted));assert.equal(accepted.job.status,"QUEUED");assert.equal(db.prepare("SELECT COUNT(*) n FROM generation_quota_admissions").get()!.n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM generation_job_items").get()!.n,1);
  account=await (await me.GET(request("/api/me",undefined,session))).json();assert.equal(account.credits.reserved,price.totalCredits);assert.equal(account.credits.available,350-price.totalCredits);assert.equal((await jobs.POST(request("/api/jobs",body,session))).status,202);assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='RESERVE'").get()!.n,1);
  const optimized=await optimizer.POST(request("/api/prompts/optimize",{action:"quote",prompt:"明亮客厅",context:"ordinary"},session));const optimizationQuote=await optimized.json();assert.equal(optimized.status,200,JSON.stringify(optimizationQuote));
  globalThis.fetch=async input=>{optimizerCalls++;assert.equal(String(input),"https://synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");return Response.json({choices:[{finish_reason:"stop",message:{content:"保留窗户与结构，明亮自然光客厅"}}],usage:{prompt_tokens:100}});};
  const optimizedResult=await optimizer.POST(request("/api/prompts/optimize",{action:"optimize",quoteId:optimizationQuote.quoteId,prompt:"明亮客厅",context:"ordinary"},session));assert.equal(optimizedResult.status,200);assert.equal((await optimizedResult.json()).status,"SUCCEEDED");assert.equal(optimizerCalls,1);
  const rechargeRuntime=await server.ssrLoadModule("/lib/server/recharge-runtime.ts");const rechargeIdentity=await rechargeRuntime.rechargeActor(request("/api/recharge/orders",undefined,session));assert.equal(rechargeIdentity.actor.ownerId,db.prepare("SELECT id FROM users").get()!.id);assert.equal(rechargeIdentity.actor.user.email,undefined);
  const before=JSON.stringify(db.prepare("SELECT * FROM credit_ledger_entries").all());
  for(const change of [()=>{bindings.WECHAT_LOGIN_ENABLED="0";},()=>{bindings.WECHAT_LOGIN_ENABLED="1";bindings.WECHAT_OPEN_APP_ID="wrong-app";},()=>{bindings.WECHAT_OPEN_APP_ID=config.WECHAT_OPEN_APP_ID;db.prepare("UPDATE users SET status='SUSPENDED'").run();}]){
   change();assert.equal((await quote.POST(request("/api/jobs/quote",{modelId:base.providerPreference,purpose:"final",resolution:"2K",inputImageCount:0,outputCount:1},session))).status,401);const refused=await jobs.POST(request("/api/jobs",{...body,idempotencyKey:crypto.randomUUID()},session));assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,"DRAFT_SCOPE_MISMATCH");
  }
  assert.equal((await quote.POST(request("/api/jobs/quote",{modelId:base.providerPreference,purpose:"final",resolution:"2K",inputImageCount:0,outputCount:1}))).status,401);assert.equal(JSON.stringify(db.prepare("SELECT * FROM credit_ledger_entries").all()),before);assert.equal(providerCalls,2);assert.equal(optimizerCalls,1);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
 }finally{globalThis.fetch=oldFetch;if(oldPublic===undefined)delete process.env.PUBLIC_IMAGE_GENERATION_ENABLED;else process.env.PUBLIC_IMAGE_GENERATION_ENABLED=oldPublic;await server.close();for(const name of Object.keys(bindings))delete bindings[name];db.close();}
});

test("transaction policy carries only the enabled configured website app",()=>{
 assert.deepEqual(activeVerifiedIdentityPolicy(config),{requireActiveVerifiedIdentity:true,wechatAppId:config.WECHAT_OPEN_APP_ID});
 assert.deepEqual(activeVerifiedIdentityPolicy({...config,WECHAT_LOGIN_ENABLED:"0"}),{requireActiveVerifiedIdentity:true});
 assert.deepEqual(activeVerifiedIdentityPolicy({...config,WECHAT_OPEN_SECRET:undefined}),{requireActiveVerifiedIdentity:true});
});
