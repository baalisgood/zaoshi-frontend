import { getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { ApiError,errorResponse,jsonResponse } from "@/lib/server/api";
import { readBoundedResponseText } from "@/lib/server/bounded-response";
import { wechatPayConfig,verifyWechatMessage,decryptWechatResource,normalizePaymentFact } from "@/lib/server/wechat-native";
import { recordPaymentFact } from "@/lib/server/recharge-native-orders";
export async function POST(request:Request):Promise<Response>{try{
 const config=wechatPayConfig(readRuntimeBindings());const raw=await readBoundedResponseText(new Response(request.body,{headers:request.headers}),{maxBytes:65536,timeoutMs:5000,signal:request.signal,tooLargeCode:"INVALID_PAYMENT_MESSAGE",invalidCode:"INVALID_PAYMENT_MESSAGE",label:"支付通知"});
 verifyWechatMessage(raw,request.headers,config);
 let outer:Record<string,unknown>;try{outer=JSON.parse(raw);}catch{throw new ApiError(400,"INVALID_PAYMENT_MESSAGE","支付通知格式无效。");}
 if(outer.event_type!=="TRANSACTION.SUCCESS"||outer.resource_type!=="encrypt-resource")throw new ApiError(400,"INVALID_PAYMENT_MESSAGE","支付通知类型无效。");
 const data=decryptWechatResource(outer.resource,config);const fact=normalizePaymentFact(data,config);
 const d1=getD1Binding();if(!d1)throw new ApiError(503,"PAYMENT_UNAVAILABLE","充值服务暂不可用。");
 await recordPaymentFact(d1,fact);return jsonResponse({code:"SUCCESS",message:"成功"});
}catch(error){return errorResponse(error,crypto.randomUUID());}}
