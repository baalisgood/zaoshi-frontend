import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectAcceptanceRun,
  seedAcceptanceRun,
} from "../../lib/acceptance/fixture-store";
import { createAcceptanceGenerationExecutor } from "../../lib/acceptance/fixture";
import {
  ACCEPTANCE_FIXTURE_BYTE_SIZE,
  ACCEPTANCE_FIXTURE_MIME_TYPE,
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_PROMPT_VERSION,
} from "../../lib/domain/acceptance-fixture";
import type {
  ConsumerControlPlane,
} from "../../lib/consumer/contracts";
import { runOne } from "../../lib/consumer/run-one";
import { FileSystemConsumerSpool } from "../../lib/consumer/spool";
import { openNodeD1Database } from "../../lib/platform/node-d1";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import {
  createInternalQueueExecutionService,
  type InternalQueueExecutionService,
} from "../../lib/server/internal-queue-execution";
import { InternalQueueService } from "../../lib/server/internal-queue-service";

const TICKET_CONFIG = {
  audience: "zaoshi-acceptance-test",
  secret: "acceptance-ticket-secret-that-is-at-least-thirty-two-bytes",
  ttlSeconds: 240,
};
const QUEUE_OPTIONS = {
  leaseSeconds: 180,
  ownerConcurrency: 1,
  providerConcurrency: 1,
  sweepLimit: 20,
  acceptanceEnabled: true,
};

