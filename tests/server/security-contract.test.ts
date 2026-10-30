import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharpRuntime from "sharp";

import { attachActorCookie, getRequestActor } from "../../lib/server/actor";
import { errorResponse } from "../../lib/server/api";
import { readImageMetadata } from "../../lib/ai/image-metadata";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
  readBoundedFormData,
  sanitizeGeneratedImage,
  validateGeneratedImage,
  validateUploadedImage,
} from "../../lib/server/files";
import { nodeImageSanitizer } from "../../lib/platform/node-image-sanitizer";
import {
  assertAssetKind,
  parseCreateJobInput,
  referenceAssetKindsForWorkflow,
  sourceAssetKindsForWorkflow,
} from "../../lib/server/job-contract";
import { startOfTodayInShanghai } from "../../lib/server/product-time";
import { serializeAsset, serializeJob } from "../../lib/server/serializers";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

type TestSharpPipeline = {
  jpeg(): TestSharpPipeline;
  toBuffer(): Promise<Buffer>;
  withExif(value: Record<string, Record<string, string>>): TestSharpPipeline;
  withMetadata(value: { orientation: number }): TestSharpPipeline;
};

const testSharp = sharpRuntime as unknown as (input: {
  create: {
    background: string;
    channels: 3;
    height: number;
    width: number;
  };
}) => TestSharpPipeline;

function pngFile(type = "image/png") {
  return new File([Buffer.from(PNG_BASE64, "base64")], "room.png", {
    type,
  });
}

function hasErrorCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}

function validJobInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceAssetId: "asset_source",
    stylePresetId: "modern-minimalist",
    lightingPreset: "noon",
    preservationMode: "structure",
    providerPreference: "doubao-seedream-5-0-pro-260628",
    workflowType: "advanced",
    resolution: "2K",
    aspectRatio: "16:9",
    quality: "high",
    lampState: "on",
    colorTemperatureKelvin: 3200,
    outputCount: 2,
    idempotencyKey: "idem-key-123456",
    ...overrides,
  };
}

test("anonymous actors are isolated and a session cookie restores the same owner", () => {
  const first = getRequestActor(new Request("https://studio.example.test/"));
  const second = getRequestActor(new Request("https://studio.example.test/"));

  assert.notEqual(first.ownerId, second.ownerId);
  assert.match(first.ownerId, /^session:[a-f0-9]{64}$/u);
  assert.ok(first.setCookie?.includes("HttpOnly"));
  assert.ok(first.setCookie?.includes("SameSite=Lax"));
  assert.ok(first.setCookie?.includes("Secure"));

  const response = attachActorCookie(new Response(null), first);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  const replay = getRequestActor(
    new Request("https://studio.example.test/", {
      headers: { cookie },
    }),
  );
  assert.equal(replay.ownerId, first.ownerId);
  assert.equal(replay.setCookie, null);
  assert.deepEqual(replay.user, {
    authenticated: false,
    displayName: "访客",
  });
});

test("generated image sanitation strips provider metadata", async () => {
  const source = await testSharp({
    create: { width: 20, height: 10, channels: 3, background: "#8c735b" },
  })
    .withExif({ IFD0: { Artist: "provider-private-marker" } })
    .jpeg()
    .toBuffer();
  assert.match(source.toString("latin1"), /provider-private-marker/u);
  const sanitized = await sanitizeGeneratedImage(
    Uint8Array.from(source),
    "image/jpeg",
    nodeImageSanitizer,
  );
  assert.equal(sanitized.mimeType, "image/jpeg");
  assert.doesNotMatch(
    Buffer.from(sanitized.bytes).toString("latin1"),
    /Exif|provider-private-marker/u,
  );
});

test("legacy READY assets cannot enter a new generation task", () => {
  assert.throws(
    () =>
      assertAssetKind(
        {
          id: "asset-legacy",
          ownerId: "owner-legacy",
          kind: "source",
          status: "READY",
          originalFileName: "legacy.jpg",
          mimeType: "image/jpeg",
          byteSize: 1,
          sha256: "a".repeat(64),
          sanitizationVersion: null,
          storageKey: "uploads/legacy.jpg",
          parentAssetId: null,
          createdAt: new Date(0).toISOString(),
          deletedAt: null,
          retentionExpiresAt: null,
          deletionRequestedAt: null,
          deletionActionId: null,
          purgedAt: null,
          moderationStatus: "UNREVIEWED",
          moderatedAt: null,
          moderationReason: null,
          moderationActionId: null,
        },
        "source",
        "sourceAssetId",
      ),
    hasErrorCode("ASSET_SANITIZATION_REQUIRED"),
  );
});

