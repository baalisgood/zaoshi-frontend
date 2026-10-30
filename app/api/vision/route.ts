import { getD1Binding } from "@/db";
import { runtimeModeration } from "@/lib/server/machine-moderation";
import { assertCurrentLegalConsent } from "@/lib/server/legal-consent";
import {
  generateVisionArtifacts,
  isAiServiceError,
  type VisionArtifactKind,
} from "@/lib/ai";
import { readAiEnvironment } from "@/lib/server/ai-environment";
import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requireJsonObject,
  requireString,
  readJsonBody,
} from "@/lib/server/api";
import { sanitizeGeneratedImage } from "@/lib/server/files";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import { readRuntimeImageSanitizer } from "@/lib/server/runtime-image-sanitizer";
import {
  createAsset,
  getAsset,
  getAssetBytes,
  getStorageMode,
  storageHeaders,
} from "@/lib/server/persistence";
import { serializeAsset } from "@/lib/server/serializers";
import { assertSameOriginMutation, assertVisionActor, assertVisionRuntime } from "@/lib/server/runtime-policy";

const allowedArtifacts = ["depth", "normal"] as const;

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);

  try {
    assertSameOriginMutation(request);
    const environment = readAiEnvironment();
    assertVisionActor(actor, environment);
    await assertCurrentLegalConsent(actor);
    assertVisionRuntime(environment);
    const sanitizer = readRuntimeImageSanitizer();
    let rawBody: unknown;
    try {
      rawBody = await readJsonBody(request, 8192);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "无法读取 JSON 请求正文。");
    }
    const body = requireJsonObject(rawBody);
    const sourceAssetId = requireString(
      body.sourceAssetId,
      "sourceAssetId",
      { max: 100 },
    );
    const requestedArtifacts = parseArtifacts(
      body.artifactTypes ?? body.artifacts,
    );
    const source = await getAsset(sourceAssetId, actor.ownerId);
    if (!source || (source.kind !== "source" && source.kind !== "output")) {
      throw new ApiError(
        404,
        "ASSET_NOT_FOUND",
        "没有找到可分析的现场图或生成结果。",
      );
    }
    if (source.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) {
      throw new ApiError(
        409,
        "ASSET_SANITIZATION_REQUIRED",
        "这张历史图片需要重新上传后才能生成结构参考。",
      );
    }
    if (source.moderationStatus === "REJECTED") {
      throw new ApiError(409, "ASSET_REJECTED", "这张图片不可用于生成结构参考。");
    }

    const d1=getD1Binding();if(!d1)throw new ApiError(503,"MODERATION_UNAVAILABLE","内容检查服务暂不可用。");
    const audit=await runtimeModeration(d1);await audit.asset(actor.ownerId,source.id,await getAssetBytes(source));
    const result = await generateVisionArtifacts(
      {
        sourceImage: {
          bytes: await getAssetBytes(source),
          mimeType: source.mimeType as "image/jpeg" | "image/png" | "image/webp",
          fileName: source.originalFileName,
        },
        artifacts: requestedArtifacts,
      },
      { env: readAiEnvironment() },
    );

    const validated = await Promise.all(
      result.artifacts.map(async (artifact) => ({
        artifact,
        image: await sanitizeGeneratedImage(
          artifact.bytes,
          artifact.mimeType,
          sanitizer,
        ),
      })),
    );
    const persisted = [];
    for (const { artifact, image } of validated) {
      const id = `asset_${crypto.randomUUID()}`;
      const asset = await createAsset(
        {
          id,
          ownerId: actor.ownerId,
          kind: artifact.kind,
          originalFileName: `${artifact.kind}-${source.id}.${image.extension}`,
          mimeType: image.mimeType,
          byteSize: image.bytes.byteLength,
          sha256: image.sha256,
          sanitizationVersion: IMAGE_SANITIZATION_VERSION,
          storageKey: `vision/${actor.ownerId}/${source.id}/${id}.${image.extension}`,
          parentAssetId: source.id,
          createdAt: new Date().toISOString(),
        },
        image.bytes,
      );
      persisted.push({
        artifactType: artifact.kind,
        asset: serializeAsset(asset),
        model: artifact.model ?? null,
        confidence: artifact.confidence ?? null,
      });
    }

    return attachActorCookie(
      jsonResponse(
        {
          requestId: result.requestId,
          provider: result.provider,
          artifacts: persisted,
          persistence: getStorageMode(),
        },
        { status: 201, headers: storageHeaders() },
      ),
      actor,
    );
  } catch (error) {
    const normalized = normalizeVisionError(error);
    return attachActorCookie(errorResponse(normalized, requestId), actor);
  }
}

function parseArtifacts(value: unknown): VisionArtifactKind[] {
  if (value === undefined) return [...allowedArtifacts];
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "artifactTypes 必须包含depth和/或normal。",
      { field: "artifactTypes" },
    );
  }
  const artifacts = value.map((kind) => {
    if (kind !== "depth" && kind !== "normal") {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "artifactTypes 仅支持depth和normal。",
        { field: "artifactTypes" },
      );
    }
    return kind;
  });
  if (new Set(artifacts).size !== artifacts.length) {
    throw new ApiError(400, "INVALID_FIELD", "artifactTypes 不能重复。", {
      field: "artifactTypes",
    });
  }
  return allowedArtifacts.filter((kind) => artifacts.includes(kind));
}

function normalizeVisionError(error: unknown): unknown {
  if (!isAiServiceError(error)) return error;
  const status =
    error.code === "NOT_CONFIGURED"
      ? 503
      : error.code === "INVALID_INPUT"
        ? 400
        : 502;
  return new ApiError(status, error.code, error.userMessage, {
    retryable: error.retryable,
  });
}
