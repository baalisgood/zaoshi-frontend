import { registrationReferral } from "./referrals";
import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api";
import { withUserIdRetry } from "./user-identity";
import { readCookie, randomToken } from "./actor";
import { secretHash, sessionCookie, SESSION_TTL_SECONDS } from "./auth-session";

let activeDerivations = 0;
async function derive(value: string, salt: string): Promise<Buffer> {
  if (activeDerivations >= 2) throw new ApiError(429, "AUTH_BUSY", "登录请求较多，请稍后重试。");
  activeDerivations += 1;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))); }
  finally { activeDerivations -= 1; }
}
const BROWSER_COOKIE = "__Host-zaoshi_auth";
export const EMAIL_ACTIONS = ["register-send", "reset-send", "register", "login", "reset"] as const;
export type EmailAction = typeof EMAIL_ACTIONS[number];
export type EmailAuthConfig = { sessionSecret: string; identityPepper: string };
export type EmailAuthServices = { captcha: (answer: string) => string; send: (email: string, code: string) => Promise<void> };
import { assertLegalInput, consentStatements } from "./legal-consent";
type Input = { inviteCode?: unknown; legal?: unknown; email?: unknown; password?: unknown; captchaId?: unknown; captchaAnswer?: unknown; challengeId?: unknown; code?: unknown };

