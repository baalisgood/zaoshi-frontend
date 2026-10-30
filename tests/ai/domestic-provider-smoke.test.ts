import assert from "node:assert/strict";
import test from "node:test";

import { AiServiceError } from "../../lib/ai/index";
import {
  buildSmokeRequest,
  parseSmokeArgs,
  runDomesticProviderSmoke,
  SmokeCliError,
  type SmokeModel,
} from "../../scripts/domestic-provider-smoke";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

function expectCliError(code: string, argv: string[]): void {
  assert.throws(
    () => parseSmokeArgs(argv),
    (error: unknown) => error instanceof SmokeCliError && error.code === code,
  );
}

test("domestic smoke CLI requires an exact model and two explicit confirmations", () => {
  expectCliError("MODEL_REQUIRED", []);
  expectCliError("LIVE_CONFIRMATION_REQUIRED", ["doubao-seedream-5-0-pro-260628", "--confirm-cost=ONE_IMAGE"]);
  expectCliError("COST_CONFIRMATION_REQUIRED", ["doubao-seedream-5-0-pro-260628", "--live"]);
  expectCliError("UNKNOWN_ARGUMENT", ["doubao-seedream-5-0-pro-260628", "--live", "--confirm-cost=yes"]);
  expectCliError("UNKNOWN_ARGUMENT", ["doubao-seedream-5-0-pro-260628", "--live", "--confirm-cost=ONE_IMAGE", "--endpoint=https://example.com"]);
  expectCliError("UNKNOWN_ARGUMENT", ["doubao-seedream-5-0-pro-260628", "--live", "--confirm-cost=ONE_IMAGE", "--model=qwen-image-3.0-pro"]);
  expectCliError("MODEL_NOT_ALLOWED", ["doubao-seedream-5-0-260128", "--live", "--confirm-cost=ONE_IMAGE"]);
  expectCliError("TOO_MANY_MODELS", ["doubao-seedream-5-0-pro-260628", "qwen-image-3.0-pro", "--live", "--confirm-cost=ONE_IMAGE"]);
  expectCliError("DUPLICATE_LIVE_FLAG", ["qwen-image-3.0-pro", "--live", "--live", "--confirm-cost=ONE_IMAGE"]);
  expectCliError("DUPLICATE_COST_CONFIRMATION", ["qwen-image-3.0-pro", "--live", "--confirm-cost=ONE_IMAGE", "--confirm-cost=ONE_IMAGE"]);
  assert.deepEqual(parseSmokeArgs(["--help"]), { help: true });
  assert.deepEqual(parseSmokeArgs(["qwen-image-3.0-pro", "--live", "--confirm-cost=ONE_IMAGE"]), { help: false, model: "qwen-image-3.0-pro" });
  assert.deepEqual(parseSmokeArgs(["qwen-image-2.0-pro", "--live", "--confirm-cost=ONE_IMAGE"]), { help: false, model: "qwen-image-2.0-pro" });
});

test("domestic smoke requests are fixed to one text-only output", () => {
  const cases: Array<[SmokeModel, "1K" | "2K"]> = [
    ["doubao-seedream-5-0-pro-260628", "2K"],
    ["doubao-seedream-4-5-251128", "2K"],
    ["qwen-image-3.0-pro", "1K"],
    ["qwen-image-2.0-pro", "1K"],
  ];
  for (const [model, resolution] of cases) {
    const request = buildSmokeRequest(model);
    assert.equal(request.providerPreference, model);
    assert.equal(request.resolution, resolution);
    assert.equal(request.outputCount, 1);
    assert.equal(request.workflowType, "self-service");
    assert.equal(request.purpose, "final");
    assert.equal(request.sourceImage, undefined);
    assert.equal(request.referenceImages, undefined);
    assert.equal(request.mask, undefined);
  }
});

