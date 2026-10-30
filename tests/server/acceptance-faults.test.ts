import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAcceptanceFaultHarness,
} from "../../lib/acceptance/faults";
import { createAcceptanceGenerationExecutor } from "../../lib/acceptance/fixture";
import {
  acceptanceRunIdentity,
  inspectAcceptanceRun,
  seedAcceptanceRun,
} from "../../lib/acceptance/fixture-store";
import type {
  ConsumerControlPlane,
  GenerationExecutor,
} from "../../lib/consumer/contracts";
import { runOne } from "../../lib/consumer/run-one";
import { FileSystemConsumerSpool } from "../../lib/consumer/spool";
import type { AcceptanceScenario } from "../../lib/domain/acceptance-fixture";
import { openNodeD1Database } from "../../lib/platform/node-d1";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import {
  createInternalQueueExecutionService,
  type InternalQueueExecutionService,
} from "../../lib/server/internal-queue-execution";
import { InternalQueueService } from "../../lib/server/internal-queue-service";

const TICKET_CONFIG = {
  audience: "zaoshi-acceptance-fault-test",
  secret: "acceptance-fault-ticket-secret-at-least-thirty-two-bytes",
  ttlSeconds: 240,
};
const QUEUE_OPTIONS = {
  leaseSeconds: 180,
  ownerConcurrency: 1,
  providerConcurrency: 1,
  sweepLimit: 20,
  acceptanceEnabled: true,
};

test("claim acknowledgement loss replays the same attempt without duplicate execution", async () => {
  await withScenario("claim_ack_loss", "claim-ack-loss-0001", async (context) => {
    const fault = createAcceptanceFaultHarness({
      scenario: context.scenario,
      control: context.control,
      spool: context.spool,
    });
    await assert.rejects(
      runOne({
        ...context.runInput,
        control: fault.control,
        spool: fault.spool,
      }),
      /ACCEPTANCE_CLAIM_ACK_LOST/u,
    );
    const leased = await inspectAcceptanceRun(context.d1, context.runId);
    assert.equal(leased.itemStatus, "LEASED");
    assert.equal(leased.attemptCount, 1);

    const recovered = await runOne(context.runInput);
    assert.equal(recovered.status, "completed");
    const completed = await inspectAcceptanceRun(context.d1, context.runId);
    assert.equal(completed.itemStatus, "SUCCEEDED");
    assert.equal(completed.attemptCount, 1);
    assert.equal(context.executions.count, 1);
  });
});

test("a pre-dispatch lease expiry is swept to a safe second attempt", async () => {
  await withScenario("claim_ack_loss", "claim-ack-loss-expiry", async (context) => {
    const fault = createAcceptanceFaultHarness({
      scenario: context.scenario,
      control: context.control,
      spool: context.spool,
    });
    await assert.rejects(
      runOne({
        ...context.runInput,
        control: fault.control,
        spool: fault.spool,
      }),
      /ACCEPTANCE_CLAIM_ACK_LOST/u,
    );
    await context.d1
      .prepare("UPDATE generation_job_items SET lease_expires_at = 0 WHERE id = ?")
      .bind(context.identity.itemId)
      .run();
    const other = await seedAcceptanceRun({
      d1: context.d1,
      bucket: context.bucket,
      runId: "reconciliation-neighbor",
      scenario: "reconciliation",
    });
    const otherClaim = await context.service.claim(
      other.workerId,
      other.claimRequestId,
      "acceptance",
      other.itemId,
    );
    assert.ok(otherClaim);
    assert.equal(
      (await context.service.transition({
        fence: otherClaim.fence,
        event: "BEGIN_PREPROCESSING",
      })).result,
      "applied",
    );
    await context.d1
      .prepare("UPDATE generation_job_items SET lease_expires_at = 0 WHERE id = ?")
      .bind(other.itemId)
      .run();
    const providerSweep = await context.service.sweep();
    assert.equal(providerSweep.retried, 0);
    assert.equal(providerSweep.failed, 0);
    assert.equal(providerSweep.reconciliationRequired, 0);
    assert.equal(
      (await inspectAcceptanceRun(context.d1, context.runId)).itemStatus,
      "LEASED",
    );
    assert.equal(
      (await inspectAcceptanceRun(context.d1, other.runId)).itemStatus,
      "PREPROCESSING",
    );
    const summary = await context.service.sweep("acceptance", context.identity.itemId);
    assert.equal(summary.retried, 1);
    assert.equal(
      (await inspectAcceptanceRun(context.d1, other.runId)).itemStatus,
      "PREPROCESSING",
    );
    await context.d1
      .prepare("UPDATE generation_job_items SET next_attempt_at = 0 WHERE id = ?")
      .bind(context.identity.itemId)
      .run();

    const recovered = await runOne({
      ...context.runInput,
      claimRequestId: context.identity.recoveryClaimRequestId,
    });
    assert.equal(recovered.status, "completed");
    const completed = await inspectAcceptanceRun(context.d1, context.runId);
    assert.equal(completed.itemStatus, "SUCCEEDED");
    assert.equal(completed.attemptCount, 2);
    assert.equal(context.executions.count, 1);
  });
});

