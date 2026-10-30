import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv,createSign,generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { createServer } from "vite";
import { applyMigrations,TestD1Database } from "../helpers/test-d1";
import { secretHash } from "../../lib/server/auth-session";
import { LEGAL_VERSION } from "../../lib/domain/legal";
import { rechargeSummary } from "../../lib/server/recharge-native-orders";
const pair=generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
const config={WECHAT_PAY_ENABLED:"1",WECHAT_PAY_APP_ID:"wx-synthetic",WECHAT_PAY_MCH_ID:"123456",WECHAT_PAY_MERCHANT_SERIAL:"merchant-synthetic",WECHAT_PAY_PRIVATE_KEY:pair.privateKey,WECHAT_PAY_API_V3_KEY:"a".repeat(32),WECHAT_PAY_PUBLIC_KEY_ID:"PUB_KEY_ID_SYNTHETIC",WECHAT_PAY_PUBLIC_KEY:pair.publicKey,WECHAT_PAY_NOTIFY_URL:"https://example.test/api/recharge/wechat/notify",SERVICE_OPERATOR_NAME:"Synthetic",SERVICE_CONTACT:"test@example.test",AUTH_MODE:"email",SESSION_SECRET:"s".repeat(32),AUTH_IDENTITY_PEPPER:"p".repeat(32)};
function headers(raw:string,serial=config.WECHAT_PAY_PUBLIC_KEY_ID){const time=String(Math.floor(Date.now()/1000)),nonce="synthetic-nonce";return {"Wechatpay-Timestamp":time,"Wechatpay-Nonce":nonce,"Wechatpay-Serial":serial,"Wechatpay-Signature":createSign("RSA-SHA256").update(`${time}\n${nonce}\n${raw}\n`).sign(pair.privateKey,"base64")};}
function signed(data:unknown,status=200,serial?:string){const raw=status===204?"":JSON.stringify(data);return new Response(status===204?null:raw,{status,headers:headers(raw,serial)});}
function success(id:string,amount=2000){return {appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,trade_type:"NATIVE",trade_state:"SUCCESS",out_trade_no:id,transaction_id:`txn-${id}`,amount:{total:amount,currency:"CNY"},success_time:new Date().toISOString().slice(0,19)+"+00:00"};}
function notification(data:unknown,serial?:string){const nonce="abcdefghijkl",aad="transaction",cipher=createCipheriv("aes-256-gcm",Buffer.from(config.WECHAT_PAY_API_V3_KEY),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString("base64");const raw=JSON.stringify({event_type:"TRANSACTION.SUCCESS",resource_type:"encrypt-resource",resource:{algorithm:"AEAD_AES_256_GCM",nonce,associated_data:aad,ciphertext}});return new Request("https://example.test/api/recharge/wechat/notify",{method:"POST",headers:headers(raw,serial),body:raw});}
async function fixture(run:(f:{db:DatabaseSync;d1:D1Database;create:(key:string,owner?:string)=>Promise<Response>;get:(id:string,owner?:string)=>Promise<Response>;close:(id:string,owner?:string,origin?:string)=>Promise<Response>;notify:(data:unknown,serial?:string)=>Promise<Response>;bindings:Record<string,unknown>})=>Promise<void>){
 const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");applyMigrations(db);const now=Math.floor(Date.now()/1000);
 for(const owner of ["payer","other"]){db.prepare("INSERT INTO users(id,display_name) VALUES(?,?)").run(owner,owner);db.prepare("INSERT INTO auth_email_credentials(email,user_id,password_hash,verified_at) VALUES(?,?,?,?)").run(`${owner}@example.test`,owner,"synthetic-unused-hash",now);db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(secretHash(config.SESSION_SECRET,owner),owner,now+3600);for(const doc of ["terms","privacy"])db.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES(?,?,?,?)").run(owner,doc,LEGAL_VERSION,now);}
 const bindingKey=Symbol.for("zaoshi.test.cloudflare.bindings"),scope=globalThis as typeof globalThis&{[bindingKey]?:Record<string,unknown>};const bindings=scope[bindingKey]??={};const d1=new TestD1Database(db) as unknown as D1Database;Object.assign(bindings,{...config,DB:d1,BACKEND_PROFILE:"sites-demo"});
 const server=await createServer({configFile:false,logLevel:"silent",server:{middlewareMode:true},resolve:{alias:{"@":resolve("."),"cloudflare:workers":resolve("tests/helpers/cloudflare-workers.ts")}}});const original=globalThis.fetch;
 try{
  const orders=await server.ssrLoadModule("/app/api/recharge/orders/route.ts"),order=await server.ssrLoadModule("/app/api/recharge/orders/[id]/route.ts"),close=await server.ssrLoadModule("/app/api/recharge/orders/[id]/close/route.ts"),notify=await server.ssrLoadModule("/app/api/recharge/wechat/notify/route.ts");
  const request=(path:string,method:string,owner="payer",origin="https://example.test",body?:unknown)=>new Request(`https://example.test${path}`,{method,headers:{cookie:`__Host-zaoshi_session=${owner}`,origin,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  await run({db,d1,bindings,create:(key,owner)=>orders.POST(request("/api/recharge/orders","POST",owner,undefined,{productCode:"CNY20",idempotencyKey:key})),get:(id,owner)=>order.GET(request(`/api/recharge/orders/${id}`,"GET",owner),{params:Promise.resolve({id})}),close:(id,owner,origin)=>close.POST(request(`/api/recharge/orders/${id}/close`,"POST",owner,origin),{params:Promise.resolve({id})}),notify:(data,serial)=>notify.POST(notification(data,serial))});
 }finally{globalThis.fetch=original;await server.close();for(const key of Object.keys(bindings))delete bindings[key];db.close();}
}
function nativeTransport():typeof fetch{return async(url,init)=>{assert.equal(new Headers(init?.headers).get("Wechatpay-Serial"),config.WECHAT_PAY_PUBLIC_KEY_ID);assert.equal(String(url),"https://api.mch.weixin.qq.com/v3/pay/transactions/native");return signed({code_url:"weixin://wxpay/bizpayurl?pr=synthetic"});};}
test("real routes: idempotent checkout, owner/origin/session isolation, unknown signature and amount tampering",()=>fixture(async f=>{
 let calls=0;const transport=nativeTransport();globalThis.fetch=async(...args)=>{calls++;return transport(...args);};
 const first=await f.create("stable-key");assert.equal(first.status,200);const id=(await first.json()).order.id;
 assert.equal((await (await f.create("stable-key")).json()).order.id,id);assert.equal(calls,1);
 assert.equal((await f.get(id,"other")).status,404);assert.equal((await f.close(id,"other")).status,404);assert.equal((await f.close(id,"payer","https://evil.test")).status,403);assert.equal((await f.close(id,"unknown")).status,401);assert.equal(calls,1);
 assert.equal((await f.notify(success(id),"unknown")).status,400);assert.equal((await f.notify(success(id,1))).status,400);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,0);
 f.db.prepare("UPDATE users SET status='SUSPENDED' WHERE id='payer'").run();assert.equal((await f.close(id)).status,401);assert.equal((await f.create("disabled-owner")).status,401);assert.equal(calls,1);
}));
test("real routes: verified 204 closes, refresh is idempotent, and late payment is preserved for reconciliation",()=>fixture(async f=>{
 globalThis.fetch=nativeTransport();const id=(await (await f.create("close-key")).json()).order.id;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(new Headers(init?.headers).get("Wechatpay-Serial"),config.WECHAT_PAY_PUBLIC_KEY_ID);return String(url).endsWith("/close")?signed(null,204):signed({appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,out_trade_no:id,trade_state:"NOTPAY"});};
 const closed=await (await f.close(id)).json();assert.equal(closed.order.status,"CANCELED");assert.equal(closed.order.codeUrl,null);assert.equal(calls,2);assert.equal((await (await f.close(id)).json()).order.status,"CANCELED");assert.equal(calls,2);
 assert.equal((await f.notify(success(id))).status,200);assert.equal((await f.notify(success(id))).status,200);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_reconciliation_events").get()?.n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,0);assert.equal((await (await f.get(id)).json()).order.reconciliation,true);
}));
test("real routes: timeout/unsigned close never abandons the original order; SUCCESS during close credits once",()=>fixture(async f=>{
 globalThis.fetch=nativeTransport();const id=(await (await f.create("uncertain-close")).json()).order.id;
 globalThis.fetch=async()=>{throw Error("synthetic timeout");};let result=await (await f.close(id)).json();assert.equal(result.queryPending,true);assert.equal(result.order.status,"PENDING");
 globalThis.fetch=async url=>String(url).endsWith("/close")?new Response(null,{status:204}):signed({appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,out_trade_no:id,trade_state:"NOTPAY"});result=await (await f.close(id)).json();assert.equal(result.queryPending,true);assert.equal(result.order.status,"PENDING");
 globalThis.fetch=async()=>signed(success(id));const results=await Promise.all([f.close(id),f.notify(success(id)),f.notify(success(id))]);assert.deepEqual(results.map(r=>r.status),[200,200,200]);assert.equal((await (await f.get(id)).json()).order.status,"CREDITED");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_payment_events_v2").get()?.n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE reason_code='RECHARGE_PAID'").get()?.n,1);assert.deepEqual(await rechargeSummary(f.d1),{status:"verified_ledger",users:1,amountFen:2000,currency:"CNY"});
}));
test("real routes: late query within expired QR window still credits, unknown trade state and create timeout retain identity",()=>fixture(async f=>{
 globalThis.fetch=async()=>{throw Error("synthetic timeout");};const failed=await f.create("timeout-create");assert.equal(failed.status,503);const id=(await failed.json()).error.details.orderId;
 f.bindings.WECHAT_PAY_ENABLED="0";assert.equal((await f.create("timeout-create")).status,503);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_orders_v2").get()?.n,1);f.bindings.WECHAT_PAY_ENABLED="1";
 globalThis.fetch=async()=>signed({appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,out_trade_no:id,trade_state:"UNKNOWN"});const unknown=await (await f.get(id)).json();assert.equal(unknown.queryPending,true);assert.equal(unknown.order.status,"PENDING");
 globalThis.fetch=nativeTransport();assert.equal((await (await f.create("timeout-create")).json()).order.id,id);
 const old="r2"+"a".repeat(30),now=Math.floor(Date.now()/1000);f.db.prepare("INSERT INTO recharge_orders_v2(id,owner_id,provider,product_code,catalog_version,amount_fen,credits,status,idempotency_key,created_at,updated_at,expires_at) VALUES(?,'payer','WECHAT_PAY','CNY20','cn-recharge-v2-20261006',2000,2000,'PENDING','expired-qr',?,?,?)").run(old,now-100,now-100,now-50);
 const data={...success(old),success_time:new Date((now-75)*1000).toISOString().slice(0,19)+"+00:00"};globalThis.fetch=async()=>signed(data);assert.equal((await (await f.get(old)).json()).order.status,"CREDITED");assert.equal((await f.notify(data)).status,200);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,1);
}));

