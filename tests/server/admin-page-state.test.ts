import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Data = { items?: unknown[]; nextCursor?: string | null };
type Result = { data?: Data; busy: boolean; error: string; pageNumber: number; next(): void; previous(): void; refresh(): void };
type Request = { url: string; signal: AbortSignal; respond(body: Data, ok?: boolean): void };

// Deferred reads exercise the actual hook without a network or DOM dependency.
function harness(initialUrl = "/api/admin/console?view=users&limit=25") {
  let url = initialUrl, index = 0, queued = false, disposed = false;
  const slots: unknown[] = [], dependencies: unknown[][] = [], cleanups: Array<void | (() => void)> = [];
  const requests: Request[] = [];
  let result: Result;
  const effects: Array<() => void> = [];
  const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const schedule = () => { if (!queued && !disposed) { queued = true; queueMicrotask(() => { queued = false; if (!disposed) render(); }); } };
  const react = {
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; schedule(); }]; },
    useRef(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(callback: unknown, deps: unknown[]) { const i = index++; if (!same(dependencies[i], deps)) { slots[i] = callback; dependencies[i] = deps; } return slots[i]; },
    useEffect(callback: () => void | (() => void), deps: unknown[]) { const i = index++; if (!same(dependencies[i], deps)) { dependencies[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); }); } },
  };
  const evaluated = { exports: {} as { useAdminPage: (url: string) => Result } };
  const source = ts.transpileModule(readFileSync("components/admin/useAdminPage.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports: evaluated.exports, require: () => react, URL, AbortController, window: { location: { origin: "http://synthetic.invalid" } }, fetch: (address: string, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ url: address, signal: options.signal, respond: (body, ok = true) => resolve({ ok, json: async () => body }) })) });
  function render() { index = 0; result = evaluated.exports.useAdminPage(url); effects.splice(0).forEach(effect => effect()); }
  render();
  return { requests, get value() { return result; }, setUrl(next: string) { url = next; render(); }, dispose() { disposed = true; cleanups.forEach(cleanup => cleanup?.()); } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("page commits only successful cursors and keeps only current rows", async () => {
  const h = harness(); await settle();
  h.requests[0].respond({ items: ["first"], nextCursor: "cursor2" }); await settle();
  h.value.next(); h.value.next(); await settle();
  assert.equal(h.requests.length, 2, "duplicate next is locked synchronously");
  h.requests[1].respond({ items: ["second"], nextCursor: "cursor3" }); await settle();
  assert.equal(h.value.pageNumber, 2); assert.deepEqual(Array.from(h.value.data!.items!), ["second"]);
  h.value.next(); await settle(); h.requests[2].respond({}, false); await settle();
  assert.equal(h.value.pageNumber, 2); assert.deepEqual(Array.from(h.value.data!.items!), ["second"]); assert.ok(h.value.error);
  h.value.previous(); await settle(); assert.ok(!h.requests[3].url.includes("cursor="));
  h.requests[3].respond({ items: ["first"], nextCursor: "cursor2" }); await settle();
  assert.equal(h.value.pageNumber, 1); h.dispose();
});

test("filters abort obsolete requests and reset cursors even when old reads resolve later", async () => {
  const h = harness(); await settle(); h.requests[0].respond({ items: ["first"], nextCursor: "cursor2" }); await settle();
  h.value.next(); await settle();
  h.setUrl("/api/admin/console?view=users&limit=25&q=3500"); await settle();
  assert.equal(h.requests[1].signal.aborted, true); assert.ok(!h.requests[2].url.includes("cursor="));
  h.requests[2].respond({ items: ["filtered"] }); await settle();
  h.requests[1].respond({ items: ["obsolete"] }); await settle();
  assert.equal(h.value.pageNumber, 1); assert.deepEqual(Array.from(h.value.data!.items!), ["filtered"]); h.dispose();
});

test("post-mutation refresh supersedes a pending pre-mutation snapshot", async () => {
  const h = harness(); await settle(); h.requests[0].respond({ items: ["ACTIVE"] }); await settle();
  h.value.refresh(); await settle(); h.value.refresh(); await settle();
  assert.equal(h.requests.length, 3, "successful save must read again while an old read is busy");
  assert.equal(h.requests[1].signal.aborted, true);
  h.requests[2].respond({ items: ["SUSPENDED"] }); await settle();
  h.requests[1].respond({ items: ["ACTIVE"] }); await settle();
  assert.deepEqual(Array.from(h.value.data!.items!), ["SUSPENDED"]); assert.equal(h.value.busy, false); h.dispose();
});
