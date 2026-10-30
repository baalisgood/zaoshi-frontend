import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { DisabledModeration, moderationMode } from "../../lib/server/machine-moderation";
import { moderationConfig } from "../../lib/server/tencent-moderation";
import { assertDraftScope, hashIdentifier } from "../../lib/server/actor";
import { newUserId, withUserIdRetry } from "../../lib/server/user-identity";

test("optional mode accepts only unset/0/1 and enabled credentials remain strict",()=>{
 for(const value of [undefined,"","0"])assert.equal(moderationMode({TENCENT_MODERATION_ENABLED:value}),"disabled");
 assert.equal(moderationMode({TENCENT_MODERATION_ENABLED:"1"}),"tencent");
 for(const value of ["false","true","2",0,1])assert.throws(()=>moderationMode({TENCENT_MODERATION_ENABLED:value}));
 assert.throws(()=>moderationConfig({TENCENT_MODERATION_ENABLED:"1"}));
});
test("disabled validates canonical bytes and account, keeps zero evidence and historical denials",async()=>{
 const db=new DatabaseSync(":memory:");applyMigrations(db);db.exec("INSERT INTO users(id,display_name) VALUES ('ABC12345','owner'),('DEF12345','foreign')");
 const bytes=new TextEncoder().encode("canonical fixture"),sha=createHash("sha256").update(bytes).digest("hex");
 db.prepare("INSERT INTO assets(id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key) VALUES ('image','ABC12345','source','PENDING','a.png','image/png',? ,?,'canonical-image-v1','upload/image')").run(bytes.length,sha);
 const audit=new DisabledModeration(new TestD1Database(db) as unknown as D1Database);
 try {
  assert.equal(audit.policyVersion,null);await audit.text("ABC12345","prompt");await audit.asset("ABC12345","image",bytes);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM asset_moderation_evidence").get()?.n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM text_moderation_evidence").get()?.n,0);
  assert.equal(db.prepare("SELECT moderation_status,moderated_at FROM assets").get()?.moderation_status,"UNREVIEWED");
  await assert.rejects(audit.asset("DEF12345","image",bytes));await assert.rejects(audit.asset("ABC12345","image",new Uint8Array([1])));
  db.exec("UPDATE users SET status='SUSPENDED' WHERE id='ABC12345'");await assert.rejects(audit.asset("ABC12345","image",bytes));await assert.rejects(audit.text("ABC12345",""));db.exec("UPDATE users SET status='ACTIVE'");
  db.prepare("INSERT INTO asset_moderation_evidence VALUES ('image',?,'old-policy','old-request','Review',unixepoch())").run(sha);await assert.rejects(audit.asset("ABC12345","image",bytes));
  db.prepare("INSERT INTO text_moderation_evidence VALUES ('ABC12345',?,'old-policy','old-text','Block',unixepoch())").run(createHash("sha256").update("prompt").digest("hex"));await assert.rejects(audit.text("ABC12345","prompt"));
 }finally{db.close();}
});
test("real user IDs are eight mixed alphanumerics and only PK collisions retry",async()=>{
 const values=new Set(Array.from({length:1000},newUserId));assert.equal(values.size,1000);for(const id of values)assert.match(id,/^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8}$/u);assert.equal(values.has("TEST0001"),false);
 let calls=0;const result=await withUserIdRetry(async id=>{if(++calls<3)throw Error('UNIQUE constraint failed: users.id');return id;});assert.equal(calls,3);assert.equal(result.length,8);
 calls=0;await assert.rejects(withUserIdRetry(async()=>{calls++;throw Error('UNIQUE constraint failed: auth_identities.id');}));assert.equal(calls,1);
 calls=0;await assert.rejects(withUserIdRetry(async()=>{calls++;throw Error('UNIQUE constraint failed: users.id');}));assert.equal(calls,5);
});
test("draft identity remains stable after actual account key migration",()=>{
 const actor={ownerId:"ABCD1234",identityNamespace:"user_old_hash",setCookie:null,user:{authenticated:true,displayName:"owner"}};
 assert.doesNotThrow(()=>assertDraftScope(hashIdentifier('draft:user_old_hash'),actor));assert.throws(()=>assertDraftScope(hashIdentifier('draft:ABCD1234'),actor));
});
