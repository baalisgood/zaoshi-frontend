import { openNodeD1Database } from "./node-d1";
import { NodeObjectBucket } from "./node-object-store";
import { readNodeSecretBindings } from "./node-secret-files";
import { IMAGE_SANITIZER_BINDING } from "./image-sanitizer";
import { nodeImageSanitizer } from "./node-image-sanitizer";
import { runLifecycleMaintenance, type LifecycleMaintenanceState } from "./node-lifecycle-maintenance";

type NodeRuntimeState = LifecycleMaintenanceState & {
  bindings: Record<string, unknown>;
  lifecycleTimer?: NodeJS.Timeout;
};

const STATE_KEY = Symbol.for("zaoshi.node-runtime.bindings");

export const env = new Proxy<Record<string, unknown>>(
  {},
  {
    get(_target, property) {
      return typeof property === "string"
        ? readRuntimeBindings()[property]
        : undefined;
    },
    ownKeys() {
      return Reflect.ownKeys(readRuntimeBindings());
    },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true };
    },
  },
);

export function readRuntimeBindings(): Record<string, unknown> {
  const scope = globalThis as typeof globalThis & {
    [STATE_KEY]?: NodeRuntimeState;
  };
  if (!scope[STATE_KEY]) {
    const databasePath = required("ZAOSHI_SQLITE_PATH");
    const objectRoot = required("ZAOSHI_OBJECT_ROOT");
    const migrationsDirectory = required("ZAOSHI_MIGRATIONS_DIR");
    const secretBindings = readNodeSecretBindings(process.env);
    const configured = Number(process.env.ZAOSHI_LIFECYCLE_INTERVAL_SECONDS ?? "3600");
    const lifecycleHealth = { enabled: process.env.ZAOSHI_LIFECYCLE_MAINTENANCE_ENABLED === "1", startedAt: Date.now(), lastCompletedAt: null, intervalSeconds: Math.max(60, Math.min(86_400, Number.isFinite(configured) ? Math.floor(configured) : 3600)) };
    const consumerHealthFile = process.env.ZAOSHI_CONSUMER_HEALTH_FILE?.trim();
    if (process.env.BACKEND_PROFILE === "cn-production" && !lifecycleHealth.enabled) throw new Error("ZAOSHI_LIFECYCLE_MAINTENANCE_ENABLED=1 is required in cn-production");
    scope[STATE_KEY] = {
      lifecycleHealth,
      bindings: {
        ...process.env,
        ...secretBindings,
        ZAOSHI_RUNTIME: "node",
        ZAOSHI_LIFECYCLE_HEALTH: lifecycleHealth,
        ...(consumerHealthFile ? { ZAOSHI_CONSUMER_HEALTH: async () => {
          const { readConsumerHealth } = await import("../consumer/health");
          return readConsumerHealth(consumerHealthFile);
        } } : {}),
        [IMAGE_SANITIZER_BINDING]: nodeImageSanitizer,
        DB: openNodeD1Database({ databasePath, migrationsDirectory }),
        ASSETS_BUCKET: new NodeObjectBucket(objectRoot),
      },
    };
    startLifecycleMaintenance(scope[STATE_KEY]);
  }
  return scope[STATE_KEY].bindings;
}

function startLifecycleMaintenance(state: NodeRuntimeState): void {
  if (!state.lifecycleHealth.enabled || state.lifecycleTimer) return;
  const intervalMs = state.lifecycleHealth.intervalSeconds * 1000;
  state.lifecycleTimer = setInterval(() => { void runLifecycleMaintenance(state); }, intervalMs);
  state.lifecycleTimer.unref();
  const initial = setTimeout(() => { void runLifecycleMaintenance(state); }, Math.min(60_000, intervalMs));
  initial.unref();
}

export function tryWaitUntil(promise: Promise<unknown>): boolean {
  void promise;
  return false;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the CVM runtime`);
  return value;
}
