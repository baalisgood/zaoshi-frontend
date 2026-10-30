import { LEGAL_VERSION, legalDocuments, hasCurrentLegalConsent } from "@/lib/domain/legal";
import { PRIVATE_TEST_OWNER } from "./private-test";
import { ApiError } from "./api";
import type { RequestActor } from "./actor";

export function assertAuthenticatedActor(actor: RequestActor): void {
  if (!actor.trusted || !actor.user.authenticated) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "请先登录。");
}
export function assertLegalInput(input: unknown): void {
  if (!hasCurrentLegalConsent(input)) throw new ApiError(409, "LEGAL_CONSENT_REQUIRED", "请阅读并同意当前版本的用户协议与隐私政策。");
}
export async function readLegalConsent(d1: D1Database, ownerId: string): Promise<boolean> {
  const row = await d1.prepare("SELECT COUNT(*) AS n FROM user_legal_acceptances WHERE user_id = ? AND version = ? AND document IN ('terms','privacy')").bind(ownerId, LEGAL_VERSION).first<{ n: number }>();
  return Number(row?.n) === 2;
}
export async function assertCurrentLegalConsent(actor: RequestActor): Promise<void> {
  assertAuthenticatedActor(actor);
  if (actor.ownerId === PRIVATE_TEST_OWNER) return;
  const { getD1Binding } = await import("@/db");
  const d1 = getD1Binding();
  if (!d1) throw new ApiError(503, "LEGAL_STORAGE_NOT_READY", "账户服务暂不可用。");
  if (!await readLegalConsent(d1, actor.ownerId)) throw new ApiError(409, "LEGAL_CONSENT_REQUIRED", "请先阅读并同意用户协议与隐私政策。");
}
export function consentStatements(d1: D1Database, ownerId: string, now: number, condition = "1", bindings: unknown[] = []): D1PreparedStatement[] {
  return legalDocuments.map((document) => d1.prepare(`INSERT INTO user_legal_acceptances (user_id, document, version, accepted_at) SELECT ?, ?, ?, ? WHERE (${condition}) ON CONFLICT(user_id,document,version) DO NOTHING`).bind(ownerId, document, LEGAL_VERSION, now, ...bindings));
}

/** Only a new WeChat registration receipt can claim this after current consent. */
export function wechatWelcomeStatement(d1: D1Database, ownerId: string): D1PreparedStatement {
 return d1.prepare(`INSERT INTO credit_ledger_entries (id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id)
   SELECT ?,id,'CREDIT',350,'registration-welcome-v1','WECHAT_REGISTRATION_WELCOME','system',wechat_registration_receipt FROM users
   WHERE id=? AND status='ACTIVE' AND wechat_registration_receipt IS NOT NULL AND email_registration_receipt IS NULL
   AND (SELECT COUNT(*) FROM user_legal_acceptances WHERE user_id=users.id AND version=? AND document IN ('terms','privacy'))=2
   AND NOT EXISTS(SELECT 1 FROM credit_ledger_entries WHERE owner_id=users.id AND idempotency_key IN ('registration-welcome-v1','email-welcome-v1'))
   ON CONFLICT(owner_id,idempotency_key) DO NOTHING`).bind(`ledger_${crypto.randomUUID()}`,ownerId,LEGAL_VERSION);
}
