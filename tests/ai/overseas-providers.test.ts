import assert from "node:assert/strict";
import test from "node:test";
import sharpRuntime from "sharp";
type SharpPipeline = { png(options?: { compressionLevel: number }): SharpPipeline; jpeg(): SharpPipeline; webp(): SharpPipeline; toBuffer(): Promise<Buffer> };
const sharp = sharpRuntime as (input: unknown, options?: unknown) => SharpPipeline;
import { prepareOverseasSingleImageGeneration, type GenerateInteriorImagesRequest } from "../../lib/ai";
import { overseasImageModelValues, imageModelCapabilities } from "../../lib/domain/image-models";
import { compileInteriorPrompt } from "../../lib/ai/prompt";

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
const jpeg = await sharp(png).jpeg().toBuffer();
const image = { bytes: new Uint8Array(png), mimeType: "image/png" as const };
function request(model: GenerateInteriorImagesRequest["providerPreference"]): GenerateInteriorImagesRequest { return { workflowType: "self-service", purpose: "final", resolution: "1K", aspectRatio: "4:3", quality: "auto", style: { presetId: "self-service" }, lighting: { timeOfDay: "day", lampState: "off", colorTemperatureKelvin: 4000 }, renovationScope: "restyle", customPrompt: "A calm living room", outputCount: 1, providerPreference: model }; }
const env = { BACKEND_PROFILE: "cn-production" as const, OPENAI_API_KEY: "test-openai", GOOGLE_API_KEY: "test-google" };

test("Google error or incomplete envelopes never promote body IDs or gateway IDs", async () => {
  for (const body of [{ responseId: "not-success", error: {} }, { responseId: "not-success", candidates: [] }, { responseId: "not-success", candidates: [{ finishReason: "MAX_TOKENS" }] }]) {
    await assert.rejects(prepareOverseasSingleImageGeneration(request("gemini-3-pro-image"), { env, fetch: async () => Response.json(body, { headers: { "x-request-id": "gateway-only" } }) }).execute(), (error: unknown) => Boolean(error && typeof error === "object" && (!('providerRequestId' in error) || error.providerRequestId === undefined)));
  }
});

