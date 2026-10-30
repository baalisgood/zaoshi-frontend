import { activeVerifiedIdentityPolicy } from "@/lib/server/wechat-auth-config-core";
import { auditGenerationInputs } from "@/lib/server/machine-moderation";
import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import { isOverseasImageModel } from "@/lib/domain/image-models";
import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, requireJsonObject, requireString, readJsonBody } from "@/lib/server/api";
import { assertAssetKind, outputQualities, outputResolutions, parseAdditionalReferencesJson, type OutputQuality, type OutputResolution } from "@/lib/server/job-contract";
import { assertQueuedJobItemsConsistent, createQueuedJobIdempotently, getJobByIdempotencyKey, getAsset, getAssetBytes, getJob, getJobOutputs, getStorageMode, storageHeaders } from "@/lib/server/persistence";
import { serializeJob } from "@/lib/server/serializers";
import { assertCostBearingActor, assertPublicImageGenerationActor, assertDomesticGenerationParameters, assertGenerationRuntime, assertSameOriginMutation, assertDomesticGenerationQueueReady, validateDomesticInputAssetsForProvider } from "@/lib/server/runtime-policy";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import type { ProviderPreference } from "@/lib/ai";
import { isImageModel, imageModelSupportsQuality } from "@/lib/domain/image-models";
import { generationBilling, quoteGenerationPrice, readGenerationPriceExpectation } from "@/lib/server/generation-pricing";
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
    assertCostBearingActor(actor, environment);
    if (Number(request.headers.get("content-length") ?? 0) > 32 * 1024) throw new ApiError(413, "BODY_TOO_LARGE", "请求正文过大。");
    const { id: previewId } = await context.params;
    const body = requireJsonObject(await readJsonBody(request));
    const selectedOutputAssetId = requireString(body.selectedOutputAssetId, "selectedOutputAssetId", { max: 128 });
    const resolution = body.resolution as OutputResolution;
    if (!(outputResolutions as readonly unknown[]).includes(resolution)) throw new ApiError(400, "INVALID_FIELD", "resolution 不受支持。", { field: "resolution" });
    const quality = body.quality as OutputQuality;
    if (!(outputQualities as readonly unknown[]).includes(quality)) throw new ApiError(400, "INVALID_FIELD", "quality 不受支持。", { field: "quality" });
    const outputCount = body.outputCount;
    if (typeof outputCount !== "number" || !Number.isInteger(outputCount) || outputCount < 1 || outputCount > 4) throw new ApiError(400, "INVALID_FIELD", "outputCount 必须是1到4的整数。", { field: "outputCount" });
    const idempotencyKey = requireString(body.idempotencyKey, "idempotencyKey", { min: 8, max: 128 });
    const prior = await getJobByIdempotencyKey(actor.ownerId, idempotencyKey);
    if (prior) {
      if (prior.requestHash !== await hashFinalize({ previewId, selectedOutputAssetId, resolution, quality, outputCount })) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求编号不能用于不同参数。");
      await assertQueuedJobItemsConsistent(prior);
      return attachActorCookie(jsonResponse({ job: serializeJob(prior, await getJobOutputs(prior.id, actor.ownerId)), persistence: getStorageMode(), idempotentReplay: true }, { status: 202, headers: storageHeaders() }), actor);
    }
    await assertCurrentLegalConsent(actor);
    const preview = await getJob(previewId, actor.ownerId);
    if (!preview) throw new ApiError(404, "JOB_NOT_FOUND", "没有找到这个生成任务。");
    if (preview.purpose !== "preview") throw new ApiError(409, "INVALID_JOB_PURPOSE", "只有参考图任务可以生成成品图。");
    if (preview.status !== "SUCCEEDED" && preview.status !== "PARTIAL_SUCCEEDED") throw new ApiError(409, "JOB_NOT_READY", "参考图任务尚未成功完成。");
    const providerPreference = preview.providerPreference;
    if (isOverseasImageModel(providerPreference)) throw new ApiError(403, "OVERSEAS_MODEL_UNAVAILABLE", "海外模型暂不对公众开放。");
    if (!isImageModel(providerPreference)) {
      throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "该历史任务使用的图片模型已停用，不能继续生成成品图。请重新提交并选择国产模型。", { provider: preview.providerPreference });
    }
    assertDomesticGenerationQueueReady(providerPreference as ProviderPreference, environment);
    assertPublicImageGenerationActor(actor, environment);
    if (!imageModelSupportsQuality(providerPreference, quality)) throw new ApiError(400, "PROVIDER_QUALITY_UNSUPPORTED", "当前模型不支持所选质量。");
    assertGenerationRuntime(providerPreference as ProviderPreference, environment);
    assertDomesticGenerationParameters(providerPreference as ProviderPreference, resolution, Boolean(preview.maskAssetId));
    const outputs = await getJobOutputs(preview.id, actor.ownerId);
    const selected = outputs.find((asset) => asset.id === selectedOutputAssetId && asset.status === "READY");
    if (!selected) throw new ApiError(400, "OUTPUT_NOT_IN_JOB", "所选参考图不属于该任务或尚未就绪。");
    const source = await getAsset(selected.id, actor.ownerId);
    assertAssetKind(source, "output", "selectedOutputAssetId");
    const providerAssets = [source];
    for (const [assetId, kind, field] of [
      [preview.referenceAssetId, ["reference", "output"], "referenceAssetId"],
      [preview.depthAssetId, "depth", "depthAssetId"],
      [preview.normalAssetId, "normal", "normalAssetId"],
    ] as const) {
      if (!assetId) continue;
      const asset = await getAsset(assetId, actor.ownerId);
      assertAssetKind(asset, kind, field);
      providerAssets.push(asset);
    }
    const additionalReferences = parseAdditionalReferencesJson(preview.additionalReferencesJson, preview.workflowType);
    for (const [index, entry] of additionalReferences.entries()) {
      const asset = await getAsset(entry.assetId, actor.ownerId);
      assertAssetKind(asset, "reference", `additionalReferences[${index}].assetId`);
      providerAssets.push(asset);
    }
    await validateDomesticInputAssetsForProvider(providerPreference as ProviderPreference, providerAssets, getAssetBytes);
    const price = quoteGenerationPrice({ modelId: providerPreference, purpose: "final", requestedResolution: resolution, inputImageCount: providerAssets.length, outputCount, quality, aspectRatio: preview.aspectRatio }, { production: true });
    const priceExpectation = readGenerationPriceExpectation(body);
    const now = new Date().toISOString();
    const moderation = await auditGenerationInputs(actor.ownerId, [preview.customPrompt,preview.editInstruction].filter(Boolean).join("\n"), providerAssets, async asset => getAssetBytes(providerAssets.find(entry => entry.id === asset.id)!));
    const result = await createQueuedJobIdempotently({
      id: `job_${crypto.randomUUID()}`,
      ownerId: actor.ownerId,
      sourceAssetId: selected.id,
      referenceAssetId: preview.referenceAssetId,
      additionalReferencesJson: JSON.stringify(additionalReferences),
      maskAssetId: preview.maskAssetId,
      depthAssetId: preview.depthAssetId,
      normalAssetId: preview.normalAssetId,
      workflowType: preview.workflowType,
      purpose: "final",
      sourceJobId: preview.id,
      promotedFromAssetId: selected.id,
      resolution,
      effectiveResolution: resolution,
      aspectRatio: preview.aspectRatio,
      quality,
      visualRealism: preview.visualRealism,
      lampState: preview.lampState,
      colorTemperatureKelvin: preview.colorTemperatureKelvin,
      spaceType: preview.spaceType,
      stylePresetId: preview.stylePresetId,
      designSchemeId: preview.designSchemeId,
      lightingPreset: preview.lightingPreset,
      preservationMode: preview.preservationMode,
      providerPreference,
      editInstruction: preview.editInstruction,
      customPrompt: preview.customPrompt,
      outputCount,
      advancedSettingsJson: preview.advancedSettingsJson,
      idempotencyKey,
      requestHash: await hashFinalize({ previewId, selectedOutputAssetId, resolution, quality, outputCount }),
      createdAt: now,
      updatedAt: now,
    }, generationBilling(price), priceExpectation, { ...activeVerifiedIdentityPolicy(bindings), ...moderation });
    if (!result.created && result.job.requestHash !== await hashFinalize({ previewId, selectedOutputAssetId, resolution, quality, outputCount })) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一个 idempotencyKey 不能用于不同的成品图请求。");
    await assertQueuedJobItemsConsistent(result.job);
    const response = jsonResponse({ job: serializeJob(result.job, result.created ? [] : await getJobOutputs(result.job.id, actor.ownerId)), persistence: getStorageMode(), idempotentReplay: !result.created }, { status: 202, headers: storageHeaders() });
    return attachActorCookie(response, actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}


async function hashFinalize(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
