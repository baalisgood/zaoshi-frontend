import type { RequestActor } from "./actor";
import { ApiError } from "./api";

export function isSiteAdmin(actor: RequestActor, bindings: Record<string, unknown>): boolean {
  if (!actor.user.authenticated || actor.trusted !== true) return false;
  if (actor.user.role === "ADMIN") return true;
  const email = actor.user.email?.trim().toLowerCase();
  return Boolean(email && adminEmails(bindings).has(email));
}

export function assertSiteAdmin(actor: RequestActor, bindings: Record<string, unknown>): void {
  if (!actor.user.authenticated || actor.trusted !== true) {
    throw new ApiError(401, "AUTH_REQUIRED", "请先完成管理员登录。");
  }
  if (!isSiteAdmin(actor, bindings)) throw new ApiError(403, "ADMIN_FORBIDDEN", "没有管理员权限。");
}

function adminEmails(bindings: Record<string, unknown>): Set<string> {
  return new Set(String(bindings.ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)));
}