test("platform display headers are normalized without exposing the platform id", () => {
  const forged = getRequestActor(
    new Request("https://studio.example.test/", {
      headers: {
        "oai-authenticated-user-id": "platform-secret-user-id",
        "oai-authenticated-user-email": "designer@example.test",
      },
    }),
    false,
  );
  assert.equal(forged.user.authenticated, false);
  const actor = getRequestActor(
    new Request("https://studio.example.test/", {
      headers: {
        "oai-authenticated-user-id": "platform-secret-user-id",
        "oai-authenticated-user-email": "designer@example.test",
        "oai-authenticated-user-full-name": encodeURIComponent("曹 设计师"),
        "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      },
    }),
    true,
  );
  assert.equal(actor.user.authenticated, true);
  assert.equal(actor.user.displayName, "曹 设计师");
  assert.equal(actor.user.email, "designer@example.test");
  assert.doesNotMatch(JSON.stringify(actor.user), /platform-secret-user-id/u);
});

test("upload validation enforces byte limit, real signature and declared MIME", async () => {
  const valid = await validateUploadedImage(pngFile(), nodeImageSanitizer);
  assert.equal(valid.mimeType, "image/png");
  assert.equal(valid.extension, "png");
  assert.equal(valid.sha256.length, 64);

  await assert.rejects(
    validateUploadedImage(pngFile("image/jpeg"), nodeImageSanitizer),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MIME_MISMATCH",
  );
  await assert.rejects(
    validateUploadedImage(
      new File(["<script>alert(1)</script>"], "fake.png", {
        type: "image/png",
      }),
      nodeImageSanitizer,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "UNSUPPORTED_MEDIA_TYPE",
  );
  await assert.rejects(
    validateUploadedImage(
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "large.png", {
        type: "image/png",
      }),
      nodeImageSanitizer,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "FILE_TOO_LARGE",
  );
});

test("multipart parsing stops at the real streamed body limit", async () => {
  const form = new FormData();
  form.set("kind", "source");
  const parsed = await readBoundedFormData(
    new Request("https://studio.example.test/api/assets", {
      body: form,
      method: "POST",
    }),
    1024,
  );
  assert.equal(parsed.get("kind"), "source");

  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedFormData(
      new Request("https://studio.example.test/api/assets", {
        body: oversizedStream,
        headers: { "content-type": "multipart/form-data; boundary=test" },
        method: "POST",
        // Node requires duplex for streamed request bodies; Workers ignore it.
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      10,
    ),
    hasErrorCode("BODY_TOO_LARGE"),
  );
  await assert.rejects(
    readBoundedFormData(
      new Request("https://studio.example.test/api/assets", {
        body: "not-multipart",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        method: "POST",
      }),
      1024,
    ),
    hasErrorCode("INVALID_MULTIPART"),
  );
});

test("upload validation fully decodes, strips metadata and rejects pixel bombs", async () => {
  const source = await testSharp({
    create: { width: 20, height: 10, channels: 3, background: "#8c735b" },
  })
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Artist: "private-location-marker" } })
    .jpeg()
    .toBuffer();
  const sourceBytes = Uint8Array.from(source);
  assert.match(source.toString("latin1"), /private-location-marker/u);

  const sanitized = await validateUploadedImage(
    new File([sourceBytes.buffer], "room.jpg", { type: "image/jpeg" }),
    nodeImageSanitizer,
  );
  assert.equal(sanitized.mimeType, "image/jpeg");
  assert.doesNotMatch(Buffer.from(sanitized.bytes).toString("latin1"), /Exif|private-location-marker/u);
  assert.notDeepEqual(sanitized.bytes, new Uint8Array(source));
  const metadata = readImageMetadata(sanitized);
  assert.equal(metadata.width, 10);
  assert.equal(metadata.height, 20);

  const truncated = sourceBytes.slice(0, Math.floor(sourceBytes.byteLength / 2));
  await assert.rejects(
    validateUploadedImage(
      new File([truncated.buffer], "broken.jpg", { type: "image/jpeg" }),
      nodeImageSanitizer,
    ),
    hasErrorCode("INVALID_IMAGE"),
  );

  const tooLarge = {
    sanitize: async () => ({
      bytes: sanitized.bytes,
      mimeType: "image/jpeg" as const,
      width: MAX_UPLOAD_PIXELS + 1,
      height: 1,
      hasAlpha: false,
    }),
  };
  await assert.rejects(
    validateUploadedImage(
      new File([sourceBytes.buffer], "room.jpg", { type: "image/jpeg" }),
      tooLarge,
    ),
    hasErrorCode("IMAGE_SANITIZER_ERROR"),
  );
});

