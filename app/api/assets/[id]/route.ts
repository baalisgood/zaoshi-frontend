import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, requireString } from "@/lib/server/api";
import {
  getAsset,
  getAssetBytes,
  getStorageMode,
  storageHeaders,
} from "@/lib/server/persistence";
import { serializeAsset } from "@/lib/server/serializers";
import { safeFileName } from "@/lib/server/files";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { requestOwnedAssetDeletion } from "@/lib/server/asset-lifecycle";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);

  try {
    const { id } = await context.params;
    const asset = await getAsset(id, actor.ownerId);
    if (!asset) {
      throw new ApiError(404, "ASSET_NOT_FOUND", "没有找到这张图片。");
    }

    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const wantsContent =
      download ||
      url.searchParams.get("content") === "1" ||
      (request.headers.get("accept") ?? "").startsWith("image/");

    if (wantsContent) {
      const bytes = await getAssetBytes(asset);
      const headers = new Headers(storageHeaders());
      headers.set("Content-Type", asset.mimeType);
      headers.set("Content-Length", String(bytes.byteLength));
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
      if (download) {
        const extension = asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType === "image/webp" ? "webp" : "png";
        const downloadName = safeFileName(asset.originalFileName || `zaoshi-${asset.id}.${extension}`);
        headers.set("Content-Disposition", `attachment; filename="zaoshi-${asset.id}.${extension}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      }
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return attachActorCookie(new Response(body, { headers }), actor);
    }

    return attachActorCookie(
      jsonResponse(
        {
          asset: serializeAsset(asset),
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

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const actor = await getRuntimeRequestActor(request);
  try {
    assertSameOriginMutation(request);
    if (!actor.user.authenticated || actor.trusted !== true) throw new ApiError(401, "AUTH_REQUIRED", "请先完成登录。");
    const deleted = await requestOwnedAssetDeletion(actor.ownerId, (await context.params).id, { actionId: requireString(request.headers.get("idempotency-key"), "Idempotency-Key", { min: 8, max: 128 }), source: "USER_REQUEST", actorId: actor.ownerId });
    if (!deleted) throw new ApiError(404, "ASSET_NOT_FOUND", "没有找到这张图片。");
    return attachActorCookie(jsonResponse({ deleted: true, cleanupPending: true }), actor);
  } catch (error) {
    return attachActorCookie(errorResponse(error, crypto.randomUUID()), actor);
  }
}
