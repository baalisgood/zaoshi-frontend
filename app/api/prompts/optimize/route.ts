import { getD1Binding } from "@/db";
import { runtimeModeration } from "@/lib/server/machine-moderation";
import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody, requireJsonObject, requireString } from "@/lib/server/api";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import { assertPromptOptimizerActor, assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { optimizerEndpoint, quoteOptimization, runOptimization, optimizationResult } from "@/lib/server/prompt-optimization";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);
  try {
    assertSameOriginMutation(request);
    const environment = readAiEnvironment(); assertPromptOptimizerActor(actor, environment);
    await assertCurrentLegalConsent(actor);
    const body = requireJsonObject(await readJsonBody(request, 10 * 1024));
    // Legacy free calls cannot dispatch a provider request.
    if (body.action !== "quote" && body.action !== "optimize" && body.action !== "result") throw new ApiError(409, "OPTIMIZATION_QUOTE_REQUIRED", "请先获取并确认本次 AI 优化费用。");
    const d1 = getD1Binding(); if (!d1) throw new ApiError(503, "OPTIMIZATION_STORAGE_UNAVAILABLE", "AI 优化服务暂不可用。");
    if (body.action === "result") return attachActorCookie(jsonResponse(await optimizationResult(d1, actor.ownerId, requireString(body.quoteId, "quoteId", { max: 100 }))), actor);
    const prompt = requireString(body.prompt, "prompt", { max: 2000 });
    optimizerEndpoint(environment);
    if (body.action === "quote") return attachActorCookie(jsonResponse(await quoteOptimization(d1, actor.ownerId, prompt, body.context)), actor);
    const id = requireString(body.quoteId, "quoteId", { max: 100 });
    const audit = await runtimeModeration(d1);
    const result = await runOptimization(d1, actor.ownerId, id, prompt, body.context, { environment, moderate: (text) => audit.text(actor.ownerId, text) });
    const currentActor = await getRuntimeRequestActor(request);
    assertPromptOptimizerActor(currentActor, environment);
    if (currentActor.ownerId !== actor.ownerId) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "账户状态已变化，请重新登录后查询优化结果。");
    await assertCurrentLegalConsent(currentActor);
    return attachActorCookie(jsonResponse(result, { status: result.status === "DISPATCHING" ? 202 : 200 }), actor);
  } catch (error) { return attachActorCookie(errorResponse(error, requestId), actor); }
}
