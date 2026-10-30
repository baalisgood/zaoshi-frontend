import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { resolveWechatAuthConfig, type WechatAuthConfig } from "./wechat-auth-config-core";
export type { AuthMode, WechatAuthConfig } from "./wechat-auth-config-core";
export { resolveWechatAuthConfig, validateWechatAuthConfig, wechatAuthStatus, wechatAuthFailureResponse } from "./wechat-auth-config-core";
export function readWechatAuthConfig(): WechatAuthConfig { return resolveWechatAuthConfig(readRuntimeBindings()); }
