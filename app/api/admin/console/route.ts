import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { attachActorCookie } from "@/lib/server/actor";
import { assertSiteAdmin } from "@/lib/server/admin";
import { grantManagedCredits, readAdminConsole, updateManagedUser } from "@/lib/server/admin-console";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";

async function context(request: Request) {
  const actor = await getRuntimeRequestActor(request);
  const bindings = readRuntimeBindings();
  assertSiteAdmin(actor, bindings);
  await ensureDatabase();
  const d1 = getD1Binding();
  if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "管理员数据存储尚未配置。");
  return { actor, bindings, d1 };
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  let actor;
  try {
    const current = await context(request); actor = current.actor;
    return attachActorCookie(jsonResponse(await readAdminConsole(request, current.d1, current.bindings)), actor);
  } catch (error) { return actor ? attachActorCookie(errorResponse(error, requestId), actor) : errorResponse(error, requestId); }
}

export async function PATCH(request: Request) {
  const requestId = crypto.randomUUID();
  let actor;
  try {
    const current = await context(request); actor = current.actor;
    assertSameOriginMutation(request);
    const result = await updateManagedUser(await readJsonBody(request, 8 * 1024), actor.ownerId, requestId, current.d1);
    return attachActorCookie(jsonResponse(result), actor);
  } catch (error) { return actor ? attachActorCookie(errorResponse(error, requestId), actor) : errorResponse(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  let actor;
  try {
    const current = await context(request); actor = current.actor;
    assertSameOriginMutation(request);
    const result = await grantManagedCredits(await readJsonBody(request, 8 * 1024), actor.ownerId, requestId, current.d1);
    return attachActorCookie(jsonResponse(result, { status: result.idempotentReplay ? 200 : 201 }), actor);
  } catch (error) { return actor ? attachActorCookie(errorResponse(error, requestId), actor) : errorResponse(error, requestId); }
}
