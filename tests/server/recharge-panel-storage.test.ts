import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Element={type:unknown;props:Record<string,unknown>};
type RequestCall={url:string;body?:{idempotencyKey:string;productCode:string};respond(order:unknown):void;reject(error:Error):void};
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
// Exercise actual component handlers with React hook slots; browser layout/effects belong to UI QA.
function harness(){
 let index=0,queued=false,scope="storage-payer",tree:Element,storageFailure="",refreshCalls=0;
 let slots:unknown[]=[],deps:unknown[][]=[];const stored=new Map<string,string>(),requests:RequestCall[]=[],refreshes:Array<{resolve():void;reject():void}>=[];
 const same=(a:unknown[]|undefined,b:unknown[])=>!!a&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const schedule=()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;render();});}};
 const react={useState(initial:unknown){const i=index++;if(!(i in slots))slots[i]=typeof initial==="function"?initial():initial;return [slots[i],(next:unknown)=>{slots[i]=typeof next==="function"?next(slots[i]):next;schedule();}];},useRef(initial:unknown){const i=index++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback(callback:unknown,next:unknown[]){const i=index++;if(!same(deps[i],next)){slots[i]=callback;deps[i]=next;}return slots[i];},useEffect(){index++;}};
 const jsx={jsx:(type:unknown,props:Record<string,unknown>)=>({type,props}),jsxs:(type:unknown,props:Record<string,unknown>)=>({type,props}),Fragment:"fragment"};
 const exports={} as {Checkout:(props:{scope:string;enabled:boolean})=>Element};
 const source=ts.transpileModule(readFileSync("components/products/RechargePanel.tsx","utf8")+"\nexports.Checkout=Checkout;",{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 runInNewContext(source,{exports,require:(name:string)=>name==="react-dom"?{createPortal:(children:unknown)=>children}:name==="./celebrate"?{celebrate(){}}:name==="react"?react:name==="react/jsx-runtime"?jsx:name==="qrcode.react"?{QRCodeSVG:"qr"}:{getClientSession:()=>({draftScope:scope}),requireClientAccess:()=>true,loadSession:()=>{refreshCalls++;return new Promise<unknown>((resolve,reject)=>refreshes.push({resolve:()=>resolve({user:{authenticated:true},draftScope:scope}),reject:()=>reject(Error("synthetic wallet timeout"))}));}},localStorage:{getItem(key:string){if(storageFailure==="get")throw Error("SecurityError");return stored.get(key)??null;},setItem(key:string,value:string){if(storageFailure==="set")throw Error("QuotaExceededError");stored.set(key,value);},removeItem(key:string){if(storageFailure==="remove")throw Error("SecurityError");stored.delete(key);}},fetch:(url:string,options?:{body?:string})=>new Promise((resolve,reject)=>requests.push({url,body:options?.body?JSON.parse(options.body):undefined,respond:order=>resolve({ok:true,json:async()=>({order})}),reject})),crypto:{randomUUID:()=>"synthetic-key-"+Math.random()},document:{body:{},addEventListener(){},removeEventListener(){}},AbortController,Date,Promise});
 function render(){index=0;tree=exports.Checkout({scope,enabled:true});}
 function elements(node:unknown):Element[]{if(Array.isArray(node))return node.flatMap(elements);if(!node||typeof node!=="object"||!("props" in node))return [];const e=node as Element;return [e,...elements(e.props.children)];}
 const all=()=>elements(tree);const packs=()=>all().find(e=>typeof e.type==="function"&&(e.type as {name:string}).name==="Packs")!;
 render();
 return {requests,refreshes,stored,get refreshCalls(){return refreshCalls;},get busy(){return packs().props.busy;},get text(){return JSON.stringify(tree,(_key,value)=>typeof value==="function"?undefined:value);},setFailure(value:string){storageFailure=value;},choose(code="CNY20"){(packs().props.onChoose as (code:string)=>void)(code);},click(label:string){if(!all().some(e=>e.type==="button"&&e.props.children===label)){const resume=all().find(e=>e.type==="button"&&(e.props.children==="查看订单"||e.props.children==="继续支付"));if(resume){(resume.props.onClick as ()=>void)();render();}}const button=all().find(e=>e.type==="button"&&e.props.children===label);assert.ok(button,`missing ${label}`);(button.props.onClick as ()=>void)();},remount(){slots=[];deps=[];render();},setScope(next:string){scope=next;slots=[];deps=[];render();}};
}
function order(status="PENDING"){return {id:"r2-synthetic",amountFen:2000,credits:2000,status,createdAt:1,expiresAt:Math.floor(Date.now()/1000)+1800,paidAt:null,codeUrl:"weixin://wxpay/bizpayurl?pr=synthetic",reconciliation:false};}

test("quota failure stops checkout before transport and preserves the in-memory request for recovery",async()=>{
 const h=harness();h.setFailure("set");h.choose();await settle();assert.equal(h.requests.length,0);assert.equal(h.busy,false);assert.match(h.text,/本次未发送支付请求/);
 h.remount();h.choose("CNY50");await settle();assert.equal(h.requests.length,0);assert.match(h.text,/原订单/);
 h.setFailure("");h.choose();await settle();assert.equal(h.requests.length,1);const key=h.requests[0].body!.idempotencyKey;
 h.requests[0].reject(Error("synthetic network failure"));await settle();assert.equal(h.busy,false);
 h.setFailure("set");h.choose();await settle();assert.equal(h.requests.length,1);assert.equal(h.busy,false);
 h.setFailure("");h.choose();await settle();assert.equal(h.requests[1].body!.idempotencyKey,key);h.requests[1].respond(order());await settle();
 h.remount();h.click("查询同一订单");await settle();assert.equal(h.requests[2].url,"/api/recharge/orders/r2-synthetic");
 h.setScope("different-owner");h.choose("CNY50");await settle();assert.notEqual(h.requests[3].body!.idempotencyKey,key);
});
test("remove failure cannot block wallet refresh, failed refresh retries and successful refresh is deduplicated",async()=>{
 const h=harness();h.choose();await settle();h.setFailure("remove");h.requests[0].respond(order("CREDITED"));await settle();assert.equal(h.refreshCalls,1);assert.equal(h.busy,false);
 h.refreshes[0].reject();await settle();h.remount();h.click("查询同一订单");await settle();h.requests[1].respond(order("CREDITED"));await settle();assert.equal(h.refreshCalls,2,"failed wallet load must be retried for the same order");
 h.click("查询同一订单");await settle();h.requests[2].respond(order("CREDITED"));await settle();assert.equal(h.refreshCalls,2,"in-flight wallet load is not duplicated");
 h.refreshes[1].resolve();await settle();assert.match(h.text,/浏览器存储不可用/);h.click("查询同一订单");await settle();h.requests[3].respond(order("CREDITED"));await settle();assert.equal(h.refreshCalls,2,"completed wallet load is not repeated");
 h.remount();assert.doesNotMatch(h.text,/微信充值订单/);h.choose("CNY50");await settle();assert.equal(h.requests[4].body!.productCode,"CNY50","stale persisted receipt must not override successful memory cleanup");
});
test("confirmed cancellation remains usable for a new package even if removing the persisted receipt fails",async()=>{
 const h=harness();h.choose();await settle();const key=h.requests[0].body!.idempotencyKey;h.requests[0].respond(order());await settle();h.click("取消订单 / 更换套餐");await settle();h.requests[1].respond(order("CANCELED"));await settle();h.setFailure("remove");h.click("开始新的充值");await settle();h.choose("CNY50");await settle();assert.equal(h.requests[2].body!.productCode,"CNY50");assert.notEqual(h.requests[2].body!.idempotencyKey,key);assert.equal(h.busy,true);h.requests[2].reject(Error("synthetic offline"));await settle();assert.equal(h.busy,false);
});
test("unreadable storage without a memory receipt cannot silently create an unknown second order",async()=>{
 const h=harness();h.setScope("unreadable-owner");h.setFailure("get");h.setScope("blocked-owner");h.choose();await settle();assert.equal(h.requests.length,0);assert.equal(h.busy,false);assert.match(h.text,/无法读取原订单/);h.setFailure("");h.choose();await settle();assert.equal(h.requests.length,1);
});

test("fresh storage from another tab supersedes an empty memory cache and reuses the existing request",async()=>{
 const h=harness();const receipt={productCode:"CNY20",idempotencyKey:"other-tab-existing-key",orderId:"r2-other-tab"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(receipt));h.choose();await settle();assert.equal(h.requests.length,1);assert.equal(h.requests[0].body!.idempotencyKey,receipt.idempotencyKey);h.requests[0].respond({...order(),id:receipt.orderId});await settle();h.click("查询同一订单");await settle();assert.equal(h.requests[1].url,"/api/recharge/orders/"+receipt.orderId);
});
test("failed deletion ignores only the cleared receipt and still observes a new receipt written by another tab",async()=>{
 const h=harness();h.choose();await settle();const oldKey=h.requests[0].body!.idempotencyKey;h.requests[0].respond(order("CANCELED"));await settle();h.setFailure("remove");h.click("开始新的充值");await settle();h.remount();assert.doesNotMatch(h.text,/微信充值订单/);
 const fresh={productCode:"CNY50",idempotencyKey:"new-other-tab-key",orderId:"r2-other-tab-next"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(fresh));h.choose("CNY50");await settle();assert.equal(h.requests[1].body!.idempotencyKey,fresh.idempotencyKey);assert.notEqual(h.requests[1].body!.idempotencyKey,oldKey);
});
test("an unpersisted memory request cannot overwrite a different active request discovered in another tab",async()=>{
 const h=harness();h.setFailure("set");h.choose();await settle();h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify({productCode:"CNY20",idempotencyKey:"concurrent-other-tab"}));h.setFailure("");h.choose();await settle();assert.equal(h.requests.length,0);assert.equal(h.busy,false);assert.match(h.text,/其他页面已有不同充值请求/);assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,"concurrent-other-tab");
});