test("output acknowledgement loss replays the committed result without executing twice", async () => {
  await withScenario("output_ack_loss", "output-ack-loss-0001", async (context) => {
    const fault = createAcceptanceFaultHarness({
      scenario: context.scenario,
      control: context.control,
      spool: context.spool,
    });
    const first = await runOne({
      ...context.runInput,
      control: fault.control,
      spool: fault.spool,
    });
    assert.equal(first.status, "reconciliation-required");
    assert.equal((await context.spool.list()).length, 1);
    const committed = await inspectAcceptanceRun(context.d1, context.runId);
    assert.equal(committed.itemStatus, "SUCCEEDED");
    assert.equal(committed.outputCommitState, "COMMITTED");

    const recovered = await runOne({
      ...context.runInput,
      claimRequestId: context.identity.recoveryClaimRequestId,
    });
    assert.deepEqual(recovered, {
      status: "completed",
      attemptId: first.attemptId,
      resumed: true,
    });
    assert.equal(context.executions.count, 1);
    assert.deepEqual(await context.spool.list(), []);
  });
});

test("durable spool survives a simulated process crash and resumes without duplicate execution", async () => {
  await withScenario("spool_recovery", "spool-recovery-0001", async (context) => {
    const fault = createAcceptanceFaultHarness({
      scenario: context.scenario,
      control: context.control,
      spool: context.spool,
    });
    const first = await runOne({
      ...context.runInput,
      control: fault.control,
      spool: fault.spool,
    });
    assert.equal(first.status, "reconciliation-required");
    assert.equal((await context.spool.list()).length, 1);
    const interrupted = await inspectAcceptanceRun(context.d1, context.runId);
    assert.equal(interrupted.itemStatus, "SUBMITTING");
    assert.equal(interrupted.outputCommitState, null);

    const recovered = await runOne({
      ...context.runInput,
      claimRequestId: context.identity.recoveryClaimRequestId,
    });
    assert.equal(recovered.status, "completed");
    assert.equal(context.executions.count, 1);
    assert.deepEqual(await context.spool.list(), []);
    assert.equal(
      (await inspectAcceptanceRun(context.d1, context.runId)).outputCount,
      1,
    );
  });
});

test("post-dispatch lease expiry becomes manual reconciliation and never re-executes", async () => {
  await withScenario("reconciliation", "reconciliation-0001", async (context) => {
    const fault = createAcceptanceFaultHarness({
      scenario: context.scenario,
      control: context.control,
      spool: context.spool,
    });
    const first = await runOne({
      ...context.runInput,
      control: fault.control,
      spool: fault.spool,
    });
    assert.equal(first.status, "reconciliation-required");
    assert.equal(context.executions.count, 0);
    assert.deepEqual(await context.spool.list(), []);
    assert.equal(
      (await inspectAcceptanceRun(context.d1, context.runId)).itemStatus,
      "SUBMITTING",
    );

    await context.d1
      .prepare("UPDATE generation_job_items SET lease_expires_at = 0 WHERE id = ?")
      .bind(context.identity.itemId)
      .run();
    const summary = await context.service.sweep("acceptance", context.identity.itemId);
    assert.equal(summary.reconciliationRequired, 1);
    const reconciled = await inspectAcceptanceRun(context.d1, context.runId);
    // Public jobs intentionally remain VALIDATING while the internal item is
    // held for operator reconciliation; the ambiguous state is never exposed
    // as an automatic retry or false failure to the user.
    assert.equal(reconciled.jobStatus, "VALIDATING");
    assert.equal(reconciled.itemStatus, "RECONCILIATION_REQUIRED");
    assert.equal(reconciled.attemptState, "AMBIGUOUS");
    assert.equal(reconciled.retryClass, "ambiguous-after-provider");
    assert.equal(reconciled.attemptErrorCode, "AMBIGUOUS_PROVIDER_OUTCOME");
    assert.equal(reconciled.outputCount, 0);
    assert.equal(context.executions.count, 0);
  });
});

