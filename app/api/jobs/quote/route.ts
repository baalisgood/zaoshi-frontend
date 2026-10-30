import { isOverseasImageModel } from "@/lib/domain/image-models";
import { ApiError, errorResponse, jsonResponse, readJsonBody, requireJsonObject } from "@/lib/server/api";
import { quoteGenerationPrice } from "@/lib/server/generation-pricing";
import { assertSameOriginMutation, assertPublicImageGenerationActor, assertGenerationRuntime } from "@/lib/server/runtime-policy";
import { assertPrivateTestJob, assertPrivateTestRequest, resolvePrivateTestConfig } from "@/lib/server/private-test";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    assertSameOriginMutation(request);
    const body = requireJsonObject(await readJsonBody(request, 4 * 1024));
    let context: Parameters<typeof quoteGenerationPrice>[1];
    if (typeof process !== "undefined" && process.env.AUTH_MODE === "private-test") {
      const { readRuntimeBindings } = await import("@/lib/platform/cloudflare-runtime");
      const bindings = readRuntimeBindings();
      if (bindings.AUTH_MODE !== "private-test") throw new Error("Private-test bindings do not match the Node process mode.");
      const privateTest = resolvePrivateTestConfig(bindings);
      assertPrivateTestRequest(request, privateTest, true);
      const { getRuntimeRequestActor } = await import("@/lib/server/runtime-actor");
      const actor = await getRuntimeRequestActor(request);
      context = { privateTest: { config: privateTest, actor } };
    }
    if (!context?.privateTest) {
      if (isOverseasImageModel(body.modelId)) throw new ApiError(403, "OVERSEAS_MODEL_UNAVAILABLE", "海外模型暂不对公众开放。");
      if (typeof process === "undefined" || process.env.PUBLIC_IMAGE_GENERATION_ENABLED !== "1") throw new ApiError(503, "GENERATION_QUEUE_NOT_READY", "正式生图尚未开放。");
      const { getRuntimeRequestActor } = await import("@/lib/server/runtime-actor");
      const { readAiEnvironment } = await import("@/lib/server/ai-environment");
      const actor = await getRuntimeRequestActor(request), environment = readAiEnvironment();
      assertPublicImageGenerationActor(actor, environment);
      assertGenerationRuntime(body.modelId as never, environment);
      context = { production: true };
    }
    const quote = quoteGenerationPrice({
      modelId: body.modelId,
      purpose: body.purpose,
      requestedResolution: body.resolution,
      inputImageCount: body.inputImageCount,
      outputCount: body.outputCount,
      quality: body.quality,
      aspectRatio: body.aspectRatio,
    }, context);
    if (context?.privateTest) {
      assertPrivateTestJob(context.privateTest.actor, { providerPreference: quote.modelId, purpose: quote.purpose, effectiveResolution: quote.effectiveResolution, outputCount: quote.outputCount });
    }
    return jsonResponse({ quote });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
