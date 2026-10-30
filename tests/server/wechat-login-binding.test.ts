import assert from "node:assert/strict";
import { startEmbeddedWechatLogin } from "../../components/auth/wechat-login-start";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { completeWechatLogin, startWechatLogin } from "../../lib/server/wechat-auth";
import { resolveStoredSessionActor } from "../../lib/server/auth-session";
import { consentStatements, wechatWelcomeStatement } from "../../lib/server/legal-consent";
import { resolveWechatAuthConfig, validateWechatAuthConfig } from "../../lib/server/wechat-auth-config-core";
import { assertPublicImageGenerationActor, assertSameOriginMutation } from "../../lib/server/runtime-policy";
const config={mode:"email" as const,enabled:true,appId:"website-app",secret:"fake-provider-secret",sessionSecret:"s".repeat(32),identityPepper:"p".repeat(32),redirectUri:"https://zaoshi.example.test/api/auth/wechat/callback"};
const hash=(value:string)=>createHmac("sha256",config.sessionSecret).update(value).digest("hex");
function setup(){const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");applyMigrations(db);return {db,d1:new TestD1Database(db) as unknown as D1Database};}
function cookie(response:Response,name:string){const value=response.headers.get("set-cookie")!.match(new RegExp(`${name}=([^;,]+)`));assert.ok(value);return `${name}=${value[1]}`;}
function emailOwner(db:DatabaseSync,id="EMAIL001",token="email-session"){
 db.prepare("INSERT INTO users(id,display_name,role) VALUES(?, '原邮箱用户','ADMIN')").run(id);
 db.prepare("INSERT INTO auth_email_credentials(email,user_id,password_hash,verified_at) VALUES(?,?,?,unixepoch())").run(`${id}@example.test`,id,"unused");
 db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,unixepoch()+3600)").run(hash(token),id);
 return `__Host-zaoshi_session=${token}`;
}
async function round(d1:D1Database,openId:string,existingCookie="",intent:"login"|"bind"="login",invite=""){
 const start=await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start?returnTo=/studio&invite="+encodeURIComponent(invite),{headers:{cookie:existingCookie}}),config,d1,intent);
 const state=new URL(start.headers.get("location")!).searchParams.get("state");const cookies=`${cookie(start,"__Host-zaoshi_oauth")}; ${existingCookie}`;
 const request=new Request(`https://zaoshi.example.test/api/auth/wechat/callback?code=synthetic-code&state=${state}`,{headers:{cookie:cookies}});
 let calls=0;const fetcher=(async()=>Response.json(++calls===1?{access_token:"synthetic",openid:openId,unionid:"shared-union"}:{nickname:"微信昵称",unionid:"shared-union"})) as typeof fetch;
 return {request,finish:()=>completeWechatLogin(request,config,d1,fetcher)};
}
test("email mode enables only explicit, fully configured website capability",()=>{
 const base={AUTH_MODE:"email",WECHAT_OPEN_APP_ID:config.appId,WECHAT_OPEN_SECRET:config.secret,WECHAT_OPEN_REDIRECT_URI:config.redirectUri,SESSION_SECRET:config.sessionSecret,AUTH_IDENTITY_PEPPER:config.identityPepper};
 assert.equal(validateWechatAuthConfig(resolveWechatAuthConfig(base)),false);
 assert.equal(validateWechatAuthConfig(resolveWechatAuthConfig({...base,WECHAT_LOGIN_ENABLED:"1"})),true);
 assert.equal(validateWechatAuthConfig(resolveWechatAuthConfig({...base,WECHAT_LOGIN_ENABLED:"1",WECHAT_OPEN_SECRET:undefined,WECHAT_OPEN_APP_SECRET:config.secret})),false);
});
test("new WeChat owner receives 350 only once after consent; old login and unionid do not merge",async()=>{
 const {db,d1}=setup();const first=await round(d1,"first");const response=await first.finish();const session=cookie(response,"__Host-zaoshi_session");
 const actor=await resolveStoredSessionActor(new Request("https://zaoshi.example.test/api/me",{headers:{cookie:session}}),config.sessionSecret,d1,"__Host-zaoshi_session",{wechatAppId:config.appId});assert.ok(actor);assert.equal(actor.user.verifiedIdentity,"wechat");assert.equal(actor.user.email,undefined);
 assertPublicImageGenerationActor(actor,{BACKEND_PROFILE:"cn-production",AUTH_MODE:"email",PUBLIC_IMAGE_GENERATION_ENABLED:"1",GENERATION_INTERNAL_API_ENABLED:"1"});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()!.n,0);
 await d1.batch([wechatWelcomeStatement(d1,actor.ownerId)]);assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()!.n,0);
 await d1.batch([...consentStatements(d1,actor.ownerId,Math.floor(Date.now()/1000)),wechatWelcomeStatement(d1,actor.ownerId)]);
 await d1.batch([wechatWelcomeStatement(d1,actor.ownerId),wechatWelcomeStatement(d1,actor.ownerId)]);
 assert.equal(db.prepare("SELECT SUM(amount) amount FROM credit_ledger_entries").get()!.amount,350);
 const again=await round(d1,"first");await again.finish();assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get()!.n,1);
 const second=await round(d1,"different");await second.finish();assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get()!.n,2);assert.equal(db.prepare("PRAGMA foreign_key_check").all().length,0);db.close();
});
test("explicit binding preserves owner role name balance and session and never grants welcome",async()=>{
 const {db,d1}=setup();const session=emailOwner(db);db.prepare("INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id) VALUES('existing','EMAIL001','CREDIT',87,'existing','TEST','system','test')").run();
 const before=db.prepare("SELECT * FROM users WHERE id='EMAIL001'").get();const binding=await round(d1,"bound",session,"bind");const response=await binding.finish();assert.equal(response.status,303);assert.equal(db.prepare("SELECT user_id FROM auth_identities WHERE provider='wechat'").get()!.user_id,"EMAIL001");assert.deepEqual(db.prepare("SELECT * FROM users WHERE id='EMAIL001'").get(),before);
 const repeat=await round(d1,"bound",session,"bind");await repeat.finish();await d1.batch([...consentStatements(d1,"EMAIL001",1),wechatWelcomeStatement(d1,"EMAIL001")]);assert.equal(db.prepare("SELECT SUM(amount) amount FROM credit_ledger_entries").get()!.amount,87);
 const login=await round(d1,"bound");const signed=await login.finish();const actor=await resolveStoredSessionActor(new Request("https://zaoshi.example.test/api/me",{headers:{cookie:cookie(signed,"__Host-zaoshi_session")}}),config.sessionSecret,d1,"__Host-zaoshi_session",{wechatAppId:config.appId});assert.equal(actor?.ownerId,"EMAIL001");assert.equal(actor?.user.role,"ADMIN");assert.equal(actor?.user.displayName,"原邮箱用户");db.close();
});
test("binding rejects anonymous, owner conflicts, switched/revoked sessions and state replay",async()=>{
 const {db,d1}=setup();await assert.rejects(startWechatLogin(new Request("https://zaoshi.example.test/bind"),config,d1,"bind"));const session=emailOwner(db);const other=emailOwner(db,"EMAIL002","other-session");
 const initial=await round(d1,"taken",session,"bind");await initial.finish();const conflict=await round(d1,"taken",other,"bind");await assert.rejects(conflict.finish(),(e:unknown)=>e instanceof Error&&"code"in e&&e.code==="WECHAT_ALREADY_BOUND");assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get()!.n,2);
 const revoked=await round(d1,"revoked",session,"bind");db.prepare("UPDATE auth_sessions SET revoked_at=unixepoch() WHERE user_id='EMAIL001'").run();await assert.rejects(revoked.finish());assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_identities").get()!.n,1);await assert.rejects(initial.finish());
 const switched=await round(d1,"switched",other,"bind");const changed=new Request(switched.request.url,{headers:{cookie:switched.request.headers.get("cookie")!.replace("other-session","different-session")}});await assert.rejects(completeWechatLogin(changed,config,d1,async()=>{throw Error("provider must not run");}));assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_identities").get()!.n,1);db.close();
});
test("concurrent binding to different owners keeps a single owner and changes neither account",async()=>{
 const {db,d1}=setup();const a=emailOwner(db),b=emailOwner(db,"EMAIL002","other-session");const before=db.prepare("SELECT * FROM users ORDER BY id").all();
 const [one,two]=await Promise.all([round(d1,"concurrent",a,"bind"),round(d1,"concurrent",b,"bind")]);const results=await Promise.allSettled([one.finish(),two.finish()]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_identities").get()!.n,1);assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(),before);db.close();
});
test("revocation during provider exchange blocks binding mutation",async()=>{
 const {db,d1}=setup();const session=emailOwner(db),flow=await round(d1,"midflight",session,"bind");let calls=0;
 await assert.rejects(completeWechatLogin(flow.request,config,d1,(async()=>{if(++calls===1){db.prepare("UPDATE auth_sessions SET revoked_at=unixepoch() WHERE user_id='EMAIL001'").run();return Response.json({access_token:"fake",openid:"midflight"});}return Response.json({nickname:"unused"});}) as typeof fetch));assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_identities").get()!.n,0);db.close();
});
test("welcome failure atomically rolls back consent and retry credits once",async()=>{
 const {db,d1}=setup();const flow=await round(d1,"rollback");await flow.finish();const id=String(db.prepare("SELECT id FROM users").get()!.id);
 db.exec("CREATE TRIGGER fail_welcome BEFORE INSERT ON credit_ledger_entries BEGIN SELECT RAISE(ABORT,'synthetic ledger failure'); END");
 await assert.rejects(d1.batch([...consentStatements(d1,id,1),wechatWelcomeStatement(d1,id)]));assert.equal(db.prepare("SELECT COUNT(*) n FROM user_legal_acceptances").get()!.n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()!.n,0);db.exec("DROP TRIGGER fail_welcome");await d1.batch([...consentStatements(d1,id,1),wechatWelcomeStatement(d1,id)]);await d1.batch([wechatWelcomeStatement(d1,id)]);assert.equal(db.prepare("SELECT SUM(amount) n FROM credit_ledger_entries").get()!.n,350);db.close();
});
test("shared email sessions reject unknown, wrong-site and suspended identities",async()=>{
 const {db,d1}=setup();db.prepare("INSERT INTO users(id,display_name) VALUES('UNKNOWN1','未知')").run();db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,'UNKNOWN1',unixepoch()+3600)").run(hash("unknown"));
 const request=new Request("https://zaoshi.example.test/me",{headers:{cookie:"__Host-zaoshi_session=unknown"}});const resolve=()=>resolveStoredSessionActor(request,config.sessionSecret,d1,"__Host-zaoshi_session",{wechatAppId:config.appId});assert.equal(await resolve(),null);
 db.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_app_id,subject_hash) VALUES('wrong','UNKNOWN1','wechat','wrong-site','wrong')").run();assert.equal(await resolve(),null);db.prepare("UPDATE auth_identities SET provider_app_id=?").run(config.appId);assert.equal((await resolve())?.user.verifiedIdentity,"wechat");db.prepare("UPDATE users SET status='SUSPENDED'").run();assert.equal(await resolve(),null);db.close();
});