test("all six exact overseas models issue one request; text and ordered references use correct native protocol", async () => {
  for (const model of overseasImageModelValues) {
    for (const referenceImages of [undefined, [{ role: "reference" as const, image }]]) {
      let calls = 0;
      const work = { ...request(model), referenceImages };
      const prepared = prepareOverseasSingleImageGeneration(work, { env, providerRequestTimeoutMs: 300_000, fetch: async (url, init) => {
        calls++;
        if (model.startsWith("gpt-")) {
          assert.equal(String(url), `https://api.openai.com/v1/images/${referenceImages ? "edits" : "generations"}`);
          const body = init!.body instanceof FormData ? Object.fromEntries(init!.body.entries()) : JSON.parse(String(init!.body));
          assert.equal(body.model, model); assert.equal(String(body.n), "1"); assert.equal(body.quality, "auto"); assert.equal(body.output_format, "jpeg");
          if (referenceImages) assert.equal((init!.body as FormData).getAll("image[]").length, 1);
          return new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64") }] }), { headers: { "x-zaoshi-provider-request-id": `actual-${model}` } });
        }
        assert.equal(String(url), `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
        const body = JSON.parse(String(init!.body));
        assert.equal(body.model, undefined); assert.equal(body.generationConfig.candidateCount, 1); assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]); assert.deepEqual(body.generationConfig.imageConfig, { imageSize: "1K", aspectRatio: "4:3" }); assert.equal(body.generationConfig.responseMimeType, undefined);
        assert.equal(body.contents[0].parts[0].text, compileInteriorPrompt(work, { id: "self-service", name: "", description: "", preview: "", promptDirective: "" }).text);
        assert.equal(body.contents[0].parts.filter((block: { inlineData?: unknown }) => block.inlineData).length, referenceImages ? 1 : 0);
        return new Response(JSON.stringify({ responseId: `actual-${model}`, candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, inlineData: { data: "BAD", mimeType: "image/png" } }, { inlineData: { data: png.toString("base64"), mimeType: "image/png" } }] } }] }));
      } });
      const result = await prepared.execute();
      assert.equal(result.model, model); assert.equal(result.outputs.length, 1); assert.equal(result.providerRequestId, `actual-${model}`);
      await assert.rejects(prepared.execute()); assert.equal(calls, 1);
    }
  }
});

test("native quality matrix and Google 0.5K maps to 512 without changing UI resolution", async () => {
  for (const model of overseasImageModelValues) {
    for (const quality of imageModelCapabilities[model].nativeQualities) {
      const prepared = prepareOverseasSingleImageGeneration({ ...request(model), quality }, { env, fetch: async (_url, init) => {
        const body = JSON.parse(String(init!.body)); assert.equal(body.quality, quality);
        return new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64") }] }));
      } });
      await prepared.execute();
    }
  }
  assert.throws(() => prepareOverseasSingleImageGeneration({ ...request("gpt-image-2"), quality: "max" }, { env, fetch: globalThis.fetch }));
  const prepared = prepareOverseasSingleImageGeneration({ ...request("gemini-3.1-flash-image"), resolution: "0.5K" }, { env, fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init!.body)).generationConfig.imageConfig.imageSize, "512");
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: png.toString("base64"), mimeType: "image/png" } }] } }] }));
  } });
  assert.equal((await prepared.execute()).outputs[0].metadata.resolution, "0.5K");
});

test("4MiB valid image passes linear base64 checks, invalid/oversize/multiple/incomplete output retains actual ID", async () => {
  const large = await sharp(Buffer.alloc(1200 * 1200 * 3, 120), { raw: { width: 1200, height: 1200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(large.length > 4 * 1024 * 1024 && large.length < 8 * 1024 * 1024);
  const part = { inlineData: { data: large.toString("base64"), mimeType: "image/png" } };
  const candidate = { finishReason: "STOP", content: { parts: [part] } };
  const body = { responseId: "actual-large", candidates: [candidate] };
  assert.equal((await prepareOverseasSingleImageGeneration(request("gemini-3.1-flash-image"), { env, fetch: async () => new Response(JSON.stringify(body)) }).execute()).outputs[0].bytes.length, large.length);
  const badBlocks = [
    { candidates: [{ ...candidate, finishReason: "MAX_TOKENS" }] },
    { candidates: [] },
    { candidates: [candidate, candidate] },
    { candidates: [{ ...candidate, content: { parts: [part, part] } }] },
    { candidates: [{ ...candidate, content: { parts: [{ inlineData: { data: "abcd==", mimeType: "image/png" } }] } }] },
    { candidates: [{ ...candidate, content: { parts: [{ inlineData: { data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"), mimeType: "image/png" } }] } }] },
  ];
  for (const value of badBlocks) await assert.rejects(prepareOverseasSingleImageGeneration(request("gemini-3.1-flash-image"), { env, fetch: async () => new Response(JSON.stringify(value), { headers: { "x-zaoshi-provider-request-id": "actual-error" } }) }).execute(), (error: unknown) => Boolean(error && typeof error === "object" && "providerRequestId" in error && error.providerRequestId === "actual-error"));
  for (const data of [[], [{ b64_json: jpeg.toString("base64") }, { b64_json: jpeg.toString("base64") }]]) await assert.rejects(prepareOverseasSingleImageGeneration(request("gpt-image-2"), { env, fetch: async () => new Response(JSON.stringify({ data }), { headers: { "x-zaoshi-provider-request-id": "actual-openai-error" } }) }).execute(), (error: unknown) => Boolean(error && typeof error === "object" && "providerRequestId" in error && error.providerRequestId === "actual-openai-error"));
});


test("OpenAI request for JPEG accepts a real PNG response by its bytes", async () => {
  let calls = 0;
  const prepared = prepareOverseasSingleImageGeneration(request("gpt-image-2"), { env, fetch: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init!.body)).output_format, "jpeg");
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  } });
  const result = await prepared.execute();
  assert.equal(result.outputs[0].mimeType, "image/png");
  assert.deepEqual(result.outputs[0].bytes, new Uint8Array(png));
  assert.equal(calls, 1);
});


test("OpenAI accepts actual JPEG, PNG and WebP bytes without trusting declared format", async () => {
  const webp = await sharp(png).webp().toBuffer();
  for (const [mimeType, bytes] of [["image/jpeg", jpeg], ["image/png", png], ["image/webp", webp]] as const) {
    let calls = 0;
    const prepared = prepareOverseasSingleImageGeneration(request("gpt-image-2"), { env, fetch: async () => { calls++; return Response.json({ output_format: "jpeg", data: [{ b64_json: bytes.toString("base64"), output_format: "jpeg" }] }, { headers: { "x-zaoshi-provider-request-id": "actual-format-id" } }); } });
    const result = await prepared.execute();
    assert.equal(result.outputs[0].mimeType, mimeType); assert.deepEqual(result.outputs[0].bytes, new Uint8Array(bytes));
    assert.equal(result.providerRequestId, "actual-format-id");
    await assert.rejects(prepared.execute()); assert.equal(calls, 1);
  }
});

test("OpenAI still rejects malformed, oversized or excessive-dimension output and retains provider ID", async () => {
  const tooWide = png.slice(); tooWide.writeUInt32BE(8193, 16);
  const tooManyPixels = png.slice(); tooManyPixels.writeUInt32BE(8192, 16); tooManyPixels.writeUInt32BE(8192, 20);
  for (const encoded of ["bad==", Buffer.from("not an image").toString("base64"), Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"), tooWide.toString("base64"), tooManyPixels.toString("base64")]) {
    let calls = 0;
    const prepared = prepareOverseasSingleImageGeneration(request("gpt-image-2"), { env, fetch: async () => { calls++; return Response.json({ data: [{ b64_json: encoded }] }, { headers: { "x-zaoshi-provider-request-id": "actual-rejected-id" } }); } });
    await assert.rejects(prepared.execute(), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "NO_IMAGE_OUTPUT" && "providerRequestId" in error && error.providerRequestId === "actual-rejected-id"));
    await assert.rejects(prepared.execute()); assert.equal(calls, 1);
  }
  await assert.rejects(prepareOverseasSingleImageGeneration(request("gemini-3-pro-image"), { env, fetch: async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: png.toString("base64"), mimeType: "image/jpeg" } }] } }] }) }).execute());
});
