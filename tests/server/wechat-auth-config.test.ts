import assert from "node:assert/strict";
import test from "node:test";
import { validateWechatAuthConfig, resolveWechatAuthConfig, wechatAuthStatus, wechatAuthFailureResponse } from "../../lib/server/wechat-auth-config-core";

const SECRET = "s".repeat(32);
const PEPPER = "p".repeat(32);
const base = { mode: "wechat" as const, appId: "a", secret: SECRET, sessionSecret: SECRET, identityPepper: PEPPER };

test("wechat config requires strong independent secrets and a strict HTTPS redirect", () => {
  assert.equal(validateWechatAuthConfig({ ...base, redirectUri: "https://example.test/callback" }), true);
  assert.equal(validateWechatAuthConfig({ ...base, sessionSecret: "short", redirectUri: "https://example.test/callback" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, identityPepper: "short", redirectUri: "https://example.test/callback" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, identityPepper: SECRET, redirectUri: "https://example.test/callback" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, redirectUri: "http://example.test/callback" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, redirectUri: "https://u:p@example.test/callback" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, redirectUri: "https://example.test/callback?x=1" }), false);
  assert.equal(validateWechatAuthConfig({ ...base, redirectUri: "https://example.test/callback#x" }), false);
});

test("wechat status is fail-closed until every binding is valid", () => {
  assert.deepEqual(wechatAuthStatus(resolveWechatAuthConfig({ AUTH_MODE: "demo" })), { code: "AUTH_DISABLED", message: "演示环境未启用真实登录。" });
  assert.deepEqual(wechatAuthStatus(resolveWechatAuthConfig({ AUTH_MODE: "wechat", WECHAT_OPEN_APP_ID: " a ", WECHAT_OPEN_SECRET: ` ${SECRET} `, WECHAT_OPEN_REDIRECT_URI: " https://example.test/callback ", SESSION_SECRET: ` ${SECRET} `, AUTH_IDENTITY_PEPPER: ` ${PEPPER} ` })), { code: "WECHAT_AUTH_READY", message: "微信登录已配置。" });
  assert.equal(wechatAuthStatus(resolveWechatAuthConfig({ AUTH_MODE: "wechat" })).code, "WECHAT_AUTH_NOT_CONFIGURED");
});

test("wechat disabled responses expose safe headers and never redirect or set cookies", async () => {
  for (const [config, expected] of [[resolveWechatAuthConfig({ AUTH_MODE: "demo" }), "AUTH_DISABLED"], [resolveWechatAuthConfig({ AUTH_MODE: "wechat" }), "WECHAT_AUTH_NOT_CONFIGURED"]] as const) {
    const response = wechatAuthFailureResponse(config);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.ok(response.headers.get("content-security-policy"));
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal((await response.json() as { error: { code: string } }).error.code, expected);
  }
});
