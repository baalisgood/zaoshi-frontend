import approved from "./fixtures/approved-generation-prices-20261005.json";
import { openAiSize } from "../../lib/ai/output-spec";
import type { OutputAspectRatio } from "../../lib/ai/types";
import assert from "node:assert/strict";
import test from "node:test";

import { POST as quotePrice } from "../../app/api/jobs/quote/route";
import { domesticImageModelQualityResolution } from "../../lib/domain/domestic-image-models";
import { parseCreateJobInput } from "../../lib/server/job-contract";
import { quoteGenerationPrice, readGenerationPriceExpectation } from "../../lib/server/generation-pricing";
import { overseasImageModelValues } from "../../lib/domain/image-models";
import { PRIVATE_TEST_OWNER } from "../../lib/server/private-test-policy";

test("quality chooses each model's highest connected resolution", () => {
  assert.equal(domesticImageModelQualityResolution("doubao-seedream-4-5-251128", "high"), "4K");
  assert.equal(domesticImageModelQualityResolution("qwen-image-2.0-pro", "high"), "2K");
  assert.equal(domesticImageModelQualityResolution("qwen-image-2.0-pro", "standard"), "2K");
  assert.equal(domesticImageModelQualityResolution("qwen-image-2.0-pro", "draft"), "1K");
});

test("price-v1 uses the selected model and its lowest supported resolution for previews", () => {
  const quote = quoteGenerationPrice({
    modelId: "qwen-image-3.0-pro",
    purpose: "preview",
    requestedResolution: "2K",
    inputImageCount: 3,
    outputCount: 4,
  });

  assert.deepEqual(
    {
      modelId: quote.modelId,
      resolution: quote.effectiveResolution,
      outputCount: quote.outputCount,
      amountPerItem: quote.amountPerItem,
      totalCredits: quote.totalCredits,
    },
    {
      modelId: "qwen-image-3.0-pro",
      resolution: "1K",
      outputCount: 1,
      amountPerItem: 69,
      totalCredits: 69,
    },
  );
});

test("price-v1 charges outputs and only provider-billed reference inputs", () => {
  const cases = [
    ["doubao-seedream-5-0-pro-260628", "2K", 3, 2, 143, 286],
    ["doubao-seedream-5-0-260128", "2K", 10, 2, 49, 98],
    ["doubao-seedream-4-5-251128", "2K", 10, 2, 56, 112],
    ["doubao-seedream-4-5-251128", "4K", 10, 2, 56, 112],
    ["qwen-image-3.0-pro", "2K", 3, 2, 125, 250],
    ["qwen-image-3.0", "2K", 3, 2, 54, 108],
    ["qwen-image-2.0-pro", "1K", 3, 2, 112, 224],
  ] as const;

  for (const [modelId, resolution, inputImageCount, outputCount, amountPerItem, totalCredits] of cases) {
    const quote = quoteGenerationPrice({ modelId, purpose: "final", requestedResolution: resolution, inputImageCount, outputCount });
    assert.equal(quote.amountPerItem, amountPerItem, modelId);
    assert.equal(quote.totalCredits, totalCredits, modelId);
  }
});

test("operation type describes the request but does not add a separate editing surcharge", () => {
  const text = quoteGenerationPrice({ modelId: "doubao-seedream-4-5-251128", purpose: "final", requestedResolution: "2K", inputImageCount: 0, outputCount: 1 });
  const multi = quoteGenerationPrice({ modelId: "doubao-seedream-4-5-251128", purpose: "final", requestedResolution: "2K", inputImageCount: 3, outputCount: 1 });
  assert.equal(text.operationType, "text-to-image");
  assert.equal(multi.operationType, "multi-reference");
  assert.equal(text.totalCredits, multi.totalCredits);
});

test("unsupported resolution and excessive inputs fail closed", () => {
  assert.throws(
    () => quoteGenerationPrice({ modelId: "qwen-image-3.0", purpose: "preview", requestedResolution: "garbage", inputImageCount: 0, outputCount: 1 }),
    hasCode("INVALID_PRICING_INPUT"),
  );
  assert.throws(
    () => quoteGenerationPrice({ modelId: "doubao-seedream-4-5-251128", purpose: "final", requestedResolution: "1K", inputImageCount: 0, outputCount: 1 }),
    hasCode("INVALID_PRICING_INPUT"),
  );
  assert.throws(
    () => quoteGenerationPrice({ modelId: "qwen-image-3.0", purpose: "final", requestedResolution: "1K", inputImageCount: 4, outputCount: 1 }),
    hasCode("INVALID_PRICING_INPUT"),
  );
});

test("quote API refuses production-off anonymous requests before exposing commercial prices", async () => {
  const response = await quotePrice(new Request("http://localhost/api/jobs/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "qwen-image-3.0", purpose: "final", resolution: "2K", inputImageCount: 2, outputCount: 3 }),
  }));
  const payload = await response.json() as { quote?: unknown };
  assert.equal(response.status, 503);
  assert.equal(payload.quote, undefined);
});

