import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AiServiceError, generateInteriorImages, prepareDomesticSingleImageGeneration, type GenerateInteriorImagesRequest } from "../../lib/ai/index";
import { compileInteriorPrompt, V2_PROMPT_TEMPLATE_VERSION, V3_PROMPT_TEMPLATE_VERSION, V4_PROMPT_TEMPLATE_VERSION, MODERN_WALNUT_PROMPT_TEMPLATE_VERSION, FRENCH_SAGE_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V4_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V5_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V6_PROMPT_TEMPLATE_VERSION, INDUSTRIAL_CARAMEL_V7_PROMPT_TEMPLATE_VERSION } from "../../lib/ai/prompt";
import { getStylePreset } from "../../lib/ai/styles";
import type { VisualRealism } from "../../lib/ai/types";
import { KLING_IMAGE_MODEL, KLING_IMAGE_URL } from "../../lib/ai/domestic-config";
import { klingProvider } from "../../lib/ai/providers/kling";
import { isApprovedQwenResultHost, qwenProvider } from "../../lib/ai/providers/qwen";
import { seedreamProvider } from "../../lib/ai/providers/seedream";
import { mapDomesticHttpError, orderedProviderImages, withInputLegend } from "../../lib/ai/providers/domestic-common";
import { PROVIDER_CANARY_FIXTURE_BYTES } from "../../lib/canary/provider-fixture";
import { domesticImageModelCapabilities, domesticImageModelProvider, domesticImageModelValues } from "../../lib/domain/domestic-image-models";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////" +
  "2wBDAf//////////////////////////////////////////////////////////////////////////////////////" +
  "wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/" +
  "9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/" +
  "aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/" +
  "aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//" +
  "8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/" +
  "aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";
const JPEG_BYTES = new Uint8Array(Buffer.from(JPEG_BASE64, "base64"));
const INPUT_PNG_BYTES = PNG_BYTES.slice();
new DataView(INPUT_PNG_BYTES.buffer).setUint32(16, 512);
new DataView(INPUT_PNG_BYTES.buffer).setUint32(20, 512);

function makeRequest(providerPreference: GenerateInteriorImagesRequest["providerPreference"]): GenerateInteriorImagesRequest {
  return {
    sourceImage: { bytes: INPUT_PNG_BYTES, mimeType: "image/png", fileName: "room.png" },
    workflowType: "concept",
    resolution: "1K",
    aspectRatio: "4:3",
    quality: "standard",
    style: { presetId: "modern-minimalist" },
    lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 },
    renovationScope: "restyle",
    outputCount: 1,
    providerPreference,
  };
}

function imageResponse() {
  return new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } });
}

