import { attachActorCookie } from "@/lib/server/actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import {
  appendReconciliationNote,
  assertReconciliationAdmin,
  listReconciliationCases,
  parseAddReconciliationNote,
  parseReconciliationLimit,
  parseReconciliationState,
} from "@/lib/server/generation-reconciliation";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";

export async function GET(request: Request) {
  const actor = await getRequestActor(request);
  try {
    assertReconciliationAdmin(request, actor, readRuntimeBindings());
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "对账存储尚未配置。");
    const params = new URL(request.url).searchParams;
    const result = await listReconciliationCases({
      state: parseReconciliationState(params.get("state")),
      limit: parseReconciliationLimit(params.get("limit")),
      cursor: params.get("cursor"),
    }, d1);
    return attachActorCookie(jsonResponse(result), actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, crypto.randomUUID()), actor);
  }
}

export async function POST(request: Request) {
  const actor = await getRequestActor(request);
  const requestId = crypto.randomUUID();
  try {
    assertReconciliationAdmin(request, actor, readRuntimeBindings());
    assertSameOriginMutation(request);
    const input = parseAddReconciliationNote(await readJsonBody(request, 8 * 1024));
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "STORAGE_NOT_CONFIGURED", "对账存储尚未配置。");
    const event = await appendReconciliationNote({
      ...input,
      actorId: actor.ownerId,
      requestId,
    }, d1);
    return attachActorCookie(jsonResponse({ event }, {
      status: event.idempotentReplay ? 200 : 201,
    }), actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