test("submission price expectation is explicit and bounded", () => {
  assert.deepEqual(readGenerationPriceExpectation({ expectedPriceVersion: "price-v1", expectedTotalCredits: 100 }), { expectedPriceVersion: "price-v1", expectedTotalCredits: 100 });
  assert.equal(readGenerationPriceExpectation({}), undefined);
  assert.throws(() => readGenerationPriceExpectation({ expectedPriceVersion: "price-v1" }), hasCode("INVALID_PRICING_INPUT"));
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

test("overseas reservations require verified active private-test context, never a body flag or commercial price", async () => {
  const actor = { ownerId: PRIVATE_TEST_OWNER, setCookie: null, trusted: true, user: { authenticated: true, displayName: "test", role: "USER" as const } };
  const context = { privateTest: { config: { expiresAt: Math.floor(Date.now() / 1000) + 60 }, actor } };
  for (const modelId of overseasImageModelValues) {
    const input = { modelId, purpose: "final", requestedResolution: "1K", inputImageCount: 1, outputCount: 4, quality: "auto" };
    assert.throws(() => quoteGenerationPrice(input), hasCode("OVERSEAS_PRIVATE_TEST_ONLY"));
    assert.throws(() => quoteGenerationPrice(input, { privateTest: { ...context.privateTest, config: { expiresAt: 1 } } }), hasCode("PRIVATE_TEST_EXPIRED"));
    assert.throws(() => quoteGenerationPrice(input, { privateTest: { ...context.privateTest, actor: { ...actor, trusted: false } } }), hasCode("CANARY_ACCESS_REQUIRED"));
    const quote = quoteGenerationPrice(input, context);
    assert.equal(quote.totalCredits, 4); assert.equal(quote.amountPerItem, 1); assert.equal(quote.inputCredits, 0); assert.equal(quote.privateTestOnly, true); assert.equal(quote.billingMode, "private-test-reservation");
    const response = await quotePrice(new Request("http://localhost/api/jobs/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, resolution: "1K", privateTest: true, billingMode: "private-test-reservation" }) }));
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "GENERATION_QUEUE_NOT_READY");
  }
});


test("approved Excel's 2840 combinations match complete per-output quotes", () => {
  const qualities: Record<string, string> = { "低": "low", "中": "medium", "高": "high", "超高": "xhigh", "最高": "max", "自动": "auto", "自动（无独立质量档）": "auto" };
  let index = 0;
  for (const [modelId, qualityLabel, requestedResolution, ratio, size, maxInputs] of approved.rates as [string, string, string, string, string, number][]) {
    const aspectRatio = ratio === "全部站内比例" ? "4:3" : ratio;
    if (size !== "模型决定") assert.equal(openAiSize(requestedResolution as "1K" | "2K" | "4K", aspectRatio as OutputAspectRatio), size);
    for (let inputImageCount = 0; inputImageCount <= maxInputs; inputImageCount++) {
      const q = quoteGenerationPrice({ modelId, quality: qualities[qualityLabel], requestedResolution, aspectRatio, purpose: "final", inputImageCount, outputCount: 4 }, { production: true });
      assert.equal(q.amountPerItem, approved.points[index++], `${modelId}/${qualityLabel}/${requestedResolution}/${aspectRatio}/${inputImageCount}`);
      assert.equal(q.totalCredits, q.amountPerItem * 4);
      assert.equal(q.outputCreditsPerImage + q.inputCredits, q.amountPerItem);
    }
  }
  assert.equal(index, 2840);
});

test("size changes price, invalid ratios fail closed, and aliases use normalized quality", () => {
  const input = { modelId: "gpt-image-2.5-flare", requestedResolution: "2K", purpose: "final", inputImageCount: 0, outputCount: 1, quality: "high" };
  assert.notEqual(quoteGenerationPrice({ ...input, aspectRatio: "1:1" }, { production: true }).amountPerItem, quoteGenerationPrice({ ...input, aspectRatio: "16:9" }, { production: true }).amountPerItem);
  assert.throws(() => quoteGenerationPrice({ ...input, aspectRatio: "bad" }, { production: true }), hasCode("INVALID_PRICING_INPUT"));
  for (const [alias, normalized] of [["draft", "low"], ["standard", "medium"]]) assert.deepEqual(quoteGenerationPrice({ ...input, quality: alias }, { production: true }), quoteGenerationPrice({ ...input, quality: normalized }, { production: true }));
});

test("real quote, create parser and reprice agree for defaults, aliases, auto and preview", () => {
  const privateActor = { ownerId: PRIVATE_TEST_OWNER, setCookie: null, trusted: true, user: { authenticated: true, displayName: "private", role: "USER" as const } };
  const contexts = [{production:true as const},{privateTest:{config:{expiresAt:Math.floor(Date.now()/1000)+60},actor:privateActor}}];
  for (const context of contexts) for (const purpose of ["preview","final"] as const) for (const quality of [undefined,"auto","draft","standard","max"]) {
    const body={workflowType:"self-service",providerPreference:"gpt-image-2.5-sunburst",resolution:"4K",purpose,quality,outputCount:4,aspectRatio:"4:3",customPrompt:"test prompt",idempotencyKey:"quote-parser-contract"};
    const first=quoteGenerationPrice({modelId:body.providerPreference,requestedResolution:body.resolution,purpose,inputImageCount:0,outputCount:body.outputCount,quality,aspectRatio:body.aspectRatio},context);
    const parsed=parseCreateJobInput(body);
    const second=quoteGenerationPrice({modelId:parsed.providerPreference,requestedResolution:parsed.resolution,purpose:parsed.purpose,inputImageCount:0,outputCount:parsed.outputCount,quality:parsed.quality,aspectRatio:parsed.aspectRatio},context);
    assert.deepEqual(first,second,`${purpose}/${quality}/${Boolean('production' in context)}`);
    if(purpose==="preview") {assert.equal(first.outputCount,1);assert.equal(first.effectiveResolution,"1K");assert.equal(first.quality,"low");}
    else if(quality===undefined) assert.equal(first.quality,"medium");
    else if(quality==="auto") assert.equal(first.quality,"auto");
  }
});
