import { getD1Binding, ensureDatabase } from '@/db';
import { getRuntimeRequestActor } from '@/lib/server/runtime-actor';
import { assertAuthenticatedActor } from '@/lib/server/legal-consent';
import { ApiError, jsonResponse, errorResponse } from '@/lib/server/api';
import { invitationCode, referralProfile } from '@/lib/server/referrals';
export async function GET(request: Request) {
 try {
  const actor=await getRuntimeRequestActor(request); assertAuthenticatedActor(actor); await ensureDatabase();
  const d1=getD1Binding(); if(!d1) throw new ApiError(503,'STORAGE_UNAVAILABLE','服务暂不可用。');
  const after=new URL(request.url).searchParams.get('after')??'';
  if(after && !invitationCode(after)) throw new ApiError(400,'INVALID_CURSOR','分页位置无效。');
  return jsonResponse({referral:await referralProfile(d1,actor.ownerId,after)});
 } catch(error) {return errorResponse(error,crypto.randomUUID());}
}
