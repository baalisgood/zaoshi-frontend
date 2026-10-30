import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutputCounter, QualityField } from "../../components/studio/StudioFields";
import { imageModelResolutionOptions, imageModelCapabilities, imageModelValues, imageQualityValues, normalizeImageQuality, normalizeImageResolution, normalizeKnownImageModel, restoreSelfServiceResolution } from "../../lib/domain/image-models";
import { isDomesticImageModel } from "../../lib/domain/domestic-image-models";

test("12 exact models have independent resolution and native quality contracts", () => {
  assert.equal(imageModelValues.length, 12);
  assert.deepEqual(imageModelCapabilities["gemini-3.1-flash-lite-image"].supportedResolutions, ["1K"]);
  assert.deepEqual(imageModelCapabilities["gemini-3.1-flash-image"].supportedResolutions, ["0.5K", "1K", "2K", "4K"]);
  for (const model of imageModelValues) {
    assert.equal(imageModelCapabilities[model].officialModel, model);
    const native = imageModelCapabilities[model].nativeQualities;
    assert.deepEqual(native, model.startsWith("gpt-image-2.5-") ? imageQualityValues : model === "gpt-image-2" ? imageQualityValues.slice(0, 4) : []);
    for (const quality of imageQualityValues) {
      assert.equal(normalizeImageQuality(model, quality), native.includes(quality) ? quality : "auto");
      assert.equal(normalizeImageResolution(model, "2K"), imageModelCapabilities[model].supportedResolutions.includes("2K") ? "2K" : imageModelCapabilities[model].supportedResolutions[0]);
    }
    const html = renderToStaticMarkup(createElement(QualityField, { model, value: "auto", onChange: () => undefined }));
    assert.match(html, /<legend>模型质量<\/legend>/u);
    assert.equal((html.match(/<button/g) ?? []).length, 6);
    assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 6 - native.length);
    assert.doesNotMatch(html, /<select/u);
    const resolutions = imageModelResolutionOptions(model);
    assert.deepEqual(resolutions.map((option) => option.value), ["0.5K", "1K", "2K", "4K"]);
    assert.deepEqual(resolutions.filter((option) => !option.disabled).map((option) => option.value), imageModelCapabilities[model].supportedResolutions);
  }
  assert.equal(isDomesticImageModel("gpt-image-2"), false);
  assert.equal(normalizeKnownImageModel("google"), "gemini-3.1-flash-image");
  assert.equal(normalizeKnownImageModel("openai"), "gpt-image-2");
  assert.equal(normalizeImageQuality("gpt-image-2", "draft"), "low");
  assert.equal(normalizeImageQuality("gpt-image-2", "standard"), "medium");
  assert.equal(normalizeImageQuality("qwen-image-3.0-pro", "high"), "auto");
});

test("legacy self-service quality restores its old resolution before quality normalization", () => {
  const model = "qwen-image-3.0-pro";
  assert.equal(restoreSelfServiceResolution(model, { quality: "draft" }), "1K");
  assert.equal(restoreSelfServiceResolution(model, { quality: "standard" }), "2K");
  assert.equal(restoreSelfServiceResolution("doubao-seedream-4-5-251128", { quality: "high" }), "4K");
  assert.equal(restoreSelfServiceResolution("gpt-image-2", { quality: "high", resolution: "1K" }), "1K");
  assert.equal(restoreSelfServiceResolution("gemini-3.1-flash-lite-image", { quality: "high", resolution: "4K" }), "1K");
});


test("shared output counter preserves 1–4 boundaries and busy protection", () => {
  for (const [value, busy, disabled] of [[1, false, 1], [2, false, 0], [4, false, 1], [2, true, 2]] as const) {
    const html = renderToStaticMarkup(createElement(OutputCounter, { value, busy, onChange: () => undefined }));
    assert.match(html, new RegExp(`<b>${value}</b>`, "u"));
    assert.equal((html.match(/disabled=""/g) ?? []).length, disabled);
    assert.match(html, /aria-label="减少输出数量"/u);
    assert.match(html, /aria-label="增加输出数量"/u);
  }
});
