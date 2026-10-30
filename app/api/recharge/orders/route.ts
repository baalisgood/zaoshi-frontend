import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { ApiError,errorResponse,jsonResponse,readJsonBody,requireJsonObject } from "@/lib/server/api";
import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import { rechargeActor,publicNativeOrder,queryNativePayment } from "@/lib/server/recharge-runtime";
import { readRechargeReceipt,createNativeOrder,saveNativeCode,readNativeOrder,NATIVE_CATALOG_VERSION } from "@/lib/server/recharge-native-orders";
import { wechatPayConfig,wechatRequest } from "@/lib/server/wechat-native";
export async function POST(request:Request):Promise<Response>{try{
 const {actor,d1}=await rechargeActor(request,true);const body=requireJsonObject(await readJsonBody(request,2048));
 let prior=await readRechargeReceipt(d1,actor.ownerId,body.productCode,body.idempotencyKey);
 if(prior&&prior.catalogVersion===NATIVE_CATALOG_VERSION&&prior.status==="PENDING"&&!prior.reconciliation&&prior.expiresAt<=Math.floor(Date.now()/1000)){
  try{prior=await queryNativePayment(d1,prior);}catch{return jsonResponse({order:publicNativeOrder(await readNativeOrder(d1,prior.id,actor.ownerId)),queryPending:true});}
 }
 if(prior&&(prior.catalogVersion!==NATIVE_CATALOG_VERSION||prior.status!=="PENDING"||prior.reconciliation||prior.codeUrl||prior.expiresAt<=Math.floor(Date.now()/1000)))return jsonResponse({order:publicNativeOrder(prior)});
 const config=wechatPayConfig(readRuntimeBindings());await assertCurrentLegalConsent(actor);
 const order=await createNativeOrder(d1,actor.ownerId,body.productCode,body.idempotencyKey);
 if(order.catalogVersion!==NATIVE_CATALOG_VERSION)return jsonResponse({order:publicNativeOrder(order),legacy:true});
 if(order.status!=="PENDING"||order.reconciliation||order.codeUrl||order.expiresAt<=Math.floor(Date.now()/1000))return jsonResponse({order:publicNativeOrder(order)});
 try {
  const data=await wechatRequest("POST","/v3/pay/transactions/native",{appid:config.appId,mchid:config.mchId,description:"造室积分充值",out_trade_no:order.id,time_expire:new Date(order.expiresAt*1000).toISOString(),notify_url:config.notifyUrl,amount:{total:order.amountFen,currency:"CNY"}},config);
  await saveNativeCode(d1,order,data.code_url);
 }catch{throw new ApiError(503,"PAYMENT_RESULT_UNCERTAIN","支付订单已保留，请查询同一订单，不要重复创建。",{orderId:order.id});}
 return jsonResponse({order:publicNativeOrder(await readNativeOrder(d1,order.id,actor.ownerId))});
}catch(error){return errorResponse(error,crypto.randomUUID());}}
