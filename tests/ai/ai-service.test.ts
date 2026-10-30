import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AiServiceError,
  generateInteriorImages,
  generateVisionArtifacts,
  listPublicStylePresets,
  openAiQuality,
  openAiSize,
  type GenerateInteriorImagesRequest,
} from "../../lib/ai/index";
import { STYLE_PRESETS } from "../../lib/ai/styles";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function makeRequest(
  providerPreference: GenerateInteriorImagesRequest["providerPreference"] = "auto",
): GenerateInteriorImagesRequest {
  return {
    sourceImage: {
      bytes: decodeBase64(PNG_BASE64),
      mimeType: "image/png",
      fileName: "room.png",
    },
    workflowType: "concept",
    resolution: "1K",
    aspectRatio: "4:3",
    quality: "standard",
    style: { presetId: "modern-minimalist" },
    lighting: {
      timeOfDay: "day",
      lampState: "mixed",
      colorTemperatureKelvin: 4000,
    },
    renovationScope: "restyle",
    outputCount: 1,
    providerPreference,
  };
}

test("public style presets include previews without internal prompts", () => {
  const styles = listPublicStylePresets();
  assert.ok(styles.length >= 12);
  assert.ok(styles.every((style) => style.preview?.startsWith("/style-previews/") && style.preview.endsWith(".webp")));
  assert.ok(styles.every((style) => !("promptDirective" in style)));
});

test("style source of truth has unique ids and bounded candidate sets", () => {
  assert.equal(new Set(STYLE_PRESETS.map((style) => style.id)).size, 17);
  for (const style of STYLE_PRESETS) {
    for (const values of Object.values(style.materials ?? {})) assert.ok(values.length >= 3 && values.length <= 6);
  }
});

test("all style previews are local and visually distinct files", async () => {
  const hashes = await Promise.all(STYLE_PRESETS.map(async (style) => createHash("sha256").update(await readFile(`public${style.preview}`)).digest("hex")));
  assert.equal(new Set(hashes).size, 17);
});