test("generated image validation rejects unreadable or excessive dimensions", () => {
  const valid = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
  assert.equal(validateGeneratedImage(valid, "image/png").mimeType, "image/png");

  const oversized = valid.slice();
  new DataView(oversized.buffer).setUint32(16, 9000);
  new DataView(oversized.buffer).setUint32(20, 9000);
  assert.throws(
    () => validateGeneratedImage(oversized, "image/png"),
    hasErrorCode("INVALID_PROVIDER_OUTPUT"),
  );
  assert.throws(
    () => validateGeneratedImage(valid, "image/jpeg"),
    hasErrorCode("INVALID_PROVIDER_OUTPUT"),
  );
  assert.throws(
    () => validateGeneratedImage(valid.subarray(0, 12), "image/png"),
    hasErrorCode("INVALID_PROVIDER_OUTPUT"),
  );

  const vp8l = webpLossless(320, 240);
  assert.equal(validateGeneratedImage(vp8l, "image/webp").mimeType, "image/webp");
  const oversizedWebp = webpLossless(8193, 240);
  assert.throws(
    () => validateGeneratedImage(oversizedWebp, "image/webp"),
    hasErrorCode("INVALID_PROVIDER_OUTPUT"),
  );
});

function webpLossless(width: number, height: number): Uint8Array {
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  const payload = Uint8Array.from([
    0x2f,
    encodedWidth & 0xff,
    ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x3f) << 6),
    (encodedHeight >> 2) & 0xff,
    (encodedHeight >> 10) & 0x0f,
  ]);
  const paddedLength = payload.length + (payload.length & 1);
  const result = new Uint8Array(12 + 8 + paddedLength);
  result.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  result.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(result.buffer).setUint32(16, payload.length, true);
  result.set(payload, 20);
  return result;
}

test("job hashing is deterministic and detects idempotency-key payload conflicts", () => {
  const first = parseCreateJobInput(validJobInput());
  const replay = parseCreateJobInput(validJobInput());
  const changed = parseCreateJobInput(validJobInput({ outputCount: 3 }));

  assert.equal(first.requestHash, replay.requestHash);
  assert.notEqual(first.requestHash, changed.requestHash);
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.equal(first.workflowType, "advanced");
  assert.equal(first.resolution, "2K");
  assert.equal(first.aspectRatio, "16:9");
  assert.equal(first.quality, "high");
  assert.equal(first.lampState, "on");
  assert.equal(first.colorTemperatureKelvin, 3200);
});

