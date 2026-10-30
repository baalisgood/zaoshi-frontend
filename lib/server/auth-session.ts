import { createHmac } from "node:crypto";
import { readCookie, type RequestActor } from "./actor";
export const SESSION_COOKIE = "__Host-zaoshi_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export function secretHash(secret: string, value: string): string { return createHmac("sha256", secret).update(value).digest("hex"); }
export function sessionCookie(value: string): string { return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`; }
export function clearSessionCookie(): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
/** Shared persistent session lookup; callers must validate their own authentication mode. */
export async function resolveStoredSessionActor(request: Request, sessionSecret: string, d1: D1Database, cookieName: string, emailMode: boolean | { wechatAppId: string } = false): Promise<RequestActor | null> {
  const token = readCookie(request.headers.get("cookie"), cookieName);
  if (!token || token.length > 128) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await d1.prepare(
    `SELECT account.id, account.identity_namespace, account.display_name, account.role, session.last_seen_at ${emailMode ? ", credential.email" : ""}
     FROM auth_sessions AS session
     JOIN users AS account ON account.id = session.user_id
     ${emailMode ? "LEFT JOIN auth_email_credentials credential ON credential.user_id = account.id AND credential.verified_at IS NOT NULL" : ""}
     WHERE session.token_hash = ? AND session.revoked_at IS NULL
       AND session.expires_at > ? AND account.status = 'ACTIVE'
       ${emailMode ? typeof emailMode === 'object' ? "AND (credential.email IS NOT NULL OR EXISTS (SELECT 1 FROM auth_identities WHERE user_id=account.id AND provider='wechat' AND provider_app_id=?))" : "AND credential.email IS NOT NULL" : ""}
     LIMIT 1`,
  ).bind(secretHash(sessionSecret, token), now, ...(typeof emailMode === "object" ? [emailMode.wechatAppId] : [])).first<{
    id: string;
    identity_namespace: string;
    display_name: string;
    role: "USER" | "ADMIN";
    last_seen_at: number;
    email?: string;
  }>();
  if (!row) return null;
  if (row.last_seen_at < now - 24 * 60 * 60) {
    await d1.prepare(
      "UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    ).bind(now, secretHash(sessionSecret, token)).run();
  }
  return {
    ownerId: row.id,
    identityNamespace: row.identity_namespace,
    setCookie: null,
    trusted: true,
    user: { authenticated: true, displayName: row.display_name, role: row.role, ...(row.email ? { email: row.email, verifiedIdentity: "email" as const } : typeof emailMode === "object" ? { verifiedIdentity: "wechat" as const } : {}) },
  };
}