test("optional self-service source still rejects empty or malformed images", async () => {
  const empty = makeRequest("mock");
  empty.workflowType = "self-service";
  empty.style = { presetId: "self-service" };
  empty.customPrompt = "测试";
  empty.sourceImage = { bytes: new Uint8Array(), mimeType: "image/png" };
  await assert.rejects(generateInteriorImages(empty, { env: { BACKEND_PROFILE: "sites-demo" } }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  const badMime = { ...empty, sourceImage: { bytes: decodeBase64(PNG_BASE64), mimeType: "image/gif" as never } };
  await assert.rejects(generateInteriorImages(badMime, { env: { BACKEND_PROFILE: "sites-demo" } }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
});

test("AI boundary rejects malformed advanced settings", async () => {
  for (const value of [null, [], { version: 1 }, { version: 1, geometryFidelity: "strict", cameraPolicy: "locked", furnishingDensity: "balanced", materialExpression: "natural", lightingContrast: "balanced", extra: true }]) {
    const request = makeRequest("mock");
    request.workflowType = "advanced";
    request.advancedSettings = value as never;
    await assert.rejects(generateInteriorImages(request, { env: { BACKEND_PROFILE: "sites-demo" } }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  }
});

test("AI boundary validates visual realism and workflow scope", async () => {
  for (const value of ["cinematic", "photo", 1]) {
    const request = makeRequest("mock");
    request.visualRealism = value as never;
    await assert.rejects(generateInteriorImages(request, { env: { BACKEND_PROFILE: "sites-demo" } }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
  }
  const request = makeRequest("mock");
  request.workflowType = "floorplan";
  request.visualRealism = "realistic";
  await assert.rejects(generateInteriorImages(request, { env: { BACKEND_PROFILE: "sites-demo" } }), (error: unknown) => error instanceof AiServiceError && error.code === "INVALID_INPUT");
});

test("auto routing without API keys returns a source-image mock placeholder", async () => {
  const request = makeRequest();
  const result = await generateInteriorImages(request, { env: { BACKEND_PROFILE: "sites-demo" } });

  assert.equal(result.provider, "mock");
  assert.equal(result.outputs[0].metadata.mock, true);
  assert.equal(result.outputs[0].metadata.placeholder, "source-image-copy");
  assert.deepEqual(result.outputs[0].bytes, request.sourceImage!.bytes);
  assert.notEqual(result.outputs[0].bytes, request.sourceImage!.bytes);
  assert.equal(result.outputs[0].mimeType, "image/png");
});

test("cn production rejects legacy overseas and mock provider preferences", async () => {
  for (const preference of ["auto", "openai", "google", "mock"] as const) {
    await assert.rejects(
      generateInteriorImages(makeRequest(preference), { env: { BACKEND_PROFILE: "cn-production", OPENAI_API_KEY: "unused", GOOGLE_API_KEY: "unused" } }),
      (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED",
    );
  }
});

test("unconfigured domestic image choices fail closed before any fetch", async () => {
  let fetchCount = 0;
  const fetchMock = (async () => { fetchCount += 1; return new Response(null, { status: 500 }); }) as typeof fetch;
  for (const preference of ["doubao-seedream-5-0-pro-260628", "qwen-image-3.0-pro", "doubao-seedream-5-0-260128", "qwen-image-3.0", "qwen-image-2.0-pro"] as const) {
    await assert.rejects(generateInteriorImages(makeRequest(preference), { env: { BACKEND_PROFILE: "sites-demo" }, fetch: fetchMock }), (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED");
    await assert.rejects(generateInteriorImages(makeRequest(preference), { fetch: fetchMock }), (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR");
  }
  assert.equal(fetchCount, 0);
});

test("domestic image choices stay disabled in sites-demo even when configured", async () => {
  let fetchCount = 0;
  const request = makeRequest("doubao-seedream-5-0-pro-260628");
  request.resolution = "2K";
  await assert.rejects(generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", ARK_API_KEY: "configured", ARK_IMAGE_MODEL: "doubao-seedream-5-0-260128" },
    fetch: (async () => { fetchCount += 1; return new Response(null, { status: 500 }); }) as typeof fetch,
  }), (error: unknown) => error instanceof AiServiceError && error.code === "NOT_CONFIGURED");
  assert.equal(fetchCount, 0);
});

test("unknown provider preferences fail closed before fetch or mock fallback", async () => {
  let fetchCount = 0;
  const fetchMock = (async () => {
    fetchCount += 1;
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  await assert.rejects(
    generateInteriorImages(makeRequest("typo-provider" as never), {
      env: { BACKEND_PROFILE: "sites-demo" },
      fetch: fetchMock,
    }),
    (error: unknown) => error instanceof AiServiceError && error.code === "PROVIDER_ERROR",
  );
  assert.equal(fetchCount, 0);
});

test("an explicitly selected unconfigured provider returns NOT_CONFIGURED", async () => {
  await assert.rejects(
    generateInteriorImages(makeRequest("openai"), { env: { BACKEND_PROFILE: "sites-demo" } }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "NOT_CONFIGURED" &&
      error.provider === "openai",
  );
});

test("OpenAI uses gpt-image-2 image edits multipart and omits input_fidelity", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }),
      { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "req_openai_1" } },
    );
  }) as typeof fetch;

  const request = makeRequest("openai");
  request.resolution = "4K";
  request.aspectRatio = "16:9";
  request.quality = "high";
  request.referenceImages = [{
    bytes: decodeBase64(PNG_BASE64),
    mimeType: "image/png",
    fileName: "reference.png",
  }];
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
    fetch: fetchMock,
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/images/edits");
  assert.equal(capturedInit?.method, "POST");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer test-openai-key");
  const form = capturedInit?.body as FormData;
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("n"), "1");
  assert.equal(form.get("size"), "3840x2160");
  assert.equal(form.get("quality"), "high");
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.has("input_fidelity"), false);
  assert.equal(result.requestId, "req_openai_1");
  assert.equal(result.outputs[0].provider, "openai");
  assert.equal(result.outputs[0].model, "gpt-image-2");
});

test("OpenAI standardizes upstream error.code", async () => {
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({ error: { code: "content_policy_violation", message: "blocked" } }),
      { status: 400, headers: { "Content-Type": "application/json", "x-request-id": "req_blocked" } },
    )) as typeof fetch;

  await assert.rejects(
    generateInteriorImages(makeRequest("openai"), {
      env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
      fetch: fetchMock,
    }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "CONTENT_REJECTED" &&
      error.providerCode === "content_policy_violation" &&
      error.requestId === "req_blocked",
  );
});

test("OpenAI authentication errors are normalized without exposing upstream details", async () => {
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "invalid_api_key",
          message: "Incorrect API key: sk-secret-material",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "req_auth_failed",
        },
      },
    )) as typeof fetch;

  await assert.rejects(
    generateInteriorImages(makeRequest("openai"), {
      env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
      fetch: fetchMock,
    }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "PROVIDER_AUTHENTICATION_FAILED" &&
      error.requestId === "req_auth_failed" &&
      !error.userMessage.includes("sk-secret-material"),
  );
});

test("OpenAI no-image errors make no unsupported billing promise", async () => {
  const fetchMock = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    generateInteriorImages(makeRequest("openai"), {
      env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
      fetch: fetchMock,
    }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "NO_IMAGE_OUTPUT" &&
      !/计费|扣费|退款/u.test(error.userMessage),
  );
});

test("Google posts interactions input and parses the final model image block", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const firstImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const finalImage = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        id: "interaction_123",
        steps: [
          { type: "model_output", content: [{ type: "image", data: firstImage, mime_type: "image/png" }] },
          { type: "model_output", content: [{ type: "image", data: finalImage, mime_type: "image/jpeg" }] },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const request = makeRequest("google");
  request.resolution = "2K";
  request.aspectRatio = "9:16";
  request.quality = "draft";
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", GEMINI_API_KEY: "test-google-key" },
    fetch: fetchMock,
  });

  assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal((capturedInit?.headers as Record<string, string>)["x-goog-api-key"], "test-google-key");
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, "gemini-3.1-flash-image");
  assert.equal(body.input[0].type, "text");
  assert.equal(body.input[1].type, "image");
  assert.equal(body.input[1].mime_type, "image/png");
  assert.equal(body.response_format.image_size, "2K");
  assert.equal(body.response_format.aspect_ratio, "9:16");
  assert.equal(result.requestId, "interaction_123");
  assert.equal(result.outputs[0].mimeType, "image/jpeg");
  assert.deepEqual(result.outputs[0].bytes, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
});