test("new job controls are hashed and Kelvin stays in the frozen range", () => {
  const withoutControls = parseCreateJobInput(validJobInput());
  const withControls = parseCreateJobInput(
    validJobInput({
      depthAssetId: "asset_depth",
      normalAssetId: "asset_normal",
    }),
  );
  assert.notEqual(withoutControls.requestHash, withControls.requestHash);
  assert.equal(withControls.depthAssetId, "asset_depth");
  assert.equal(withControls.normalAssetId, "asset_normal");
  assert.throws(
    () =>
      parseCreateJobInput(
        validJobInput({ colorTemperatureKelvin: 6501 }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_FIELD",
  );
});

test("advanced prior-concept references retain owner and kind boundaries", async () => {
  assert.deepEqual(referenceAssetKindsForWorkflow("advanced"), [
    "reference",
    "output",
  ]);
  assert.deepEqual(referenceAssetKindsForWorkflow("concept"), ["reference"]);
  assert.deepEqual(referenceAssetKindsForWorkflow("floorplan"), ["reference"]);
  assert.deepEqual(sourceAssetKindsForWorkflow("concept", false), ["source"]);
  assert.deepEqual(sourceAssetKindsForWorkflow("concept", true), [
    "source",
    "output",
  ]);
  assert.deepEqual(sourceAssetKindsForWorkflow("advanced", false), [
    "source",
    "output",
  ]);
  assert.deepEqual(sourceAssetKindsForWorkflow("floorplan", false), [
    "floorplan",
  ]);

  const route = await readFile(
    new URL("../../app/api/jobs/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getAsset\(input\.referenceAssetId, actor\.ownerId\)/u);
  assert.match(route, /referenceAssetKindsForWorkflow\(input\.workflowType\)/u);
  assert.match(route, /sourceAssetKindsForWorkflow\(input\.workflowType/u);
});

test("today asset scope uses the China product-day boundary", () => {
  assert.equal(
    startOfTodayInShanghai(new Date("2026-08-16T03:30:00.000Z")),
    "2026-08-15T16:00:00.000Z",
  );
  assert.equal(
    startOfTodayInShanghai(new Date("2026-08-15T15:59:59.999Z")),
    "2026-08-14T16:00:00.000Z",
  );
});

test("local editing requires both a mask and an instruction", () => {
  assert.throws(
    () => parseCreateJobInput(validJobInput({ maskAssetId: "asset_mask" })),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INCOMPLETE_LOCAL_EDIT",
  );
  const parsed = parseCreateJobInput(
    validJobInput({
      sourceAssetId: "asset_output_parent",
      maskAssetId: "asset_mask",
      editInstruction: "替换选中区域的单椅",
    }),
  );
  assert.equal(parsed.sourceAssetId, "asset_output_parent");
  assert.equal(parsed.maskAssetId, "asset_mask");
});

test("unexpected API errors never expose internal messages to clients", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const response = errorResponse(
      new Error("database password=do-not-leak"),
      "request-safe",
    );
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /do-not-leak|password|database/u);
    assert.match(text, /INTERNAL_ERROR/u);
    assert.match(text, /request-safe/u);
  } finally {
    console.error = originalConsoleError;
  }
});

test("serialized output assets expose immutable parent lineage without storage keys", () => {
  const serialized = serializeAsset({
    id: "asset_child",
    ownerId: "session:owner-secret",
    kind: "output",
    status: "READY",
    originalFileName: "generated.png",
    mimeType: "image/png",
    byteSize: 128,
    sha256: "a".repeat(64),
    sanitizationVersion: "canonical-image-v1",
    storageKey: "private/generated/secret.png",
    parentAssetId: "asset_parent",
    createdAt: "2026-08-16T00:00:00.000Z",
    deletedAt: null,
    retentionExpiresAt: null,
    deletionRequestedAt: null,
    deletionActionId: null,
    purgedAt: null,
    moderationStatus: "APPROVED",
    moderatedAt: null,
    moderationReason: null,
    moderationActionId: null,
  });

  assert.equal(serialized.parentAssetId, "asset_parent");
  assert.equal(serialized.url, "/api/assets/asset_child?content=1");
  assert.equal("ownerId" in serialized, false);
  assert.equal("storageKey" in serialized, false);
  assert.equal("sha256" in serialized, false);
});

test("serialized jobs expose every frozen generation control in deterministic order", () => {
  const serialized = serializeJob(
    {
      id: "job_contract",
      ownerId: "session:secret",
      sourceAssetId: "asset_source",
      referenceAssetId: "asset_reference",
      maskAssetId: null,
      depthAssetId: "asset_depth",
      normalAssetId: "asset_normal",
      workflowType: "advanced",
      resolution: "4K",
      aspectRatio: "3:2",
      quality: "high",
      lampState: "off",
      colorTemperatureKelvin: 6500,
      stylePresetId: "modern-minimalist",
      lightingPreset: "night",
      preservationMode: "structure",
      providerPreference: "openai",
      editInstruction: null,
      outputCount: 2,
      status: "QUEUED",
      completedOutputCount: 0,
      idempotencyKey: "idempotency-contract",
      requestHash: "b".repeat(64),
      provider: null,
      model: null,
      providerRequestId: null,
      promptTemplateVersion: null,
      errorCode: null,
      errorMessage: null,
      errorRetryable: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    },
    [],
  );

  assert.deepEqual(serialized.controlAssetIds, ["asset_depth", "asset_normal"]);
  assert.equal(serialized.workflowType, "advanced");
  assert.equal(serialized.resolution, "4K");
  assert.equal(serialized.aspectRatio, "3:2");
  assert.equal(serialized.quality, "high");
  assert.equal(serialized.lampState, "off");
  assert.equal(serialized.colorTemperatureKelvin, 6500);
  assert.equal(serialized.providerPreference, "openai");
  assert.equal("ownerId" in serialized, false);
});

test("new owner APIs preserve privacy and the canonical vision contract", async () => {
  const [assetsRoute, visionRoute, meRoute] = await Promise.all([
    readFile(new URL("../../app/api/assets/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/vision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/me/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(assetsRoute, /listAssets\(actor\.ownerId/u);
  assert.match(assetsRoute, /limit\s*>\s*100/u);
  assert.match(assetsRoute, /assets:\s*rows\.map\(serializeAsset\)/u);
  assert.match(visionRoute, /body\.artifactTypes\s*\?\?\s*body\.artifacts/u);
  assert.match(visionRoute, /artifactType:\s*artifact\.kind/u);
  assert.match(visionRoute, /assertVisionActor\(actor, environment\)/u);
  assert.match(visionRoute, /source\.kind\s*!==\s*"source"[\s\S]*source\.kind\s*!==\s*"output"/u);
  assert.match(visionRoute, /source\.sanitizationVersion\s*!==\s*IMAGE_SANITIZATION_VERSION/u);
  assert.match(visionRoute, /sanitizeGeneratedImage\([\s\S]*sanitizer/u);
  assert.match(visionRoute, /sanitizationVersion:\s*IMAGE_SANITIZATION_VERSION/u);
  assert.match(meRoute, /getAssetStats\(actor\.ownerId\)/u);
  assert.doesNotMatch(meRoute, /oai-authenticated-user-id/u);
});

test("template mutations enforce same-origin requests while reads stay public to the owner", async () => {
  const [collection, item, share, shared] = await Promise.all([
    readFile(new URL("../../app/api/templates/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/templates/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/templates/[id]/share/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/templates/shared/[token]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /assertSameOriginMutation\(request\)/u);
  assert.match(item, /PATCH[\s\S]*assertSameOriginMutation\(request\)/u);
  assert.match(item, /DELETE[\s\S]*assertSameOriginMutation\(request\)/u);
  assert.match(share, /POST[\s\S]*assertSameOriginMutation\(request\)/u);
  assert.doesNotMatch(collection.match(/export async function GET[\s\S]*?export async function POST/u)?.[0] ?? "", /assertSameOriginMutation/u);
  assert.doesNotMatch(shared, /assertSameOriginMutation/u);
});

test("admin and analytics routes keep privilege and same-origin boundaries explicit", async () => {
  const [admin, analytics] = await Promise.all([
    readFile(new URL("../../app/api/admin/console/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/analytics/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /assertSiteAdmin\(actor, bindings\)/u);
  assert.match(admin, /PATCH[\s\S]*assertSameOriginMutation\(request\)[\s\S]*readJsonBody\(request, 8 \* 1024\)/u);
  assert.match(admin, /POST[\s\S]*assertSameOriginMutation\(request\)[\s\S]*readJsonBody\(request, 8 \* 1024\)/u);
  assert.match(analytics, /POST[\s\S]*assertSameOriginMutation\(request\)[\s\S]*recordAnalyticsEvent/u);
  assert.doesNotMatch(analytics, /export async function GET/u);
});

test("asset content route enforces owner lookup and private response headers", async () => {
  const route = await readFile(
    new URL("../../app/api/assets/[id]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getAsset\(id, actor\.ownerId\)/u);
  assert.match(route, /Cache-Control", "private, no-store"/u);
  assert.match(route, /X-Content-Type-Options", "nosniff"/u);
  assert.doesNotMatch(route, /getR2Binding|ASSETS_BUCKET/u);
});

test("Cloudflare runtime imports stay behind the platform seam", async () => {
  const files = [
    "lib/platform/cloudflare-runtime.ts",
    "db/index.ts",
    "lib/server/background.ts",
    "lib/server/ai-environment.ts",
    "lib/server/wechat-auth-config.ts",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8")),
  );
  const [platform, ...callers] = sources;
  assert.match(platform, /from\s+["']cloudflare:workers["']/u);
  for (const source of callers) assert.doesNotMatch(source, /cloudflare:workers/u);
  assert.match(sources[1], /readRuntimeBindings\(\)/u);
  assert.match(sources[2], /tryWaitUntil\(promise\)/u);
  assert.match(sources[3], /readRuntimeBindings\(\)/u);
  assert.match(sources[4], /readRuntimeBindings\(\)/u);
});

test("database and processor contracts retain owner-scoped idempotency and parent versions", async () => {
  const [schema, processor, route, background, queuedCreation, actor] = await Promise.all([
    readFile(new URL("../../db/schema.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../lib/server/job-processor.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../app/api/jobs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/background.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/queued-job-creation.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/actor.ts", import.meta.url), "utf8"),
  ]);
  assert.match(
    schema,
    /uidx_generation_jobs_owner_idempotency[\s\S]*table\.ownerId[\s\S]*table\.idempotencyKey/u,
  );
  assert.match(
    processor,
    /sourceAssetKindsForWorkflow\(job\.workflowType, Boolean\(job\.maskAssetId\), job\.purpose, Boolean\(job\.sourceJobId\)\)/u,
  );
  assert.match(processor, /parentAssetId:\s*job\.sourceAssetId/u);
  assert.match(route, /const outputs = result\.created\s*\? \[\]/u);
  assert.match(route, /createQueuedJobIdempotently/u);
  assert.match(route, /assertDraftScope\(\(rawBody as Record<string, unknown>\)\.draftScope, actor\)/u);
  assert.match(actor, /timingSafeEqual\(actual, expected\)/u);
  assert.match(actor, /DRAFT_SCOPE_MISMATCH/u);
  assert.match(route, /assertDraftScope\([\s\S]*?\n\s*const environment = readAiEnvironment\(\)[\s\S]*?\n\s*assertCostBearingActor/u);
  assert.match(route, /assertDraftScope\([\s\S]*?createQueuedJobIdempotently/u);
  assert.match(actor, /typeof value !== "string"[\s\S]*DRAFT_SCOPE_MISMATCH/u);
  assert.match(actor, /hashIdentifier\(`draft:\$\{actor\.identityNamespace \?\? actor\.ownerId\}`\)/u);
  assert.match(route, /assertQueuedJobItemsConsistent/u);
  assert.doesNotMatch(route, /scheduleBackground|processGenerationJob/u);
  assert.match(queuedCreation, /d1\.batch\(\[insertAdmission, insertJob, retainInputs, \.\.\.insertItems, \.\.\.\(privateTestCredit \? \[privateTestCredit\] : \[\]\), \.\.\.reserveCredits\]\)/u);
  assert.match(queuedCreation, /providerKey = imageModelProvider/u);
  assert.match(background, /tryWaitUntil\(promise\)/u);
  assert.doesNotMatch(background, /await\s+promise/u);
});

test("D1 migration and runtime bootstrap contain every v2 generation column", async () => {
  const [migration, runtimeSchema] = await Promise.all([
    readFile(new URL("../../drizzle/0001_noisy_wong.sql", import.meta.url), "utf8"),
    readFile(new URL("../../db/index.ts", import.meta.url), "utf8"),
  ]);
  for (const column of [
    "depth_asset_id",
    "normal_asset_id",
    "workflow_type",
    "resolution",
    "aspect_ratio",
    "quality",
    "lamp_state",
    "color_temperature_kelvin",
  ]) {
    assert.match(migration, new RegExp(`ADD \\x60?${column}\\x60?`, "u"));
    assert.match(runtimeSchema, new RegExp(`name: "${column}"`, "u"));
  }
});