test("acceptance scenario is fixed by run id and cannot be relabeled", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-fault-id-")));
  try {
    const d1 = openNodeD1Database({
      databasePath: join(root, "db", "zaoshi.sqlite"),
      migrationsDirectory: join(process.cwd(), "drizzle"),
    });
    const bucket = {
      put() {
        throw new Error("MISMATCH_MUST_FAIL_BEFORE_STORAGE");
      },
    } as unknown as R2Bucket;
    await assert.rejects(
      seedAcceptanceRun({
        d1,
        bucket,
        runId: "claim-ack-loss-0002",
        scenario: "happy_path",
      }),
      /INVALID_ACCEPTANCE_SCENARIO/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type ScenarioContext = {
  scenario: AcceptanceScenario;
  runId: string;
  d1: D1Database;
  bucket: NodeObjectBucket;
  identity: ReturnType<typeof acceptanceRunIdentity>;
  service: InternalQueueService;
  control: ConsumerControlPlane;
  spool: FileSystemConsumerSpool;
  executions: { count: number };
  runInput: {
    workerId: string;
    claimRequestId: string;
    control: ConsumerControlPlane;
    executor: GenerationExecutor;
    spool: FileSystemConsumerSpool;
    heartbeatIntervalMs: number;
    expectedItemId: string;
  };
};

async function withScenario(
  scenario: AcceptanceScenario,
  runId: string,
  execute: (context: ScenarioContext) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-fault-")));
  try {
    const d1 = openNodeD1Database({
      databasePath: join(root, "db", "zaoshi.sqlite"),
      migrationsDirectory: join(process.cwd(), "drizzle"),
    });
    const bucket = new NodeObjectBucket(join(root, "objects"));
    const identity = await seedAcceptanceRun({ d1, bucket, runId, scenario });
    const queue = new D1GenerationQueue(d1);
    const execution = createInternalQueueExecutionService(
      {
        auth: {
          enabled: true,
          audience: TICKET_CONFIG.audience,
          transport: "private-docker",
          keys: new Map(),
        },
        d1,
        r2: bucket,
        ticket: TICKET_CONFIG,
        ...QUEUE_OPTIONS,
      },
      d1,
    );
    const service = new InternalQueueService(queue, QUEUE_OPTIONS, execution);
    const control = acceptanceControl(service, execution, identity);
    const spool = new FileSystemConsumerSpool(join(root, "spool"));
    const executions = { count: 0 };
    const executor = countingExecutor(executions);
    await execute({
      scenario,
      runId,
      d1,
      bucket,
      identity,
      service,
      control,
      spool,
      executions,
      runInput: {
        workerId: identity.workerId,
        claimRequestId: identity.claimRequestId,
        control,
        executor,
        spool,
        heartbeatIntervalMs: 60_000,
        expectedItemId: identity.itemId,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function acceptanceControl(
  service: InternalQueueService,
  execution: InternalQueueExecutionService,
  identity: { itemId: string },
): ConsumerControlPlane {
  return {
    claim: (workerId, claimRequestId) =>
      service.claim(workerId, claimRequestId, "acceptance", identity.itemId),
    heartbeat: async (fence) => requireApplied(await service.heartbeat(fence)),
    transition: async (input) => requireApplied(await service.transition(input)),
    work: (fence) => execution.createWork(fence),
    input: async (fence, ticket) => {
      const value = await execution.readInput(fence, ticket);
      return { bytes: value.bytes, mimeType: value.mimeType, sha256: value.sha256 };
    },
    prepareOutput: async (input) => {
      const value = await execution.prepareOutput(input);
      return { commitId: value.commitId, ticket: value.ticket };
    },
    uploadOutput: async (fence, ticket, mimeType, bytes) =>
      (await execution.uploadOutput(fence, ticket, bytes, mimeType)).result,
  };
}

function countingExecutor(counter: { count: number }): GenerationExecutor {
  const delegate = createAcceptanceGenerationExecutor();
  return {
    async prepare(work, inputs) {
      const prepared = await delegate.prepare(work, inputs);
      return {
        ...prepared,
        async execute() {
          counter.count += 1;
          return prepared.execute();
        },
      };
    },
  };
}

function requireApplied(value: { result: string }): "applied" | "already_applied" {
  if (value.result === "applied" || value.result === "already_applied") {
    return value.result;
  }
  throw new Error("TEST_CONTROL_PLANE_REJECTED");
}
