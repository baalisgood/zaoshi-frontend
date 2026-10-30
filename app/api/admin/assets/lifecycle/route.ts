import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { attachActorCookie } from "@/lib/server/actor";
import { assertSiteAdmin } from "@/lib/server/admin";
import { getAssetLifecycleSummary, retryBlockedObjectCleanup } from "@/lib/server/asset-lifecycle";
import { ApiError, errorResponse, jsonResponse, readJsonBody, requireJsonObject, requireString } from "@/lib/server/api";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";

async function actor(request: Request) { const current = await getRuntimeRequestActor(request); assertSiteAdmin(current, readRuntimeBindings()); return current; }

export async function GET(request: Request) { let current; try { current = await actor(request); return attachActorCookie(jsonResponse({ summary: await getAssetLifecycleSummary() }), current); } catch (error) { return current ? attachActorCookie(errorResponse(error, crypto.randomUUID()), current) : errorResponse(error, crypto.randomUUID()); } }

export async function POST(request: Request) { const requestId = crypto.randomUUID(); let current; try { current = await actor(request); assertSameOriginMutation(request); const body = requireJsonObject(await readJsonBody(request, 2 * 1024)); if (body.action === "retryBlocked") { const result = await retryBlockedObjectCleanup({ actionId: requireString(body.actionId, "actionId", { min: 8, max: 128 }), actorId: current.ownerId, requestId }); return attachActorCookie(jsonResponse({ result, summary: await getAssetLifecycleSummary() }), current); } throw new ApiError(400, "INVALID_ACTION", "资产维护动作无效。"); } catch (error) { return current ? attachActorCookie(errorResponse(error, requestId), current) : errorResponse(error, requestId); } }