test("a different package choice exposes the other tab receipt for query instead of creating another order",async()=>{
 const h=harness();h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify({productCode:"CNY20",idempotencyKey:"other-tab-query-key",orderId:"r2-query-other-tab"}));h.choose("CNY50");await settle();assert.equal(h.requests.length,0);assert.match(h.text,/微信充值订单/);h.click("查询同一订单");await settle();assert.equal(h.requests[0].url,"/api/recharge/orders/r2-query-other-tab");
});
test("completed wallet cleanup cannot erase a newer receipt written by another tab",async()=>{
 const h=harness();h.choose();await settle();h.requests[0].respond(order("CREDITED"));await settle();const newer={productCode:"CNY50",idempotencyKey:"other-tab-newer-after-payment",orderId:"r2-newer-after-payment"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(newer));h.refreshes[0].resolve();await settle();assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);h.choose("CNY50");await settle();assert.equal(h.requests[1].body!.idempotencyKey,newer.idempotencyKey);
});

for(const action of ["query","close","create"] as const)test(`late ${action} response cannot replace a newer tab receipt and exposes its query entry`,async()=>{
 const h=harness();h.choose();await settle();let response=0;
 if(action!=="create"){h.requests[0].respond(order());await settle();h.click(action==="query"?"查询同一订单":"取消订单 / 更换套餐");await settle();response=1;}
 const newer={productCode:"CNY50",idempotencyKey:`newer-after-${action}`,orderId:`r2-newer-after-${action}`};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(newer));
 h.requests[response].respond(order(action==="create"?"PENDING":"CANCELED"));await settle();assert.equal(h.busy,false);assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);assert.match(h.text,/其他页面已更新充值订单/);assert.doesNotMatch(h.text,/开始新的充值/);
 h.click("查询同一订单");await settle();assert.equal(h.requests[response+1].url,"/api/recharge/orders/"+newer.orderId);h.requests[response+1].respond({...order(),id:newer.orderId});await settle();assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).orderId,newer.orderId);
});
test("stale canceled-order reset cannot delete a newer tab receipt",async()=>{
 const h=harness();h.choose();await settle();h.requests[0].respond(order("CANCELED"));await settle();const newer={productCode:"CNY50",idempotencyKey:"newer-before-stale-reset",orderId:"r2-newer-before-reset"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(newer));h.click("开始新的充值");await settle();assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);h.click("查询同一订单");await settle();assert.equal(h.requests[1].url,"/api/recharge/orders/"+newer.orderId);
});
test("a late paid response refreshes the wallet without clearing the newer tab receipt",async()=>{
 const h=harness();h.choose();await settle();h.requests[0].respond(order());await settle();h.click("查询同一订单");await settle();const newer={productCode:"CNY50",idempotencyKey:"newer-before-late-paid",orderId:"r2-newer-before-paid"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(newer));h.requests[1].respond(order("CREDITED"));await settle();assert.equal(h.refreshCalls,1);assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);h.refreshes[0].resolve();await settle();assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);h.click("查询同一订单");await settle();assert.equal(h.requests[2].url,"/api/recharge/orders/"+newer.orderId);
});

test("switching packages after another tab replaces the receipt cannot leave a stale reset button for the old order",async()=>{
 const h=harness();h.choose();await settle();h.requests[0].respond(order("CANCELED"));await settle();const newer={productCode:"CNY50",idempotencyKey:"newer-before-package-switch",orderId:"r2-newer-package-switch"};h.stored.set("zaoshi:recharge:storage-payer",JSON.stringify(newer));h.choose("CNY100");await settle();assert.equal(h.requests.length,1);assert.doesNotMatch(h.text,/开始新的充值/);h.click("查询同一订单");await settle();assert.equal(h.requests[1].url,"/api/recharge/orders/"+newer.orderId);assert.equal(JSON.parse(h.stored.get("zaoshi:recharge:storage-payer")!).idempotencyKey,newer.idempotencyKey);
});
