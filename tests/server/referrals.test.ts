import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, TestD1Database } from '../helpers/test-d1';
import { registrationReferral, referralProfile } from '../../lib/server/referrals';
import { createNativeOrder, readNativeOrder, recordPaymentFact } from '../../lib/server/recharge-native-orders';
import { updateManagedUser, readAdminConsole } from '../../lib/server/admin-console';
function setup(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 db.exec("INSERT INTO users(id,display_name,role,email_registration_receipt) VALUES ('ADMIN001','admin','ADMIN',NULL),('PROMO001','promoter','USER',NULL),('INVITE01','invitee','USER','receipt'),('NORMAL01','normal','USER',NULL)");
 db.exec("INSERT INTO referral_promoters(user_id) VALUES('PROMO001')");
 return {db,d1:new TestD1Database(db) as unknown as D1Database};
}
const payment=(order:{id:string;amountFen:number;createdAt:number},suffix='1')=>({orderId:order.id,amountFen:order.amountFen,transactionId:`txn-${suffix}`,paidAt:order.createdAt,factsHash:createHash('sha256').update(suffix).digest('hex')});
test('only new registration with its exact receipt can attach once to an active promoter',async()=>{
 const {db,d1}=setup();
 for(const [id,code,receipt] of [['NORMAL01','PROMO001','receipt'],['INVITE01','PROMO001','wrong'],['INVITE01','bad','receipt'],['PROMO001','PROMO001','receipt']])await registrationReferral(d1,id,code,'email',receipt).run();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_referrals').get()?.n,0);
 await registrationReferral(d1,'INVITE01','PROMO001','email','receipt').run();
 await registrationReferral(d1,'INVITE01','PROMO001','email','receipt').run();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_referrals').get()?.n,1);
 assert.throws(()=>db.exec("UPDATE user_referrals SET promoter_id='ADMIN001'"),/immutable/);
 db.exec("UPDATE referral_promoters SET enabled=0;UPDATE users SET email_registration_receipt='fresh' WHERE id='NORMAL01'");
 await registrationReferral(d1,'NORMAL01','PROMO001','email','fresh').run();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_referrals').get()?.n,1);
 db.close();
});
test('every verified recharge grants 5% package bonus and accrues 8% cash exactly once',async()=>{
 const {db,d1}=setup();await registrationReferral(d1,'INVITE01','PROMO001','email','receipt').run();
 for(const [code,credits,cash] of [['CNY100',11025,800],['CNY500',57750,4000]] as const){
  const order=await createNativeOrder(d1,'INVITE01',code,code);
  assert.equal(order.credits+(order.bonusCredits??0),credits);
  assert.equal((await createNativeOrder(d1,'INVITE01',code,code)).id,order.id);
  const fact=payment(order,code);
  await Promise.all([recordPaymentFact(d1,fact),recordPaymentFact(d1,fact)]);
  assert.equal(db.prepare("SELECT SUM(amount) n FROM credit_ledger_entries WHERE id IN ('ledger_recharge_'||?,'ledger_referral_'||?)").get(order.id,order.id)?.n,credits);
  assert.equal(db.prepare('SELECT commission_fen FROM referral_order_terms WHERE order_id=?').get(order.id)?.commission_fen,cash);
  db.exec('UPDATE referral_promoters SET enabled=0');
 }
 const profile=await referralProfile(d1,'PROMO001');assert.equal(profile?.accruedFen,4800);assert.equal(profile?.invitedCount,1);assert.equal(profile?.enabled,false);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE owner_id='PROMO001'").get()?.n,0);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
});
test('failed bonus rolls back the payment and package credit; late or mismatched payments grant nothing',async()=>{
 const {db,d1}=setup();await registrationReferral(d1,'INVITE01','PROMO001','email','receipt').run();
 const order=await createNativeOrder(d1,'INVITE01','CNY20','atomic');
 db.exec("CREATE TRIGGER fail_reward BEFORE INSERT ON referral_rewards BEGIN SELECT RAISE(ABORT,'forced failure');END");
 await assert.rejects(recordPaymentFact(d1,payment(order)),/forced failure/);
 assert.equal((await readNativeOrder(d1,order.id)).status,'PENDING');
 for(const table of ['credit_ledger_entries','referral_rewards','recharge_payment_events_v2'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n,0);
 db.exec('DROP TRIGGER fail_reward');
 await assert.rejects(recordPaymentFact(d1,{...payment(order),amountFen:1}));
 assert.equal(await recordPaymentFact(d1,{...payment(order),paidAt:order.createdAt-1}),'RECONCILIATION_REQUIRED');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM referral_rewards').get()?.n,0);
 assert.throws(()=>db.prepare('INSERT INTO referral_rewards(order_id) VALUES(?)').run(order.id),/unpaid/);
 assert.throws(()=>db.exec("INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id) VALUES('fake','INVITE01','CREDIT',100,'fake','REFERRAL_RECHARGE_BONUS','system')"));
 db.close();
});
test('ordinary payments and ordinary user edits never create referral records',async()=>{
 const {db,d1}=setup();
 await updateManagedUser({action:'UPDATE_USER',actionId:'ordinary-edit',userId:'NORMAL01',promoterEnabled:false},'ADMIN001','r',d1);
 assert.equal(await referralProfile(d1,'NORMAL01'),null);
 const order=await createNativeOrder(d1,'NORMAL01','CNY100','normal');await recordPaymentFact(d1,payment(order));
 assert.equal(order.bonusCredits,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM referral_rewards').get()?.n,0);
 await updateManagedUser({action:'UPDATE_USER',actionId:'enable-promo',userId:'NORMAL01',promoterEnabled:true},'ADMIN001','r',d1);
 assert.equal((await referralProfile(d1,'NORMAL01'))?.enabled,true);db.close();
});
test('superadmin remains first across cursor pages without duplicates and filters still apply',async()=>{
 const {db,d1}=setup();db.exec("UPDATE users SET created_at=1 WHERE id='ADMIN001'");
 const ids:string[]=[];let cursor:string|null=null;
 do{const result=await readAdminConsole(new Request('https://example.test/api/admin/console?view=users&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),d1,{}) as {items:Array<{id:string}>;nextCursor:string|null};ids.push(...result.items.map(x=>x.id));cursor=result.nextCursor;}while(cursor);
 assert.equal(ids[0],'ADMIN001');assert.equal(new Set(ids).size,4);assert.equal(ids.length,4);
 const filtered=await readAdminConsole(new Request('https://example.test/api/admin/console?view=users&q=normal'),d1,{}) as {items:Array<{id:string}>};assert.deepEqual(filtered.items.map(x=>x.id),['NORMAL01']);db.close();
});
