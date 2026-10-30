import type {
  ConsumerControlPlane,
  ConsumerMaintenanceControlPlane,
  ConsumerSpool,
  ConsumerSpoolMaintenance,
  GenerationExecutor,
  SweepSummary,
} from "./contracts";
import { ConsumerControlPlaneError } from "./control-plane-client";
import type {
  ConsumerHealthReporter,
  ConsumerHealthSnapshot,
  ConsumerHealthState,
} from "./health";
import { runOne, type RunOneResult } from "./run-one";

export type ConsumerDaemonOptions = {
  workerId: string;
  control: ConsumerControlPlane & ConsumerMaintenanceControlPlane;
  executor: GenerationExecutor;
  spool: ConsumerSpool & ConsumerSpoolMaintenance;
  health: ConsumerHealthReporter;
  heartbeatIntervalMs: number;
  idleBackoff: { minMs: number; maxMs: number };
  errorBackoff: { minMs: number; maxMs: number };
  reconciliationBackoffMs: number;
  sweepIntervalMs: number;
  busyBurstLimit: number;
  quarantine: { retentionMs: number; maxEntries: number; maxBytes: number };
  signal: AbortSignal;
  now?: () => number;
  random?: () => number;
  claimRequestId?: () => string;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export async function runConsumerDaemon(options: ConsumerDaemonOptions): Promise<void> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const nextClaimRequestId =
    options.claimRequestId ?? (() => `claim_${crypto.randomUUID()}`);
  const delay = options.delay ?? abortableDelay;
  const startedAt = new Date(now()).toISOString();
  const health = createHealthState(startedAt);
  let claimRequestId = nextClaimRequestId();
  let nextSweepAt = 0;
  let busyBurst = 0;
  let idleAttempt = 0;
  let errorAttempt = 0;
  let hasSucceeded = false;
  let heartbeatFailed = false;

  const liveControl = new Proxy(options.control, {
    get(target, key) {
      if (key === "claim") return async (...args: Parameters<ConsumerControlPlane["claim"]>) => {
        const result = await target.claim(...args);
        heartbeatFailed = false;
        health.lastSuccessAt = new Date(now()).toISOString();
        await publish(options.health, health, "ready", now(), null);
        return result;
      };
      if (key === "heartbeat") return async (...args: Parameters<ConsumerControlPlane["heartbeat"]>) => {
        try {
          const result = await target.heartbeat(...args);
          if (result !== "applied" && result !== "already_applied") throw new Error("CONTROL_PLANE_MUTATION_REJECTED");
          heartbeatFailed = false;
          health.lastSuccessAt = new Date(now()).toISOString();
          await publish(options.health, health, "ready", now(), null);
          return result;
        } catch (error) {
          heartbeatFailed = true;
          health.counters.controlPlaneFailures += 1;
          await publish(options.health, health, "degraded", now(), normalizedErrorCode(error));
          throw error;
        }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await publish(options.health, health, "starting", now(), null);
  try {
    while (!options.signal.aborted) {
      if (now() >= nextSweepAt) {
        try {
          await options.spool.list();
          const local = await options.spool.maintainQuarantine({
            nowMs: now(),
            ...options.quarantine,
          });
          const sweep = await options.control.sweep();
          heartbeatFailed = false;
          health.counters.sweeps += 1;
          health.counters.quarantineRemoved += local.removed;
          health.counters.reconciliationRequired += reconciliationCount(sweep);
          hasSucceeded = true;
          errorAttempt = 0;
          nextSweepAt = now() + options.sweepIntervalMs;
          health.lastSuccessAt = new Date(now()).toISOString();
          await publish(
            options.health,
            health,
            "ready",
            now(),
            null,
          );
        } catch (error) {
          health.counters.controlPlaneFailures += 1;
          errorAttempt += 1;
          await publish(
            options.health,
            health,
            health.state === "degraded" || heartbeatFailed || !hasSucceeded || errorAttempt >= 3 ? "degraded" : "ready",
            now(),
            normalizedErrorCode(error),
          );
          await delay(
            jitteredBackoff(options.errorBackoff, errorAttempt, random),
            options.signal,
          );
          continue;
        }
      }

      if (options.signal.aborted) break;
      let result: RunOneResult;
      try {
        result = await runOne({
          workerId: options.workerId,
          claimRequestId,
          control: liveControl,
          executor: options.executor,
          spool: options.spool,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
        });
        // A concrete result proves the claim request was acknowledged or was
        // never needed because a spooled output was resumed. Only now rotate.
        claimRequestId = nextClaimRequestId();
        if (!heartbeatFailed) {
          hasSucceeded = true;
          errorAttempt = 0;
          health.lastSuccessAt = new Date(now()).toISOString();
        }
      } catch (error) {
        // Reuse the same request ID after an uncertain claim response. The
        // control plane can then replay the original fence instead of leasing
        // another task.
        health.counters.controlPlaneFailures += 1;
        errorAttempt += 1;
        await publish(
          options.health,
          health,
          health.state === "degraded" || heartbeatFailed || !hasSucceeded || errorAttempt >= 3 ? "degraded" : "ready",
          now(),
          normalizedErrorCode(error),
        );
        await delay(
          jitteredBackoff(options.errorBackoff, errorAttempt, random),
          options.signal,
        );
        continue;
      }

      if (result.status === "completed") {
        health.counters.completed += 1;
        busyBurst += 1;
        idleAttempt = 0;
      } else if (result.status === "safe-failure") {
        health.counters.safeFailures += 1;
        busyBurst = 0;
        idleAttempt = 0;
      } else if (result.status === "reconciliation-required") {
        health.counters.reconciliationRequired += 1;
        busyBurst = 0;
        idleAttempt = 0;
      } else {
        busyBurst = 0;
        idleAttempt += 1;
      }

      await publish(
        options.health,
        health,
        heartbeatFailed ? "degraded" : "ready",
        now(),
        heartbeatFailed ? health.lastErrorCode : null,
      );
      if (options.signal.aborted) break;
      if (result.status === "idle") {
        await delay(
          jitteredBackoff(options.idleBackoff, idleAttempt, random),
          options.signal,
        );
      } else if (result.status === "reconciliation-required" || result.status === "moderation-pending") {
        await delay(options.reconciliationBackoffMs, options.signal);
      } else if (result.status === "safe-failure" || result.status === "moderation-rejected") {
        await delay(options.errorBackoff.minMs, options.signal);
      } else if (busyBurst >= options.busyBurstLimit) {
        busyBurst = 0;
        await delay(1, options.signal);
      }
    }
  } finally {
    await publish(options.health, health, "draining", now(), health.lastErrorCode);
    await publish(options.health, health, "stopped", now(), health.lastErrorCode);
  }
}

export async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

function createHealthState(startedAt: string): ConsumerHealthSnapshot {
  return {
    version: 1,
    state: "starting",
    startedAt,
    updatedAt: startedAt,
    lastSuccessAt: null,
    lastErrorCode: null,
    counters: {
      completed: 0,
      safeFailures: 0,
      reconciliationRequired: 0,
      controlPlaneFailures: 0,
      sweeps: 0,
      quarantineRemoved: 0,
    },
  };
}

async function publish(
  reporter: ConsumerHealthReporter,
  snapshot: ConsumerHealthSnapshot,
  state: ConsumerHealthState,
  nowMs: number,
  errorCode: string | null,
): Promise<void> {
  snapshot.state = state;
  snapshot.updatedAt = new Date(nowMs).toISOString();
  snapshot.lastErrorCode = errorCode;
  await reporter.write(structuredClone(snapshot));
}

function reconciliationCount(summary: SweepSummary): number {
  return (
    summary.reconciliationRequired +
    (summary.outputReconciliationRequired ?? 0)
  );
}

function jitteredBackoff(
  range: { minMs: number; maxMs: number },
  attempt: number,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  const ceiling = Math.min(range.maxMs, range.minMs * 2 ** exponent);
  const sample = Math.min(Math.max(random(), 0), 0.999999999);
  return Math.floor(range.minMs + sample * (ceiling - range.minMs + 1));
}

function normalizedErrorCode(error: unknown): string {
  if (error instanceof ConsumerControlPlaneError) {
    return `CONTROL_PLANE_${error.status}_${error.code}`.slice(0, 100);
  }
  if (
    error instanceof Error &&
    /^[A-Z0-9_]{1,100}$/u.test(error.message)
  ) {
    return error.message;
  }
  return "CONSUMER_OPERATION_FAILED";
}

function validateOptions(options: ConsumerDaemonOptions): void {
  const positive = [
    options.heartbeatIntervalMs,
    options.idleBackoff.minMs,
    options.idleBackoff.maxMs,
    options.errorBackoff.minMs,
    options.errorBackoff.maxMs,
    options.reconciliationBackoffMs,
    options.sweepIntervalMs,
    options.busyBurstLimit,
    options.quarantine.retentionMs,
    options.quarantine.maxEntries,
    options.quarantine.maxBytes,
  ];
  if (
    positive.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    options.idleBackoff.minMs > options.idleBackoff.maxMs ||
    options.errorBackoff.minMs > options.errorBackoff.maxMs
  ) {
    throw new Error("INVALID_CONSUMER_DAEMON_OPTIONS");
  }
}
