import { DisabledModeration } from "../../lib/server/machine-moderation";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { nodeImageSanitizer } from "../../lib/platform/node-image-sanitizer";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";
import { FileSystemConsumerSpool } from "../../lib/consumer/spool";
import { runOne } from "../../lib/consumer/run-one";
import type { ConsumerControlPlane } from "../../lib/consumer/contracts";
import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { InternalQueueService } from "../../lib/server/internal-queue-service";
import { InternalQueueExecutionService } from "../../lib/server/internal-queue-execution";
import { createD1QueuedJobIdempotently, type D1QueuedJobRecord } from "../../lib/server/queued-job-creation";
import { creditCredits } from "../../lib/server/credit-ledger";
import { AiServiceError } from "../../lib/ai/types";
import { PRIVATE_TEST_OWNER } from "../../lib/server/private-test";
import sharpRuntime from "sharp";

import {
  GenerationExecutionError,
  type DownloadedInput,
} from "../../lib/consumer/contracts";
import { createDomesticGenerationExecutor } from "../../lib/consumer/domestic-executor";
import { domesticImageModelCapabilities, domesticImageModelValues } from "../../lib/domain/domestic-image-models";
import type { GenerationWorkSpec } from "../../lib/domain/generation-work";
import type { ImageSanitizer } from "../../lib/platform/image-sanitizer";

const OUTPUT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const OUTPUT_PNG_BYTES = new Uint8Array(Buffer.from(OUTPUT_PNG_BASE64, "base64"));
const INPUT_PNG_BYTES = OUTPUT_PNG_BYTES.slice();
new DataView(INPUT_PNG_BYTES.buffer).setUint32(16, 512);
new DataView(INPUT_PNG_BYTES.buffer).setUint32(20, 512);
const sharp = sharpRuntime as unknown as (input: { create: { width: number; height: number; channels: 3; background: string } }) => { jpeg(): { toBuffer(): Promise<Buffer> }; png(): { toBuffer(): Promise<Buffer> } };
const testSanitizer: ImageSanitizer = {
  async sanitize(input) {
    return {
      bytes: input.bytes,
      mimeType: input.mimeType,
      width: 1,
      height: 1,
      hasAlpha: true,
    };
  },
};

test("domestic executor rejects acceptance work before any provider access", async () => {
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: {
      seedream: {
        id: "seedream-low-cost",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
      qwen: {
        id: "qwen-low-cost",
        provider: "qwen",
        apiKey: "qwen-test-key",
        workspaceId: "workspace_123",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async () => {
      calls += 1;
      throw new Error("provider network must not be reached");
    }) as typeof fetch,
  });
  const acceptance: GenerationWorkSpec = {
    ...seedreamWork(),
    executionKind: "acceptance",
    providerPreference: "acceptance-fixture-v1",
    resolution: "0.5K",
    aspectRatio: "1:1",
    quality: "draft",
    visualRealism: "conceptual",
    stylePresetId: "acceptance-fixture-v1",
    lampState: "off",
  };
  await assert.rejects(
    executor.prepare(acceptance, downloadedInputs()),
    /INVALID_PROVIDER_MODEL/u,
  );
  assert.equal(calls, 0);
});

test("Seedream 4.5 consumer carries 4K through one generation POST and sanitation", async () => {
  const outputJpegBase64 = (await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer()).toString("base64");
  const requests: Request[] = [];
  const executor = createDomesticGenerationExecutor({
    slots: {
      seedream: {
        id: "seedream-low-cost",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({ data: [{ b64_json: outputJpegBase64 }] }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "seedream-request-1",
          },
        },
      );
    }) as typeof fetch,
  });

  const prepared = await executor.prepare({ ...seedreamWork("4K"), spaceType: "bedroom" }, downloadedInputs());
  assert.equal(requests.length, 0);
  assert.deepEqual(
    {
      provider: prepared.provider,
      model: prepared.model,
      accountSlotId: prepared.accountSlotId,
    },
    {
      provider: "seedream",
      model: "doubao-seedream-4-5-251128",
      accountSlotId: "seedream-low-cost",
    },
  );

  const output = await prepared.execute();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  assert.equal((await requests[0]!.clone().json() as { size?: string }).size, "4K");
  const providerPrompt = (await requests[0]!.clone().json() as { prompt: string }).prompt;
  assert.match(providerPrompt, /卧室/u);
  assert.match(providerPrompt, /(?:low upholstered|slim oak|floating-frame) (?:platform )?bed/u);
  assert.match(providerPrompt, /full-height flush wardrobe/u);
  assert.doesNotMatch(providerPrompt, /flush media cabinet/u);
  assert.equal(
    requests[0]!.url,
    "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  );
  assert.equal(output.providerRequestId, "seedream-request-1");
  assert.equal(output.mimeType, "image/jpeg");
  assert.equal(output.sanitizationVersion, "canonical-image-v1");

  await assert.rejects(prepared.execute(), GenerationExecutionError);
  assert.equal(requests.length, 1);
});