test("embedded login returns only public parameters with nonce cookie and single-use callback", async () => {
 const {db,d1}=setup();
 const response=await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start?returnTo=/studio",{method:"POST"}),config,d1,"login","embedded");
 assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
 const data=await response.json();assert.deepEqual(Object.keys(data).sort(),["appid","expiresAt","redirect_uri","scope","state"].sort());
 assert.equal(data.appid,config.appId);assert.equal(data.scope,"snsapi_login");assert.equal(data.redirect_uri,config.redirectUri);assert.match(data.state,/^[A-Za-z0-9_-]{43}$/);
 assert.ok(data.expiresAt>Date.now()&&data.expiresAt<=Date.now()+600_000);
 assert.match(response.headers.get("set-cookie")!,/Secure/);assert.match(response.headers.get("set-cookie")!,/HttpOnly/);assert.match(response.headers.get("set-cookie")!,/SameSite=Lax/);
 const request=new Request(`https://zaoshi.example.test/api/auth/wechat/callback?code=fake&state=${data.state}`,{headers:{cookie:cookie(response,"__Host-zaoshi_oauth")}});
 let calls=0;const fetcher=(async()=>Response.json(++calls===1?{access_token:"fake",openid:"embedded"}:{nickname:"embedded"})) as typeof fetch;
 const result=await completeWechatLogin(request,config,d1,fetcher);assert.equal(result.status,303);await assert.rejects(completeWechatLogin(request,config,d1,fetcher));assert.equal(calls,2);db.close();
});
test("embedded start requires same-origin mutation; conflict preserves both users and original session",async()=>{
 const url="https://zaoshi.example.test/api/auth/wechat/start";
 assert.throws(()=>assertSameOriginMutation(new Request(url,{method:"POST",headers:{origin:"https://evil.example"}})));
 assert.throws(()=>assertSameOriginMutation(new Request(url,{method:"POST"})));
 assert.doesNotThrow(()=>assertSameOriginMutation(new Request(url,{method:"POST",headers:{origin:"https://zaoshi.example.test"}})));
 const {db,d1}=setup();const a=emailOwner(db),b=emailOwner(db,"EMAIL002","other-session");
 await (await round(d1,"taken",a,"bind")).finish();
 const before=db.prepare("SELECT * FROM users ORDER BY id").all();const sessions=db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all();
 await assert.rejects((await round(d1,"taken",b,"bind")).finish());
 assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(),before);assert.deepEqual(db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(),sessions);
 assert.equal((await resolveStoredSessionActor(new Request(url,{headers:{cookie:b}}),config.sessionSecret,d1,"__Host-zaoshi_session",true))?.ownerId,"EMAIL002");db.close();
});
test("start route preserves GET redirect and gates embedded POST before state creation",async()=>{
 const {createServer}=await import("vite"),{resolve}=await import("node:path");
 const {db,d1}=setup();const key=Symbol.for("zaoshi.test.cloudflare.bindings");const scope=globalThis as typeof globalThis&{[key]?:Record<string,unknown>};const bindings=scope[key]??={};
 Object.assign(bindings,{AUTH_MODE:"email",WECHAT_LOGIN_ENABLED:"1",WECHAT_OPEN_APP_ID:config.appId,WECHAT_OPEN_SECRET:config.secret,WECHAT_OPEN_REDIRECT_URI:config.redirectUri,SESSION_SECRET:config.sessionSecret,AUTH_IDENTITY_PEPPER:config.identityPepper,DB:d1,BACKEND_PROFILE:"sites-demo"});
 const server=await createServer({configFile:false,logLevel:"silent",server:{middlewareMode:true},resolve:{alias:{"@":resolve("."),"cloudflare:workers":resolve("tests/helpers/cloudflare-workers.ts")}}});
 try {
  const route=await server.ssrLoadModule("/app/api/auth/wechat/start/route.ts");const url="https://zaoshi.example.test/api/auth/wechat/start";
  for(const origin of [undefined,"https://evil.example"]) {const response=await route.POST(new Request(url,{method:"POST",headers:origin?{origin}:{}}));assert.equal(response.status,403);}
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_oauth_states").get()!.n,0);
  const response=await route.POST(new Request(url,{method:"POST",headers:{origin:"https://zaoshi.example.test"}}));assert.equal(response.status,200);assert.equal((await response.json()).appid,config.appId);
  const legacy=await route.GET(new Request(url));assert.equal(legacy.status,302);assert.equal(new URL(legacy.headers.get("location")!).origin,"https://open.weixin.qq.com");
 } finally {await server.close();for(const name of Object.keys(bindings))delete bindings[name];db.close();}
});
test("embedded remount shares pending state issuance and queues changed destinations behind real delayed D1 writes",async()=>{
 const {db,d1}=setup();const originalFetch=globalThis.fetch;
 const seed=await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"),config,d1);
 const nonce=cookie(seed,"__Host-zaoshi_oauth");
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 let entered!:()=>void;const firstEntered=new Promise<void>(resolve=>{entered=resolve;});
 let calls=0;const originalBatch=d1.batch.bind(d1);
 d1.batch=async statements=>{if(calls===1){entered();await blocked;}return originalBatch(statements);};
 globalThis.fetch=async(input,init)=>{
  calls++;assert.equal(init?.signal,undefined);
  return startWechatLogin(new Request(new URL(String(input),"https://zaoshi.example.test"),{method:"POST",headers:{cookie:nonce}}),config,d1,"login","embedded");
 };
 try {
  const abandoned=startEmbeddedWechatLogin("/studio");await firstEntered;
  const remounted=startEmbeddedWechatLogin("/studio");assert.equal(remounted,abandoned);assert.equal(calls,1);
  const changed=startEmbeddedWechatLogin("/profile");await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
  release();const old=await abandoned;const current=await changed;assert.equal(calls,2);assert.notEqual(old.state,current.state);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_oauth_states WHERE state_hash=?").get(hash(current.state))!.n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_oauth_states WHERE state_hash=?").get(hash(old.state))!.n,0);
  let providerCalls=0;
  const response=await completeWechatLogin(new Request(`https://zaoshi.example.test/api/auth/wechat/callback?code=synthetic&state=${current.state}`,{headers:{cookie:nonce}}),config,d1,(async()=>Response.json(++providerCalls===1?{access_token:"synthetic",openid:"serialized"}:{nickname:"serialized"})) as typeof fetch);
  assert.equal(response.status,303);assert.equal(new URL(response.headers.get("location")!).pathname,"/consent");
 } finally {release();globalThis.fetch=originalFetch;db.close();}
});
test("embedded start releases a completed HTTP failure so explicit retry can succeed",async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>++calls===1?Response.json({error:{message:"synthetic unavailable"}},{status:503}):Response.json({state:"retry"});
 try{await assert.rejects(startEmbeddedWechatLogin("/studio"),/synthetic unavailable/);assert.equal((await startEmbeddedWechatLogin("/studio")).state,"retry");assert.equal(calls,2);}finally{globalThis.fetch=original;}
});

 test("OAuth freezes invite for new users while login and bind cannot change attribution",async()=>{
 const {db,d1}=setup();db.exec("INSERT INTO users(id,display_name) VALUES('PROMO001','P'),('PROMO002','Q');INSERT INTO referral_promoters(user_id) VALUES('PROMO001'),('PROMO002')");
 await (await round(d1,'invited','','login','PROMO001')).finish();
 assert.equal(db.prepare('SELECT promoter_id FROM user_referrals').get()?.promoter_id,'PROMO001');
 assert.equal(db.prepare('SELECT active_concurrency_limit n FROM user_generation_limits').get()?.n,3);
 await (await round(d1,'invited','','login','PROMO002')).finish();
 assert.equal(db.prepare('SELECT promoter_id FROM user_referrals').get()?.promoter_id,'PROMO001');
 const session=emailOwner(db);await(await round(d1,'bound-invite',session,'bind','PROMO002')).finish();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_referrals').get()?.n,1);db.close();
 });
