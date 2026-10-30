import { invitationCode, registrationReferral } from "./referrals";
import { withUserIdRetry } from "./user-identity";
import { readLegalConsent } from "./legal-consent";
import { createHmac } from "node:crypto";
import type { RequestActor } from "./actor";
import { randomToken, readCookie, safeDisplayValue } from "./actor";
import { ApiError, jsonResponse } from "./api";
import type { WechatAuthConfig } from "./wechat-auth-config-core";
import { validateWechatAuthConfig } from "./wechat-auth-config-core";

import { resolveStoredSessionActor } from "./auth-session";
export { resolveStoredSessionActor } from "./auth-session";

const SESSION_COOKIE = "__Host-zaoshi_session";
const OAUTH_COOKIE = "__Host-zaoshi_oauth";
const OAUTH_TTL_SECONDS = 10 * 60;
const MAX_ACTIVE_OAUTH_STATES = 1_000;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const WECHAT_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WECHAT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";

type WechatToken = { accessToken: string; openId: string; unionId?: string };

export async function startWechatLogin(
  request: Request,
  config: WechatAuthConfig,
  d1: D1Database,
  intent: "login" | "bind" = "login",
  presentation: "redirect" | "embedded" = "redirect",
): Promise<Response> {
  assertConfigured(config);
  const bindingActor = intent === "bind" ? await resolveStoredSessionActor(request, config.sessionSecret, d1, SESSION_COOKIE, true) : null;
  if (intent === "bind" && !bindingActor) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先登录已有邮箱账户，再绑定微信。");
  const bindingSession = bindingActor ? secretHash(config.sessionSecret, readCookie(request.headers.get("cookie"), SESSION_COOKIE)!) : null;
  const state = randomToken();
  const existingNonce = readCookie(request.headers.get("cookie"), OAUTH_COOKIE);
  const browserNonce = existingNonce && /^[A-Za-z0-9_-]{43}$/u.test(existingNonce) ? existingNonce : randomToken();
  const now = Math.floor(Date.now() / 1000);
  const returnPath = normalizeReturnPath(new URL(request.url).searchParams.get("returnTo"));
  const stateHash = secretHash(config.sessionSecret, state);
  const nonceHash = secretHash(config.sessionSecret, browserNonce);
  await d1.batch([
    d1.prepare("DELETE FROM auth_oauth_states WHERE expires_at < ?").bind(now),
    d1.prepare("DELETE FROM auth_oauth_states WHERE browser_nonce_hash = ? AND consumed_at IS NULL").bind(nonceHash),
    d1.prepare(
      `INSERT INTO auth_oauth_states
        (state_hash, browser_nonce_hash, return_path, expires_at, intent, target_owner_id, initiating_session_hash, invite_code)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM auth_oauth_states WHERE consumed_at IS NULL AND expires_at >= ?) < ?`,
    ).bind(
      stateHash,
      nonceHash,
      returnPath,
      now + OAUTH_TTL_SECONDS,
      intent, bindingActor?.ownerId ?? null, bindingSession, intent === "login" ? invitationCode(new URL(request.url).searchParams.get("invite")) : null,
      now,
      MAX_ACTIVE_OAUTH_STATES,
    ),
  ]);
  if (!await d1.prepare("SELECT 1 AS present FROM auth_oauth_states WHERE state_hash = ?").bind(stateHash).first()) {
    throw new ApiError(429, "AUTH_RATE_LIMITED", "扫码登录请求过多，请稍后再试。");
  }
  if (presentation === "embedded") return jsonResponse({
    appid: config.appId, scope: "snsapi_login", redirect_uri: config.redirectUri,
    state, expiresAt: (now + OAUTH_TTL_SECONDS) * 1000,
  }, { headers: { "Set-Cookie": oauthCookie(browserNonce) } });
  const target = new URL(WECHAT_AUTHORIZE_URL);
  target.searchParams.set("appid", config.appId);
  target.searchParams.set("redirect_uri", config.redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "snsapi_login");
  target.searchParams.set("state", state);
  target.hash = "wechat_redirect";
  return redirectResponse(target, oauthCookie(browserNonce));
}