test("all six domestic adapters receive the complete v2 prompt without shortening", async () => {
  for (const model of domesticImageModelValues) {
    const request = makeRequest(model);
    request.designSchemeId = "modern-minimalist-01-v2";
    request.resolution = model.startsWith("doubao-") ? "2K" : "1K";
    const expected = compileInteriorPrompt(request, getStylePreset(request.style.presetId)!).text;
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: model.startsWith("doubao-") ? { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" } : { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "test-key", DASHSCOPE_WORKSPACE_ID: "ws-izvs9scwesm7icuy" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/")) return imageResponse();
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentPrompt = model.startsWith("doubao-") ? String(body.prompt) : String(((body.input as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0].content).at(-1)?.text);
        return model.startsWith("doubao-")
          ? new Response(JSON.stringify({ model, data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, V2_PROMPT_TEMPLATE_VERSION);
    await prepared.execute();
    assert.equal(sentPrompt, `${expected}\nInput image order: Image 1: primary room or plan input.${model.startsWith("doubao-") ? "\nCreate variation 1 of 1." : ""}`, model);
  }
});

test("domestic adapters reject missing or cross-family model IDs without fetching", async () => {
  let calls = 0;
  const context = { apiKey: "key", fetch: (async () => { calls += 1; return new Response(null, { status: 500 }); }) as typeof fetch, prompt: "prompt", promptTemplateVersion: "test", baseUrl: "https://unused.invalid" };
  const seedream = makeRequest("doubao-seedream-5-0-pro-260628"); seedream.resolution = "2K";
  await assert.rejects(seedreamProvider.generate(seedream, context), (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED");
  await assert.rejects(qwenProvider.generate(makeRequest("qwen-image-3.0-pro"), { ...context, model: "doubao-seedream-5-0-pro-260628" }), (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("all three Seedream choices send the selected model and Seedream 5.0 variants request PNG", async () => {
  for (const model of ["doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-260128", "doubao-seedream-4-5-251128"] as const) {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const request = makeRequest(model);
    request.resolution = "2K";
    const result = await generateInteriorImages(request, {
      env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "ark-key" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const output = model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64;
        return new Response(JSON.stringify({ model, data: [{ b64_json: output }] }), { status: 200, headers: { "Content-Type": "application/json", "x-request-id": `seedream-${model}` } });
      }) as typeof fetch,
    });
    assert.equal(capturedUrl, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
    assert.equal(capturedBody?.model, model);
    assert.equal(capturedBody?.response_format, "b64_json");
    assert.equal(capturedBody?.output_format, model === "doubao-seedream-4-5-251128" ? undefined : "png");
    assert.equal(result.provider, "seedream");
    assert.equal(result.model, model);
    assert.equal(result.providerRequestId, `seedream-${model}`);
    assert.equal(result.outputs[0].mimeType, model === "doubao-seedream-4-5-251128" ? "image/jpeg" : "image/png");
    assert.deepEqual(result.outputs[0].bytes, model === "doubao-seedream-4-5-251128" ? JPEG_BYTES : PNG_BYTES);
  }
});

test("Seedream accepts a realistic base64 JSON body above the shared provider limit", async () => {
  const largePng = new Uint8Array(300 * 1024);
  largePng.set(PNG_BYTES);
  const request = makeRequest("doubao-seedream-5-0-pro-260628");
  request.resolution = "2K";
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "ark-key", ARK_IMAGE_MODEL: "doubao-seedream-5-0-260128" },
    fetch: (async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(largePng).toString("base64") }] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  });
  assert.equal(result.outputs[0].bytes.byteLength, largePng.byteLength);
});

test("Seedream 4.5 accepts JPEG output and reports its detected MIME type", async () => {
  const request = makeRequest("doubao-seedream-4-5-251128");
  request.resolution = "2K";
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "ark-key" },
    fetch: (async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from(JPEG_BYTES).toString("base64") }],
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": "seedream-45-jpeg",
      },
    })) as typeof fetch,
  });
  assert.equal(result.outputs[0]?.mimeType, "image/jpeg");
  assert.deepEqual(result.outputs[0]?.bytes, JPEG_BYTES);
  assert.equal(result.providerRequestId, "seedream-45-jpeg");
});

