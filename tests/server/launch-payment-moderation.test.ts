import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { ApiError } from "../../lib/server/api";
import { applyMigrations,TestD1Database } from "../helpers/test-d1";
import { createRechargeOrder } from "../../lib/server/recharge-orders";
import { createNativeOrder,readNativeOrder,recordPaymentFact,saveNativeCode,rechargeSummary,nativeProducts } from "../../lib/server/recharge-native-orders";
import { decryptWechatResource,normalizePaymentFact,signWechatRequest,verifyWechatMessage,wechatPayConfig,wechatRequest,type WechatPayConfig } from "../../lib/server/wechat-native";
import { moderateContent,moderationConfig,signModeration,assertModerationPass } from "../../lib/server/tencent-moderation";
import { readBoundedResponseText } from "../../lib/server/bounded-response";
const keys=generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
const config:WechatPayConfig={appId:"wx-test",mchId:"123456",serial:"merchant-test",publicKeyId:"trusted",privateKey:keys.privateKey,apiV3Key:"k".repeat(32),publicKeys:{trusted:keys.publicKey},notifyUrl:"https://example.test/api/recharge/wechat/notify"};
const tencent={secretId:"test-id",secretKey:"test-secret",region:"ap-guangzhou",bizType:"test-policy"};
function signed(raw:string,overrides:Record<string,string>={}){const timestamp=String(Math.floor(Date.now()/1000)),nonce="test-nonce";return new Headers({"Wechatpay-Timestamp":timestamp,"Wechatpay-Nonce":nonce,"Wechatpay-Serial":"trusted","Wechatpay-Signature":createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${raw}\n`).sign(keys.privateKey,"base64"),...overrides});}
function setup(maximum=Infinity){const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");applyMigrations(db,maximum);db.exec("INSERT INTO users(id,display_name) VALUES('payer','A'),('other','B')");return {db,d1:new TestD1Database(db) as unknown as D1Database};}
function fact(id:string,amount:number,transaction="txn-test",paidAt=Math.floor(Date.now()/1000)){return {orderId:id,transactionId:transaction,amountFen:amount,paidAt,factsHash:createHash("sha256").update(JSON.stringify({id,amount,transaction,paidAt})).digest("hex")};}
function snapshot(db:DatabaseSync,tables:string[]){return tables.map(table=>JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=="optimization_id")))));}
test("native crypto signs raw bytes, verifies only trusted fresh messages and authenticates AES-GCM",async()=>{
 assert.throws(()=>wechatPayConfig({}));assert.match(signWechatRequest("GET","/v3/pay/transactions/out-trade-no/id?mchid=123456","",config,1700000000,"nonce"),/WECHATPAY2-SHA256-RSA2048/);
 const raw=JSON.stringify({event_type:"TRANSACTION.SUCCESS"});verifyWechatMessage(raw,signed(raw),config);
 for(const headers of [signed(raw,{"Wechatpay-Serial":"unknown"}),signed(raw,{"Wechatpay-Timestamp":"1000000000"}),signed(raw,{"Wechatpay-Signature":"WECHATPAY/SIGNTEST/test"}),signed(raw,{"Wechatpay-Signature-Type":"unexpected"})])assert.throws(()=>verifyWechatMessage(raw,headers,config));assert.throws(()=>verifyWechatMessage(raw+" ",signed(raw),config));
 const plain={appid:config.appId,mchid:config.mchId,trade_type:"NATIVE",trade_state:"SUCCESS",out_trade_no:"r2"+"a".repeat(30),transaction_id:"txn-native",amount:{total:2000,currency:"CNY",payer_total:1},success_time:new Date().toISOString().slice(0,19)+"+00:00"};
 const nonce="abcdefghijkl",aad="transaction",cipher=createCipheriv("aes-256-gcm",Buffer.from(config.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final(),cipher.getAuthTag()]).toString("base64");
 assert.deepEqual(decryptWechatResource({algorithm:"AEAD_AES_256_GCM",nonce,associated_data:aad,ciphertext},config),plain);assert.throws(()=>decryptWechatResource({algorithm:"AEAD_AES_256_GCM",nonce,associated_data:"wrong",ciphertext},config));
 const normalized=normalizePaymentFact(plain,config);assert.equal(normalized.amountFen,2000);for(const bad of [{...plain,mchid:"foreign"},{...plain,trade_type:"JSAPI"},{...plain,amount:{total:2000.1,currency:"CNY"}},{...plain,amount:{total:2000,currency:"USD"}},{...plain,success_time:"2099-01-01T00:00:00+08:00"}])assert.throws(()=>normalizePaymentFact(bad,config));
 const mock:typeof fetch=async(_url,init)=>{assert.equal(String(_url),"https://api.mch.weixin.qq.com/v3/pay/transactions/native");assert.match(String(new Headers(init?.headers).get("authorization")),/WECHATPAY2/);const body=JSON.stringify({code_url:"weixin://wxpay/bizpayurl?pr=test"});return new Response(body,{headers:signed(body)});};assert.equal((await wechatRequest("POST","/v3/pay/transactions/native",{amount:{total:2000}},config,mock)).code_url,"weixin://wxpay/bizpayurl?pr=test");
 await assert.rejects(wechatRequest("POST","/v3/pay/transactions/native",{},config,async()=>new Response(null,{status:204,headers:signed("")})));
});
test("v2 migration preserves v1 pending/credited rows and strictly credits one canonical payment",async()=>{
 const {db,d1}=setup(27);const pending=await createRechargeOrder(d1,{ownerId:"payer",provider:"WECHAT_PAY",productCode:"CNY50",idempotencyKey:"legacy-pending"});const paid=await createRechargeOrder(d1,{ownerId:"payer",provider:"WECHAT_PAY",productCode:"CNY10",idempotencyKey:"legacy-paid"});
 db.prepare(`INSERT INTO recharge_payment_events(id,order_id,provider,provider_event_id,provider_transaction_id,amount_fen,payload_hash,paid_at,verified_at) VALUES('legacy-event',?,'WECHAT_PAY','legacy-event','legacy-txn',1000,?,?,?)`).run(paid.order.id,"a".repeat(64),paid.order.createdAt,paid.order.createdAt);
 const old=snapshot(db,["recharge_orders","recharge_payment_events","credit_ledger_entries"]);for(const name of ["0028_recharge_v2.sql","0029_machine_moderation.sql","0030_output_moderation_rejections.sql","0031_email_registration_welcome.sql","0032_short_user_ids.sql","0033_prompt_optimization.sql","0034_wechat_login_binding.sql","0035_referrals_and_generation_limits.sql"])db.exec(readFileSync(`drizzle/${name}`,"utf8"));assert.deepEqual(snapshot(db,["recharge_orders","recharge_payment_events","credit_ledger_entries"]),old);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
 const replay=await createNativeOrder(d1,"payer","CNY50","legacy-pending");assert.equal(replay.id,pending.order.id);assert.equal(replay.credits,5000);assert.equal(replay.catalogVersion,pending.order.catalogVersion);
 const order=await createNativeOrder(d1,"payer","CNY50","new-checkout");assert.equal(order.id.length,32);assert.equal(order.credits,5100);await assert.rejects(readNativeOrder(d1,order.id,"other"));await saveNativeCode(d1,order,"weixin://wxpay/bizpayurl?pr=test");assert.equal((await readNativeOrder(d1,order.id,"payer")).codeUrl,"weixin://wxpay/bizpayurl?pr=test");
 const payment=fact(order.id,order.amountFen);assert.deepEqual(await Promise.all([recordPaymentFact(d1,payment),recordPaymentFact(d1,payment)]),["CREDITED","CREDITED"]);assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE id=?").get("ledger_recharge_"+order.id)?.n,1);
 const before=snapshot(db,["recharge_orders_v2","recharge_payment_events_v2","credit_ledger_entries"]);for(const changed of [{...payment,amountFen:1},{...payment,factsHash:"b".repeat(64)}])await assert.rejects(recordPaymentFact(d1,changed));assert.deepEqual(snapshot(db,["recharge_orders_v2","recharge_payment_events_v2","credit_ledger_entries"]),before);
 const second=await createNativeOrder(d1,"payer","CNY20","duplicate-legacy-event");await assert.rejects(recordPaymentFact(d1,fact(second.id,second.amountFen,"legacy-txn")),/cross-version/);assert.equal((await readNativeOrder(d1,second.id)).status,"PENDING");
 assert.deepEqual(await rechargeSummary(d1),{status:"verified_ledger",users:1,amountFen:6000,currency:"CNY"});assert.deepEqual(await rechargeSummary(d1,Math.floor(Date.now()/1000)+1),{status:"verified_ledger",users:0,amountFen:0,currency:"CNY"});
 assert.deepEqual(nativeProducts,{CNY20:{amountFen:2000,credits:2000},CNY50:{amountFen:5000,credits:5100},CNY100:{amountFen:10000,credits:10500},CNY200:{amountFen:20000,credits:21400},CNY500:{amountFen:50000,credits:55000}});assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
});
test("verified late success within payment window credits; expired/canceled and out-of-window receipts persist for reconciliation",async()=>{
 const {db,d1}=setup();const now=Math.floor(Date.now()/1000);
 for(const [index,status] of ["PENDING","EXPIRED","CANCELED"].entries()){
  const id="r2"+String(index).repeat(30);db.prepare(`INSERT INTO recharge_orders_v2(id,owner_id,provider,product_code,catalog_version,amount_fen,credits,status,idempotency_key,created_at,updated_at,expires_at) VALUES(?,'payer','WECHAT_PAY','CNY20','cn-recharge-v2-20261006',2000,2000,?,?,?, ?,?)`).run(id,status,"past-"+index,now-100,now-100,now-50);
  const payment=fact(id,2000,"late-"+index,now-75);assert.equal(await recordPaymentFact(d1,payment),status==="PENDING"?"CREDITED":"RECONCILIATION_REQUIRED");assert.equal(await recordPaymentFact(d1,payment),status==="PENDING"?"CREDITED":"RECONCILIATION_REQUIRED");
 }
 const outside=await createNativeOrder(d1,"payer","CNY20","outside-window");const payment=fact(outside.id,2000,"outside",outside.createdAt-1);assert.equal(await recordPaymentFact(d1,payment),"RECONCILIATION_REQUIRED");assert.equal(db.prepare("SELECT COUNT(*) n FROM recharge_reconciliation_events").get()?.n,3);assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE reason_code='RECHARGE_PAID'").get()?.n,1);
});
test("moderation uses actual private base64, fixed endpoints and Pass/Review/Block/unknown boundaries",async()=>{
 assert.throws(()=>moderationConfig({}));assert.match(signModeration("{}","image",tencent,1700000000),/TC3-HMAC-SHA256 Credential=test-id/);
 const image=await (sharp as (options:object)=>{png():{toBuffer():Promise<Buffer>}})({create:{width:64,height:64,channels:3,background:"white"}}).png().toBuffer();
 for(const decision of ["Pass","Review","Block"] as const){let calls=0;const transport:typeof fetch=async(url,init)=>{calls++;assert.equal(String(url),"https://ims.tencentcloudapi.com/");const body=JSON.parse(String(init?.body));assert.equal(body.FileContent,image.toString("base64"));assert.equal(body.FileUrl,undefined);return Response.json({Response:{Suggestion:decision,RequestId:"request-test"}});};const result=await moderateContent("image",image,tencent,transport);assert.equal(result.decision,decision);assert.equal(result.sha256,createHash("sha256").update(image).digest("hex"));assert.equal(calls,1);if(decision==="Pass")assertModerationPass(result);else assert.throws(()=>assertModerationPass(result));}
 for(const payload of [{Response:{Suggestion:"unknown",RequestId:"request-test"}},{Response:{Error:{Code:"denied"}}}])await assert.rejects(moderateContent("text","private prompt",tencent,async()=>Response.json(payload)),(error:unknown)=>error instanceof ApiError&&error.code==="MODERATION_UNAVAILABLE");await assert.rejects(moderateContent("text","private prompt",tencent,async()=>{throw Error("network timeout");}));let calls=0;await assert.rejects(moderateContent("image",Buffer.concat([image,Buffer.alloc(7500000)]),tencent,async()=>{calls++;return Response.json({});}),(error:unknown)=>error instanceof ApiError&&error.code==="MODERATION_IMAGE_TOO_LARGE");assert.equal(calls,0);await assert.rejects(moderateContent("text","字".repeat(10001),tencent,async()=>Response.json({})));
});
test("raw signed-body reader cancels timeout, disconnect and over-limit streams before any payment processing",async()=>{
 for(const mode of ["timeout","abort","overflow"]){let canceled=0;const abort=new AbortController();const body=new ReadableStream<Uint8Array>({start(controller){if(mode==="overflow")controller.enqueue(new Uint8Array(100));},cancel(){canceled++;}});const read=readBoundedResponseText(new Response(body),{maxBytes:50,timeoutMs:10,signal:abort.signal,tooLargeCode:"BIG",invalidCode:"BAD",label:"notification"});if(mode==="abort")abort.abort();await assert.rejects(read);assert.equal(canceled,1);}
 const raw="{\"safe\":true}";assert.equal(await readBoundedResponseText(new Response(raw),{maxBytes:100,timeoutMs:100,tooLargeCode:"BIG",invalidCode:"BAD",label:"notification"}),raw);
});


test("over-limit notification rejects even when stream cancel never settles", async()=>{
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(25));},cancel(){return new Promise<void>(()=>undefined);}});
 const result=readBoundedResponseText(new Response(body),{maxBytes:24,timeoutMs:20,tooLargeCode:"BIG",invalidCode:"BAD",label:"notification"});
 await assert.rejects(Promise.race([result,new Promise((_,reject)=>setTimeout(()=>reject(new Error("reader hung")),100))]),(error:unknown)=>error instanceof ApiError&&error.code==="BIG");
});
