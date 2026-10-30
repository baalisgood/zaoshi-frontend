import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, creditTestOwner, TestD1Database } from "../helpers/test-d1";
import { getCreditSnapshot } from "../../lib/server/credit-ledger";
import { optimizationCredits, optimizationInput, optimizerEndpoint, quoteOptimization, readOptimization, recoverOptimizations, runOptimization } from "../../lib/server/prompt-optimization";
const environment = { BACKEND_PROFILE: "cn-production" as const, DASHSCOPE_API_KEY: "unit-test-key" };
const moderate = async () => undefined;
function setup(amount = 100) { const db = new DatabaseSync(":memory:"); applyMigrations(db); db.exec("INSERT INTO users(id,display_name) VALUES ('OWNER001','test'),('OTHER001','other')"); creditTestOwner(db, "OWNER001", amount); creditTestOwner(db, "OTHER001", amount); return { db, d1: new TestD1Database(db) as unknown as D1Database }; }
const output = (tokens = 100, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ finish_reason: "stop", message: { content: "优化后的空间要求" } }], usage: { prompt_tokens: tokens }, ...extra });

test("input-only integer prices, full system framing upper bound and frozen context", () => {
  assert.equal(optimizationCredits(1), 1); assert.equal(optimizationCredits(4166), 1); assert.equal(optimizationCredits(4167), 2);
  for (const bad of [0,-1,1.1,NaN,Infinity,20001]) assert.throws(() => optimizationCredits(bad));
  for (const text of ["hello", "中".repeat(2000), "😀".repeat(1000)]) {
    const input = optimizationInput(text, "ordinary"); assert.ok(input.tokenCap > new TextEncoder().encode(text).byteLength);
    assert.notEqual(input.hash("OWNER001"), input.hash("OTHER001")); assert.notEqual(input.hash("OWNER001"), optimizationInput(text,"local-prompt").hash("OWNER001"));
  }
  assert.throws(() => optimizationInput("中".repeat(2001), "ordinary")); assert.throws(() => optimizationInput("  ","ordinary")); assert.throws(() => optimizationInput("x","replace"));
  assert.match(optimizerEndpoint(environment), /^https:\/\/dashscope.aliyuncs.com\//u);
  assert.throws(() => optimizerEndpoint({ ...environment, DASHSCOPE_WORKSPACE_ID: "evil.com/" })); assert.throws(() => optimizerEndpoint({}));
});
test("quote is local, reserves only at dispatch, settles actual input usage and replays without dispatch", async () => {
  const { d1, db } = setup(); const prompt = "中".repeat(2000); const q = await quoteOptimization(d1,"OWNER001",prompt,"ordinary");
  assert.equal(q.maximumCredits,2); assert.equal((await getCreditSnapshot(d1,"OWNER001")).reserved,0);
  let calls=0; const fetch: typeof globalThis.fetch = async (url,init) => { calls++; assert.equal(url,"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"); assert.equal(init?.redirect,"error"); const body=JSON.parse(String(init?.body)); assert.equal(body.enable_thinking,false); assert.equal(body.model,"qwen3.8-flash"); assert.equal(body.messages.length,2); assert.ok(!body.tools); assert.equal((await getCreditSnapshot(d1,"OWNER001")).reserved,2); return output(); };
  const deps={environment,moderate,fetch}; const result=await runOptimization(d1,"OWNER001",q.quoteId,prompt,"ordinary",deps);
  assert.equal(result.chargedCredits,1); assert.deepEqual(await getCreditSnapshot(d1,"OWNER001"),{credited:100,available:99,reserved:0,spent:1});
  assert.deepEqual(await runOptimization(d1,"OWNER001",q.quoteId,prompt,"ordinary",deps),result); assert.equal(calls,1);
  assert.deepEqual(db.prepare("SELECT entry_type,amount FROM credit_ledger_entries WHERE optimization_id=? ORDER BY created_at,rowid").all(q.quoteId).map(r=>[r.entry_type,r.amount]),[["RESERVE",2],["SETTLE",1],["RELEASE",1]]);
  await assert.rejects(runOptimization(d1,"OTHER001",q.quoteId,prompt,"ordinary",deps)); await assert.rejects(runOptimization(d1,"OWNER001",q.quoteId,"changed","ordinary",deps)); assert.equal(calls,1);
});
test("provider, usage, output and moderation failures release all and never resend same key", async () => {
  const cases: ((q: Awaited<ReturnType<typeof quoteOptimization>>) => Promise<Response>)[] = [async()=>{throw new Error("network timeout");},async()=>Response.json({}, {status:500}),async()=>output(0),async()=>output(1.2),async(q)=>output(q.tokenUpperBound+1),async()=>output(100,{usage:{}}),async()=>output(100,{choices:[{finish_reason:"length",message:{content:"partial"}}]}),async()=>output(100,{choices:[{finish_reason:"stop",message:{content:" "}}]}),async()=>output(100,{choices:[{finish_reason:"stop",message:{content:"x".repeat(2001)}}]}),async()=>new Response("x".repeat(40000)),async()=>new Response("not json")];
  for (const response of cases) { const { d1 }=setup(); const q=await quoteOptimization(d1,"OWNER001","要求","ordinary"); let calls=0; const deps={environment,moderate,fetch:async()=>{calls++; return response(q);}}; await assert.rejects(runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",deps)); assert.deepEqual(await getCreditSnapshot(d1,"OWNER001"),{credited:100,available:100,reserved:0,spent:0}); await assert.rejects(runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",deps)); assert.equal(calls,1); }
  const { d1 }=setup(); const q=await quoteOptimization(d1,"OWNER001","要求","ordinary"); let checks=0;
  await assert.rejects(runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",{environment,fetch:async()=>output(),moderate:async()=>{if(++checks===2)throw new Error("blocked output");}})); assert.equal((await getCreditSnapshot(d1,"OWNER001")).spent,0);
});
test("insufficient funds and blocked input make zero provider calls",async()=>{
  for (const blocked of [false,true]) {const {d1}=setup(1); const prompt="中".repeat(2000);const q=await quoteOptimization(d1,"OWNER001",prompt,"ordinary");let calls=0;
    await assert.rejects(runOptimization(d1,"OWNER001",q.quoteId,prompt,"ordinary",{environment,moderate:async()=>{if(blocked)throw new Error("blocked");},fetch:async()=>{calls++;return output();}}));assert.equal(calls,0);assert.equal((await getCreditSnapshot(d1,"OWNER001")).reserved,0);
  }
});
test("concurrent same-key only dispatches once; owner different key fails while active",async()=>{
  const {d1}=setup(); const q=await quoteOptimization(d1,"OWNER001","要求","ordinary");const q2=await quoteOptimization(d1,"OWNER001","要求2","ordinary");let resolve!: (r:Response)=>void;let calls=0;
  const deps={environment,moderate,fetch:async()=>{calls++;return new Promise<Response>(r=>{resolve=r;});}};
  const pending=runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",deps); while(!resolve)await new Promise(r=>setImmediate(r));
  assert.equal((await runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",deps)).status,"DISPATCHING"); await assert.rejects(runOptimization(d1,"OWNER001",q2.quoteId,"要求2","ordinary",deps)); assert.equal(calls,1);resolve(output());await pending;
});
test("crash recovery releases reservation and late completion loses compare-and-set",async()=>{
 const {d1,db}=setup();const q=await quoteOptimization(d1,"OWNER001","要求","ordinary");let resolve!: (r:Response)=>void;
 const pending=runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",{environment,moderate,fetch:async()=>new Promise<Response>(r=>{resolve=r;})});while(!resolve)await new Promise(r=>setImmediate(r));
 // Controlled test clock expires the dispatched lease without altering production transitions.
 const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='prompt_optimization_update_guard'").get()!.sql as string;db.exec("DROP TRIGGER prompt_optimization_update_guard");db.prepare("UPDATE prompt_optimization_requests SET expires_at=unixepoch()-1 WHERE id=?").run(q.quoteId);db.exec(trigger);
 await recoverOptimizations(d1,"OWNER001");resolve(output());await assert.rejects(pending);assert.equal((await readOptimization(d1,"OWNER001",q.quoteId))?.status,"FAILED");assert.deepEqual(await getCreditSnapshot(d1,"OWNER001"),{credited:100,available:100,reserved:0,spent:0});
});
test("quote rate/account gates and ledger forgery fail closed",async()=>{
 const {d1,db}=setup();for(let i=0;i<10;i++)await quoteOptimization(d1,"OWNER001","要求","ordinary");await assert.rejects(quoteOptimization(d1,"OWNER001","要求","ordinary"));
 db.exec("UPDATE users SET status='SUSPENDED' WHERE id='OTHER001'");await assert.rejects(quoteOptimization(d1,"OTHER001","要求","ordinary"));
 const q=(await readOptimization(d1,"OWNER001",(db.prepare("SELECT id FROM prompt_optimization_requests LIMIT 1").get()!.id as string)))!;
 assert.throws(()=>db.prepare("INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,optimization_id,idempotency_key,reason_code,price_version,actor_id,request_id) VALUES(?, 'OWNER001','SETTLE',1,?,?,'fake','PROMPT_OPTIMIZATION',?,'system',?)").run('fake',q.id,q.id,q.price_version,q.id));
 assert.throws(()=>db.prepare("INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,idempotency_key,reason_code,price_version,actor_id,request_id) VALUES('fake','OWNER001','RESERVE',1,'fake','fake','FAKE','v1','system','fake')").run());
});
test("committed success response loss replays same result; atomic reserve failure has zero provider calls",async()=>{
 const {d1,db}=setup();const q=await quoteOptimization(d1,"OWNER001","要求","ordinary");let calls=0;let lost=true;
 const fault={prepare(sql:string){const stmt=d1.prepare(sql);if(sql.includes("SET status='SUCCEEDED'")){return {bind(...args:unknown[]){const bound=stmt.bind(...args);return {async run(){const result=await bound.run();if(lost){lost=false;throw Error("lost committed DB response");}return result;}};}};}return stmt;}} as D1Database;
 const deps={environment,moderate,fetch:async()=>{calls++;return output();}};const result=await runOptimization(fault,"OWNER001",q.quoteId,"要求","ordinary",deps);assert.equal(result.status,"SUCCEEDED");assert.equal((await getCreditSnapshot(d1,"OWNER001")).spent,1);assert.deepEqual(await runOptimization(d1,"OWNER001",q.quoteId,"要求","ordinary",deps),result);assert.equal(calls,1);
 const q2=await quoteOptimization(d1,"OTHER001","要求","ordinary");db.exec("CREATE TRIGGER test_reserve_crash BEFORE INSERT ON credit_ledger_entries WHEN NEW.entry_type='RESERVE' BEGIN SELECT RAISE(ABORT,'simulated durable write failure'); END;");
 await assert.rejects(runOptimization(d1,"OTHER001",q2.quoteId,"要求","ordinary",deps));assert.equal((await readOptimization(d1,"OTHER001",q2.quoteId))?.status,"QUOTED");assert.equal((await getCreditSnapshot(d1,"OTHER001")).reserved,0);assert.equal(calls,1);
});
