import { REFERRAL_TERMS } from "./referrals";
import { ApiError } from "./api";
import type { PaymentFact } from "./wechat-native";
export const NATIVE_CATALOG_VERSION = "cn-recharge-v2-20261006";
export const nativeProducts = { CNY20: {amountFen:2000,credits:2000}, CNY50:{amountFen:5000,credits:5100}, CNY100:{amountFen:10000,credits:10500}, CNY200:{amountFen:20000,credits:21400}, CNY500:{amountFen:50000,credits:55000} } as const;
export type NativeOrder = { id:string; ownerId:string; productCode:string; catalogVersion:string; amountFen:number; credits:number; bonusCredits?:number; status:string; createdAt:number; expiresAt:number; paidAt:number|null; codeUrl:string|null; reconciliation:boolean };
function serialize(row:Record<string,unknown>): NativeOrder {return {id:String(row.id),ownerId:String(row.owner_id),productCode:String(row.product_code),catalogVersion:String(row.catalog_version),amountFen:Number(row.amount_fen),credits:Number(row.credits),bonusCredits:Number(row.bonus_credits??0),status:String(row.status),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at),paidAt:row.paid_at===null?null:Number(row.paid_at),codeUrl:typeof row.code_url === "string"?row.code_url:null,reconciliation:Number(row.reconciliation)>0};}
const select = `SELECT o.*, COALESCE((SELECT bonus_credits FROM referral_order_terms WHERE order_id=o.id),0) AS bonus_credits, s.code_url, EXISTS(SELECT 1 FROM recharge_reconciliation_events r WHERE r.order_id=o.id) AS reconciliation FROM recharge_orders_v2 o LEFT JOIN recharge_native_sessions s ON s.order_id=o.id`;
export async function readNativeOrder(d1:D1Database,id:string,ownerId?:string):Promise<NativeOrder> {
 const row=await d1.prepare(select+" WHERE o.id=?").bind(id).first<Record<string,unknown>>() ?? await d1.prepare("SELECT * FROM recharge_orders WHERE id=?").bind(id).first<Record<string,unknown>>();
 if(!row || (ownerId!==undefined && row.owner_id!==ownerId)) throw new ApiError(404,"RECHARGE_ORDER_NOT_FOUND","没有找到这笔充值订单。");return serialize(row);
}
export async function readRechargeReceipt(d1:D1Database,ownerId:string,productCode:unknown,key:unknown):Promise<NativeOrder|null>{
 if(typeof key!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(key))throw new ApiError(400,"INVALID_FIELD","充值请求标识无效。");
 const row=await d1.prepare(select+" WHERE o.owner_id=? AND o.idempotency_key=?").bind(ownerId,key).first<Record<string,unknown>>()??await d1.prepare("SELECT * FROM recharge_orders WHERE owner_id=? AND idempotency_key=?").bind(ownerId,key).first<Record<string,unknown>>();
 if(!row)return null;if(row.product_code!==productCode||row.provider!=="WECHAT_PAY")throw conflict();return serialize(row);
}
export async function createNativeOrder(d1:D1Database,ownerId:string,productCode:unknown,key:unknown):Promise<NativeOrder> {
 if(typeof key!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(key)) throw new ApiError(400,"INVALID_FIELD","充值请求标识无效。");
 const receipt=await readRechargeReceipt(d1,ownerId,productCode,key);if(receipt)return receipt;
 if(typeof productCode!=="string" || !Object.hasOwn(nativeProducts,productCode))throw new ApiError(400,"INVALID_FIELD","请选择有效充值套餐。");
 const product=nativeProducts[productCode as keyof typeof nativeProducts],now=Math.floor(Date.now()/1000),id="r2"+crypto.randomUUID().replaceAll("-","").slice(0,30);
 await d1.batch([d1.prepare(`INSERT INTO recharge_orders_v2 (id,owner_id,provider,product_code,catalog_version,amount_fen,credits,status,idempotency_key,created_at,updated_at,expires_at) SELECT ?,?,'WECHAT_PAY',?,?,?,?,'PENDING',?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND status='ACTIVE') ON CONFLICT(owner_id,idempotency_key) DO NOTHING`).bind(id,ownerId,productCode,NATIVE_CATALOG_VERSION,product.amountFen,product.credits,key,now,now,now+1800,ownerId),
 d1.prepare(`INSERT INTO referral_order_terms(order_id,invitee_id,promoter_id,rule_version,commission_bps,bonus_bps,amount_fen,bonus_credits,commission_fen)
 SELECT o.id,o.owner_id,r.promoter_id,?,?,?,?,CAST(o.credits*?/10000 AS INTEGER),CAST(o.amount_fen*?/10000 AS INTEGER)
 FROM recharge_orders_v2 o JOIN user_referrals r ON r.invitee_id=o.owner_id WHERE o.id=? AND o.status='PENDING'`)
 .bind(REFERRAL_TERMS.version,REFERRAL_TERMS.commissionBps,REFERRAL_TERMS.bonusBps,product.amountFen,REFERRAL_TERMS.bonusBps,REFERRAL_TERMS.commissionBps,id)]);
 const created=await d1.prepare(select+" WHERE o.owner_id=? AND o.idempotency_key=?").bind(ownerId,key).first<Record<string,unknown>>();
 if(!created)throw new ApiError(403,"USER_SUSPENDED","当前账户不可创建充值订单。");if(created.product_code!==productCode)throw conflict();return serialize(created);
}
export async function saveNativeCode(d1:D1Database,order:NativeOrder,url:unknown):Promise<void> {
 if(typeof url!=="string" || url.length>2048 || !/^weixin:\/\/wxpay\/bizpayurl\?pr=[A-Za-z0-9_-]+$/.test(url))throw new ApiError(502,"INVALID_PAYMENT_CODE","支付二维码暂不可用。");
 await d1.prepare(`INSERT INTO recharge_native_sessions(order_id,code_url) SELECT ?,? WHERE EXISTS(SELECT 1 FROM recharge_orders_v2 o JOIN users u ON u.id=o.owner_id WHERE o.id=? AND o.owner_id=? AND o.status='PENDING' AND o.expires_at>unixepoch() AND u.status='ACTIVE') ON CONFLICT(order_id) DO NOTHING`).bind(order.id,url,order.id,order.ownerId).run();
}
export async function recordPaymentFact(d1:D1Database,fact:PaymentFact):Promise<"CREDITED"|"RECONCILIATION_REQUIRED"> {
 const order=await readNativeOrder(d1,fact.orderId);if(order.amountFen!==fact.amountFen)throw new ApiError(400,"PAYMENT_AMOUNT_MISMATCH","支付金额与订单不一致。");
 const prior=await d1.prepare("SELECT * FROM recharge_payment_events_v2 WHERE provider='WECHAT_PAY' AND provider_transaction_id=?").bind(fact.transactionId).first<Record<string,unknown>>();
 if(prior){if(prior.order_id!==fact.orderId || prior.payload_hash!==fact.factsHash)throw conflict();if(order.status!=="CREDITED")throw new ApiError(503,"PAYMENT_UNAVAILABLE","支付状态待核对。");return "CREDITED";}
 const now=Math.floor(Date.now()/1000),eventId="wechat:"+fact.transactionId;
 if(order.status!=="PENDING" || fact.paidAt<order.createdAt || fact.paidAt>order.expiresAt){
  await d1.prepare(`INSERT INTO recharge_reconciliation_events(id,order_id,provider,provider_transaction_id,amount_fen,paid_at,verified_at,facts_hash,reason) VALUES(?,?,'WECHAT_PAY',?,?,?,?,?,?) ON CONFLICT(provider_transaction_id) DO NOTHING`).bind("reconcile_"+crypto.randomUUID(),order.id,fact.transactionId,fact.amountFen,fact.paidAt,now,fact.factsHash,fact.paidAt<order.createdAt||fact.paidAt>order.expiresAt?"OUTSIDE_PAYMENT_WINDOW":"ORDER_NOT_PAYABLE").run();
  const stored=await d1.prepare("SELECT order_id,facts_hash FROM recharge_reconciliation_events WHERE provider_transaction_id=?").bind(fact.transactionId).first<{order_id:string;facts_hash:string}>();if(stored?.order_id!==order.id||stored.facts_hash!==fact.factsHash)throw conflict();return "RECONCILIATION_REQUIRED";
 }
 try {
 await d1.prepare(`INSERT INTO recharge_payment_events_v2(id,order_id,provider,provider_event_id,provider_transaction_id,amount_fen,payload_hash,paid_at,verified_at) VALUES(?,?,'WECHAT_PAY',?,?,?,?,?,?) ON CONFLICT(provider,provider_event_id) DO NOTHING`).bind("event_"+crypto.randomUUID(),order.id,eventId,fact.transactionId,fact.amountFen,fact.factsHash,fact.paidAt,now).run();
 } catch(error) {
  // A signed close may win after our read; preserve a late payment for reconciliation.
  if((await readNativeOrder(d1,order.id)).status!=="PENDING")return recordPaymentFact(d1,fact);
  throw error;
 }
 const verified=await d1.prepare("SELECT order_id,payload_hash FROM recharge_payment_events_v2 WHERE provider='WECHAT_PAY' AND provider_transaction_id=?").bind(fact.transactionId).first<{order_id:string;payload_hash:string}>();
 if(verified?.order_id!==order.id||verified.payload_hash!==fact.factsHash)throw conflict();if((await readNativeOrder(d1,order.id)).status!=="CREDITED")throw new ApiError(503,"PAYMENT_UNAVAILABLE","支付状态待核对。");return "CREDITED";
}
function conflict():ApiError{return new ApiError(409,"IDEMPOTENCY_CONFLICT","充值请求与原订单不一致。");}

export async function rechargeSummary(d1:D1Database,start=0,end=Math.floor(Date.now()/1000)){
 const row=await d1.prepare(`SELECT COUNT(DISTINCT o.owner_id) AS users,COALESCE(SUM(o.amount_fen),0) AS amountFen FROM (
  SELECT id,owner_id,amount_fen,credits,status,paid_at,credit_ledger_entry_id FROM recharge_orders
  UNION ALL SELECT id,owner_id,amount_fen,credits,status,paid_at,credit_ledger_entry_id FROM recharge_orders_v2
 ) o JOIN credit_ledger_entries l ON l.id=o.credit_ledger_entry_id AND l.owner_id=o.owner_id AND l.amount=o.credits AND l.entry_type='CREDIT' AND l.reason_code='RECHARGE_PAID'
 WHERE o.status='CREDITED' AND o.paid_at>=? AND o.paid_at<=?`).bind(start,end).first<{users:number;amountFen:number}>();
 return {status:"verified_ledger" as const,users:Number(row?.users??0),amountFen:Number(row?.amountFen??0),currency:"CNY" as const};
}
