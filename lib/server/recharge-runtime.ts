import { getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { getRuntimeRequestActor } from "./runtime-actor";
import { assertAuthenticatedActor } from "./legal-consent";
import { assertSameOriginMutation } from "./runtime-policy";
import { limitEmailAuth, resolveEmailAuthConfig } from "./email-auth";
import { ApiError } from "./api";
import { wechatPayConfig, wechatRequest, normalizePaymentFact } from "./wechat-native";
import { recordPaymentFact, readNativeOrder, type NativeOrder } from "./recharge-native-orders";
export async function rechargeActor(request:Request,mutation=false) {
 if(mutation)assertSameOriginMutation(request);
 const actor=await getRuntimeRequestActor(request);assertAuthenticatedActor(actor);
 const d1=getD1Binding();if(!d1)throw new ApiError(503,"PAYMENT_UNAVAILABLE","充值暂未开放。");
 const auth=resolveEmailAuthConfig(readRuntimeBindings());if(!auth)throw new ApiError(503,"PAYMENT_UNAVAILABLE","充值暂未开放。");
 await limitEmailAuth(d1,auth,`recharge:${mutation?"create":"query"}:${actor.ownerId}`,mutation?10:30,60);
 return {actor,d1};
}
export async function queryNativePayment(d1:D1Database,order:NativeOrder,close=false):Promise<NativeOrder> {
 const config=wechatPayConfig(readRuntimeBindings());
 let data:Record<string,unknown>;try{
  data=await wechatRequest("GET",`/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}?mchid=${encodeURIComponent(config.mchId)}`,undefined,config);
 }catch(error){
  if(error instanceof ApiError&&error.code==="WECHAT_ORDER_NOT_EXIST"&&order.expiresAt<=Math.floor(Date.now()/1000)){
   await d1.prepare("UPDATE recharge_orders_v2 SET status='EXPIRED',updated_at=unixepoch() WHERE id=? AND owner_id=? AND status='PENDING' AND expires_at<=unixepoch()").bind(order.id,order.ownerId).run();
   return readNativeOrder(d1,order.id,order.ownerId);
  }
  throw error;
 }
 if(data.appid!==config.appId||data.mchid!==config.mchId||data.out_trade_no!==order.id)throw new ApiError(400,"INVALID_PAYMENT_MESSAGE","支付订单校验失败。");
 if(data.trade_state==="SUCCESS")await recordPaymentFact(d1,normalizePaymentFact(data,config));
 else if(!["NOTPAY","USERPAYING","CLOSED","REVOKED","PAYERROR"].includes(String(data.trade_state)))throw new ApiError(503,"PAYMENT_UNAVAILABLE","支付状态待核对。");
 else if(close&&data.trade_state==="NOTPAY"){
  await wechatRequest("POST",`/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}/close`,{mchid:config.mchId},config);
  await cancelNativeOrder(d1,order);
 }
 // Expiration of a QR is not proof that no payment happened. Only signed CLOSED/REVOKED is final.
 else if(["CLOSED","REVOKED"].includes(String(data.trade_state)))await cancelNativeOrder(d1,order);
 return readNativeOrder(d1,order.id,order.ownerId);
}
async function cancelNativeOrder(d1:D1Database,order:NativeOrder):Promise<void>{
 await d1.prepare("UPDATE recharge_orders_v2 SET status='CANCELED',updated_at=unixepoch() WHERE id=? AND owner_id=? AND status='PENDING'").bind(order.id,order.ownerId).run();
}
export function publicNativeOrder(order:NativeOrder) {
 const {ownerId: _ownerId,...safe}=order;void _ownerId;
 return {...safe,codeUrl:order.status==="PENDING"&&!order.reconciliation&&order.expiresAt>Math.floor(Date.now()/1000)?order.codeUrl:null};
}