test("Seedream smoke uses the fixed official endpoint and returns a redacted summary", async () => {
  let calls = 0;
  let writtenPath = "";
  let writtenBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const secret = "sentinel-secret-key";
  const result = await runDomesticProviderSmoke({
    model: "doubao-seedream-5-0-pro-260628",
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: secret },
    now: (() => { let value = 1000; return () => value += 25; })(),
    fetch: (async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://ark.cn-beijing.volces.com/api/v3/images/generations");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "doubao-seedream-5-0-pro-260628");
      assert.equal(body.size, "2K");
      assert.equal("image" in body, false);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "request id/unsafe" },
      });
    }) as typeof fetch,
    writeOutput: async (path, bytes) => { writtenPath = path; writtenBytes = bytes; },
  });
  assert.equal(calls, 1);
  assert.equal(result.provider, "seedream");
  assert.equal(result.model, "doubao-seedream-5-0-pro-260628");
  assert.equal(result.requestId, "request_id_unsafe");
  assert.equal(result.outputCount, 1);
  assert.equal(result.byteSize, PNG_BYTES.byteLength);
  assert.match(writtenPath, /outputs\/domestic-smoke\/1025-seedream\.png$/u);
  assert.deepEqual(writtenBytes, PNG_BYTES);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
});

test("Qwen smoke uses only its configured Beijing workspace endpoint", async () => {
  for (const [model, resultHost] of [
    ["qwen-image-3.0-pro", "dashscope-result-bj.oss-cn-beijing.aliyuncs.com"],
    ["qwen-image-2.0-pro", "dashscope-result-sh.oss-cn-shanghai.aliyuncs.com"],
  ] as const) {
    const urls: string[] = [];
    const result = await runDomesticProviderSmoke({
      model,
      env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "dash-secret", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
      now: () => 2000,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("dashscope-result")) {
          return new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } });
        }
        return new Response(JSON.stringify({
          request_id: "qwen-smoke",
          output: { choices: [{ message: { content: [{ image: `https://${resultHost}/smoke.png` }] } }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
      writeOutput: async () => undefined,
    });
    assert.deepEqual(urls, [
      "https://workspace_123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      `https://${resultHost}/smoke.png`,
    ]);
    assert.equal(result.provider, "qwen");
    assert.equal(result.model, model);
    assert.equal(result.byteSize, PNG_BYTES.byteLength);
  }
});

test("Qwen smoke uses one overall deadline across generation and result download", async () => {
  const controller = new AbortController();
  let notifyDownloadStarted: (() => void) | undefined;
  const downloadStarted = new Promise<void>((resolve) => { notifyDownloadStarted = resolve; });
  const result = runDomesticProviderSmoke({
    model: "qwen-image-3.0-pro",
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "dash-secret", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    signal: controller.signal,
    fetch: (async (input, init) => {
      if (!String(input).includes("dashscope-result")) {
        return new Response(JSON.stringify({
          request_id: "qwen-deadline",
          output: { choices: [{ message: { content: [{ image: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/deadline.png" }] } }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      notifyDownloadStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch,
    writeOutput: async () => undefined,
  });
  await downloadStarted;
  controller.abort(new DOMException("overall deadline", "TimeoutError"));
  await assert.rejects(result, (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_TIMEOUT");
});

test("domestic smoke fails closed before fetch when runtime credentials are incomplete", async () => {
  let calls = 0;
  const fetchMock = (async () => { calls += 1; return new Response(null, { status: 500 }); }) as typeof fetch;
  await assert.rejects(runDomesticProviderSmoke({ model: "doubao-seedream-5-0-pro-260628", env: { BACKEND_PROFILE: "sites-demo", ARK_API_KEY: "key" }, fetch: fetchMock, writeOutput: async () => undefined }));
  await assert.rejects(runDomesticProviderSmoke({ model: "doubao-seedream-5-0-pro-260628", env: { BACKEND_PROFILE: "cn-production" }, fetch: fetchMock, writeOutput: async () => undefined }));
  await assert.rejects(runDomesticProviderSmoke({ model: "qwen-image-3.0-pro", env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "https://example.com" }, fetch: fetchMock, writeOutput: async () => undefined }));
  assert.equal(calls, 0);
});