export function resolveEmailAuthConfig(bindings: Record<string, unknown>): EmailAuthConfig | null {
  const sessionSecret = bindings.SESSION_SECRET, identityPepper = bindings.AUTH_IDENTITY_PEPPER;
  return bindings.AUTH_MODE === "email" && typeof sessionSecret === "string" && sessionSecret.length >= 32 && typeof identityPepper === "string" && identityPepper.length >= 32 && sessionSecret !== identityPepper ? { sessionSecret, identityPepper } : null;
}
function invalid(): ApiError { return new ApiError(400, "AUTH_INVALID", "邮箱、密码或验证码无效，请检查后重试。"); }
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(email)) throw invalid();
  return email;
}
function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 512) throw invalid();
  return value;
}
export async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password(value), salt);
  return `scrypt:32768:8:1:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(value: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (!/^scrypt:32768:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/u.test(stored)) return false;
  const key = await derive(value, parts[4]);
  return timingSafeEqual(key, Buffer.from(parts[5], "hex"));
}
function browser(request: Request): string {
  const value = readCookie(request.headers.get("cookie"), BROWSER_COOKIE);
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw invalid();
  return value;
}
function answerHash(config: EmailAuthConfig, id: string, purpose: string, answer: unknown): string {
  const text = typeof answer === "string" && /^\d{6}$/u.test(answer) ? answer : "invalid";
  return secretHash(config.sessionSecret, `${id}:${purpose}:${text}`);
}
export async function limitEmailAuth(d1: D1Database, config: EmailAuthConfig, key: string, maximum: number, seconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000), bucket = secretHash(config.identityPepper, `${key}:${Math.floor(now / seconds)}`);
  const row = await d1.prepare(`INSERT INTO auth_email_rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`).bind(bucket, now + seconds).first<{ count: number }>();
  if (!row || row.count > maximum) throw new ApiError(429, "AUTH_RATE_LIMITED", "请求过于频繁，请稍后重试。");
  await d1.batch([
    d1.prepare("DELETE FROM auth_email_rate_limits WHERE bucket IN (SELECT bucket FROM auth_email_rate_limits WHERE expires_at < ? LIMIT 100)").bind(now),
    d1.prepare("DELETE FROM auth_email_challenges WHERE id IN (SELECT id FROM auth_email_challenges WHERE expires_at < ? LIMIT 100)").bind(now - 3600),
  ]);
}
export async function createEmailCaptcha(request: Request, action: EmailAction, d1: D1Database, config: EmailAuthConfig, services: EmailAuthServices): Promise<Response> {
  const nonce = readCookie(request.headers.get("cookie"), BROWSER_COOKIE);
  const browserToken = nonce && /^[A-Za-z0-9_-]{43}$/u.test(nonce) ? nonce : randomToken();
  await limitEmailAuth(d1, config, "global:captcha", 600, 900);
  await limitEmailAuth(d1, config, `flow:captcha:${action}`, 200, 900);
  await limitEmailAuth(d1, config, `browser:captcha:${browserToken}`, 30, 900);
  const id = randomToken(), answer = String(randomInt(1_000_000)).padStart(6, "0"), purpose = `captcha:${action}`;
  await d1.prepare("INSERT INTO auth_email_challenges (id, subject_hash, purpose, answer_hash, browser_hash, expires_at, delivered) VALUES (?, '', ?, ?, ?, ?, 1)")
    .bind(id, purpose, answerHash(config, id, purpose, answer), secretHash(config.sessionSecret, browserToken), Math.floor(Date.now() / 1000) + 180).run();
  return Response.json({ id, svg: services.captcha(answer) }, { headers: { "Cache-Control": "no-store", "Set-Cookie": `${BROWSER_COOKIE}=${browserToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600` } });
}
function consumption(d1: D1Database, config: EmailAuthConfig, input: { id: unknown; answer: unknown; purpose: string; browserHash: string; subject: string }, receipt: string, gate = "1=1", values: unknown[] = []): D1PreparedStatement[] {
  const id = typeof input.id === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input.id) ? input.id : "invalid", now = Math.floor(Date.now() / 1000);
  const where = `id = ? AND purpose = ? AND browser_hash = ? AND subject_hash = ? AND consumed_at IS NULL AND delivered = 1 AND expires_at > ? AND attempts < 5 AND (${gate})`;
  return [
    d1.prepare(`UPDATE auth_email_challenges SET attempts = attempts + 1, attempt_by = ? WHERE ${where}`).bind(receipt, id, input.purpose, input.browserHash, input.subject, now, ...values),
    d1.prepare(`UPDATE auth_email_challenges SET consumed_at = ?, consumed_by = ? WHERE id = ? AND purpose = ? AND browser_hash = ? AND subject_hash = ? AND answer_hash = ? AND consumed_at IS NULL AND delivered = 1 AND expires_at > ? AND attempts BETWEEN 1 AND 5 AND attempt_by = ? AND (${gate})`)
      .bind(now, receipt, id, input.purpose, input.browserHash, input.subject, answerHash(config, id, input.purpose, input.answer), now, receipt, ...values),
  ];
}
const receiptGate = "EXISTS (SELECT 1 FROM auth_email_challenges WHERE consumed_by = ?)";
async function consumed(d1: D1Database, receipt: string): Promise<boolean> { return Boolean(await d1.prepare("SELECT 1 FROM auth_email_challenges WHERE consumed_by = ?").bind(receipt).first()); }
export async function sendEmailCode(request: Request, action: "register-send" | "reset-send", input: Input, d1: D1Database, config: EmailAuthConfig, services: EmailAuthServices): Promise<Response> {
  if (action === "register-send") assertLegalInput(input.legal);
  const email = normalizeEmail(input.email), browserHash = secretHash(config.sessionSecret, browser(request)), receipt = randomToken();
  await d1.batch(consumption(d1, config, { id: input.captchaId, answer: input.captchaAnswer, purpose: `captcha:${action}`, browserHash, subject: "" }, receipt));
  if (!await consumed(d1, receipt)) throw invalid();
  await limitEmailAuth(d1, config, "global:send", 30, 3600);
  await limitEmailAuth(d1, config, `flow:send:${action}`, 20, 3600);
  await limitEmailAuth(d1, config, `send:${email}`, 1, 60);
  await limitEmailAuth(d1, config, `send-hour:${email}`, 5, 3600);
  const id = randomToken(), code = String(randomInt(1_000_000)).padStart(6, "0"), purpose = action === "register-send" ? "register" : "reset";
  await d1.prepare("INSERT INTO auth_email_challenges (id, subject_hash, purpose, answer_hash, browser_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, secretHash(config.identityPepper, email), purpose, answerHash(config, id, purpose, code), browserHash, Math.floor(Date.now() / 1000) + 600).run();
  try { await services.send(email, code); } catch { throw new ApiError(503, "EMAIL_SEND_UNAVAILABLE", "邮件发送暂时不可用，请稍后重试。"); }
  await d1.prepare("UPDATE auth_email_challenges SET delivered = 1 WHERE id = ? AND consumed_at IS NULL").bind(id).run();
  return Response.json({ challengeId: id, message: "验证码已发送，请检查邮箱。" }, { headers: { "Cache-Control": "no-store" } });
}
export async function completeEmailAuth(request: Request, action: "register" | "login" | "reset", input: Input, d1: D1Database, config: EmailAuthConfig): Promise<Response> {
  if (action === "register") assertLegalInput(input.legal);
  const email = normalizeEmail(input.email), value = password(input.password), browserHash = secretHash(config.sessionSecret, browser(request));
  const captchaReceipt = randomToken(), receipt = randomToken(), now = Math.floor(Date.now() / 1000);
  const cap = consumption(d1, config, { id: input.captchaId, answer: input.captchaAnswer, purpose: `captcha:${action}`, browserHash, subject: "" }, captchaReceipt);
  await d1.batch(cap); if (!await consumed(d1, captchaReceipt)) throw invalid();
  await limitEmailAuth(d1, config, `attempt:${email}`, 10, 900);
  await limitEmailAuth(d1, config, "global:derive", 120, 900);
  await limitEmailAuth(d1, config, `flow:derive:${action}`, 60, 900);
  await limitEmailAuth(d1, config, `browser:derive:${browserHash}`, 20, 900);
  if (action === "login") {
    const credential = await d1.prepare("SELECT user_id, password_hash, version FROM auth_email_credentials WHERE email = ?").bind(email).first<{ user_id: string; password_hash: string; version: number }>();
    // Equal KDF work for missing accounts; this derived value is never persisted.
    const dummy = `scrypt:32768:8:1:${"0".repeat(32)}:${"0".repeat(128)}`;
    const valid = await verifyPassword(value, credential?.password_hash ?? dummy);
    if (!credential || !valid) throw invalid();
    const token = randomToken(), tokenHash = secretHash(config.sessionSecret, token);
    await d1.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at)
      SELECT ?, credential.user_id, ?, ? FROM auth_email_credentials credential JOIN users account ON account.id = credential.user_id
      WHERE credential.email = ? AND credential.version = ? AND account.status = 'ACTIVE' AND (${receiptGate})`)
      .bind(tokenHash, now + SESSION_TTL_SECONDS, now, email, credential.version, captchaReceipt).run();
    if (!await d1.prepare("SELECT 1 FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).first()) throw invalid();
    return Response.json({ authenticated: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(token) } });
  }
  const hash = await hashPassword(value), subject = secretHash(config.identityPepper, email);
  const otp = consumption(d1, config, { id: input.challengeId, answer: input.code, purpose: action, browserHash, subject }, receipt, receiptGate, [captchaReceipt]);
  const gated = `${receiptGate} AND ${receiptGate}`, gates = [captchaReceipt, receipt];
  if (action === "reset") {
    await d1.batch([...otp,
      d1.prepare(`UPDATE auth_email_credentials SET password_hash = ?, version = version + 1 WHERE email = ? AND (${gated})`).bind(hash, email, ...gates),
      d1.prepare(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id IN (SELECT user_id FROM auth_email_credentials WHERE email = ?) AND (${gated})`).bind(now, email, ...gates),
    ]);
    if (!await consumed(d1, receipt)) throw invalid();
    return Response.json({ message: "密码已更新，请重新登录。" }, { headers: { "Cache-Control": "no-store" } });
  }
  const token = randomToken(), tokenHash = secretHash(config.sessionSecret, token);
  const active = "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'ACTIVE')";
  const registered = `${gated} AND (${active}) AND EXISTS (SELECT 1 FROM auth_email_credentials WHERE user_id = ? AND email = ? AND password_hash = ?)`;
  const legacy = await d1.prepare("SELECT id FROM users WHERE identity_namespace=?").bind(`user_${secretHash(config.identityPepper, `email:${email}`)}`).first<{id:string}>();
  const mapped = await d1.prepare("SELECT user_id AS id FROM auth_identities WHERE provider='email' AND provider_app_id='email:v1' AND subject_hash=?").bind(subject).first<{id:string}>();
  if (legacy && mapped && legacy.id !== mapped.id) throw invalid();
  const existing = mapped ?? legacy;
  await withUserIdRetry(async (candidateId) => {
  const userId = existing?.id ?? candidateId;
  const registeredValues = [...gates, userId, userId, email, hash];
  await d1.batch([...otp,
    ...(existing ? [] : [d1.prepare(`INSERT INTO users (id, display_name, email_registration_receipt) SELECT ?, '邮箱用户', ? WHERE (${gated}) AND NOT EXISTS (SELECT 1 FROM auth_email_credentials WHERE email = ?)`).bind(userId, receipt, ...gates, email)]),
    d1.prepare(`INSERT INTO auth_email_credentials (email, user_id, password_hash, verified_at) SELECT ?, ?, ?, ? WHERE (${gated}) AND (${active}) ON CONFLICT(email) DO NOTHING`).bind(email, userId, hash, now, ...gates, userId),
    d1.prepare(`INSERT INTO auth_identities (id, user_id, provider, provider_app_id, subject_hash) SELECT ?, ?, 'email', 'email:v1', ? WHERE (${registered}) ON CONFLICT(provider, provider_app_id, subject_hash) DO NOTHING`).bind(`identity_${subject}`, userId, subject, ...registeredValues),
    d1.prepare(`INSERT INTO user_generation_limits (owner_id,active_concurrency_limit) SELECT ?,3 WHERE (${registered}) ON CONFLICT(owner_id) DO NOTHING`).bind(userId, ...registeredValues),
    ...consentStatements(d1, userId, now, registered, registeredValues),
    registrationReferral(d1, userId, input.inviteCode, "email", receipt, registered, registeredValues),
    d1.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at) SELECT ?, ?, ?, ? WHERE (${registered})`).bind(tokenHash, userId, now + SESSION_TTL_SECONDS, now, ...registeredValues),
    d1.prepare(`INSERT INTO credit_ledger_entries (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
      SELECT ?, ?, 'CREDIT', 350, 'email-welcome-v1', 'EMAIL_REGISTRATION_WELCOME', 'system', ?
      WHERE (${gated}) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'ACTIVE' AND email_registration_receipt = ?)
      AND EXISTS (SELECT 1 FROM auth_email_credentials WHERE user_id = ? AND email = ? AND password_hash = ?)
      ON CONFLICT(owner_id, idempotency_key) DO NOTHING`).bind(`ledger_${randomToken()}`, userId, receipt, ...gates, userId, receipt, userId, email, hash),
  ]);
  });
  if (!await d1.prepare("SELECT 1 FROM auth_sessions WHERE token_hash = ?").bind(tokenHash).first()) throw invalid();
  return Response.json({ authenticated: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(token) } });
}
