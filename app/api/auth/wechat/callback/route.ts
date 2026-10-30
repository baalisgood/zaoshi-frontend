import { ensureDatabase, getD1Binding } from "@/db";
import { ApiError } from "@/lib/server/api";
import { readWechatAuthConfig, validateWechatAuthConfig, wechatAuthFailureResponse } from "@/lib/server/wechat-auth-config";
import { clearOauthCookie, completeWechatLogin } from "@/lib/server/wechat-auth";

export async function GET(request: Request): Promise<Response> {
  const config = readWechatAuthConfig();
  if (!validateWechatAuthConfig(config)) return wechatAuthFailureResponse(config);
  try {
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) throw new ApiError(503, "AUTH_STORAGE_UNAVAILABLE", "登录服务暂时不可用。");
    return await completeWechatLogin(request, config, d1);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "WECHAT_LOGIN_FAILED";
    const reason = code === "WECHAT_ALREADY_BOUND" ? "conflict" : code === "BINDING_SESSION_CHANGED" ? "session" : "failed";
    console.error(JSON.stringify({event:"wechat_login_callback_failed",reason,requestId:crypto.randomUUID()}));
    const headers = new Headers({ Location: new URL(`/login?wechat=${reason}`, config.redirectUri).toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    headers.append("Set-Cookie", clearOauthCookie());
    return new Response(null, { status:303, headers });
  }
}
