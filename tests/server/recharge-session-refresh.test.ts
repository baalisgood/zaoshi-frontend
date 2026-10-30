import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Element={type:unknown;props:Record<string,unknown>;key?:string};
type Instance={slots:unknown[];deps:unknown[][];cleanups:Array<(()=>void)|undefined>;index:number};
type ClientSession=typeof import("../../components/site/session");
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const account=(credits=0,owner="integration-owner",authenticated=true)=>({user:{authenticated,displayName:owner},authMode:"email",draftScope:owner,legal:{accepted:true,version:"synthetic"},credits:{available:credits,reserved:0,spent:0},stats:{total:0,today:0,byKind:{}}});
const paid={id:"r2-integration-paid",productCode:"CNY20",amountFen:2000,credits:2000,status:"CREDITED",expiresAt:Math.floor(Date.now()/1000)+1800,codeUrl:null,reconciliation:false};

// Real session module plus real RechargePanel, with subscriptions and component unmounts.
function harness(){
 const make=():Instance=>({slots:[],deps:[],cleanups:[],index:0}),parent=make();let child:Instance|undefined,childKey:string|undefined,active=parent,queued=false,disposed=false,tree:Element,checkout:Element|undefined;
 const effects:Array<()=>void>=[],stored=new Map<string,string>(),me:Array<{respond(status:number,body?:unknown):void;reject():void}>=[],orders:Array<{respond():void}>=[],cancelled=new Set<number>();let timer=0;
 const all=(node:unknown):Element[]=>Array.isArray(node)?node.flatMap(all):node&&typeof node==="object"&&"props" in node?[node as Element,...all((node as Element).props.children)]:[];
 const same=(a:unknown[]|undefined,b:unknown[])=>!!a&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const schedule=()=>{if(!queued&&!disposed){queued=true;queueMicrotask(()=>{queued=false;if(!disposed)render();});}};
 const react={
  useState(initial:unknown){const instance=active,i=instance.index++;if(!(i in instance.slots))instance.slots[i]=typeof initial==="function"?initial():initial;return [instance.slots[i],(next:unknown)=>{instance.slots[i]=typeof next==="function"?next(instance.slots[i]):next;schedule();}];},
  useRef(initial:unknown){const i=active.index++;if(!(i in active.slots))active.slots[i]={current:initial};return active.slots[i];},
  useCallback(callback:unknown,deps:unknown[]){const i=active.index++;if(!same(active.deps[i],deps)){active.slots[i]=callback;active.deps[i]=deps;}return active.slots[i];},
  useEffect(callback:()=>void|(()=>void),deps:unknown[]){const instance=active,i=instance.index++;if(!same(instance.deps[i],deps)){instance.deps[i]=deps;effects.push(()=>{instance.cleanups[i]?.();instance.cleanups[i]=callback()||undefined;});}},
  useSyncExternalStore(subscribe:(callback:()=>void)=>()=>void,snapshot:()=>unknown){const i=active.index++;if(!(i in active.slots)){active.slots[i]=true;active.cleanups[i]=subscribe(schedule);}return snapshot();},
 };
 const fetcher=(url:string,init?:{method?:string})=>{
  if(url==="/api/me")return new Promise<Response>((resolve,reject)=>me.push({respond:(status,body)=>resolve(Response.json(body??{error:"synthetic"},{status})),reject:()=>reject(Error("synthetic network timeout"))}));
  if(url==="/api/recharge/catalog")return Promise.resolve(Response.json({enabled:true}));
  if(url==="/api/recharge/orders"&&init?.method==="POST")return new Promise<Response>(resolve=>orders.push({respond:()=>resolve(Response.json({order:paid}))}));
  if(url.startsWith("/api/recharge/orders/"))return Promise.resolve(Response.json({order:paid}));
  throw Error("unexpected synthetic request "+url);
 };
 const session={} as ClientSession;
 const compile=(file:string)=>ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const window={location:{pathname:"/products",search:"",assign(){}}};
 runInNewContext(compile("components/site/session.ts"),{exports:session,require:()=>react,fetch:fetcher,window});
 const panel={} as {RechargePanel:()=>Element};const jsx=(type:unknown,props:Record<string,unknown>,key?:string)=>({type,props,key});
 runInNewContext(compile("components/products/RechargePanel.tsx"),{exports:panel,require:(name:string)=>name==="react-dom"?{createPortal:(children:unknown)=>children}:name==="./celebrate"?{celebrate(){}}:name==="react"?react:name==="react/jsx-runtime"?{jsx,jsxs:jsx,Fragment:"fragment"}:name==="qrcode.react"?{QRCodeSVG:"qr"}:session,fetch:fetcher,localStorage:{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>{stored.set(key,value);},removeItem:(key:string)=>{stored.delete(key);}},crypto:{randomUUID:()=>"session-integration-key"},document:{body:{},addEventListener(){},removeEventListener(){}},AbortController,Date,Promise,setInterval:()=>0,clearInterval(){},setTimeout:(callback:()=>void)=>{const id=++timer;queueMicrotask(()=>{if(!cancelled.has(id))callback();});return id;},clearTimeout:(id:number)=>{cancelled.add(id);}});
 function render(){
  active=parent;active.index=0;tree=panel.RechargePanel();const node=all(tree).find(e=>typeof e.type==="function"&&(e.type as {name:string}).name==="Checkout");
  if(node){if(!child||childKey!==node.key){child?.cleanups.forEach(fn=>fn?.());child=make();childKey=node.key;}active=child;active.index=0;checkout=(node.type as (props:Record<string,unknown>)=>Element)(node.props);}else{child?.cleanups.forEach(fn=>fn?.());child=undefined;childKey=undefined;checkout=undefined;}
  effects.splice(0).forEach(effect=>effect());
 }
 render();
 return {me,orders,stored,session,get mounted(){return !!checkout;},get text(){return JSON.stringify(checkout??tree,(_key,value)=>typeof value==="function"?undefined:value);},choose(){const packs=all(checkout??tree).find(e=>typeof e.type==="function"&&(e.type as {name:string}).name==="Packs")!;(packs.props.onChoose as (code:string)=>void)("CNY20");},query(){const button=all(checkout).find(e=>e.type==="button"&&e.props.children==="查询同一订单");assert.ok(button,"query entry must remain mounted");(button.props.onClick as ()=>void)();},dispose(){disposed=true;parent.cleanups.forEach(fn=>fn?.());child?.cleanups.forEach(fn=>fn?.());}};
}
async function loaded(){const h=harness();assert.equal(h.me.length,1);h.me[0].respond(200,account());await settle();assert.equal(h.mounted,true);assert.equal(h.session.requireClientAccess(),true);return h;}

