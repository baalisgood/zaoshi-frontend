import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { attachActorCookie } from "@/lib/server/actor";
import { ApiError, errorResponse, jsonResponse } from "@/lib/server/api";
import {
  listDeadLetters,
  parseDeadLetterLimit,
  parseDeadLetterState,
} from "@/lib/server/generation-dead-letters";
import { assertReconciliationAdmin } from "@/lib/server/generation-reconciliation";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";

export async function GET(request: Request) {
  const actor = await getRequestActor(request);
  try {
    assertReconciliationAdmin(request, actor, readRuntimeBindings());
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "死信存储尚未配置。");
    const params = new URL(request.url).searchParams;
    const result = await listDeadLetters({
      state: parseDeadLetterState(params.get("state")),
      limit: parseDeadLetterLimit(params.get("limit")),
      cursor: params.get("cursor"),
    }, d1);
    return attachActorCookie(jsonResponse(result), actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, crypto.randomUUID()), actor);
  }
}
