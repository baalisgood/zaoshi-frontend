import { getD1Binding, getR2Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { readQueueMonitor } from "@/lib/server/admin-console";
import { jsonResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const database = getD1Binding();
  const bucket = getR2Binding();
  const lifecycle = readRuntimeBindings().ZAOSHI_LIFECYCLE_HEALTH as { enabled?: boolean; startedAt?: number; lastCompletedAt?: number | null; intervalSeconds?: number } | undefined;
  const now = Date.now(), lifecycleDeadline = Math.max(60, lifecycle?.intervalSeconds ?? 3600) * 2000;
  const lifecycleUnhealthy = lifecycle?.enabled === true && now - (lifecycle.lastCompletedAt ?? lifecycle.startedAt ?? now) > lifecycleDeadline;
  const lifecycleAlerts = lifecycleUnhealthy ? ["LIFECYCLE_MAINTENANCE_STALE"] : [];
  if (!database || !bucket || lifecycleUnhealthy) {
    return jsonResponse(
      { ok: false, alerts: lifecycleAlerts },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    await database.prepare("SELECT 1 AS ready").first();
    await bucket.get("health/nonexistent-probe");
    const queue = await readQueueMonitor(database, readRuntimeBindings());
    return jsonResponse(
      { ok: true, alerts: queue.alerts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonResponse(
      { ok: false, alerts: lifecycleAlerts },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