test("Seedream 4.5 rejects a non-JPEG provider output", async () => {
  const request = makeRequest("doubao-seedream-4-5-251128");
  request.resolution = "2K";
  await assert.rejects(generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "ark-key" },
    fetch: (async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR");
});

test("all three Qwen choices send the selected model to the fixed Beijing endpoint", async () => {
  for (const model of ["qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.0-pro"] as const) {
    let requestBody: Record<string, unknown> | undefined;
    const result = await generateInteriorImages(makeRequest(model), {
      env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "dash-key", DASHSCOPE_WORKSPACE_ID: "ws-izvs9scwesm7icuy" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/")) return imageResponse();
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(url, "https://ws-izvs9scwesm7icuy.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
        return new Response(JSON.stringify({ request_id: `qwen-${model}`, output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(requestBody?.model, model);
    assert.equal(result.provider, "qwen");
    assert.equal(result.model, model);
    assert.equal(result.outputs.length, 1);
  }
});

test("all six domestic models send the photo-level prompt for every legacy realism level", async () => {
  const levels = ["conceptual", "rendered", "realistic", "photorealistic"] as const satisfies readonly VisualRealism[];
  const expectedHashes = {
    seedream: {
      conceptual: "cb3977a21b501f64c00eeb1b4eebdf26e61330b7f2f72c987a2aeb3dfb237b67",
      rendered: "cb3977a21b501f64c00eeb1b4eebdf26e61330b7f2f72c987a2aeb3dfb237b67",
      realistic: "cb3977a21b501f64c00eeb1b4eebdf26e61330b7f2f72c987a2aeb3dfb237b67",
      photorealistic: "cb3977a21b501f64c00eeb1b4eebdf26e61330b7f2f72c987a2aeb3dfb237b67",
    },
    qwen: {
      conceptual: "1d2a3ad84026a6f32792541f505a69de568d7ff48752c80aa361b736dc43d1fb",
      rendered: "1d2a3ad84026a6f32792541f505a69de568d7ff48752c80aa361b736dc43d1fb",
      realistic: "1d2a3ad84026a6f32792541f505a69de568d7ff48752c80aa361b736dc43d1fb",
      photorealistic: "1d2a3ad84026a6f32792541f505a69de568d7ff48752c80aa361b736dc43d1fb",
    },
  } as const;

  for (const model of domesticImageModelValues) {
    const provider = domesticImageModelProvider(model);
    for (const visualRealism of levels) {
      const request = makeRequest(model);
      request.sourceImage = { bytes: PROVIDER_CANARY_FIXTURE_BYTES, mimeType: "image/png", fileName: "synthetic-interior-480.png" };
      request.resolution = domesticImageModelCapabilities[model].supportedResolutions[0];
      request.visualRealism = visualRealism;
      let calls = 0;
      let body: Record<string, unknown> | undefined;
      await generateInteriorImages(request, {
        env: provider === "seedream"
          ? { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "fake-ark-key" }
          : { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "fake-dash-key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          const url = String(input);
          if (url.includes("dashscope-result")) return imageResponse();
          assert.equal(url, provider === "seedream"
            ? "https://ark.cn-beijing.volces.com/api/v3/images/generations"
            : "https://workspace_123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return provider === "seedream"
            ? new Response(JSON.stringify({ data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })
            : new Response(JSON.stringify({ request_id: `qwen-${visualRealism}`, output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }) as typeof fetch,
      });
      assert.equal(body?.model, model);
      const prompt = provider === "seedream"
        ? body?.prompt
        : (((body?.input as { messages?: Array<{ content?: Array<{ text?: string }> }> })?.messages?.[0]?.content ?? []).at(-1)?.text);
      assert.equal(typeof prompt, "string");
      assert.match(String(prompt), /Input image order: Image 1: primary room or plan input\./u);
      assert.match(String(prompt), /Keep every existing door and window opening at its original position, size, and proportions/u);
      assert.doesNotMatch(String(prompt), /remove original window frames|remove old frames or visible iron bars/u);
      assert.equal(createHash("sha256").update(String(prompt)).digest("hex"), expectedHashes[provider][visualRealism]);
      if (provider === "seedream") {
        assert.equal(body?.size, request.resolution);
        assert.equal((body?.image as unknown[])?.length, 1);
      } else {
        const parameters = body?.parameters as Record<string, unknown>;
        assert.equal(parameters?.size, request.resolution === "1K" ? "1024*768" : "2048*1536");
      }
      assert.equal(calls, provider === "seedream" ? 1 : 2);
    }
  }
});

test("Qwen downloads multiple outputs sequentially", async () => {
  const request = makeRequest("qwen-image-3.0-pro");
  request.outputCount = 3;
  let activeDownloads = 0;
  let peakDownloads = 0;
  const urls = [1, 2, 3].map((index) => `https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output-${index}.png`);
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "dash-key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async (input: RequestInfo | URL) => {
      if (!String(input).includes("dashscope-result")) {
        return new Response(JSON.stringify({ request_id: "qwen-sequential", output: { choices: urls.map((image) => ({ message: { content: [{ image }] } })) } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      activeDownloads += 1;
      peakDownloads = Math.max(peakDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeDownloads -= 1;
      return imageResponse();
    }) as typeof fetch,
  });
  assert.equal(result.outputs.length, 3);
  assert.equal(peakDownloads, 1);
});

test.skip("Hunyuan uses TokenHub synchronously and downloads its temporary COS result", async () => {
  let calls = 0;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = String(input);
    if (url === "https://aigc-image.cos.myqcloud.com/output.png") return imageResponse();
    assert.equal(url, "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "hy-image-v3");
    assert.equal(body.size, "1024x768");
    return new Response(JSON.stringify({ request_id: "hy-1", data: [{ url: "https://aigc-image.cos.myqcloud.com/output.png" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const result = await generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", TENCENT_TOKENHUB_API_KEY: "tokenhub-key" },
    fetch: fetchMock,
  });
  assert.equal(calls, 2);
  assert.equal(result.provider, "hunyuan");
});

test("Kling creates and queries an official asynchronous image task", async () => {
  const urls: string[] = [];
  let createdBody: Record<string, unknown> | undefined;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://p1-kling.klingai.com/output.png") return imageResponse();
    if (init?.method === "POST") { createdBody = JSON.parse(String(init.body)) as Record<string, unknown>; return new Response(JSON.stringify({ code: 0, request_id: "kling-create", data: { task_id: "task-1", task_status: "submitted" } }), { status: 200, headers: { "Content-Type": "application/json" } }); }
    return new Response(JSON.stringify({ code: 0, request_id: "kling-query", data: { task_id: "task-1", task_status: "succeed", task_result: { images: [{ url: "https://p1-kling.klingai.com/output.png" }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const result = await klingProvider.generate(makeRequest("kling"), {
    apiKey: "kling-token",
    fetch: fetchMock,
    prompt: "Preserve the room structure and apply the requested design.",
    promptTemplateVersion: "test-v1",
    baseUrl: KLING_IMAGE_URL,
    model: KLING_IMAGE_MODEL,
  });
  assert.deepEqual(urls, [
    "https://api-singapore.klingai.com/v1/images/omni-image",
    "https://api-singapore.klingai.com/v1/images/omni-image/task-1",
    "https://p1-kling.klingai.com/output.png",
  ]);
  assert.equal(result.provider, "kling");
  assert.match(String(createdBody?.prompt), /<<<image_1>>>/u);
});

test.skip("Kling application routing stays fail-closed until task IDs are durably recoverable", async () => {
  let calls = 0;
  await assert.rejects(generateInteriorImages(makeRequest("kling"), {
    env: { BACKEND_PROFILE: "cn-production", KLING_API_TOKEN: "kling-token" },
    fetch: (async () => { calls += 1; return new Response(null, { status: 500 }); }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("domestic adapters enforce official input and resolution boundaries before fetch", async () => {
  let calls = 0;
  const fetchMock = (async () => { calls += 1; return new Response(null, { status: 500 }); }) as typeof fetch;
  const qwen = makeRequest("qwen-image-3.0-pro");
  qwen.referenceImages = [0, 1, 2].map((index) => ({ bytes: PNG_BYTES, mimeType: "image/png", fileName: `reference-${index}.png` }));
  await assert.rejects(generateInteriorImages(qwen, { env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" }, fetch: fetchMock }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  const unsupported = makeRequest("qwen-image-3.0-pro");
  unsupported.resolution = "4K";
  await assert.rejects(generateInteriorImages(unsupported, { env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" }, fetch: fetchMock }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  const masked = makeRequest("doubao-seedream-5-0-pro-260628");
  masked.resolution = "2K";
  masked.renovationScope = "local-edit";
  masked.mask = { bytes: PNG_BYTES, mimeType: "image/png", fileName: "mask.png" };
  await assert.rejects(generateInteriorImages(masked, { env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "key", ARK_IMAGE_MODEL: "doubao-seedream-5-0-260128" }, fetch: fetchMock }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("role-bearing references preserve server order and role labels", () => {
  const request = makeRequest("doubao-seedream-5-0-pro-260628");
  request.referenceImages = [
    { role: "style", image: { bytes: PNG_BYTES, mimeType: "image/png" } },
    { role: "furnishing", image: { bytes: PNG_BYTES, mimeType: "image/png" } },
    { role: "material", image: { bytes: PNG_BYTES, mimeType: "image/png" } },
  ];
  request.controlImages = [
    { kind: "depth", image: { bytes: PNG_BYTES, mimeType: "image/png" } },
    { kind: "normal", image: { bytes: PNG_BYTES, mimeType: "image/png" } },
  ];
  const ordered = orderedProviderImages(request);
  assert.deepEqual(ordered.map((item) => item.role), [
    "primary room or plan input", "style", "furnishing", "material", "depth structural reference", "normal structural reference",
  ]);
  assert.match(withInputLegend("prompt", ordered), /Image 2: style\. Image 3: furnishing\. Image 4: material\. Image 5: depth structural reference\. Image 6: normal structural reference\./u);
});

test("domestic providers support text-only and references-only payloads without placeholders", async () => {
  const textRequest = makeRequest("doubao-seedream-5-0-pro-260628");
  delete textRequest.sourceImage;
  textRequest.workflowType = "self-service";
  textRequest.resolution = "2K";
  textRequest.style = { presetId: "self-service" };
  textRequest.customPrompt = "纯文字室内空间";
  let seedreamBody: Record<string, unknown> | undefined;
  const seedreamResult = await generateInteriorImages(textRequest, { env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "key" }, fetch: (async (_input, init) => { seedreamBody = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } }); }) as typeof fetch });
  assert.equal("image" in (seedreamBody ?? {}), false);
  assert.equal(seedreamResult.providerRequestId, undefined);
  assert.match(seedreamResult.requestId, /^local_seedream_/u);

  const referenceRequest = { ...textRequest, referenceImages: [
    { role: "reference" as const, image: { bytes: PNG_BYTES, mimeType: "image/png" as const } },
    { role: "reference" as const, image: { bytes: PNG_BYTES, mimeType: "image/png" as const } },
  ], providerPreference: "qwen-image-3.0-pro" as const };
  let qwenBody: Record<string, unknown> | undefined;
  await generateInteriorImages(referenceRequest, { env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" }, fetch: (async (input, init) => { const url = String(input); if (url.includes("dashscope-result")) return imageResponse(); qwenBody = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ request_id: "qwen-ref", output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } }); }) as typeof fetch });
  const content = (((qwenBody?.input as Record<string, unknown>)?.messages as Array<Record<string, unknown>>)?.[0]?.content as Array<Record<string, unknown>>);
  assert.deepEqual(content?.slice(0, 2).map((item) => item.image), [`data:image/png;base64,${PNG_BASE64}`, `data:image/png;base64,${PNG_BASE64}`]);
  assert.deepEqual(orderedProviderImages(referenceRequest).map((item) => item.role), ["reference", "reference"]);
  assert.equal(withInputLegend("prompt", []).includes("Input image order"), false);
});

test("empty provider errors retain HTTP rate-limit semantics", async () => {
  const request = makeRequest("doubao-seedream-5-0-pro-260628");
  request.resolution = "2K";
  await assert.rejects(generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "key", ARK_IMAGE_MODEL: "doubao-seedream-5-0-260128" },
    fetch: (async () => new Response(null, { status: 429 })) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "RATE_LIMITED" && error.retryable);
});

test("domestic HTTP errors expose only stable categories", () => {
  const invalid = mapDomesticHttpError("qwen", 422, {
    code: "invalid_parameter_with_private_detail",
  });
  assert.equal(invalid.code, "INVALID_INPUT");
  assert.equal(invalid.providerCode, undefined);
  assert.equal(invalid.message.includes("private_detail"), false);

  const content = mapDomesticHttpError("qwen", 400, {
    code: "DataInspectionFailed",
  });
  assert.equal(content.code, "CONTENT_REJECTED");
  assert.equal(content.providerCode, "datainspectionfailed");

  const seedreamContent = mapDomesticHttpError("seedream", 400, {
    error: { code: "InputImageSensitiveContentDetected" },
  });
  assert.equal(seedreamContent.code, "CONTENT_REJECTED");
  assert.equal(
    seedreamContent.providerCode,
    "inputimagesensitivecontentdetected",
  );

  const quota = mapDomesticHttpError("qwen", 400, { code: "Arrearage" });
  assert.equal(quota.code, "PROVIDER_QUOTA_EXCEEDED");
  assert.equal(quota.retryable, false);

  const timeout = mapDomesticHttpError("qwen", 408, {
    code: "RequestTimeOut",
  });
  assert.equal(timeout.code, "PROVIDER_TIMEOUT");
  assert.equal(timeout.retryable, true);
});

test("provider result downloads reject unapproved hosts before a second fetch", async () => {
  let calls = 0;
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async () => { calls += 1; return new Response(JSON.stringify({ request_id: "qwen-host", output: { choices: [{ message: { content: [{ image: "https://attacker.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } }); }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR" && error.requestId === "qwen-host" && error.providerRequestId === "qwen-host");
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async () => { calls += 1; return new Response(JSON.stringify({ request_id: "qwen-host", output: { choices: [{ message: { content: [{ image: "https://attacker.dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } }); }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR" && error.requestId === "qwen-host" && error.providerRequestId === "qwen-host");
  assert.equal(calls, 1);
});

test("Qwen result host validation accepts dynamic official OSS buckets only", () => {
  for (const hostname of [
    "dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com",
    "dashscope-a717.oss-accelerate.aliyuncs.com",
    "dashscope-result-bj.oss-cn-beijing.aliyuncs.com",
  ]) {
    assert.equal(isApprovedQwenResultHost(hostname), true, hostname);
  }
  for (const hostname of [
    "attacker.aliyuncs.com",
    "dashscope-result.oss-cn-beijing.aliyuncs.com.evil.example",
    "evil-dashscope-result.oss-cn-beijing.aliyuncs.com",
    "dashscope-result-.oss-cn-beijing.aliyuncs.com",
    "dashscope-result.oss-cn-beijing-.aliyuncs.com",
    "dashscope-result.oss-cn-beijing.example.com",
  ]) {
    assert.equal(isApprovedQwenResultHost(hostname), false, hostname);
  }
});

test("Qwen output download keeps HTTPS credential port and redirect protections", async () => {
  for (const outputUrl of [
    "http://dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com/output.png",
    "https://user@dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com/output.png",
    "https://dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com:444/output.png",
  ]) {
    let calls = 0;
    await assert.rejects(generateInteriorImages(makeRequest("qwen-image-2.0-pro"), {
      env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ request_id: "qwen-url-guard", output: { choices: [{ message: { content: [{ image: outputUrl }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR");
    assert.equal(calls, 1);
  }

  let calls = 0;
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-2.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ request_id: "qwen-redirect", output: { choices: [{ message: { content: [{ image: "https://dashscope-a717.oss-accelerate.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      assert.equal(init?.redirect, "error");
      return new Response(null, { status: 302, headers: { Location: "https://example.com/output.png" } });
    }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR");
  assert.equal(calls, 2);
});

test("provider JSON decoding errors retain the response request id", async () => {
  const request = makeRequest("doubao-seedream-5-0-pro-260628");
  request.resolution = "2K";
  await assert.rejects(generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "key" },
    fetch: (async () => new Response("not-json", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": "seedream-invalid-json",
      },
    })) as typeof fetch,
  }), (error: unknown) =>
    error instanceof AiServiceError &&
    error.code === "PROVIDER_ERROR" &&
    error.requestId === "seedream-invalid-json" &&
    error.providerRequestId === "seedream-invalid-json",
  );
});

test("Qwen HTTP errors retain a body request id for reconciliation", async () => {
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async () => new Response(JSON.stringify({
      request_id: "qwen-http-error",
      code: "Throttling.RateLimit",
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch,
  }), (error: unknown) =>
    error instanceof AiServiceError &&
    error.code === "RATE_LIMITED" &&
    error.providerRequestId === "qwen-http-error",
  );
});

test("internal request and download timeouts retain timeout semantics", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const seedream = makeRequest("doubao-seedream-5-0-pro-260628");
  seedream.resolution = "2K";
  await assert.rejects(generateInteriorImages(seedream, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "key", ARK_IMAGE_MODEL: "doubao-seedream-5-0-260128" },
    fetch: (async () => { throw timeout; }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_TIMEOUT");

  let calls = 0;
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    fetch: (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ request_id: "qwen-timeout", output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw timeout;
    }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_TIMEOUT");

  const stalledJson = new ReadableStream<Uint8Array>({ start() {} });
  const jsonController = new AbortController();
  setTimeout(() => jsonController.abort(), 5);
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    signal: jsonController.signal,
    fetch: (async () => new Response(stalledJson, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_TIMEOUT");

  let bodyCalls = 0;
  const stalledImage = new ReadableStream<Uint8Array>({ start() {} });
  const imageController = new AbortController();
  setTimeout(() => imageController.abort(), 5);
  await assert.rejects(generateInteriorImages(makeRequest("qwen-image-3.0-pro"), {
    env: { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace_123" },
    signal: imageController.signal,
    fetch: (async () => {
      bodyCalls += 1;
      if (bodyCalls === 1) return new Response(JSON.stringify({ request_id: "qwen-stalled-image", output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(stalledImage, { status: 200, headers: { "Content-Type": "image/png" } });
    }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_TIMEOUT");
});


test("all six models preserve 300-second POST and result-download budgets", async () => {
  const originalTimeout = AbortSignal.timeout;
  const budgets: number[] = [];
  AbortSignal.timeout = (milliseconds) => { budgets.push(milliseconds); return originalTimeout(milliseconds); };
  try {
    for (const model of domesticImageModelValues) {
      budgets.length = 0;
      const request = { ...makeRequest(model), resolution: "2K" as const };
      const prepared = await prepareDomesticSingleImageGeneration(request, {
        providerRequestTimeoutMs: 300_000,
        env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "mock", DASHSCOPE_API_KEY: "mock", DASHSCOPE_WORKSPACE_ID: "mock-workspace" },
        fetch: (async (_url, init) => init?.method === "GET" ? imageResponse() : new Response(JSON.stringify(domesticImageModelProvider(model) === "seedream" ? { data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] } : { request_id: "mock", output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { headers: { "Content-Type": "application/json" } })) as typeof fetch,
      });
      await prepared.execute();
      assert.deepEqual(budgets, domesticImageModelProvider(model) === "seedream" ? [300_000] : [300_000, 300_000], model);
    }
  } finally { AbortSignal.timeout = originalTimeout; }
});

test("Seedream 5 Pro prepared payload carries the complete v3 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "cream-cozy" }, designSchemeId: "cream-cozy-02-v3", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("cream-cozy")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, V3_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.match(sentPrompt, /将上传的客厅照片改造为一张装修完成/u);
});

test("Seedream 5 Pro prepared payload carries the complete v4 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "cream-cozy" }, designSchemeId: "cream-cozy-02-v4", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("cream-cozy")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, V4_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  assert.match(sentPrompt, /在上传的原照片上完成室内装修与软装编辑/u);
});

test("Seedream 5 Pro prepared payload carries the complete modern walnut v3 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "modern-minimalist" }, designSchemeId: "modern-minimalist-04-v3", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("modern-minimalist")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, MODERN_WALNUT_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  assert.match(sentPrompt, /在上传的原照片上完成室内装修与软装编辑/u);
});

test("Seedream 5 Pro prepared payload carries the complete french sage v3 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "french-modern" }, designSchemeId: "french-modern-05-v3", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("french-modern")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, FRENCH_SAGE_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  assert.match(sentPrompt, /在上传的原照片上完成室内装修与软装编辑/u);
});

test("Seedream 5 Pro prepared payload carries the complete industrial caramel v3 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v3", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, INDUSTRIAL_CARAMEL_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  assert.match(sentPrompt, /在上传的原照片上完成室内装修与软装编辑/u);
});

test("Seedream 5 Pro prepared payload carries the complete industrial caramel v4 frozen prose", async () => {
  const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v4", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
  const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
  let sentPrompt = "";
  const prepared = prepareDomesticSingleImageGeneration(request, {
    env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(prepared.promptTemplateVersion, INDUSTRIAL_CARAMEL_V4_PROMPT_TEMPLATE_VERSION);
  await prepared.execute();
  assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
  assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  assert.match(sentPrompt, /在上传的原照片上完成室内装修与软装编辑/u);
});

test("Seedream 5 Pro prepared payload carries the complete industrial caramel v5 frozen prose", async () => {
  for (const spaceType of ["living-room", "bedroom", "kitchen", "bathroom"] as const) {
    const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v5", spaceType, visualRealism: "photorealistic" as const };
    const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentPrompt = JSON.parse(String(init?.body)).prompt;
        return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, INDUSTRIAL_CARAMEL_V5_PROMPT_TEMPLATE_VERSION);
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
    assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
    assert.match(sentPrompt, /在上传的现场照片上完成/u);
  }
});

test("Seedream 5 Pro prepared payload carries the complete industrial caramel v6 frozen prose", async () => {
  for (const spaceType of ["living-room", "bedroom", "kitchen", "bathroom"] as const) {
    const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v6", spaceType, visualRealism: "photorealistic" as const };
    const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentPrompt = JSON.parse(String(init?.body)).prompt;
        return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, INDUSTRIAL_CARAMEL_V6_PROMPT_TEMPLATE_VERSION);
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
    assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
    assert.match(sentPrompt, /在上传的现场照片上完成/u);
  }
});

test("Seedream 5 Pro prepared payload carries the complete industrial caramel v7 six-room prose", async () => {
  for (const spaceType of ["living-room", "bedroom", "kitchen", "bathroom", "study", "children-room"] as const) {
    const request = { ...makeRequest("doubao-seedream-5-0-pro-260628"), resolution: "2K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v7", spaceType, visualRealism: "photorealistic" as const };
    const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentPrompt = JSON.parse(String(init?.body)).prompt;
        return new Response(JSON.stringify({ model: request.providerPreference, data: [{ b64_json: PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, INDUSTRIAL_CARAMEL_V7_PROMPT_TEMPLATE_VERSION);
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.\nCreate variation 1 of 1.`);
    assert.doesNotMatch(sentPrompt, /standard quality|draft quality|high quality/u);
  }
});

test("all six domestic adapters send the selected v8 room prompt unchanged", async () => {
  for (const model of domesticImageModelValues) for (const spaceType of ["living-room", "children-room", "kitchen"] as const) {
    const request = { ...makeRequest(model), resolution: model.startsWith("doubao-") ? "2K" as const : "1K" as const, style: { presetId: "industrial-loft" }, designSchemeId: "industrial-loft-02-v8", spaceType, visualRealism: "photorealistic" as const };
    const compiled = compileInteriorPrompt(request, getStylePreset("industrial-loft")!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: model.startsWith("doubao-") ? { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" } : { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "test-key", DASHSCOPE_WORKSPACE_ID: "ws-izvs9scwesm7icuy" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/")) return imageResponse();
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentPrompt = model.startsWith("doubao-") ? String(body.prompt) : String(((body.input as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0].content).at(-1)?.text);
        return model.startsWith("doubao-")
          ? new Response(JSON.stringify({ model, data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, "interior-concept-v23");
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.${model.startsWith("doubao-") ? "\nCreate variation 1 of 1." : ""}`);
    if (model === "qwen-image-2.0-pro") assert.ok(Buffer.byteLength(sentPrompt) <= 1200);
  }
});

test("all six domestic adapters send the v9 living-room ceiling prompt unchanged", async () => {
  for (const model of domesticImageModelValues) {
    const request = { ...makeRequest(model), resolution: model.startsWith("doubao-") ? "2K" as const : "1K" as const, style: { presetId: "coastal-relaxed" }, designSchemeId: "coastal-relaxed-01-v9", spaceType: "living-room" as const, visualRealism: "photorealistic" as const };
    const compiled = compileInteriorPrompt(request, getStylePreset(request.style.presetId)!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: model.startsWith("doubao-") ? { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" } : { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "test-key", DASHSCOPE_WORKSPACE_ID: "ws-izvs9scwesm7icuy" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/")) return imageResponse();
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentPrompt = model.startsWith("doubao-") ? String(body.prompt) : String(((body.input as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0].content).at(-1)?.text);
        return model.startsWith("doubao-")
          ? new Response(JSON.stringify({ model, data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, "interior-concept-v24");
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.${model.startsWith("doubao-") ? "\nCreate variation 1 of 1." : ""}`);
    if (model === "qwen-image-2.0-pro") assert.ok(Buffer.byteLength(sentPrompt) <= 1200);
  }
});

test("all six domestic adapters send both v10 lamp states unchanged", async () => {
  for (const model of domesticImageModelValues) for (const lampState of ["on", "off"] as const) {
    const request = { ...makeRequest(model), resolution: model.startsWith("doubao-") ? "2K" as const : "1K" as const, style: { presetId: "coastal-relaxed" }, designSchemeId: "coastal-relaxed-01-v10", spaceType: "living-room" as const, visualRealism: "photorealistic" as const, lighting: { timeOfDay: "night" as const, lampState, colorTemperatureKelvin: 4000 } };
    const compiled = compileInteriorPrompt(request, getStylePreset(request.style.presetId)!);
    let sentPrompt = "";
    const prepared = prepareDomesticSingleImageGeneration(request, {
      env: model.startsWith("doubao-") ? { BACKEND_PROFILE: "cn-production", ARK_API_KEY: "test-key" } : { BACKEND_PROFILE: "cn-production", DASHSCOPE_API_KEY: "test-key", DASHSCOPE_WORKSPACE_ID: "ws-izvs9scwesm7icuy" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/")) return imageResponse();
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentPrompt = model.startsWith("doubao-") ? String(body.prompt) : String(((body.input as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0].content).at(-1)?.text);
        return model.startsWith("doubao-")
          ? new Response(JSON.stringify({ model, data: [{ b64_json: model === "doubao-seedream-4-5-251128" ? JPEG_BASE64 : PNG_BASE64 }] }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/output.png" }] } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    assert.equal(prepared.promptTemplateVersion, "interior-concept-v25");
    await prepared.execute();
    assert.equal(sentPrompt, `${compiled.text}\nInput image order: Image 1: primary room or plan input.${model.startsWith("doubao-") ? "\nCreate variation 1 of 1." : ""}`);
    if (model === "qwen-image-2.0-pro") assert.ok(Buffer.byteLength(sentPrompt) <= 1200);
  }
});
