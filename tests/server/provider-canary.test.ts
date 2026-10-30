import { DisabledModeration } from "../../lib/server/machine-moderation";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharpRuntime from "sharp";

import {
  PROVIDER_CANARY_FIXTURE_BYTES,
  PROVIDER_CANARY_FIXTURE_HEIGHT,
  PROVIDER_CANARY_FIXTURE_MIME_TYPE,
  PROVIDER_CANARY_FIXTURE_SHA256,
  PROVIDER_CANARY_FIXTURE_WIDTH,
  PROVIDER_CANARY_MODEL,
} from "../../lib/canary/provider-fixture";
import {
  inspectProviderCanary,
  PROVIDER_CANARY_IDENTITY,
  seedProviderCanary,
} from "../../lib/canary/provider-store";
import { createProviderCanaryExecutor } from "../../lib/canary/provider-executor";
import { createDurablePaidRunMarker } from "../../lib/canary/paid-marker";
import type { ConsumerControlPlane } from "../../lib/consumer/contracts";
import type { GenerationWorkSpec } from "../../lib/domain/generation-work";
import { runOne } from "../../lib/consumer/run-one";
import { FileSystemConsumerSpool } from "../../lib/consumer/spool";
import { openNodeD1Database } from "../../lib/platform/node-d1";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import {
  InternalQueueExecutionService,
} from "../../lib/server/internal-queue-execution";
import { InternalQueueService } from "../../lib/server/internal-queue-service";

const TICKET = {
  audience: "provider-canary-test",
  secret: "provider-canary-ticket-secret-at-least-thirty-two-bytes",
  ttlSeconds: 240,
};
const QUEUE = {
  leaseSeconds: 180,
  ownerConcurrency: 1,
  providerConcurrency: 1,
  sweepLimit: 10,
  acceptanceEnabled: false,
};
const sharp = sharpRuntime as unknown as (input: Uint8Array) => { jpeg(): { toBuffer(): Promise<Buffer> } };

