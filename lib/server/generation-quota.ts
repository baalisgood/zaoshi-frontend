import { ensureDatabase, getD1Binding } from "@/db";
import { PRIVATE_TEST_OWNER } from "./private-test";
import { startOfTodayInShanghai } from "./product-time";

export type GenerationQuotaSnapshot = {
  dailyLimit: number | null;
  usedToday: number;
  remainingToday: number | null;
  pending: number;
  pendingLimit: number;
  activeConcurrencyLimit: number;
  dailyUnlimited: boolean;
};

export async function getGenerationQuotaSnapshot(ownerId: string, dailyUnlimited = false): Promise<GenerationQuotaSnapshot> {
  await ensureDatabase();
  const d1 = getD1Binding();
  if (!d1) return snapshot({ daily_limit: 20, used_today: 0, pending: 0, pending_limit: 4, active_limit: 3 }, dailyUnlimited, ownerId);
  const row = await d1.prepare(
    `SELECT
       COALESCE(limits.daily_output_limit, 20) AS daily_limit,
       COALESCE(limits.max_pending_outputs, 4) AS pending_limit,
       COALESCE(limits.active_concurrency_limit, 3) AS active_limit,
       COALESCE((SELECT SUM(units) FROM generation_quota_admissions
         WHERE owner_id = ? AND day_start = ?), 0) AS used_today,
       COALESCE((SELECT COUNT(*) FROM generation_job_items
         WHERE owner_id = ? AND status NOT IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED','CANCELED')), 0) AS pending
     FROM (SELECT 1) AS seed
     LEFT JOIN user_generation_limits AS limits ON limits.owner_id = ?`,
  ).bind(ownerId, startOfTodayInShanghai(), ownerId, ownerId).first<{
    daily_limit: number;
    used_today: number;
    pending: number;
    pending_limit: number;
    active_limit: number;
  }>();
  return snapshot(row ?? { daily_limit: 20, used_today: 0, pending: 0, pending_limit: 4, active_limit: 3 }, dailyUnlimited, ownerId);
}

function snapshot(row: { daily_limit: number; used_today: number; pending: number; pending_limit: number; active_limit: number }, dailyUnlimited: boolean, ownerId: string): GenerationQuotaSnapshot {
  return {
    dailyLimit: null,
    usedToday: row.used_today,
    remainingToday: null,
    pending: row.pending,
    pendingLimit: dailyUnlimited && ownerId === PRIVATE_TEST_OWNER ? 4 : row.pending_limit,
    activeConcurrencyLimit: row.active_limit,
    dailyUnlimited: true,
  };
}