export async function completeWechatLogin(
  request: Request,
  config: WechatAuthConfig,
  d1: D1Database,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  assertConfigured(config);
  const url = new URL(request.url);
  const state = boundedParameter(url.searchParams.get("state"), "state", 128);
  const code = boundedParameter(url.searchParams.get("code"), "code", 512);
  const browserNonce = readCookie(request.headers.get("cookie"), OAUTH_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !browserNonce || !/^[A-Za-z0-9_-]{43}$/u.test(browserNonce)) {
    throw new ApiError(400, "OAUTH_STATE_INVALID", "登录状态无效，请重新扫码。");
  }
  const now = Math.floor(Date.now() / 1000);
  const consumed = await d1.prepare(
    `UPDATE auth_oauth_states
     SET consumed_at = ?
     WHERE state_hash = ? AND browser_nonce_hash = ?
       AND consumed_at IS NULL AND expires_at >= ?
     RETURNING return_path, intent, target_owner_id, initiating_session_hash, invite_code`,
  ).bind(
    now,
    secretHash(config.sessionSecret, state),
    secretHash(config.sessionSecret, browserNonce),
    now,
  ).first<{ return_path: string; intent: "login" | "bind"; target_owner_id: string | null; initiating_session_hash: string | null; invite_code: string | null }>();
  if (!consumed) {
    throw new ApiError(400, "OAUTH_STATE_INVALID", "登录状态已失效，请重新扫码。");
  }

  const currentSession = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (consumed.intent === "bind") {
    if (!currentSession || secretHash(config.sessionSecret, currentSession) !== consumed.initiating_session_hash) throw new ApiError(401, "BINDING_SESSION_CHANGED", "登录状态已变化，请重新登录邮箱账户后绑定。");
    const actor = await resolveStoredSessionActor(request, config.sessionSecret, d1, SESSION_COOKIE, true);
    if (!actor || actor.ownerId !== consumed.target_owner_id) throw new ApiError(401, "BINDING_SESSION_CHANGED", "登录状态已变化，请重新绑定。");
  }
  const token = await exchangeCode(config, code, fetcher);
  const profile = await fetchWechatProfile(token, fetcher);
  const subjectHash = secretHash(config.identityPepper, `${config.appId}:${token.openId}`);
  const unionId = profile.unionId ?? token.unionId;
  const unionHash = unionId ? secretHash(config.identityPepper, unionId) : null;

  if (consumed.intent === "bind") {
    const activeSession = "EXISTS (SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN auth_email_credentials c ON c.user_id=u.id AND c.verified_at IS NOT NULL WHERE s.token_hash=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='ACTIVE')";
    await d1.prepare(`INSERT INTO auth_identities (id,user_id,provider,provider_app_id,subject_hash,union_hash)
      SELECT ?,?,'wechat',?,?,? WHERE (${activeSession}) ON CONFLICT(provider,provider_app_id,subject_hash) DO NOTHING`)
      .bind(`identity_${subjectHash}`,consumed.target_owner_id,config.appId,subjectHash,unionHash,consumed.initiating_session_hash,consumed.target_owner_id,Math.floor(Date.now()/1000)).run();
    const bound = await d1.prepare(`SELECT user_id FROM auth_identities WHERE provider='wechat' AND provider_app_id=? AND subject_hash=? AND (${activeSession})`)
      .bind(config.appId,subjectHash,consumed.initiating_session_hash,consumed.target_owner_id,Math.floor(Date.now()/1000)).first<{user_id:string}>();
    if (!bound) throw new ApiError(401,"BINDING_SESSION_CHANGED","登录状态已变化，请重新绑定。");
    if (bound.user_id !== consumed.target_owner_id) throw new ApiError(409,"WECHAT_ALREADY_BOUND","该微信已属于其他账户，无法绑定；账户和积分未合并。");
    return new Response(null,{status:303,headers:{Location:new URL("/profile?wechat=bound",config.redirectUri).toString(),"Cache-Control":"no-store","Set-Cookie":clearOauthCookie()}});
  }
  const identityId = `identity_${subjectHash}`;
  const sessionToken = randomToken();
  const sessionHash = secretHash(config.sessionSecret, sessionToken);
  const displayName = safeDisplayValue(profile.nickname, 120) ?? "微信用户";
  const oldSession = readCookie(request.headers.get("cookie"), SESSION_COOKIE);

  await withUserIdRetry(async (candidateId) => {
  const mapped = await d1.prepare("SELECT user_id FROM auth_identities WHERE provider='wechat' AND provider_app_id=? AND subject_hash=?").bind(config.appId, subjectHash).first<{ user_id: string }>();
  const userId = mapped?.user_id ?? candidateId;
  const statements = [
    d1.prepare(
      `INSERT INTO users (id, display_name, wechat_registration_receipt)
       SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM auth_identities WHERE provider='wechat' AND provider_app_id=? AND subject_hash=?)`,
    ).bind(userId, displayName, secretHash(config.sessionSecret, state), config.appId, subjectHash),
    d1.prepare(
      `INSERT INTO auth_identities
        (id, user_id, provider, provider_app_id, subject_hash, union_hash)
       SELECT ?, ?, 'wechat', ?, ?, ? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)
       ON CONFLICT(provider, provider_app_id, subject_hash) DO UPDATE SET
         union_hash = COALESCE(auth_identities.union_hash, excluded.union_hash),
         updated_at = unixepoch()`,
    ).bind(identityId, userId, config.appId, subjectHash, unionHash, userId),
    d1.prepare("UPDATE users SET display_name=?, updated_at=unixepoch() WHERE NOT EXISTS(SELECT 1 FROM auth_email_credentials WHERE user_id=users.id) AND id IN(SELECT user_id FROM auth_identities WHERE provider='wechat' AND provider_app_id=? AND subject_hash=?)").bind(displayName, config.appId, subjectHash),
    d1.prepare(
      `INSERT INTO user_generation_limits (owner_id,active_concurrency_limit)
       SELECT user_id,3 FROM auth_identities WHERE provider='wechat' AND provider_app_id=? AND subject_hash=? ON CONFLICT(owner_id) DO NOTHING`,
    ).bind(config.appId, subjectHash),
    d1.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at)
       SELECT ?, identity.user_id, ?, ?
       FROM auth_identities AS identity
       JOIN users AS account ON account.id = identity.user_id
       WHERE identity.provider = 'wechat' AND identity.provider_app_id = ?
         AND identity.subject_hash = ? AND account.status = 'ACTIVE'`,
    ).bind(sessionHash, now + SESSION_TTL_SECONDS, now, config.appId, subjectHash),
  ];
  statements.push(registrationReferral(d1, userId, consumed.invite_code, "wechat", secretHash(config.sessionSecret, state)));
  if (oldSession) {
    statements.push(
      d1.prepare(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
      ).bind(now, secretHash(config.sessionSecret, oldSession)),
    );
  }
  await d1.batch(statements);
  });
  const created = await d1.prepare(
    "SELECT user_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(sessionHash).first<{ user_id: string }>();
  if (!created) throw new ApiError(403, "ACCOUNT_DISABLED", "当前账户暂时无法登录。");

  const headers = new Headers({
    Location: new URL(await readLegalConsent(d1, created.user_id) ? consumed.return_path : `/consent?returnTo=${encodeURIComponent(consumed.return_path)}`, config.redirectUri).toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", sessionCookie(sessionToken));
  headers.append("Set-Cookie", clearOauthCookie());
  return new Response(null, { status: 303, headers });
}

export async function resolveWechatSessionActor(
  request: Request,
  config: WechatAuthConfig,
  d1: D1Database,
): Promise<RequestActor | null> {
  if (!validateWechatAuthConfig(config)) return null;
  return resolveStoredSessionActor(request, config.sessionSecret!, d1, SESSION_COOKIE);
}

export async function revokeWechatSession(
  request: Request,
  config: WechatAuthConfig,
  d1: D1Database,
): Promise<Response> {
  assertConfigured(config);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) {
    await d1.prepare(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE token_hash = ?",
    ).bind(secretHash(config.sessionSecret, token)).run();
  }
  return Response.json({ loggedOut: true }, {
    headers: { "Cache-Control": "no-store", "Set-Cookie": clearSessionCookie() },
  });
}

export function clearOauthCookie(): string {
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function assertConfigured(config: WechatAuthConfig): asserts config is Required<WechatAuthConfig> {
  if (!validateWechatAuthConfig(config)) {
    throw new ApiError(503, "WECHAT_AUTH_NOT_CONFIGURED", "微信登录尚未配置。");
  }
}

async function exchangeCode(config: Required<WechatAuthConfig>, code: string, fetcher: typeof fetch): Promise<WechatToken> {
  const url = new URL(WECHAT_TOKEN_URL);
  url.searchParams.set("appid", config.appId);
  url.searchParams.set("secret", config.secret);
  url.searchParams.set("code", code);
  url.searchParams.set("grant_type", "authorization_code");
  const value = await providerJson(url, fetcher);
  const accessToken = stringField(value, "access_token", 2048);
  const openId = stringField(value, "openid", 256);
  if (!accessToken || !openId) throw providerFailure(value);
  return { accessToken, openId, ...(stringField(value, "unionid", 256) ? { unionId: stringField(value, "unionid", 256)! } : {}) };
}

async function fetchWechatProfile(token: WechatToken, fetcher: typeof fetch): Promise<{ nickname: string | null; unionId?: string }> {
  const url = new URL(WECHAT_USERINFO_URL);
  url.searchParams.set("access_token", token.accessToken);
  url.searchParams.set("openid", token.openId);
  url.searchParams.set("lang", "zh_CN");
  const value = await providerJson(url, fetcher);
  if (typeof value.errcode === "number" && value.errcode !== 0) throw providerFailure(value);
  const unionId = stringField(value, "unionid", 256);
  return { nickname: stringField(value, "nickname", 120), ...(unionId ? { unionId } : {}) };
}

async function providerJson(url: URL, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new ApiError(502, "WECHAT_PROVIDER_UNAVAILABLE", "微信登录服务暂时不可用，请重新扫码。");
    return await readBoundedJson(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "WECHAT_PROVIDER_UNAVAILABLE", "微信登录服务暂时不可用，请重新扫码。");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_PROVIDER_BODY_BYTES) throw new ApiError(502, "WECHAT_PROVIDER_INVALID", "微信登录响应无效，请重新扫码。");
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, "WECHAT_PROVIDER_INVALID", "微信登录响应无效，请重新扫码。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_PROVIDER_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(502, "WECHAT_PROVIDER_INVALID", "微信登录响应无效，请重新扫码。");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(502, "WECHAT_PROVIDER_INVALID", "微信登录响应无效，请重新扫码。");
  }
}

function providerFailure(value: Record<string, unknown>): ApiError {
  const code = typeof value.errcode === "number" ? value.errcode : undefined;
  return new ApiError(400, "WECHAT_LOGIN_REJECTED", "微信授权未完成，请重新扫码。", code === undefined ? undefined : { providerCode: code });
}

function stringField(value: Record<string, unknown>, name: string, max: number): string | null {
  const field = value[name];
  if (typeof field !== "string" || field.length < 1 || field.length > max) return null;
  return field;
}

function boundedParameter(value: string | null, name: string, max: number): string {
  if (!value || value.length > max || hasControlCharacter(value)) {
    throw new ApiError(400, "OAUTH_CALLBACK_INVALID", `微信登录回调缺少有效${name}。`);
  }
  return value;
}

function normalizeReturnPath(value: string | null): string {
  if (!value) return "/profile";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.startsWith("/api/") || value.length > 512 || hasControlCharacter(value)) return "/profile";
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value, (character) => character.charCodeAt(0)).some((code) => code < 32 || code === 127);
}

function secretHash(secret: string | undefined, value: string): string {
  if (!secret) throw new ApiError(503, "WECHAT_AUTH_NOT_CONFIGURED", "微信登录尚未配置。");
  return createHmac("sha256", secret).update(value).digest("hex");
}

function oauthCookie(value: string): string {
  return `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_TTL_SECONDS}`;
}

function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function redirectResponse(target: URL, cookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
