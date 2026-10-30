import { randomInt } from "node:crypto";
import { ApiError } from "./api";

export const PRIVATE_TEST_USER_ID = "TEST0001";
export function newUserId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (;;) {
    const value = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    if (value !== PRIVATE_TEST_USER_ID && /[A-Z]/u.test(value) && /[0-9]/u.test(value)) return value;
  }
}
export async function withUserIdRetry<T>(operation: (id: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await operation(newUserId()); }
    catch (error) {
      // Only a users primary-key collision is safe to retry; D1 batch rolls it back.
      if (!/UNIQUE constraint failed: users\.id(?:\b|$)/u.test(String(error))) throw error;
    }
  }
  throw new ApiError(503, "ACCOUNT_ID_UNAVAILABLE", "账户创建暂时不可用，请重试。");
}
export async function identityNamespace(d1: D1Database, id: string): Promise<string> {
  const row = await d1.prepare("SELECT identity_namespace FROM users WHERE id = ?").bind(id).first<{ identity_namespace: string }>();
  return row?.identity_namespace ?? id;
}