test("real routes: disabled payment fails before order writes or transport; signed CLOSED/REVOKED finalize and invalid products are rejected",()=>fixture(async f=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error("must not call");};f.bindings.WECHAT_PAY_ENABLED="0";
 assert.equal((await f.create("disabled-payment")).status,503);assert.equal(calls,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_orders_v2").get()?.n,0);
 f.bindings.WECHAT_PAY_ENABLED="1";globalThis.fetch=nativeTransport();
 for(const state of ["CLOSED","REVOKED"]){const id=(await (await f.create(state)).json()).order.id;globalThis.fetch=async()=>signed({appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,out_trade_no:id,trade_state:state});assert.equal((await (await f.get(id)).json()).order.status,"CANCELED");globalThis.fetch=nativeTransport();}
 const {createNativeOrder}=await import("../../lib/server/recharge-native-orders");for(const product of ["toString","__proto__","missing",null])await assert.rejects(createNativeOrder(f.d1,"payer",product,"bad-"+String(product)),(e:unknown)=>e instanceof Error&&"code" in e&&e.code==="INVALID_FIELD");
}));
test("real routes: success notification between NOTPAY and close response cannot be overwritten by cancellation",()=>fixture(async f=>{
 globalThis.fetch=nativeTransport();const id=(await (await f.create("close-payment-race")).json()).order.id;
 globalThis.fetch=async url=>{if(String(url).endsWith("/close")){assert.equal((await f.notify(success(id))).status,200);return signed(null,204);}return signed({appid:config.WECHAT_PAY_APP_ID,mchid:config.WECHAT_PAY_MCH_ID,out_trade_no:id,trade_state:"NOTPAY"});};
 assert.equal((await (await f.close(id)).json()).order.status,"CREDITED");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,1);assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
}));