test("actual session + checkout retain paid state on wallet 503, block new actions and retry the same order",async()=>{
 const h=await loaded();try{h.choose();await settle();h.orders[0].respond();await settle();assert.equal(h.me.length,2);assert.equal(h.mounted,true,"wallet revalidation must not unmount checkout");assert.equal(h.session.requireClientAccess(),false,"preserved display snapshot is not fresh authority while pending");h.me[1].respond(503);await settle();assert.equal(h.mounted,true);assert.equal(h.session.getClientSession()?.credits?.available,0);assert.equal(h.session.requireClientAccess(),false);assert.match(h.text,/账户信息刷新失败/);assert.ok(h.stored.get("zaoshi:recharge:integration-owner"));h.query();await settle();assert.equal(h.me.length,3);h.me[2].respond(200,account(2000));await settle();assert.equal(h.mounted,true);assert.equal(h.session.getClientSession()?.credits?.available,2000);assert.equal(h.session.requireClientAccess(),true);assert.equal(h.orders.length,1,"wallet recovery must not create another order");assert.equal(h.stored.has("zaoshi:recharge:integration-owner"),false);}finally{h.dispose();}
});
test("preserving refresh retains only transient failures and never retains a 401/403 or guest identity",async()=>{
 for(const status of [401,403]){const h=await loaded();try{const refresh=h.session.loadSession(true,{preserveOnTransientFailure:true});h.me[1].respond(status);await assert.rejects(refresh);await settle();assert.equal(h.session.getClientSession(),undefined);assert.equal(h.mounted,false);assert.equal(h.session.requireClientAccess(),false);}finally{h.dispose();}}
 const h=await loaded();try{const refresh=h.session.loadSession(true,{preserveOnTransientFailure:true});h.me[1].respond(200,account(0,"guest",false));await refresh;await settle();assert.equal(h.session.getClientSession()?.user.authenticated,false);assert.equal(h.mounted,false);assert.equal(h.session.requireClientAccess(),false);}finally{h.dispose();}
});
test("network/429 snapshots are not cached authority, and default refresh still clears identity",async()=>{
 for(const status of [429,"network"] as const){const h=await loaded();try{const refresh=h.session.loadSession(true,{preserveOnTransientFailure:true});if(status==="network")h.me[1].reject();else h.me[1].respond(status);await assert.rejects(refresh);await settle();assert.equal(h.mounted,true);assert.equal(h.session.requireClientAccess(),false);const revalidate=h.session.loadSession();assert.equal(h.me.length,3,"a failed snapshot cannot bypass revalidation");assert.equal(h.session.getClientSession(),undefined,"ordinary session loading keeps its clearing behavior");h.me[2].respond(200,account(0,"guest",false));await revalidate;await settle();assert.equal(h.mounted,false);}finally{h.dispose();}}
});
test("new identity B wins when an earlier identity A refresh later succeeds or fails",async()=>{
 for(const status of [200,503]){const h=await loaded();try{const stale=h.session.loadSession(true,{preserveOnTransientFailure:true});const fresh=h.session.loadSession(true);assert.equal(h.session.getClientSession(),undefined);h.me[2].respond(200,account(500,"owner-B"));await fresh;await settle();assert.equal(h.session.getClientSession()?.draftScope,"owner-B");h.me[1].respond(status,account(2000));await assert.rejects(stale);await settle();assert.equal(h.session.getClientSession()?.draftScope,"owner-B");assert.equal(h.session.requireClientAccess(),true);}finally{h.dispose();}}
});
test("paid order receipt is retained when the wallet response belongs to guest/B and recovers on A login",async()=>{
 for(const changed of [account(0,"guest",false),account(500,"owner-B")]){const h=await loaded();try{h.choose();await settle();h.orders[0].respond();await settle();h.me[1].respond(200,changed);await settle();assert.ok(h.stored.has("zaoshi:recharge:integration-owner"),"another identity is not confirmation of A wallet refresh");assert.doesNotMatch(h.text,/微信充值订单/);const relogin=h.session.loadSession(true);h.me[2].respond(200,account(2000));await relogin;await settle();assert.equal(h.me.length,4,"A receipt must retry wallet refresh after identity recovery");h.me[3].respond(200,account(2000));await settle();assert.equal(h.stored.has("zaoshi:recharge:integration-owner"),false);assert.equal(h.orders.length,1);assert.equal(h.session.getClientSession()?.draftScope,"integration-owner");}finally{h.dispose();}}
});
