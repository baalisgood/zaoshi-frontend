import { userEditInstruction } from "@/lib/domain/bare-shell";
import { activeVerifiedIdentityPolicy } from "@/lib/server/wechat-auth-config-core";
import { auditGenerationInputs } from "@/lib/server/machine-moderation";
import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import { isOverseasImageModel } from "@/lib/domain/image-models";
import { readImageMetadata } from "@/lib/ai/image-metadata";
import type { ImageMimeType } from "@/lib/ai/types";
import { getStylePreset } from "@/lib/ai";
import { assertDraftScope, attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  readJsonBody,
} from "@/lib/server/api";
import {
  assertAssetKind,
  parseCreateJobInput,
  referenceAssetKindsForWorkflow,
  sourceAssetKindsForWorkflow,
  isCompatibleReplayHash,
  workflowTypes,
  type WorkflowType,
} from "@/lib/server/job-contract";
import {
  assertQueuedJobItemsConsistent,
  createQueuedJobIdempotently,
  getJobByIdempotencyKey,
  getAsset,
  getAssetBytes,
  getJobOutputs,
  listJobsWithOutputs,
  getStorageMode,
  storageHeaders,
} from "@/lib/server/persistence";
import { serializeJob } from "@/lib/server/serializers";
import { assertCostBearingActor, assertDomesticGenerationParameters, assertGenerationRuntime, assertSameOriginMutation, assertDomesticGenerationQueueReady, assertPublicImageGenerationActor, validateDomesticInputAssetsForProvider } from "@/lib/server/runtime-policy";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import { generationBilling, quoteGenerationPrice, readGenerationPriceExpectation } from "@/lib/server/generation-pricing";
import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { assertPrivateTestJob, assertPrivateTestRequest, resolvePrivateTestConfig } from "@/lib/server/private-test";

type JobCursor = { createdAt: string; id: string };

function decodeCursor(value: string | null): JobCursor | undefined {
  if (!value) return undefined;
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid cursor");
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.createdAt !== "string" ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      typeof cursor.id !== "string" ||
      cursor.id.length < 1 ||
      cursor.id.length > 128
    ) throw new Error("invalid cursor");
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "任务列表分页参数无效。");
  }
}

