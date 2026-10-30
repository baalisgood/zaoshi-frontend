import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsumerControlPlane,
  ConsumerMaintenanceControlPlane,
  ConsumerSpool,
  ConsumerSpoolMaintenance,
  GenerationExecutor,
} from "../../lib/consumer/contracts";
import { abortableDelay, runConsumerDaemon } from "../../lib/consumer/daemon";
import type {
  ConsumerHealthReporter,
  ConsumerHealthSnapshot,
} from "../../lib/consumer/health";

test("daemon reuses an ambiguous claim request id and runs maintenance serially", async () => {
  const controller = new AbortController();
  const claims: string[] = [];
  const events: string[] = [];
  let clock = 0;
  let sweepCalls = 0;
  let claimCalls = 0;
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const control = fakeControl({
    async sweep() {
      events.push("sweep");
      sweepCalls += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, ++activeOperations);
      activeOperations -= 1;
      return { retried: 0, failed: 0, reconciliationRequired: 0 };
    },
    async claim(_workerId, claimRequestId) {
      events.push("claim");
      claims.push(claimRequestId);
      claimCalls += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, ++activeOperations);
      activeOperations -= 1;
      if (claimCalls === 1) throw new Error("CONTROL_PLANE_UNAVAILABLE");
      return null;
    },
  });
  const health = new MemoryHealth();
  await runConsumerDaemon({
    ...daemonOptions(controller, control, health),
    now: () => clock,
    random: () => 0,
    claimRequestId: () => `claim-${claims.length + 1}`,
    async delay(milliseconds) {
      clock += Math.max(milliseconds, 30_000);
      if (claimCalls >= 2) controller.abort();
    },
  });

  assert.deepEqual(claims, ["claim-1", "claim-1"]);
  assert.equal(sweepCalls, 2);
  assert.equal(maximumActiveOperations, 1);
  assert.deepEqual(events, ["sweep", "claim", "sweep", "claim"]);
  assert.equal(health.snapshots.at(-1)?.state, "stopped");
  assert.equal(health.snapshots.at(-1)?.counters.controlPlaneFailures, 1);
});

test("daemon finishes an in-flight operation after shutdown and does not claim again", async () => {
  const controller = new AbortController();
  let claims = 0;
  const health = new MemoryHealth();
  const control = fakeControl({
    async claim() {
      claims += 1;
      controller.abort();
      return null;
    },
  });
  await runConsumerDaemon({
    ...daemonOptions(controller, control, health),
    async delay() {
      throw new Error("DELAY_MUST_NOT_RUN_AFTER_ABORT");
    },
  });
  assert.equal(claims, 1);
  assert.deepEqual(
    health.snapshots.slice(-2).map((snapshot) => snapshot.state),
    ["draining", "stopped"],
  );
});

test("daemon backoff timer keeps the standalone Node process alive", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  let timerHasRef: (() => boolean) | undefined;
  globalThis.setTimeout = ((...arguments_: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...arguments_);
    if (typeof timer === "object" && timer && "hasRef" in timer) {
      timerHasRef = (timer as NodeJS.Timeout).hasRef.bind(timer);
    }
    return timer;
  }) as typeof setTimeout;
  try {
    const pending = abortableDelay(60_000, controller.signal);
    assert.equal(timerHasRef?.(), true);
    controller.abort();
    await pending;
  } finally {
    controller.abort();
    globalThis.setTimeout = originalSetTimeout;
  }
});

function daemonOptions(
  controller: AbortController,
  control: ConsumerControlPlane & ConsumerMaintenanceControlPlane,
  health: ConsumerHealthReporter,
) {
  return {
    workerId: "worker-daemon-1",
    control,
    executor: {
      async prepare() {
        throw new Error("EXECUTOR_MUST_NOT_RUN");
      },
    } satisfies GenerationExecutor,
    spool: {
      async list() {
        return [];
      },
      async maintainQuarantine() {
        return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 };
      },
      async read() {
        throw new Error("SPOOL_READ_MUST_NOT_RUN");
      },
      async save() {
        throw new Error("SPOOL_SAVE_MUST_NOT_RUN");
      },
      async remove() {
        throw new Error("SPOOL_REMOVE_MUST_NOT_RUN");
      },
      async quarantine() {
        throw new Error("SPOOL_QUARANTINE_MUST_NOT_RUN");
      },
    } satisfies ConsumerSpool & ConsumerSpoolMaintenance,
    health,
    heartbeatIntervalMs: 8_000,
    idleBackoff: { minMs: 1_000, maxMs: 15_000 },
    errorBackoff: { minMs: 2_000, maxMs: 30_000 },
    reconciliationBackoffMs: 30_000,
    sweepIntervalMs: 30_000,
    busyBurstLimit: 8,
    quarantine: {
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEntries: 100,
      maxBytes: 1_073_741_824,
    },
    signal: controller.signal,
  };
}

function fakeControl(
  overrides: Partial<ConsumerControlPlane & ConsumerMaintenanceControlPlane>,
): ConsumerControlPlane & ConsumerMaintenanceControlPlane {
  return {
    async claim() {
      return null;
    },
    async sweep() {
      return { retried: 0, failed: 0, reconciliationRequired: 0 };
    },
    async heartbeat() {
      throw new Error("HEARTBEAT_MUST_NOT_RUN");
    },
    async transition() {
      throw new Error("TRANSITION_MUST_NOT_RUN");
    },
    async work() {
      throw new Error("WORK_MUST_NOT_RUN");
    },
    async input() {
      throw new Error("INPUT_MUST_NOT_RUN");
    },
    async prepareOutput() {
      throw new Error("PREPARE_OUTPUT_MUST_NOT_RUN");
    },
    async uploadOutput() {
      throw new Error("UPLOAD_OUTPUT_MUST_NOT_RUN");
    },
    ...overrides,
  };
}

class MemoryHealth implements ConsumerHealthReporter {
  readonly snapshots: ConsumerHealthSnapshot[] = [];

  async write(snapshot: ConsumerHealthSnapshot) {
    this.snapshots.push(structuredClone(snapshot));
  }
}

test('pool serializes health writes, drains peers on a fatal slot, and retains degraded health',async()=>{
 const {runConsumerPool}=await import('../../lib/consumer/pool');const controller=new AbortController();const memory=new MemoryHealth();
 let writing=0,peak=0,claims=0;
 const valid=daemonOptions(controller,fakeControl({async claim(){claims++;return null;}}),memory);
 const slots=[valid,{...valid,heartbeatIntervalMs:0}];
 await assert.rejects(runConsumerPool(slots,{async write(snapshot){peak=Math.max(peak,++writing);await new Promise(resolve=>setTimeout(resolve,1));memory.snapshots.push(structuredClone(snapshot));writing--; }},controller.signal));
 assert.equal(peak,1);assert.equal(memory.snapshots.at(-1)?.state,'degraded');
 const stopped=claims;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(claims,stopped);
});
