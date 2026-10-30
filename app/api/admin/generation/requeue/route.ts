import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { attachActorCookie } from "@/lib/server/actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
import { assertReconciliationAdmin } from "@/lib/server/generation-reconciliation";
import {
  parseSafeRequeueInput,
  requeueFailedBeforeProvider,
} from "@/lib/server/generation-safe-requeue";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";

export async function POST(request: Request) {
  const actor = await getRequestActor(request);
  const requestId = crypto.randomUUID();
  try {
    assertReconciliationAdmin(request, actor, readRuntimeBindings());
    assertSameOriginMutation(request);
    const input = parseSafeRequeueInput(await readJsonBody(request, 8 * 1024));
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "生成队列存储尚未配置。");
    const result = await requeueFailedBeforeProvider({
      ...input,
      actorId: actor.ownerId,
      requestId,
    }, d1);
    return attachActorCookie(jsonResponse({ action: result }, {
      status: result.idempotentReplay ? 200 : 201,
    }), actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
