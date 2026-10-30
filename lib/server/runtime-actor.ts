import { resolveEmailAuthConfig } from "./email-auth";
import { resolveStoredSessionActor, SESSION_COOKIE } from "./auth-session";
import { getD1Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { getRequestActor, type RequestActor } from "./actor";
import { resolveWechatAuthConfig, validateWechatAuthConfig } from "./wechat-auth-config-core";
import { resolveWechatSessionActor } from "./wechat-auth";
import { getPrivateTestActor, resolvePrivateTestConfig } from "./private-test";

/** Runtime seam: only a trusted hosting adapter may enable platform identity headers. */
export async function getRuntimeRequestActor(request: Request): Promise<RequestActor> {
  const bindings = readRuntimeBindings();
  const d1 = getD1Binding();
  const privateTest = resolvePrivateTestConfig(bindings);
  if (bindings.AUTH_MODE === "private-test") {
    const actor = privateTest && d1 ? await getPrivateTestActor(request, privateTest, d1) : null;
    return actor ?? getRequestActor(request, false);
  }
  if (bindings.AUTH_MODE === "email") {
    const config = resolveEmailAuthConfig(bindings);
    const wechat = resolveWechatAuthConfig(bindings);
    const actor = config && d1 ? await resolveStoredSessionActor(request, config.sessionSecret, d1, SESSION_COOKIE, validateWechatAuthConfig(wechat) ? { wechatAppId: wechat.appId! } : true) : null;
    return actor ?? getRequestActor(request, false);
  }
  if (bindings.TRUST_PLATFORM_IDENTITY_HEADERS === "1" && request.headers.get("oai-authenticated-user-id")) {
    return getRequestActor(request, true);
  }
  const config = resolveWechatAuthConfig(bindings);
  if (config.mode === "wechat" && d1) {
    const actor = await resolveWechatSessionActor(request, config, d1);
    if (actor) return actor;
  }
  return getRequestActor(request, false);
}