function encodeCursor(cursor: JobCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);
  try {
    const url = new URL(request.url);
    const rawWorkflow = url.searchParams.get("workflowType") ?? "concept";
    if (!workflowTypes.includes(rawWorkflow as WorkflowType)) {
      throw new ApiError(400, "INVALID_WORKFLOW", "任务工作台类型无效。");
    }
    const rawLimit = url.searchParams.get("limit") ?? "20";
    if (!/^\d{1,2}$/u.test(rawLimit)) {
      throw new ApiError(400, "INVALID_LIMIT", "任务列表数量无效。");
    }
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 50) {
      throw new ApiError(400, "INVALID_LIMIT", "任务列表每页数量必须在 1 到 50 之间。");
    }
    const result = await listJobsWithOutputs(actor.ownerId, {
      workflowType: rawWorkflow as WorkflowType,
      limit,
      cursor: decodeCursor(url.searchParams.get("cursor")),
    });
    const last = result.items.at(-1)?.job;
    return attachActorCookie(
      jsonResponse(
        {
          jobs: result.items.map(({ job, outputs }) => serializeJob(job, outputs)),
          nextCursor: result.hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
          persistence: getStorageMode(),
        },
        { headers: storageHeaders() },
      ),
      actor,
    );
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);

  try {
    assertSameOriginMutation(request);
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(request);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "无法读取 JSON 请求正文。");
    }
    const input = parseCreateJobInput(rawBody);
    assertDraftScope((rawBody as Record<string, unknown>).draftScope, actor);
    const environment = readAiEnvironment();
    const bindings = readRuntimeBindings();
    const privateTestMode = bindings.AUTH_MODE === "private-test";
    const privateTest = resolvePrivateTestConfig(bindings);
    assertCostBearingActor(actor, environment);
    if (privateTestMode) { assertPrivateTestRequest(request, privateTest, true); assertPrivateTestJob(actor, input); }
    const prior = await getJobByIdempotencyKey(actor.ownerId, input.idempotencyKey);
    if (prior) {
      if (!isCompatibleReplayHash(input, prior.requestHash)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求编号不能用于不同参数。");
      await assertQueuedJobItemsConsistent(prior);
      return attachActorCookie(jsonResponse({ job: serializeJob(prior, await getJobOutputs(prior.id, actor.ownerId)), persistence: getStorageMode(), idempotentReplay: true }, { status: 202, headers: storageHeaders() }), actor);
    }
    if (!privateTestMode && isOverseasImageModel(input.providerPreference)) throw new ApiError(403, "OVERSEAS_MODEL_UNAVAILABLE", "海外模型暂不对公众开放，请选择国内模型。");
    await assertCurrentLegalConsent(actor);
    if (privateTestMode) {
      await ensureDatabase();
      const d1 = getD1Binding();
      if (!d1) throw new ApiError(503, "QUEUE_REQUIRES_D1", "付费私测需要持久数据库。");
    } else {
      assertDomesticGenerationQueueReady(input.providerPreference, environment);
      assertPublicImageGenerationActor(actor, environment);
      assertGenerationRuntime(input.providerPreference, environment);
    }
    assertDomesticGenerationParameters(input.providerPreference, input.effectiveResolution, Boolean(input.maskAssetId));

    // Resolve again here so a style removed between parsing and persistence
    // can never create an unprocessable job.
    if (input.workflowType === "concept" && !getStylePreset(input.stylePresetId)) {
      throw new ApiError(400, "UNKNOWN_STYLE", "所选设计风格不存在。");
    }

    const source = input.sourceAssetId ? await getAsset(input.sourceAssetId, actor.ownerId) : null;
    if (input.workflowType !== "self-service" || input.sourceAssetId) assertAssetKind(source, sourceAssetKindsForWorkflow(input.workflowType, Boolean(input.maskAssetId), "preview"), "sourceAssetId");
    const providerAssets = source ? [source] : [];
    if (input.referenceAssetId) {
      const reference = await getAsset(input.referenceAssetId, actor.ownerId);
      assertAssetKind(
        reference,
        referenceAssetKindsForWorkflow(input.workflowType),
        "referenceAssetId",
      );
      providerAssets.push(reference);
    }
    for (const [index, entry] of input.additionalReferences.entries()) {
      const reference = await getAsset(entry.assetId, actor.ownerId);
      assertAssetKind(reference, "reference", `additionalReferences[${index}].assetId`);
      providerAssets.push(reference);
    }
    if (input.maskAssetId) {
      const mask = await getAsset(input.maskAssetId, actor.ownerId);
      assertAssetKind(mask, "mask", "maskAssetId");
    }
    if (input.depthAssetId) {
      const depth = await getAsset(input.depthAssetId, actor.ownerId);
      assertAssetKind(depth, "depth", "depthAssetId");
      providerAssets.push(depth);
    }
    if (input.normalAssetId) {
      const normal = await getAsset(input.normalAssetId, actor.ownerId);
      assertAssetKind(normal, "normal", "normalAssetId");
      providerAssets.push(normal);
    }
    await validateDomesticInputAssetsForProvider(input.providerPreference, providerAssets, getAssetBytes);
    const selectionId = input.additionalReferences.find((entry) => entry.role === "selection")?.assetId;
    if (selectionId) {
      const annotation = providerAssets.find((asset) => asset.id === selectionId)!;
      if (!source) throw new ApiError(400, "LOCAL_EDIT_DIMENSIONS", "局部修改缺少原图。");
      const baseSize = readImageMetadata({ bytes: await getAssetBytes(source), mimeType: source.mimeType as ImageMimeType });
      const markedSize = readImageMetadata({ bytes: await getAssetBytes(annotation), mimeType: annotation.mimeType as ImageMimeType });
      if (![baseSize.width, baseSize.height, markedSize.width, markedSize.height].every((value) => Number.isInteger(value) && Number(value) > 0) || baseSize.width !== markedSize.width || baseSize.height !== markedSize.height) throw new ApiError(400, "LOCAL_EDIT_DIMENSIONS", "标注图与局部编辑原图尺寸无效或不一致，请重新保存选区。");
    }
    const moderation = await auditGenerationInputs(actor.ownerId, [input.customPrompt, userEditInstruction(input.editInstruction)].filter(Boolean).join("\n"), providerAssets, async asset => getAssetBytes(providerAssets.find(entry => entry.id === asset.id)!));
    const price = quoteGenerationPrice({ modelId: input.providerPreference, purpose: input.purpose, requestedResolution: input.resolution, inputImageCount: providerAssets.length, outputCount: input.outputCount, quality: input.quality, aspectRatio: input.aspectRatio }, privateTestMode && privateTest ? { privateTest: { config: privateTest, actor } } : { production: true });
    const priceExpectation = readGenerationPriceExpectation(rawBody);
    const billing = generationBilling(price);

    const now = new Date().toISOString();
    const result = await createQueuedJobIdempotently({
      id: `job_${crypto.randomUUID()}`,
      ownerId: actor.ownerId,
      sourceAssetId: input.sourceAssetId,
      referenceAssetId: input.referenceAssetId,
      additionalReferencesJson: JSON.stringify(input.additionalReferences),
      maskAssetId: input.maskAssetId,
      depthAssetId: input.depthAssetId,
      normalAssetId: input.normalAssetId,
      workflowType: input.workflowType,
      purpose: input.purpose,
      effectiveResolution: input.effectiveResolution,
      sourceJobId: null,
      promotedFromAssetId: null,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      visualRealism: input.visualRealism,
      lampState: input.lampState,
      colorTemperatureKelvin: input.colorTemperatureKelvin,
      spaceType: input.spaceType,
      stylePresetId: input.stylePresetId,
      designSchemeId: input.designSchemeId,
      lightingPreset: input.lightingPreset,
      preservationMode: input.preservationMode,
      providerPreference: input.providerPreference,
      editInstruction: input.editInstruction,
      customPrompt: input.customPrompt,
      outputCount: input.outputCount,
      advancedSettingsJson: JSON.stringify(input.advancedSettings),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAt: now,
      updatedAt: now,
    }, billing, priceExpectation, privateTest ? { ...moderation, maxAttempts: 1, privateTestAutoCredit: true, privateTestDailyUnlimited: true, allowPrivateTestOverseas: true } : { ...activeVerifiedIdentityPolicy(bindings), ...moderation });

    const compatibleLegacyReplay = !result.created && isCompatibleReplayHash(input, result.job.requestHash);
    if (!result.created && result.job.requestHash !== input.requestHash && !compatibleLegacyReplay) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "同一个 idempotencyKey 不能用于不同的生成请求。",
      );
    }
    await assertQueuedJobItemsConsistent(result.job);
    // Return the accepted snapshot without an extra output read. The task list
    // polling endpoint is authoritative once the independent consumer starts.
    const outputs = result.created
      ? []
      : await getJobOutputs(result.job.id, actor.ownerId);
    const response = jsonResponse(
      {
        job: serializeJob(result.job, outputs),
        persistence: getStorageMode(),
        idempotentReplay: !result.created,
      },
      { status: 202, headers: storageHeaders() },
    );
    return attachActorCookie(response, actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
