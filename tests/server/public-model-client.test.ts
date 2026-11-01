import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as options from "../../lib/domain/public-model-options";
import type { ImageModel, ImageQuality, ImageResolution } from "../../lib/domain/image-models";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function selectionHarness() {
  let index = 0, queued = false;
  const slots: unknown[] = [], deps: unknown[][] = [], effects: Array<() => void> = [];
  const current = { provider: "gpt-image-2.5-sunburst" as ImageModel, resolution: "2K" as ImageResolution, quality: "medium" as ImageQuality, setProvider: (value: unknown) => update("provider", value), setResolution: (value: unknown) => update("resolution", value), setQuality: (value: unknown) => update("quality", value) };
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };
  function update(field: "provider" | "resolution" | "quality", value: unknown) { const next = typeof value === "function" ? value(current[field]) : value; if (!Object.is(current[field], next)) { Object.assign(current, { [field]: next }); schedule(); } }
  const react = {
    useCallback(callback: unknown) { index++; return callback; },
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { if (!Object.is(slots[i], next)) { slots[i] = next; schedule(); } }]; },
    useEffect(effect: () => void, next: unknown[]) { const i = index++; if (!deps[i] || deps[i].some((v, n) => !Object.is(v, next[n]))) { deps[i] = next; effects.push(effect); } },
  };
  type Selection = { optionId?: string; ready: boolean; select(id: string): void; restore(config: Record<string, unknown>): unknown };
  const exports = {} as { usePublicModelOption: (...args: unknown[]) => Selection };
  const source = ts.transpileModule(readFileSync("components/studio/usePublicModelOption.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, require: (name: string) => name === "react" ? react : options });
  let selection: Selection;
  function render() { index = 0; selection = exports.usePublicModelOption(current.provider, current.resolution, current.quality, current.setProvider, current.setResolution, current.setQuality); while (effects.length) effects.shift()!(); }
  render(); return { current, get selection() { return selection; } };
}

test("same option survives 1K/2K model switches and draft/template restore; stale quality cannot change fixed specification", async () => {
  const h = selectionHarness(); await settle(); assert.equal(h.selection.ready, true);
  for (const id of ["gemini-lite-flash-a", "gemini-lite-flash-b"]) {
    h.selection.restore({ optionId: id, resolution: "1K", quality: "high" }); await settle(); assert.equal(h.current.provider, "gemini-3.1-flash-lite-image"); assert.equal(h.current.quality, "auto"); assert.equal(h.selection.optionId, id);
    h.current.setResolution("2K"); await settle(); assert.equal(h.current.provider, "gemini-3.1-flash-image"); assert.equal(h.selection.optionId, id); assert.equal(h.selection.ready, true);
    h.current.setResolution("1K"); await settle(); assert.equal(h.current.provider, "gemini-3.1-flash-lite-image");
  }
  h.selection.restore({ optionId: "sunburst-medium-2k", resolution: "2K", quality: "low" }); await settle(); assert.equal(h.current.quality, "medium"); assert.equal(h.current.resolution, "2K");
  h.selection.restore({ providerPreference: "qwen-image-3.0", resolution: "2K" }); await settle(); assert.equal(h.selection.optionId, undefined); assert.equal(h.selection.ready, false);
});

function pricingHarness(finalize: boolean) {
  let index = 0, output: unknown, commits = 0, timerId = 0;
  const slots: unknown[] = [], deps: unknown[][] = [], effects: Array<() => void> = [], cleanups = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void; signal: AbortSignal }[] = [];
  const session = { privateTest: false, credits: { available: 10000 } };
  let input = { optionId: "sunburst-medium-2k", modelId: "gpt-image-2.5-sunburst", resolution: "2K", quality: "medium", inputImageCount: 0, outputCount: 1, aspectRatio: "4:3" };
  const quote = (_first: unknown, second: unknown, third?: AbortSignal | boolean) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal: typeof third === "object" ? third : second as AbortSignal }); });
  const react = {
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: unknown) => { commits++; slots[i] = value; render(); }]; },
    useEffect(effect: () => void | (() => void), next: unknown[]) { const i = index++; if (!deps[i] || deps[i].some((v, n) => !Object.is(v, next[n]))) { deps[i] = next; effects.push(() => { cleanups.get(i)?.(); const cleanup = effect(); if (cleanup) cleanups.set(i, cleanup); }); } },
  };
  const exports = {} as { useGenerationPricing: (input: unknown) => unknown; useFinalizeGenerationPricing: (...args: unknown[]) => unknown };
  const source = ts.transpileModule(readFileSync("components/studio/useGenerationPricing.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, AbortController, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id), require: (name: string) => name === "react" ? react : name.endsWith("/session") ? { useSession: () => session } : { quoteGeneration: quote, quoteFinalizedGeneration: quote } });
  function render() { index = 0; output = finalize ? exports.useFinalizeGenerationPricing("synthetic-preview", input.resolution, input.outputCount, input.quality, input.optionId, input.modelId) : exports.useGenerationPricing(input); while (effects.length) effects.shift()!(); }
  function flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); }
  render(); flush();
  return { pending, get output() { return output as { final?: unknown; quote?: unknown; error?: string }; }, get commits() { return commits; }, change() { input = { ...input, optionId: "flare-low-flex", modelId: "gpt-image-2.5-flare", resolution: "4K", quality: "low" }; render(); flush(); }, unmount() { cleanups.forEach(cleanup => cleanup()); } };
}
for (const finalize of [false, true]) test(`${finalize ? "finalize" : "create"} quote hook ignores out-of-order success/error and commits nothing after unmount even if transport ignores abort`, async () => {
  const h = pricingHarness(finalize); h.change(); assert.equal(h.pending[0].signal.aborted, true);
  const current = { totalCredits: 100 }; h.pending[1].resolve(current); await settle(); assert.equal(finalize ? h.output.quote : h.output.final, current);
  const count = h.commits; h.pending[0].resolve({ totalCredits: 999 }); await settle(); assert.equal(h.commits, count); assert.equal(finalize ? h.output.quote : h.output.final, current);
  const late = pricingHarness(finalize); late.change(); late.pending[0].reject(new Error("late old error")); await settle(); assert.equal(late.output.error, undefined);
  const before = late.commits; late.unmount(); late.pending[1].resolve({ totalCredits: 55 }); await settle(); assert.equal(late.commits, before); h.unmount();
});

test("public selected specs use GET prices while private UI uses authenticated quote POST rather than a public commercial budget", async () => {
  const { quoteGeneration } = await import("../../components/site/api");
  const original = globalThis.fetch, calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined }); return Response.json({ quote: { priceVersion: "synthetic", totalCredits: 1, amountPerItem: 1 } }); }) as typeof fetch;
  try {
    const payload = { optionId:"sunburst-medium-2k",modelId:"gpt-image-2.5-sunburst",quality:"medium",resolution:"2K",purpose:"final" as const,inputImageCount:0,outputCount:1,aspectRatio:"4:3" };
    await quoteGeneration(payload); await quoteGeneration(payload,undefined,true);
    assert.match(calls[0].url,/^\/api\/prices\?/); assert.equal(calls[0].method,"GET"); assert.equal(calls[1].url,"/api/jobs/quote"); assert.equal(calls[1].method,"POST"); assert.deepEqual(JSON.parse(calls[1].body!),payload);
  } finally {globalThis.fetch=original;}
});
