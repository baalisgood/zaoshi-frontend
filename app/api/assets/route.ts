import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import { createHash } from "node:crypto";
import { assertDraftScope, attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requireEnum,
} from "@/lib/server/api";
import {
  MAX_UPLOAD_BODY_BYTES,
  readBoundedFormData,
  safeFileName,
  validateUploadedImage,
} from "@/lib/server/files";
import {
  createAsset,
  getAssetRecord,
  getAssetBytes,
  getStorageMode,
  listAssets,
  storageHeaders,
} from "@/lib/server/persistence";
import { serializeAsset } from "@/lib/server/serializers";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import { assertCostBearingActor, assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { readRuntimeImageSanitizer } from "@/lib/server/runtime-image-sanitizer";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { assertPrivateTestActor, assertPrivateTestRequest, resolvePrivateTestConfig } from "@/lib/server/private-test";

const uploadKinds = [
  "source",
  "reference",
  "mask",
  "depth",
  "normal",
  "floorplan",
] as const;
const assetKinds = [...uploadKinds, "output"] as const;
const assetScopes = ["today", "all"] as const;
const STAGING_RETENTION_SECONDS = 24 * 60 * 60;

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);

  try {
    const url = new URL(request.url);
    const scope = requireEnum(
      url.searchParams.get("scope") ?? "today",
      "scope",
      assetScopes,
    );
    const rawKind = url.searchParams.get("kind");
    const kind = rawKind ? requireEnum(rawKind, "kind", assetKinds) : undefined;
    const rawLimit = url.searchParams.get("limit") ?? "50";
    const limit = Number(rawLimit);
    if (!/^\d{1,3}$/u.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "limit 必须是1到100之间的整数。",
        { field: "limit", min: 1, max: 100 },
      );
    }

    const rows = await listAssets(actor.ownerId, { scope, kind, limit });
    return attachActorCookie(
      jsonResponse(
        {
          assets: rows.map(serializeAsset),
          scope,
          kind: kind ?? null,
          limit,
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
    assertCostBearingActor(actor, readAiEnvironment());
    await assertCurrentLegalConsent(actor);
    const bindings = readRuntimeBindings();
    const privateTest = resolvePrivateTestConfig(bindings);
    if (bindings.AUTH_MODE === "private-test") { assertPrivateTestRequest(request, privateTest, true); assertPrivateTestActor(actor); }
    assertDraftScope(request.headers.get("x-zaoshi-draft-scope"), actor);
    const sanitizer = readRuntimeImageSanitizer();
    const form = await readBoundedFormData(request, MAX_UPLOAD_BODY_BYTES);

    const fileValue = form.get("file");
    if (!(fileValue instanceof File)) {
      throw new ApiError(400, "FILE_REQUIRED", "file 字段必须是一张图片。");
    }
    const kind = requireEnum(form.get("kind"), "kind", uploadKinds);
    const validated = await validateUploadedImage(
      fileValue,
      sanitizer,
    );
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey && !/^[A-Za-z0-9:_.-]{8,128}$/u.test(idempotencyKey)) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "上传操作编号格式无效。");
    const id = idempotencyKey ? `asset_${createHash("sha256").update(`${actor.identityNamespace ?? actor.ownerId}\0${idempotencyKey}`).digest("hex")}` : `asset_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record = {
        id,
        ownerId: actor.ownerId,
        kind,
        originalFileName: safeFileName(fileValue.name),
        mimeType: validated.mimeType,
        byteSize: validated.bytes.byteLength,
        sha256: validated.sha256,
        sanitizationVersion: IMAGE_SANITIZATION_VERSION,
        storageKey: `uploads/${actor.ownerId}/${id}-${crypto.randomUUID()}-${validated.sha256.slice(0, 16)}.${validated.extension}`,
        createdAt,
        retentionExpiresAt: Math.floor(Date.now() / 1000) + STAGING_RETENTION_SECONDS,
      } as const;
    const sameUpload = async (rejectMismatch = false) => {
      const existing = await getAssetRecord(id, actor.ownerId);
      if (!existing) return null;
      if (existing.kind !== kind || existing.mimeType !== validated.mimeType || existing.byteSize !== validated.bytes.byteLength || existing.sha256 !== validated.sha256) {
        if (rejectMismatch) throw new ApiError(409, "UPLOAD_IDEMPOTENCY_CONFLICT", "同一个上传操作编号不能用于不同图片。");
        return null;
      }
      if (existing.status === "PENDING") throw new ApiError(409, "UPLOAD_IN_PROGRESS", "这次上传尚未完成，请稍后重试；如持续失败，请重新选择图片后提交。");
      if (existing.status !== "READY" || existing.moderationStatus === "REJECTED") throw new ApiError(410, "UPLOAD_IDEMPOTENCY_EXPIRED", "这次上传记录已失效，请重新提交。");
      try { await getAssetBytes(existing); }
      catch (error) {
        if (error instanceof ApiError && error.code === "ASSET_CONTENT_MISSING") throw new ApiError(410, "UPLOAD_IDEMPOTENCY_EXPIRED", "这次上传记录对应的图片已清理，请重新提交。");
        throw error;
      }
      return existing;
    };
    let asset = idempotencyKey ? await sameUpload(true) : null;
    let replay = Boolean(asset);
    if (!asset) {
      try { asset = await createAsset(record, validated.bytes); }
      catch (error) {
        // Only a verified READY winner can replace the original creation failure.
        try { asset = idempotencyKey ? await sameUpload(true) : null; }
        catch (recoveryError) {
          if (!(error instanceof ApiError) && recoveryError instanceof ApiError && ["UPLOAD_IDEMPOTENCY_CONFLICT", "UPLOAD_IN_PROGRESS"].includes(recoveryError.code)) throw recoveryError;
          throw error;
        }
        if (!asset) throw error;
        replay = true;
      }
    }

    const response = jsonResponse(
      {
        asset: serializeAsset(asset),
        persistence: getStorageMode(),
      },
      { status: replay ? 200 : 201, headers: storageHeaders() },
    );
    return attachActorCookie(response, actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
