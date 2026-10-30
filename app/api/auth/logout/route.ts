import { resolveEmailAuthConfig } from "@/lib/server/email-auth";
import { clearSessionCookie, secretHash, SESSION_COOKIE } from "@/lib/server/auth-session";
import { readCookie } from "@/lib/server/actor";
import { ApiError, errorResponse } from "@/lib/server/api";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { readWechatAuthConfig, validateWechatAuthConfig, wechatAuthFailureResponse } from "@/lib/server/wechat-auth-config";
import { revokeWechatSession } from "@/lib/server/wechat-auth";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { resolvePrivateTestConfig, assertPrivateTestRequest } from "@/lib/server/private-test";

export async function POST(request: Request): Promise<Response> {
  const bindings = readRuntimeBindings();
  const privateTest = resolvePrivateTestConfig(bindings);
  if (bindings.AUTH_MODE === "private-test") {
    try {
      if (!privateTest) throw new ApiError(404, "NOT_FOUND", "私测入口未启用或已到期。");
      assertPrivateTestRequest(request, privateTest, true);
      return Response.json({ loggedOut: false }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return errorResponse(error, crypto.randomUUID()); }
  }
  if (bindings.AUTH_MODE === "email") {
    try {
      assertSameOriginMutation(request);
      const config = resolveEmailAuthConfig(bindings); if (!config) throw new ApiError(503, "EMAIL_AUTH_NOT_CONFIGURED", "邮箱登录尚未配置。");
      await ensureDatabase(); const d1 = getD1Binding(); if (!d1) throw new ApiError(503, "AUTH_STORAGE_UNAVAILABLE", "登录服务暂时不可用。");
      const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
      if (token) await d1.prepare("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE token_hash = ?").bind(secretHash(config.sessionSecret, token)).run();
      return Response.json({ loggedOut: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": clearSessionCookie() } });
    } catch (error) { return errorResponse(error, crypto.randomUUID()); }
  }
  const config = readWechatAuthConfig();
  if (!validateWechatAuthConfig(config)) return wechatAuthFailureResponse(config);
  try {
    assertSameOriginMutation(request);
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "AUTH_STORAGE_UNAVAILABLE", "登录服务暂时不可用。");
    return await revokeWechatSession(request, config, d1);
  } catch (error) {
    return errorResponse(error, crypto.randomUUID());
  }
}
import { ensureDatabase, getD1Binding } from "@/db";
