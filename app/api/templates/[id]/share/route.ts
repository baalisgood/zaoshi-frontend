import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { createShare, getTemplate, revokeShares } from "@/lib/server/templates";
type Ctx = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Ctx) { const actor=await getRequestActor(request); try { assertSameOriginMutation(request); const {id}=await context.params; if (!(await getTemplate(id,actor.ownerId))) throw new ApiError(404,"TEMPLATE_NOT_FOUND","模板不存在。"); const body = await readJsonBody(request); const action = body && typeof body === "object" ? (body as Record<string,unknown>).action : undefined; if (action === "revoke") { await revokeShares(id, actor.ownerId); return attachActorCookie(jsonResponse({revoked:true}),actor); } if (action !== "create") throw new ApiError(400, "INVALID_ACTION", "分享操作必须是create或revoke。"); const {token}=await createShare(id, actor.ownerId); return attachActorCookie(jsonResponse({token,shareUrl:`/api/templates/shared/${encodeURIComponent(token)}`}),actor); } catch(error) { return attachActorCookie(errorResponse(error,crypto.randomUUID()),actor); } }