test("Google preserves completed variations when a later request is rate limited", async () => {
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          id: "interaction_partial",
          output_image: {
            type: "image",
            data: PNG_BASE64,
            mime_type: "image/png",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "temporary quota pressure",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const request = makeRequest("google");
  request.outputCount = 3;
  const result = await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", GEMINI_API_KEY: "test-google-key" },
    fetch: fetchMock,
  });

  assert.equal(calls, 2);
  assert.equal(result.provider, "google");
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].requestId, "interaction_partial");
});

test("Google errors are normalized and no-image errors make no billing promise", async () => {
  const rateLimited = (async () =>
    new Response(
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "provider internal quota identifier secret-123",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "x-goog-request-id": "google_rate_1",
        },
      },
    )) as typeof fetch;
  await assert.rejects(
    generateInteriorImages(makeRequest("google"), {
      env: { BACKEND_PROFILE: "sites-demo", GEMINI_API_KEY: "test-google-key" },
      fetch: rateLimited,
    }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "RATE_LIMITED" &&
      error.retryable &&
      error.requestId === "google_rate_1" &&
      !error.userMessage.includes("secret-123"),
  );

  const noImage = (async () =>
    new Response(JSON.stringify({ id: "interaction_empty", steps: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    generateInteriorImages(makeRequest("google"), {
      env: { BACKEND_PROFILE: "sites-demo", GEMINI_API_KEY: "test-google-key" },
      fetch: noImage,
    }),
    (error: unknown) =>
      error instanceof AiServiceError &&
      error.code === "NO_IMAGE_OUTPUT" &&
      !/计费|扣费|退款/u.test(error.userMessage),
  );
});

test("vision artifacts fail explicitly when the external pipeline is not configured", async () => {
  await assert.rejects(
    generateVisionArtifacts(
      { sourceImage: makeRequest().sourceImage!, artifacts: ["depth", "normal"] },
      { env: { BACKEND_PROFILE: "sites-demo" } },
    ),
    (error: unknown) =>
      error instanceof AiServiceError && error.code === "NOT_CONFIGURED",
  );
});

test("gpt-image-2 output mapping respects every flexible-size constraint", () => {
  const resolutions = ["1K", "2K", "4K"] as const;
  const ratios = ["1:1", "4:3", "3:2", "16:9", "9:16"] as const;
  for (const resolution of resolutions) {
    for (const ratio of ratios) {
      const [width, height] = openAiSize(resolution, ratio)
        .split("x")
        .map(Number);
      assert.ok(width <= 3840 && height <= 3840);
      assert.equal(width % 16, 0);
      assert.equal(height % 16, 0);
      assert.ok(Math.max(width, height) / Math.min(width, height) <= 3);
      assert.ok(width * height >= 655_360);
      assert.ok(width * height <= 8_294_400);
    }
  }
  assert.equal(openAiSize("4K", "1:1"), "2880x2880");
  assert.equal(openAiSize("4K", "4:3"), "3200x2400");
  assert.equal(openAiSize("4K", "3:2"), "3456x2304");
  assert.equal(openAiQuality("draft"), "low");
  assert.equal(openAiQuality("standard"), "medium");
  assert.equal(openAiQuality("high"), "high");
});

test("vision artifacts are returned only from a configured external pipeline", async () => {
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        request_id: "vision_123",
        artifacts: [
          { kind: "normal", mime_type: "image/png", data: PNG_BASE64, model: "normal-model" },
          { kind: "depth", mime_type: "image/png", data: PNG_BASE64, model: "depth-model" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const result = await generateVisionArtifacts(
    { sourceImage: makeRequest().sourceImage!, artifacts: ["depth", "normal"] },
    {
      env: { BACKEND_PROFILE: "sites-demo", VISION_PIPELINE_URL: "https://vision.example.test/analyze" },
      fetch: fetchMock,
    },
  );

  assert.equal(result.provider, "vision-pipeline");
  assert.equal(result.requestId, "vision_123");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.kind), ["depth", "normal"]);
});

test("vision pipeline maps stalled response bodies and oversized JSON to stable errors", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const timeout = new AbortController();
  setTimeout(() => timeout.abort(), 5);
  await assert.rejects(generateVisionArtifacts(
    { sourceImage: makeRequest().sourceImage!, artifacts: ["depth"] },
    {
      env: { BACKEND_PROFILE: "sites-demo", VISION_PIPELINE_URL: "https://vision.example.test/analyze" },
      signal: timeout.signal,
      fetch: (async () => new Response(stalled, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    },
  ), (error: unknown) => error instanceof AiServiceError && error.code === "VISION_PIPELINE_ERROR" && error.retryable);

  await assert.rejects(generateVisionArtifacts(
    { sourceImage: makeRequest().sourceImage!, artifacts: ["depth"] },
    {
      env: { BACKEND_PROFILE: "sites-demo", VISION_PIPELINE_URL: "https://vision.example.test/analyze" },
      fetch: (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": String(41 * 1024 * 1024) } })) as typeof fetch,
    },
  ), (error: unknown) => error instanceof AiServiceError && error.code === "VISION_PIPELINE_ERROR" && error.retryable);
});

test("references and controls reach providers in source-reference-depth-normal order", async () => {
  let form: FormData | undefined;
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    form = init?.body as FormData;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const request = makeRequest("openai");
  request.workflowType = "advanced";
  request.controlImages = [
    {
      kind: "depth",
      image: {
        bytes: decodeBase64(PNG_BASE64),
        mimeType: "image/png",
        fileName: "control-depth.png",
      },
    },
    {
      kind: "normal",
      image: {
        bytes: decodeBase64(PNG_BASE64),
        mimeType: "image/png",
        fileName: "control-normal.png",
      },
    },
  ];
  request.referenceImages = [
    {
      bytes: decodeBase64(PNG_BASE64),
      mimeType: "image/png",
      fileName: "style-reference.png",
    },
  ];

  await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
    fetch: fetchMock,
  });

  const names = form
    ?.getAll("image[]")
    .map((entry) => (entry instanceof File ? entry.name : ""));
  assert.deepEqual(names, [
    "image-0.png",
    "image-1.png",
    "image-2.png",
    "image-3.png",
  ]);
  assert.match(String(form?.get("prompt")), /exact order: depth, normal/u);
  assert.match(String(form?.get("prompt")), /soft guidance[\s\S]*not measured geometry or hard ControlNet constraints/u);
  assert.doesNotMatch(String(form?.get("prompt")), /They constrain geometry only/u);
});

test("floorplan workflow prompt preserves geometry and disclaims construction use", async () => {
  let form: FormData | undefined;
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    form = init?.body as FormData;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const request = makeRequest("openai");
  request.workflowType = "floorplan";

  await generateInteriorImages(request, {
    env: { BACKEND_PROFILE: "sites-demo", OPENAI_API_KEY: "test-openai-key" },
    fetch: fetchMock,
  });

  const prompt = String(form?.get("prompt"));
  assert.match(prompt, /colored conceptual floor-plan presentation/u);
  assert.match(prompt, /Do not add, remove, move/u);
  assert.match(prompt, /not a construction drawing/u);
  assert.match(prompt, /never invent measurements/u);
});