test("Qwen consumer sends one generation POST and one result download GET", async () => {
  const requests: Request[] = [];
  const executor = createDomesticGenerationExecutor({
    slots: {
      qwen: {
        id: "qwen-low-cost",
        provider: "qwen",
        apiKey: "qwen-test-key",
        workspaceId: "workspace_123",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return new Response(OUTPUT_PNG_BYTES.slice().buffer, {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(
        JSON.stringify({
          request_id: "qwen-request-1",
          output: {
            choices: [
              {
                message: {
                  content: [
                    {
                      image:
                        "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/output.png",
                    },
                  ],
                },
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  const prepared = await executor.prepare(qwenWork(), downloadedInputs());
  assert.equal(requests.length, 0);
  const output = await prepared.execute();
  assert.equal(output.providerRequestId, "qwen-request-1");
  assert.deepEqual(requests.map((request) => request.method), ["POST", "GET"]);
  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    1,
  );
});

test("Qwen result download failure preserves the provider request id", async () => {
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: {
      qwen: {
        id: "qwen-low-cost",
        provider: "qwen",
        apiKey: "qwen-test-key",
        workspaceId: "workspace_123",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async (_input, init) => {
      calls += 1;
      if ((init?.method ?? "GET") === "GET") {
        return new Response(null, { status: 503 });
      }
      return new Response(
        JSON.stringify({
          request_id: "qwen-request-download-failed",
          output: {
            choices: [
              {
                message: {
                  content: [
                    {
                      image:
                        "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/output.png",
                    },
                  ],
                },
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  const prepared = await executor.prepare(qwenWork(), downloadedInputs());
  await assert.rejects(prepared.execute(), (error: unknown) => {
    assert.ok(error instanceof GenerationExecutionError);
    assert.equal(error.providerRequestId, "qwen-request-download-failed");
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    return true;
  });
  assert.equal(calls, 2);
});

test("output sanitation failure preserves the provider request id", async () => {
  const executor = createDomesticGenerationExecutor({
    slots: {
      seedream: {
        id: "seedream-low-cost",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
    },
    sanitizer: {
      async sanitize() {
        throw new Error("decode failed");
      },
    },
    fetch: (async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: OUTPUT_PNG_BASE64 }] }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "seedream-sanitize-failed",
          },
        },
      )) as typeof fetch,
  });
  const prepared = await executor.prepare(seedreamWork(), downloadedInputs());
  await assert.rejects(prepared.execute(), (error: unknown) => {
    assert.ok(error instanceof GenerationExecutionError);
    assert.equal(error.providerRequestId, "seedream-sanitize-failed");
    return true;
  });
});

test("a local correlation id is never recorded as a provider request id", async () => {
  const executor = createDomesticGenerationExecutor({
    slots: {
      seedream: {
        id: "seedream-low-cost",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async () => new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  const prepared = await executor.prepare(seedreamWork(), downloadedInputs());
  await assert.rejects(prepared.execute(), (error: unknown) => {
    assert.ok(error instanceof GenerationExecutionError);
    assert.equal(error.providerRequestId, null);
    return true;
  });
});

test("local validation failures make no provider request", async () => {
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: {
      seedream: {
        id: "seedream-low-cost",
        provider: "seedream",
        apiKey: "seedream-test-key",
      },
    },
    sanitizer: testSanitizer,
    fetch: (async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch,
  });

  const wrongDigest = downloadedInputs();
  wrongDigest[0] = { ...wrongDigest[0]!, bytes: OUTPUT_PNG_BYTES };
  await assert.rejects(
    executor.prepare(seedreamWork(), wrongDigest),
    /INPUT_INTEGRITY_CONFLICT/u,
  );

  const unknownStyle = seedreamWork();
  unknownStyle.stylePresetId = "not-a-real-style";
  await assert.rejects(
    executor.prepare(unknownStyle, downloadedInputs()),
    /Unknown style preset/u,
  );
  assert.equal(calls, 0);
});

test("private-test expiry crossing after preparation blocks the provider POST", async () => {
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: { seedream: { id: "seedream-low-cost", provider: "seedream", apiKey: "seedream-test-key" } },
    sanitizer: testSanitizer,
    privateTestExpiresAt: Math.floor(Date.now() / 1000) - 1,
    fetch: (async () => { calls += 1; throw new Error("provider network must not be reached"); }) as typeof fetch,
  });
  const prepared = await executor.prepare(seedreamWork(), downloadedInputs());
  await assert.rejects(prepared.execute(), GenerationExecutionError);
  assert.equal(calls, 0);
});

test("an unconfigured provider family is rejected before network access", async () => {
  let calls = 0;
  const executor = createDomesticGenerationExecutor({
    slots: {},
    sanitizer: testSanitizer,
    fetch: (async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch,
  });
  await assert.rejects(
    executor.prepare(qwenWork(), downloadedInputs()),
    /PROVIDER_ACCOUNT_SLOT_NOT_CONFIGURED/u,
  );
  assert.equal(calls, 0);
});

function seedreamWork(resolution: "2K" | "4K" = "2K"): GenerationWorkSpec {
  return work({
    providerPreference: "doubao-seedream-4-5-251128",
    resolution,
  });
}

function qwenWork(): GenerationWorkSpec {
  return work({
    providerPreference: "qwen-image-2.0-pro",
    resolution: "1K",
  });
}

function work(
  overrides: Pick<GenerationWorkSpec, "providerPreference" | "resolution">,
): GenerationWorkSpec {
  return {
    version: 1,
    executionKind: "provider",
    itemId: "qitem-executor-1",
    attemptId: "attempt-executor-1",
    outputOrdinal: 0,
    totalOutputs: 1,
    workflowType: "concept",
    purpose: "final",
    aspectRatio: "4:3",
    quality: "standard",
    visualRealism: "photorealistic",
    stylePresetId: "modern-minimalist",
    lightingPreset: "noon",
    lampState: "mixed",
    colorTemperatureKelvin: 4000,
    renovationScope: "restyle",
    promotedFromPreview: false,
    editInstruction: null,
    customPrompt: null,
    advancedSettings: null,
    outputCount: 1,
    inputs: [
      {
        role: "source",
        index: 0,
        mimeType: "image/png",
        byteSize: INPUT_PNG_BYTES.byteLength,
        sha256: digest(INPUT_PNG_BYTES),
        ticket: "t".repeat(64),
      },
    ],
    ...overrides,
  };
}

function downloadedInputs(): DownloadedInput[] {
  return [
    {
      role: "source",
      index: 0,
      mimeType: "image/png",
      bytes: INPUT_PNG_BYTES,
    },
  ];
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Sunburst Max work prepares only with its private-test slot and socket, then sends one native request", async () => {
  const requests: Request[] = [];
  const ready: string[] = [];
  const outputJpegBase64 = (await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer()).toString("base64");
  const options = {
    slots: { openai: { id: "openai-test", provider: "openai" as const, apiKey: "test-only-key" } },
    sanitizer: testSanitizer,
    privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60,
    fetch: (async () => { throw new Error("direct overseas fallback forbidden"); }) as typeof fetch,
    overseasTransport: {
      async assertReady(provider: "openai" | "google") { ready.push(provider); },
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [{ b64_json: outputJpegBase64 }] }, { headers: { "x-zaoshi-provider-request-id": "actual-sunburst-max", "x-request-id": "gateway-generated" } });
      }) as typeof fetch,
    },
  };
  const selected = { ...seedreamWork(), providerPreference: "gpt-image-2.5-sunburst" as const, quality: "max" as const };
  await assert.rejects(createDomesticGenerationExecutor({ ...options, slots: {} }).prepare(selected, downloadedInputs()), /PROVIDER_ACCOUNT_SLOT_NOT_CONFIGURED/u);
  await assert.rejects(createDomesticGenerationExecutor({ ...options, overseasTransport: undefined }).prepare(selected, downloadedInputs()), /OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED/u);
  await assert.rejects(createDomesticGenerationExecutor({ ...options, overseasTransport: { ...options.overseasTransport, async assertReady() { throw new Error("OVERSEAS_SOCKET_UNAVAILABLE"); } } }).prepare(selected, downloadedInputs()), /OVERSEAS_SOCKET_UNAVAILABLE/u);
  await assert.rejects(createDomesticGenerationExecutor({ ...options, privateTestExpiresAt: Math.floor(Date.now() / 1000) - 1 }).prepare(selected, downloadedInputs()), /OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED/u);
  assert.equal(requests.length, 0);
  const prepared = await createDomesticGenerationExecutor(options).prepare(selected, downloadedInputs());
  assert.deepEqual(ready, ["openai"]);
  assert.equal(prepared.provider, "openai"); assert.equal(prepared.model, selected.providerPreference);
  assert.equal(prepared.accountSlotId, "openai-test");
  const output = await prepared.execute();
  const native = await requests[0]!.clone().formData();
  assert.equal(requests[0]!.url, "https://api.openai.com/v1/images/edits");
  assert.equal(requests[0]!.headers.get("x-request-id"), selected.attemptId);
  assert.equal(native.get("model"), selected.providerPreference); assert.equal(native.get("quality"), "max");
  assert.equal(native.get("size"), "2048x1536"); assert.equal(native.get("n"), "1"); assert.equal(native.get("output_format"), "jpeg");
  assert.equal(native.getAll("image[]").length, 1);
  assert.deepEqual(new Uint8Array(await (native.get("image[]") as Blob).arrayBuffer()), INPUT_PNG_BYTES);
  assert.equal(output.providerRequestId, "actual-sunburst-max"); assert.equal(output.sanitizationVersion, "canonical-image-v1");
  await assert.rejects(prepared.execute(), GenerationExecutionError);
  assert.equal(requests.length, 1);
  requests.length = 0;
  const formal = { ...options, privateTestExpiresAt: undefined, publicGenerationEnabled: true };
  assert.throws(() => createDomesticGenerationExecutor({ ...options, publicGenerationEnabled: true }), /MIXED_GENERATION_MODE/u);
  await assert.rejects(createDomesticGenerationExecutor({ ...formal, publicGenerationEnabled: false }).prepare(selected, downloadedInputs()), /OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED/u);
  const commercial = await createDomesticGenerationExecutor(formal).prepare(selected, downloadedInputs());
  await commercial.execute();
  await assert.rejects(commercial.execute(), GenerationExecutionError);
  assert.equal(requests.length, 1);
});

for (const model of domesticImageModelValues) {
  test(`private-test executor preserves ${model}, slot, endpoint and output format`, async () => {
    const capability = domesticImageModelCapabilities[model];
    const selected = work({ providerPreference: model, resolution: capability.supportedResolutions[0] });
    const requests: Request[] = [];
    const jpeg = model === "doubao-seedream-4-5-251128";
    const outputBytes = jpeg ? await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer() : Buffer.from(OUTPUT_PNG_BYTES);
    const slots = {
      seedream: { id: "seedream-test", provider: "seedream" as const, apiKey: "seedream-test-key" },
      qwen: { id: "qwen-test", provider: "qwen" as const, apiKey: "qwen-test-key", workspaceId: "workspace_123" },
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") return new Response(Uint8Array.from(outputBytes).buffer, { headers: { "content-type": "image/png" } });
      return new Response(JSON.stringify(capability.provider === "seedream"
        ? { data: [{ b64_json: outputBytes.toString("base64") }] }
        : { request_id: "qwen-six", output: { choices: [{ message: { content: [{ image: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/output.png" }] } }] } }),
      { headers: { "content-type": "application/json", "x-request-id": "seedream-six" } });
    };
    const executor = createDomesticGenerationExecutor({ slots, sanitizer: testSanitizer, fetch: fakeFetch, privateTestExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const prepared = await executor.prepare(selected, downloadedInputs());
    assert.equal(prepared.model, model);
    assert.equal(prepared.provider, capability.provider);
    assert.equal(prepared.accountSlotId, `${capability.provider}-test`);
    assert.equal(requests.length, 0);
    const output = await prepared.execute();
    const post = requests[0]!;
    assert.equal(post.method, "POST");
    assert.equal(post.url, capability.provider === "seedream" ? "https://ark.cn-beijing.volces.com/api/v3/images/generations" : "https://workspace_123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    assert.equal((await post.clone().json() as { model: string }).model, model);
    assert.equal(output.mimeType, jpeg ? "image/jpeg" : "image/png");
    assert.deepEqual(requests.map((request) => request.method), capability.provider === "seedream" ? ["POST"] : ["POST", "GET"]);
    await assert.rejects(prepared.execute(), GenerationExecutionError);
    const expired = createDomesticGenerationExecutor({ slots, sanitizer: testSanitizer, fetch: fakeFetch, privateTestExpiresAt: Math.floor(Date.now() / 1000) - 1 });
    const expiredPrepared = await expired.prepare(selected, downloadedInputs());
    const before = requests.length;
    await assert.rejects(expiredPrepared.execute(), GenerationExecutionError);
    const missing = createDomesticGenerationExecutor({ slots: {}, sanitizer: testSanitizer, fetch: fakeFetch });
    await assert.rejects(missing.prepare(selected, downloadedInputs()), /PROVIDER_ACCOUNT_SLOT_NOT_CONFIGURED/u);
    assert.equal(requests.length, before);
  });
}


test("OpenAI PNG response passes real sanitizer, spool, SQLite commit and stored serving MIME once", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-openai-mime-")));
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
    const d1 = new TestD1Database(database) as unknown as D1Database;
    database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(PRIVATE_TEST_OWNER,"Private MIME test");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    await creditCredits(d1, { ownerId: PRIVATE_TEST_OWNER, amount: 10, idempotencyKey: "mime-credit", reasonCode: "TEST", actorId: "test", requestId: "mime-credit" });
    const job: D1QueuedJobRecord = { id: "job-mime-test", ownerId: PRIVATE_TEST_OWNER, sourceAssetId: null, referenceAssetId: null, additionalReferencesJson: "[]", maskAssetId: null, depthAssetId: null, normalAssetId: null, workflowType: "self-service", purpose: "final", sourceJobId: null, promotedFromAssetId: null, resolution: "2K", effectiveResolution: "2K", aspectRatio: "16:9", quality: "auto", visualRealism: "photorealistic", lampState: "off", colorTemperatureKelvin: 4000, stylePresetId: "self-service", lightingPreset: "noon", preservationMode: "structure", providerPreference: "gpt-image-2", editInstruction: null, customPrompt: "test room", outputCount: 1, advancedSettingsJson: "{}", idempotencyKey: "mime-idem", requestHash: "mime-hash", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await createD1QueuedJobIdempotently(d1, job, { amountPerItem: 1, priceVersion: "test-v1" }, { maxAttempts: 1, allowPrivateTestOverseas: true });
    const queue = new D1GenerationQueue(d1);
    const bucket = new NodeObjectBucket(join(root, "objects"));
    const expiry = { expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const execution = new InternalQueueExecutionService(d1, bucket, { audience: "mime-test", secret: "s".repeat(40), ttlSeconds: 240 }, queue, false, expiry, new DisabledModeration(d1));
    const service = new InternalQueueService(queue, { leaseSeconds: 180, ownerConcurrency: 1, providerConcurrency: 1, sweepLimit: 10 }, execution, { d1, config: expiry });
    const applied = (value: { result: string }) => { assert.equal(value.result, "applied"); return "applied" as const; };
    const control: ConsumerControlPlane = {
      claim: (worker, requestId) => service.claim(worker, requestId),
      heartbeat: async (fence) => applied(await service.heartbeat(fence)),
      transition: async (input) => applied(await service.transition(input)),
      work: (fence) => execution.createWork(fence),
      input: async (fence, ticket) => { const input = await execution.readInput(fence, ticket); return { bytes: input.bytes, mimeType: input.mimeType, sha256: input.sha256 }; },
      prepareOutput: async (input) => { const output = await execution.prepareOutput(input); return { commitId: output.commitId, ticket: output.ticket }; },
      uploadOutput: async (fence, ticket, mimeType, bytes) => (await execution.uploadOutput(fence, ticket, bytes, mimeType)).result,
    };
    let calls = 0;
    const executor = createDomesticGenerationExecutor({ slots: { openai: { id: "openai-test", provider: "openai", apiKey: "test-only-key" } }, sanitizer: nodeImageSanitizer, fetch: async () => { throw new Error("direct fallback forbidden"); }, privateTestExpiresAt: expiry.expiresAt, overseasTransport: { async assertReady() {}, fetch: async (_input, init) => { calls++; assert.equal(JSON.parse(String(init!.body)).output_format, "jpeg"); return Response.json({ data: [{ b64_json: png.toString("base64") }] }, { headers: { "x-zaoshi-provider-request-id": "actual-png-test" } }); } } });
    const spool = new FileSystemConsumerSpool(join(root, "spool"));
    let saved = 0;
    const save = spool.save.bind(spool);
    spool.save = async (record, bytes) => { saved++; assert.equal(record.mimeType, "image/png"); await save(record, bytes); };
    const input = { workerId: "mime-worker", claimRequestId: "mime-claim", control, executor, spool, heartbeatIntervalMs: 60_000 };
    assert.equal((await runOne(input)).status, "completed");
    assert.equal(calls, 1); assert.equal(saved, 1); assert.equal((await spool.list()).length, 0);
    assert.equal(database.prepare("SELECT status FROM generation_jobs WHERE id=?").get(job.id)?.status, "SUCCEEDED");
    assert.equal(database.prepare("SELECT state FROM generation_output_commits").get()?.state, "COMMITTED");
    const asset = database.prepare("SELECT mime_type,storage_key FROM assets WHERE kind='output'").get()!;
    assert.equal(asset.mime_type, "image/png"); assert.match(String(asset.storage_key), /\.png$/u);
    const stored = await bucket.get(String(asset.storage_key)); assert.ok(stored);
    assert.equal(stored.httpMetadata?.contentType, "image/png");
    const served = new Response(await stored.arrayBuffer(), { headers: { "Content-Type": String(asset.mime_type), "X-Content-Type-Options": "nosniff" } });
    assert.equal(served.headers.get("Content-Type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()).slice(0, 8), new Uint8Array([137,80,78,71,13,10,26,10]));
    assert.equal((await runOne({ ...input, claimRequestId: "mime-repeat" })).status, "idle"); assert.equal(calls, 1);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM generation_reconciliation_cases").get()?.count, 0);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});


test("overseas rejection logs one safe category and internal attempt ID without arbitrary error content", async (t) => {
  const logs: unknown[][] = [];
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  for (const [scenario, expected] of [["png", null], ["empty", "FINAL_IMAGE_COUNT"], ["invalid", "IMAGE_INVALID"], ["incomplete", "CANDIDATE_INCOMPLETE"], ["canary", "UNKNOWN"]] as const) {
    logs.length = 0; let calls = 0;
    if (scenario === "canary") {
      const from = Buffer.from;
      t.mock.method(Buffer, "from", (...args: unknown[]) => {
        if (args[0] === "AAAA" && args[1] === "base64") throw new AiServiceError({ code: "NO_IMAGE_OUTPUT", message: "SECRET_CANARY_PROMPT_TOKEN", userMessage: "test" });
        return Reflect.apply(from, Buffer, args);
      });
    }
    const google = scenario === "incomplete";
    const selected = { ...seedreamWork(), providerPreference: google ? "gemini-3-pro-image" as const : "gpt-image-2" as const, quality: "auto" as const };
    const executor = createDomesticGenerationExecutor({
      slots: google ? { google: { id: "google-test", provider: "google", apiKey: "test-only-key" } } : { openai: { id: "openai-test", provider: "openai", apiKey: "test-only-key" } },
      sanitizer: nodeImageSanitizer,
      fetch: async () => { throw new Error("direct fallback forbidden"); },
      privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60,
      overseasTransport: { async assertReady() {}, fetch: async () => { calls++; return Response.json(google ? { candidates: [] } : { data: scenario === "empty" ? [] : [{ b64_json: scenario === "invalid" ? "bad==" : scenario === "canary" ? "AAAA" : png.toString("base64") }] }); } },
    });
    const prepared = await executor.prepare(selected, downloadedInputs());
    if (expected === null) { assert.equal((await prepared.execute()).mimeType, "image/png"); assert.equal(logs.length, 0); }
    else {
      await assert.rejects(prepared.execute(), GenerationExecutionError);
      assert.deepEqual(logs, [["zaoshi.overseas_image_rejected", { attemptId: selected.attemptId, reason: expected }]]);
      assert.doesNotMatch(JSON.stringify(logs), /SECRET_CANARY_PROMPT_TOKEN/u);
    }
    await assert.rejects(prepared.execute()); assert.equal(calls, 1);
    assert.equal(logs.length, expected === null ? 0 : 1);
  }
});
