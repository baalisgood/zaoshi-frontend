import type { RequestActor } from "./actor";
import { ApiError } from "./api";

export const PRIVATE_TEST_OWNER = "TEST0001";
export type PrivateTestConfig = { expiresAt: number };

export function assertPrivateTestActive(config: PrivateTestConfig, now = Math.floor(Date.now() / 1000)): void {
  if (config.expiresAt <= now) throw new ApiError(503, "PRIVATE_TEST_EXPIRED", "付费私测已到期，不再领取或发起模型调用。");
}

export function assertPrivateTestActor(actor: RequestActor) {
  if (actor.ownerId !== PRIVATE_TEST_OWNER || actor.trusted !== true || !actor.user.authenticated || actor.user.role !== "USER") throw new ApiError(403, "CANARY_ACCESS_REQUIRED", "仅私测账号可执行此操作。");
}