test("real routes: only signed ORDER_NOT_EXIST after expiration can finish an absent provider order",()=>fixture(async f=>{
 const now=Math.floor(Date.now()/1000);
 const expired=(suffix:string,key:string)=>{const id="r2"+suffix.repeat(30);f.db.prepare("INSERT INTO recharge_orders_v2(id,owner_id,provider,product_code,catalog_version,amount_fen,credits,status,idempotency_key,created_at,updated_at,expires_at) VALUES(?,'payer','WECHAT_PAY','CNY20','cn-recharge-v2-20261006',2000,2000,'PENDING',?,?,?,?)").run(id,key,now-100,now-100,now-50);return id;};
 const id=expired("b","absent-expired");let calls=0;
 for(const response of [()=>new Response(JSON.stringify({code:"ORDER_NOT_EXIST"}),{status:404}),()=>signed({code:"NOT_FOUND"},404),()=>signed({code:"ORDER_NOT_EXIST"},500)]){
  globalThis.fetch=async()=>{calls++;return response();};const result=await (await f.close(id)).json();assert.equal(result.order.status,"PENDING");assert.equal(result.queryPending,true);
 }
 globalThis.fetch=async()=>{calls++;return signed({code:"ORDER_NOT_EXIST"},404);};
 assert.equal((await (await f.create("absent-expired")).json()).order.status,"EXPIRED");assert.equal((await (await f.close(id)).json()).order.status,"EXPIRED");assert.equal(calls,4);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,0);
 globalThis.fetch=nativeTransport();const fresh=(await (await f.create("not-expired")).json()).order.id;
 globalThis.fetch=async()=>signed({code:"ORDER_NOT_EXIST"},404);const pending=await (await f.close(fresh)).json();assert.equal(pending.order.status,"PENDING");assert.equal(pending.queryPending,true);
 globalThis.fetch=nativeTransport();assert.equal((await f.create("new-after-expired")).status,200);
 const paid={...success(id),success_time:new Date((now-75)*1000).toISOString().slice(0,19)+"+00:00"};assert.equal((await f.notify(paid)).status,200);assert.equal((await f.notify(paid)).status,200);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_reconciliation_events").get()?.n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,0);
 const winner=expired("c","absent-credit-race"),winnerPaid={...success(winner),success_time:new Date((now-75)*1000).toISOString().slice(0,19)+"+00:00"};globalThis.fetch=async()=>{assert.equal((await f.notify(winnerPaid)).status,200);return signed({code:"ORDER_NOT_EXIST"},404);};assert.equal((await (await f.get(winner)).json()).order.status,"CREDITED");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,1);
}));
test("real routes: in-flight native creation cannot restore a QR after signed absent-order expiration",()=>fixture(async f=>{
 let created!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{created=resolve;}),waiting=new Promise<void>(resolve=>{finish=resolve;});let id="";
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith("/native")){id=JSON.parse(String(init?.body)).out_trade_no;created();await waiting;return signed({code_url:"weixin://wxpay/bizpayurl?pr=late"});}return signed({code:"ORDER_NOT_EXIST"},404);};
 const creation=f.create("inflight-absent");await started;const now=Date.now();const original=Date.now;Date.now=()=>now+1801000;f.db.function("unixepoch",()=>Math.floor((now+1801000)/1000));
 try{const result=await (await f.close(id)).json();assert.equal(result.order.status,"EXPIRED");finish();const late=await (await creation).json();assert.equal(late.order.status,"EXPIRED");assert.equal(late.order.codeUrl,null);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM recharge_native_sessions").get()?.n,0);}finally{Date.now=original;finish();await creation;}
}));
