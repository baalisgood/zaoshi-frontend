import { requirePublicModelOption } from "@/lib/server/public-model-option";
import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody, requireJsonObject } from "@/lib/server/api";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import { parseAdditionalReferencesJson } from "@/lib/server/job-contract";
import { getJob } from "@/lib/server/persistence";
import { quoteGenerationPrice } from "@/lib/server/generation-pricing";
import { assertSameOriginMutation, assertPublicImageGenerationActor, assertGenerationRuntime } from "@/lib/server/runtime-policy";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { assertPrivateTestRequest, resolvePrivateTestConfig } from "@/lib/server/private-test";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const actor = await getRuntimeRequestActor(request);
  const requestId = crypto.randomUUID();
  try {
    assertSameOriginMutation(request);
    const bindings = readRuntimeBindings();
    if (bindings.AUTH_MODE === "private-test") {
      assertPrivateTestRequest(request, resolvePrivateTestConfig(bindings), true);
      throw new ApiError(409, "PRIVATE_TEST_FINALIZE_FORBIDDEN", "付费私测不开放参考图晋升成品图，请直接提交单次任务。");
    }
    const environment = readAiEnvironment();
    assertPublicImageGenerationActor(actor, environment);
    const body = requireJsonObject(await readJsonBody(request, 4 * 1024));
    const { id } = await context.params;
    const preview = await getJob(id, actor.ownerId);
    if (!preview) throw new ApiError(404, "JOB_NOT_FOUND", "没有找到这个生成任务。");
    if (preview.purpose !== "preview") throw new ApiError(409, "INVALID_JOB_PURPOSE", "只有参考图任务可以报价高清成品。");
    const tuple = requirePublicModelOption({ optionId: body.optionId, modelId: body.providerPreference, resolution: body.resolution, quality: body.quality });
    assertGenerationRuntime(tuple.model, environment);
    const additional = parseAdditionalReferencesJson(preview.additionalReferencesJson, preview.workflowType);
    const inputImageCount = 1 + Number(Boolean(preview.referenceAssetId)) + Number(Boolean(preview.depthAssetId)) + Number(Boolean(preview.normalAssetId)) + additional.length;
    const response = jsonResponse({ quote: quoteGenerationPrice({
      optionId: body.optionId,
      modelId: tuple.model,
      purpose: "final",
      requestedResolution: body.resolution,
      inputImageCount,
      outputCount: body.outputCount,
      quality: body.quality,
      aspectRatio: preview.aspectRatio,
    }, { production: true }) });
    return attachActorCookie(response, actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
