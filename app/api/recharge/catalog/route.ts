import { getD1Binding, ensureDatabase } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { jsonResponse, errorResponse } from "@/lib/server/api";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { nativeProducts } from "@/lib/server/recharge-native-orders";
import { REFERRAL_TERMS } from "@/lib/server/referrals";
import { wechatPayConfig } from "@/lib/server/wechat-native";
export async function GET(request: Request): Promise<Response> {
 try {
  let enabled=false;try {wechatPayConfig(readRuntimeBindings());enabled=true;}catch{enabled=false;}
  const actor=await getRuntimeRequestActor(request);
  let bonusBps=0;
  if(actor.trusted && actor.user.authenticated){
   await ensureDatabase();
   const row=await getD1Binding()?.prepare('SELECT 1 FROM user_referrals WHERE invitee_id=?').bind(actor.ownerId).first();
   if(row)bonusBps=REFERRAL_TERMS.bonusBps;
  }
  return jsonResponse({enabled,products:nativeProducts,bonusBps});
 }catch(error){return errorResponse(error,crypto.randomUUID());}
}