test("fixed provider Canary seeds one item and executes one Seedream POST", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-provider-canary-")));
  try {
    const outputJpegBase64 = (await sharp(PROVIDER_CANARY_FIXTURE_BYTES).jpeg().toBuffer()).toString("base64");
    const d1 = openNodeD1Database({
      databasePath: join(root, "db", "zaoshi.sqlite"),
      migrationsDirectory: join(process.cwd(), "drizzle"),
    });
    const bucket = new NodeObjectBucket(join(root, "objects"));
    await d1.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").bind(PROVIDER_CANARY_IDENTITY.ownerId,"Canary test").run();
    const first = await seedProviderCanary({ d1, bucket });
    const replay = await seedProviderCanary({ d1, bucket });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(PROVIDER_CANARY_FIXTURE_BYTES.byteLength, 3315);
    assert.equal(
      PROVIDER_CANARY_FIXTURE_SHA256,
      "e52b5613031ed024b693e31f8a22e08812f269c49f3e4f78dcd3987f5113b282",
    );
    const seeded = await inspectProviderCanary({ d1, bucket });
    assert.equal(seeded.model, PROVIDER_CANARY_MODEL);
    assert.equal(seeded.jobStatus, "QUEUED");
    assert.equal(seeded.attemptCount, 0);
    assert.equal(seeded.maxAttempts, 1);
    assert.deepEqual(seeded.input, {
      mimeType: "image/png",
      byteSize: PROVIDER_CANARY_FIXTURE_BYTES.byteLength,
      sha256: PROVIDER_CANARY_FIXTURE_SHA256,
      width: PROVIDER_CANARY_FIXTURE_WIDTH,
      height: PROVIDER_CANARY_FIXTURE_HEIGHT,
    });

    const queue = new D1GenerationQueue(d1);
    const execution = new InternalQueueExecutionService(d1, bucket, TICKET, queue, false, null, new DisabledModeration(d1));
    const service = new InternalQueueService(queue, QUEUE, execution);
    let calls = 0;
    const fetchMock: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, PROVIDER_CANARY_MODEL);
      assert.equal(body.size, "2K");
      assert.equal(body.response_format, "b64_json");
      assert.ok(Array.isArray(body.image));
      return new Response(
        JSON.stringify({
          model: PROVIDER_CANARY_MODEL,
          data: [{ b64_json: outputJpegBase64 }],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "provider-canary-request-1",
          },
        },
      );
    };
    const spool = new FileSystemConsumerSpool(join(root, "spool"));
    const result = await runOne({
      workerId: "provider-canary-test",
      claimRequestId: "claim-provider-canary-test",
      control: providerControl(service, execution),
      executor: createProviderCanaryExecutor({
        slot: {
          id: "seedream-canary-test",
          provider: "seedream",
          apiKey: "seedream-test-key",
        },
        fetch: fetchMock,
      }),
      spool,
      heartbeatIntervalMs: 60_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    const repeated = await runOne({
      workerId: "provider-canary-test",
      claimRequestId: "claim-provider-canary-repeat",
      control: providerControl(service, execution),
      executor: createProviderCanaryExecutor({
        slot: {
          id: "seedream-canary-test",
          provider: "seedream",
          apiKey: "seedream-test-key",
        },
        fetch: fetchMock,
      }),
      spool,
      heartbeatIntervalMs: 60_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    assert.equal(repeated.status, "idle");
    assert.equal(calls, 1);
    const completed = await inspectProviderCanary({ d1, bucket });
    assert.equal(completed.jobStatus, "SUCCEEDED");
    assert.equal(completed.itemStatus, "SUCCEEDED");
    assert.equal(completed.attemptState, "SUCCEEDED");
    assert.equal(completed.attemptCount, 1);
    assert.equal(completed.outputCommitState, "COMMITTED");
    assert.equal(completed.outputRelationCount, 1);
    assert.equal(completed.providerRequestId, "provider-canary-request-1");
    assert.equal(completed.reconciliationCount, 0);
    assert.equal(completed.deadLetterCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider Canary executor rejects unauthorized work before provider fetch", async () => {
  let fetchCalls = 0;
  const executor = createProviderCanaryExecutor({
    slot: {
      id: "seedream-canary-test",
      provider: "seedream",
      apiKey: "seedream-test-key",
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response("unexpected", { status: 500 });
    },
  });
  const base = authorizedWork();
  for (const [work, inputs] of [
    [{ ...base, itemId: "qitem-provider-canary-wrong" }, authorizedInputs()],
    [
      { ...base, providerPreference: "doubao-seedream-5-0-pro-260628" },
      authorizedInputs(),
    ],
    [base, [{ ...authorizedInputs()[0]!, bytes: Uint8Array.from([1, 2, 3]) }]],
  ] as const) {
    await assert.rejects(
      executor.prepare(work as GenerationWorkSpec, inputs),
      /PROVIDER_CANARY_WORK_CONFLICT/u,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("durable paid marker syncs file and directory before work can continue", async () => {
  const events: string[] = [];
  const handle = (prefix: string) => ({
    async writeFile() {
      events.push(`${prefix}:write`);
    },
    async sync() {
      events.push(`${prefix}:sync`);
    },
    async close() {
      events.push(`${prefix}:close`);
    },
  });
  let opens = 0;
  await createDurablePaidRunMarker(
    "/isolated/spool/.paid-run-used",
    "authorized\n",
    {
      async open(_path, flags) {
        opens += 1;
        events.push(`open:${flags}`);
        return handle(opens === 1 ? "file" : "directory");
      },
    },
  );
  events.push("provider-eligible");
  assert.deepEqual(events, [
    "open:wx",
    "file:write",
    "file:sync",
    "file:close",
    "open:r",
    "directory:sync",
    "directory:close",
    "provider-eligible",
  ]);
});

test("provider Canary recovers a committed output acknowledgement without a second POST", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-provider-recover-")));
  try {
    const d1 = openNodeD1Database({
      databasePath: join(root, "db", "zaoshi.sqlite"),
      migrationsDirectory: join(process.cwd(), "drizzle"),
    });
    const bucket = new NodeObjectBucket(join(root, "objects"));
    await d1.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").bind(PROVIDER_CANARY_IDENTITY.ownerId,"Canary test").run();
    await seedProviderCanary({ d1, bucket });
    const queue = new D1GenerationQueue(d1);
    const execution = new InternalQueueExecutionService(d1, bucket, TICKET, queue, false, null, new DisabledModeration(d1));
    const service = new InternalQueueService(queue, QUEUE, execution);
    const underlying = providerControl(service, execution);
    let loseAck = true;
    const control: ConsumerControlPlane = {
      ...underlying,
      uploadOutput: async (...args) => {
        const result = await underlying.uploadOutput(...args);
        if (loseAck) {
          loseAck = false;
          throw new Error("simulated committed ACK loss");
        }
        return result;
      },
    };
    const outputJpegBase64 = (await sharp(PROVIDER_CANARY_FIXTURE_BYTES).jpeg().toBuffer()).toString("base64");
    let fetchCalls = 0;
    const executor = createProviderCanaryExecutor({
      slot: {
        id: "seedream-canary-test",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            model: PROVIDER_CANARY_MODEL,
            data: [{ b64_json: outputJpegBase64 }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "provider-canary-recovery-request",
            },
          },
        );
      },
    });
    const spool = new FileSystemConsumerSpool(join(root, "spool"));
    const first = await runOne({
      workerId: "provider-canary-first",
      claimRequestId: "provider-canary-first-claim",
      control,
      executor,
      spool,
      heartbeatIntervalMs: 60_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    assert.equal(first.status, "reconciliation-required");
    assert.equal(fetchCalls, 1);
    const recovered = await runOne({
      workerId: "provider-canary-recover",
      claimRequestId: "provider-canary-recover-must-not-claim",
      control,
      executor: {
        async prepare(): Promise<never> {
          throw new Error("provider must stay disabled during recovery");
        },
      },
      spool,
      heartbeatIntervalMs: 60_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    assert.equal(recovered.status, "completed");
    assert.equal(fetchCalls, 1);
    assert.equal((await spool.list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function authorizedWork(): GenerationWorkSpec {
  return {
    version: 1,
    executionKind: "provider",
    itemId: PROVIDER_CANARY_IDENTITY.itemId,
    attemptId: "attempt-provider-canary-test",
    outputOrdinal: 0,
    totalOutputs: 1,
    providerPreference: PROVIDER_CANARY_MODEL,
    workflowType: "concept",
    spaceType: "unspecified",
    purpose: "final",
    resolution: "2K",
    aspectRatio: "1:1",
    quality: "draft",
    visualRealism: "photorealistic",
    stylePresetId: "modern-minimalist",
    lightingPreset: "noon",
    lampState: "mixed",
    colorTemperatureKelvin: 4000,
    renovationScope: "replace-soft-furnishings",
    promotedFromPreview: false,
    editInstruction: null,
    customPrompt: null,
    advancedSettings: null,
    outputCount: 1,
    inputs: [
      {
        role: "source",
        index: 0,
        mimeType: PROVIDER_CANARY_FIXTURE_MIME_TYPE,
        byteSize: PROVIDER_CANARY_FIXTURE_BYTES.byteLength,
        sha256: PROVIDER_CANARY_FIXTURE_SHA256,
        ticket: "t".repeat(64),
      },
    ],
  };
}

function authorizedInputs() {
  return [
    {
      role: "source",
      index: 0,
      mimeType: PROVIDER_CANARY_FIXTURE_MIME_TYPE,
      bytes: PROVIDER_CANARY_FIXTURE_BYTES,
    },
  ];
}

function providerControl(
  service: InternalQueueService,
  execution: InternalQueueExecutionService,
): ConsumerControlPlane {
  return {
    claim: (workerId, claimRequestId) =>
      service.claim(workerId, claimRequestId, "provider"),
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