test("fixed acceptance executor completes only its targeted run without a provider", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-acceptance-")));
  try {
    const d1 = openNodeD1Database({
      databasePath: join(root, "db", "zaoshi.sqlite"),
      migrationsDirectory: join(process.cwd(), "drizzle"),
    });
    const bucket = new NodeObjectBucket(join(root, "objects"));
    const other = await seedAcceptanceRun({
      d1,
      bucket,
      runId: "happy-path-0000",
    });
    const identity = await seedAcceptanceRun({
      d1,
      bucket,
      runId: "happy-path-0001",
    });
    await seedAcceptanceRun({ d1, bucket, runId: identity.runId });

    const queue = new D1GenerationQueue(d1);
    const disabled = new InternalQueueService(queue, {
      ...QUEUE_OPTIONS,
      acceptanceEnabled: false,
    });
    await assert.rejects(
      disabled.claim("acceptance-disabled", "acceptance-disabled", "acceptance"),
      hasCode("QUEUE_ACCEPTANCE_DISABLED"),
    );

    const execution = createInternalQueueExecutionService(
      {
        auth: {
          enabled: true,
          audience: "zaoshi-acceptance-test",
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
    assert.equal(await service.claim("provider-worker", "provider-claim"), null);

    const spool = new FileSystemConsumerSpool(join(root, "spool"));
    const result = await runOne({
      workerId: identity.workerId,
      claimRequestId: identity.claimRequestId,
      control: acceptanceControl(service, execution, identity),
      executor: createAcceptanceGenerationExecutor(),
      spool,
      heartbeatIntervalMs: 60_000,
      expectedItemId: identity.itemId,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(await spool.list(), []);
    const completedInspection = await inspectAcceptanceRun(d1, identity.runId);
    assert.deepEqual(completedInspection, {
      runId: identity.runId,
      scenario: "happy_path",
      jobStatus: "SUCCEEDED",
      itemStatus: "SUCCEEDED",
      attemptCount: 1,
      leaseGeneration: 1,
      leaseExpiresAt: null,
      nextAttemptAt: completedInspection.nextAttemptAt,
      lastErrorCode: null,
      lastErrorRetryable: null,
      attemptState: "SUCCEEDED",
      executionProvider: "acceptance",
      executionModel: "acceptance-fixture-v1",
      retryClass: null,
      attemptErrorCode: null,
      outputCommitState: "COMMITTED",
      outputCount: 1,
    });
    const queuedInspection = await inspectAcceptanceRun(d1, other.runId);
    assert.deepEqual(queuedInspection, {
      runId: other.runId,
      scenario: "happy_path",
      jobStatus: "QUEUED",
      itemStatus: "QUEUED",
      attemptCount: 0,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      nextAttemptAt: queuedInspection.nextAttemptAt,
      lastErrorCode: null,
      lastErrorRetryable: null,
      attemptState: null,
      executionProvider: null,
      executionModel: null,
      retryClass: null,
      attemptErrorCode: null,
      outputCommitState: null,
      outputCount: 0,
    });
    const committed = await d1
      .prepare(
        `SELECT upload_request_id, provider_request_id, prompt_template_version,
                mime_type, byte_size, sha256
         FROM generation_output_commits WHERE item_id = ?`,
      )
      .bind(identity.itemId)
      .first<{
        upload_request_id: string;
        provider_request_id: string | null;
        prompt_template_version: string;
        mime_type: string;
        byte_size: number;
        sha256: string;
      }>();
    assert.ok(committed);
    const disabledExecution = createInternalQueueExecutionService(
      {
        auth: {
          enabled: true,
          audience: "zaoshi-acceptance-test",
          transport: "private-docker",
          keys: new Map(),
        },
        d1,
        r2: bucket,
        ticket: TICKET_CONFIG,
        ...QUEUE_OPTIONS,
        acceptanceEnabled: false,
      },
      d1,
    );
    await assert.rejects(
      disabledExecution.prepareOutput({
        fence: {
          itemId: identity.itemId,
          leaseToken: "disabled-acceptance-replay",
          leaseGeneration: 1,
        },
        uploadRequestId: committed.upload_request_id,
        providerRequestId: committed.provider_request_id,
        promptTemplateVersion: committed.prompt_template_version,
        sanitizationVersion: null,
        mimeType: committed.mime_type,
        byteSize: committed.byte_size,
        sha256: committed.sha256,
      }),
      hasCode("QUEUE_ACCEPTANCE_DISABLED"),
    );
    const otherClaim = await service.claim(
      other.workerId,
      other.claimRequestId,
      "acceptance",
      other.itemId,
    );
    assert.ok(otherClaim);
    await assert.rejects(
      disabled.heartbeat(otherClaim.fence),
      hasCode("QUEUE_ACCEPTANCE_DISABLED"),
    );
    for (const transition of [
      { fence: otherClaim.fence, event: "BEGIN_PREPROCESSING" as const },
      {
        fence: otherClaim.fence,
        event: "FAIL_BEFORE_PROVIDER" as const,
        errorCode: "ACCEPTANCE_DISABLED_TEST",
        errorMessage: "Acceptance disabled test",
        errorRetryable: false,
      },
      {
        fence: otherClaim.fence,
        event: "MARK_AMBIGUOUS" as const,
        errorCode: "ACCEPTANCE_DISABLED_TEST",
        errorMessage: "Acceptance disabled test",
        providerRequestId: null,
      },
    ]) {
      await assert.rejects(
        disabled.transition(transition),
        hasCode("QUEUE_ACCEPTANCE_DISABLED"),
      );
    }
    assert.equal(
      (await service.transition({
        fence: otherClaim.fence,
        event: "BEGIN_PREPROCESSING",
      })).result,
      "applied",
    );
    assert.equal(
      (await service.transition({
        fence: otherClaim.fence,
        event: "BEGIN_ACCEPTANCE_EXECUTION",
      })).result,
      "applied",
    );
    assert.equal(
      (await service.transition({
        fence: otherClaim.fence,
        event: "RECORD_ACCEPTANCE_RESULT",
      })).result,
      "applied",
    );
    const prepared = await execution.prepareOutput({
      fence: otherClaim.fence,
      uploadRequestId: "upload-acceptance-kill-switch",
      providerRequestId: null,
      promptTemplateVersion: ACCEPTANCE_PROMPT_VERSION,
      sanitizationVersion: null,
      mimeType: ACCEPTANCE_FIXTURE_MIME_TYPE,
      byteSize: ACCEPTANCE_FIXTURE_BYTE_SIZE,
      sha256: ACCEPTANCE_FIXTURE_SHA256,
    });
    assert.equal(prepared.result, "prepared");
    await d1
      .prepare(
        "UPDATE generation_job_items SET lease_expires_at = 0 WHERE id = ?",
      )
      .bind(other.itemId)
      .run();
    assert.deepEqual(await service.sweep(), {
      retried: 0,
      failed: 0,
      reconciliationRequired: 0,
      outputsRecovered: 0,
      outputReconciliationRequired: 0,
    });
    assert.equal(
      (await inspectAcceptanceRun(d1, other.runId)).outputCommitState,
      "PREPARED",
    );
    const killSwitchService = new InternalQueueService(
      queue,
      { ...QUEUE_OPTIONS, acceptanceEnabled: false },
      disabledExecution,
    );
    assert.deepEqual(await killSwitchService.sweep(), {
      retried: 0,
      failed: 0,
      reconciliationRequired: 0,
      outputsRecovered: 0,
      outputReconciliationRequired: 0,
    });
    const frozen = await inspectAcceptanceRun(d1, other.runId);
    assert.equal(frozen.itemStatus, "PERSISTING");
    assert.equal(frozen.outputCommitState, "PREPARED");
    assert.deepEqual(
      (await d1.prepare("PRAGMA foreign_key_check").all()).results,
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function acceptanceControl(
  service: InternalQueueService,
  execution: InternalQueueExecutionService,
  identity: { itemId: string },
): ConsumerControlPlane {
  return {
    claim: (workerId, claimRequestId) =>
      service.claim(
        workerId,
        claimRequestId,
        "acceptance",
        identity.itemId,
      ),
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

function requireApplied(value: { result: string }): "applied" | "already_applied" {
  if (value.result === "applied" || value.result === "already_applied") {
    return value.result;
  }
  throw new Error("TEST_CONTROL_PLANE_REJECTED");
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
