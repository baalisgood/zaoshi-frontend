import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { attachActorCookie } from "@/lib/server/actor";
import { assertSiteAdmin } from "@/lib/server/admin";
import { listRechargeReconciliation } from "@/lib/server/admin-recharge";
import { ApiError, errorResponse, jsonResponse } from "@/lib/server/api";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  let actor;
  try {
    actor = await getRuntimeRequestActor(request);
    assertSiteAdmin(actor, readRuntimeBindings());
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "充值记录暂不可用。");
    return attachActorCookie(jsonResponse(await listRechargeReconciliation(d1, new URL(request.url).searchParams)), actor);
  } catch (error) { return actor ? attachActorCookie(errorResponse(error, requestId), actor) : errorResponse(error, requestId); }
}
