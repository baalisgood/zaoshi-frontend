import { getD1Binding } from "@/db";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { assertAuthenticatedActor, assertLegalInput, consentStatements, readLegalConsent, wechatWelcomeStatement } from "@/lib/server/legal-consent";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
export async function POST(request: Request): Promise<Response> {
 try {
  assertSameOriginMutation(request);
  const actor = await getRuntimeRequestActor(request); assertAuthenticatedActor(actor);
  assertLegalInput(await readJsonBody(request, 2048));
  const d1 = getD1Binding(); if (!d1) throw new ApiError(503,"LEGAL_STORAGE_NOT_READY","账户服务暂不可用。");
  await d1.batch([...consentStatements(d1, actor.ownerId, Math.floor(Date.now()/1000), "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'ACTIVE')", [actor.ownerId]), wechatWelcomeStatement(d1, actor.ownerId)]);
  const active = await d1.prepare("SELECT id FROM users WHERE id = ? AND status = 'ACTIVE'").bind(actor.ownerId).first();
  if (!active) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "账户状态已更新，请重新登录。");
  if (!await readLegalConsent(d1, actor.ownerId)) throw new ApiError(503, "LEGAL_STORAGE_NOT_READY", "协议确认未保存，请重试。");
  return jsonResponse({ accepted: true });
 } catch(error) { return errorResponse(error,crypto.randomUUID()); }
}
