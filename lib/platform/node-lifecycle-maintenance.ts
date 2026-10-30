export type LifecycleMaintenanceState = {
  bindings: Record<string, unknown>;
  lifecycleBusy?: boolean;
  lifecycleHealth: { enabled: boolean; startedAt: number; lastCompletedAt: number | null; intervalSeconds: number };
};

export async function runLifecycleMaintenance(state: LifecycleMaintenanceState): Promise<void> {
  if (state.lifecycleBusy) return;
  state.lifecycleBusy = true;
  try {
    const analytics = await import("../server/analytics");
    const lifecycle = await import("../server/asset-lifecycle");
    await analytics.purgeExpiredAnalytics(state.bindings.DB as D1Database);
    await lifecycle.sweepExpiredGallery(100);
    await lifecycle.sweepExpiredAssets(100);
    const cleanup = await lifecycle.processObjectCleanup(50);
    if (cleanup.blocked > 0) console.error("ZAOSHI_LIFECYCLE_CLEANUP_BLOCKED");
    state.lifecycleHealth.lastCompletedAt = Date.now();
  } catch {
    console.error("ZAOSHI_LIFECYCLE_MAINTENANCE_FAILED");
  } finally {
    state.lifecycleBusy = false;
  }
}
