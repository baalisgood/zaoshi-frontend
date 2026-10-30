import { ensureDatabase, getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { ApiError, errorResponse, readJsonBody } from "@/lib/server/api";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { completeEmailAuth, createEmailCaptcha, EMAIL_ACTIONS, limitEmailAuth, resolveEmailAuthConfig, sendEmailCode, type EmailAction } from "@/lib/server/email-auth";

async function context(request: Request) {
  const bindings = readRuntimeBindings(), config = resolveEmailAuthConfig(bindings);
  if (!config) throw new ApiError(503, "EMAIL_AUTH_NOT_CONFIGURED", "邮箱登录尚未配置。");
  if (bindings.ZAOSHI_RUNTIME !== "node") throw new ApiError(503, "EMAIL_AUTH_NOT_CONFIGURED", "邮箱登录尚未配置。");
  const { emailAuthServices } = await import("@/lib/server/email-auth-services");
  const services = emailAuthServices(bindings);
  if (new URL(request.url).protocol !== "https:" || bindings.AUTH_TRUSTED_PROXY !== "1") throw new ApiError(503, "AUTH_PROXY_NOT_CONFIGURED", "登录安全入口尚未配置。");
  const ip = request.headers.get("x-real-ip");
  if (!ip || ip.length > 45 || !/^[a-fA-F0-9.:]+$/u.test(ip)) throw new ApiError(400, "AUTH_REQUEST_INVALID", "登录请求无效。");
  await ensureDatabase();
  const d1 = getD1Binding(); if (!d1) throw new ApiError(503, "AUTH_STORAGE_UNAVAILABLE", "登录服务暂时不可用。");
  await limitEmailAuth(d1, config, `ip:${ip}`, 120, 900);
  return { d1, config, services };
}
export async function GET(request: Request, route: { params: Promise<{ action: string }> }): Promise<Response> {
  try {
    if ((await route.params).action !== "captcha") throw new ApiError(404, "NOT_FOUND", "入口不存在。");
    const action = new URL(request.url).searchParams.get("purpose");
    if (!EMAIL_ACTIONS.includes(action as EmailAction)) throw new ApiError(400, "AUTH_REQUEST_INVALID", "验证码用途无效。");
    const { d1, config, services } = await context(request);
    return await createEmailCaptcha(request, action as EmailAction, d1, config, services);
  } catch (error) { return errorResponse(error, crypto.randomUUID()); }
}
export async function POST(request: Request, route: { params: Promise<{ action: string }> }): Promise<Response> {
  try {
    assertSameOriginMutation(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "AUTH_REQUEST_INVALID", "请求格式无效。");
    const action = (await route.params).action;
    if (!EMAIL_ACTIONS.includes(action as EmailAction)) throw new ApiError(404, "NOT_FOUND", "入口不存在。");
    const { d1, config, services } = await context(request), value = await readJsonBody(request, 4096);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "AUTH_REQUEST_INVALID", "请求格式无效。");
    if (action === "register-send" || action === "reset-send") return await sendEmailCode(request, action, value, d1, config, services);
    return await completeEmailAuth(request, action as "register" | "login" | "reset", value, d1, config);
  } catch (error) { return errorResponse(error, crypto.randomUUID()); }
}
