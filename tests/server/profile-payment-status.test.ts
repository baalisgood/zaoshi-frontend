import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Element = { type: unknown; props: Record<string, unknown> };
type CatalogRequest = {
  url: string;
  options: RequestInit;
  respond(value: unknown, options?: { ok?: boolean; badJson?: boolean }): void;
  reject(error: Error): void;
};
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

// Run the actual component and effects, retaining hook slots across session changes.
function harness(options: { compact?: boolean; authenticated?: boolean; authMode?: string; privateTest?: boolean } = {}) {
  let index = 0, queued = false, mounted = true, updatesAfterUnmount = 0;
  let tree: Element;
  let compact = options.compact ?? false;
  const session = {
    draftScope: "profile-owner-a", authMode: options.authMode ?? "email", privateTest: options.privateTest ?? false,
    user: { authenticated: options.authenticated ?? true, displayName: "Synthetic user", email: "synthetic@example.com" },
    credits: { available: 123, reserved: 4, spent: 5 }, stats: { total: 6, today: 1, byKind: {} },
    referral: { invitees: [], invitedCount: 2 }, persistence: "database",
  };
  const slots: unknown[] = [], deps: unknown[][] = [];
  const cleanups = new Map<number, () => void>();
  const pendingEffects: Array<() => void> = [];
  const timers = new Map<number, { callback(): void; delay: number }>();
  let timerId = 0;
  const requests: CatalogRequest[] = [];
  const same = (a: unknown[] | undefined, b: unknown[]) => Boolean(a) && a!.length === b.length && a!.every((v, i) => Object.is(v, b[i]));
  const schedule = () => {
    if (!mounted) { updatesAfterUnmount++; return; }
    if (!queued) { queued = true; queueMicrotask(() => { queued = false; if (mounted) render(); }); }
  };
  const react = {
    useState(initial: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; schedule(); }];
    },
    useRef(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(callback: unknown, next: unknown[]) { const i = index++; if (!same(deps[i], next)) { slots[i] = callback; deps[i] = next; } return slots[i]; },
    useEffect(effect: () => void | (() => void), next: unknown[]) {
      const i = index++;
      if (!same(deps[i], next)) {
        deps[i] = next;
        pendingEffects.push(() => { cleanups.get(i)?.(); const cleanup = effect(); if (cleanup) cleanups.set(i, cleanup); else cleanups.delete(i); });
      }
    },
  };
  const jsx = { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }), Fragment: "fragment" };
  const exports = {} as { ProfileView: (props: { compact: boolean }) => Element };
  const source = ts.transpileModule(readFileSync("components/profile/ProfileView.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(source, {
    exports,
    require: (name: string) => name === "react" ? react : name === "react/jsx-runtime" ? jsx : name === "@/components/site/session" ? { useSession: () => session, loadSession: async () => ({ ...session }) } : name === "./ReferralPanel" ? { ReferralPanel: "referral-panel" } : {},
    fetch: (url: string, requestOptions: RequestInit) => new Promise((resolve, reject) => requests.push({ url, options: requestOptions, respond: (value, responseOptions = {}) => resolve({ ok: responseOptions.ok ?? true, json: async () => { if (responseOptions.badJson) throw Error("invalid JSON"); return value; } }), reject })),
    AbortController, Promise,
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  function render() {
    index = 0; tree = exports.ProfileView({ compact });
    while (pendingEffects.length) pendingEffects.shift()!();
  }
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const element = node as Element; return [element, ...elements(element.props.children)];
  }
  render();
  return {
    requests,
    get text() { return JSON.stringify(tree, (_key, value) => typeof value === "function" ? undefined : value); },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
    get activeTimers() { return timers.size; },
    get referralPresent() { return elements(tree).some(e => e.type === "referral-panel"); },
    changeScope(scope: string) { session.draftScope = scope; render(); },
    setCompact(value: boolean) { compact = value; render(); },
    expire() { for (const { callback, delay } of [...timers.values()]) { assert.ok(delay > 0 && delay <= 10000); callback(); } },
    unmount() { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); mounted = false; },
  };
}

for (const enabled of [true, false]) test(`profile shows authoritative catalog enabled=${enabled} without creating an order`, async () => {
  const h = harness(); await settle();
  assert.match(h.text, /正在确认/); assert.doesNotMatch(h.text, /真实支付尚在筹备|内测 · 未启用/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/recharge/catalog");
  assert.equal(h.requests[0].options.cache, "no-store"); assert.equal(h.requests[0].options.method, undefined); assert.equal(h.requests[0].options.body, undefined);
  h.requests[0].respond({ enabled }); await settle();
  assert.match(h.text, enabled ? /充值已开放/ : /充值暂未开放/);
  if (enabled) assert.match(h.text, /微信扫码充值/);
  assert.doesNotMatch(h.text, /付款成功|立即到账|保证到账/);
  assert.match(h.text, /可用积分/); assert.match(h.text, /123/); assert.match(h.text, /退出登录/); assert.equal(h.referralPresent, true);
  assert.equal(h.activeTimers, 0); assert.equal(h.requests.length, 1); h.unmount();
});

for (const failure of ["http", "network", "json", "missing", "wrong-type"] as const) test(`catalog ${failure} failure is unknown and leaves the profile usable`, async () => {
  const h = harness(); await settle();
  const request = h.requests[0];
  if (failure === "network") request.reject(Error("offline"));
  else if (failure === "http") request.respond({}, { ok: false });
  else if (failure === "json") request.respond({}, { badJson: true });
  else request.respond(failure === "missing" ? {} : { enabled: "true" });
  await settle(); assert.match(h.text, /暂时无法确认/); assert.doesNotMatch(h.text, /充值暂未开放|充值已开放|资料读取失败/);
  assert.match(h.text, /123/); assert.match(h.text, /退出登录/); assert.equal(h.referralPresent, true); assert.equal(h.activeTimers, 0); h.unmount();
});

test("catalog timeout aborts and an ignored abort cannot turn a late response into an enabled badge", async () => {
  const h = harness(); await settle(); h.expire(); await settle();
  assert.equal(h.requests[0].options.signal?.aborted, true); assert.match(h.text, /暂时无法确认/);
  h.requests[0].respond({ enabled: true }); await settle(); assert.doesNotMatch(h.text, /充值已开放/); assert.match(h.text, /123/); h.unmount();
});

test("switching scope cancels the old request and isolates late results even when transport ignores abort", async () => {
  const h = harness(); await settle(); const old = h.requests[0];
  h.changeScope("profile-owner-b"); assert.match(h.text, /正在确认/); await settle();
  assert.equal(old.options.signal?.aborted, true); assert.equal(h.requests.length, 2);
  h.requests[1].respond({ enabled: false }); await settle(); old.respond({ enabled: true }); await settle();
  assert.match(h.text, /充值暂未开放/); assert.doesNotMatch(h.text, /充值已开放/); h.unmount();
});

test("a previously resolved account status is hidden immediately on scope change and unmount prevents late updates", async () => {
  const h = harness(); await settle(); h.requests[0].respond({ enabled: true }); await settle(); assert.match(h.text, /充值已开放/);
  h.changeScope("profile-owner-c"); assert.doesNotMatch(h.text, /充值已开放/); assert.match(h.text, /正在确认/); await settle();
  const late = h.requests[1]; h.unmount(); assert.equal(late.options.signal?.aborted, true); assert.equal(h.activeTimers, 0);
  late.respond({ enabled: false }); await settle(); assert.equal(h.updatesAfterUnmount, 0);
});

for (const options of [{ compact: true }, { authenticated: false }, { authMode: "private-test" }, { authMode: "private-test", privateTest: true }, { privateTest: true }]) test(`catalog is not requested for ${JSON.stringify(options)}`, async () => {
  const h = harness(options); await settle(); assert.equal(h.requests.length, 0);
  if (options.authMode === "private-test") {
    assert.match(h.text, /回环私测/); assert.match(h.text, options.privateTest ? /开发者私测无需充值积分/ : /调试生图无需充值积分/);
  }
  h.unmount();
});

test("switching to compact cancels an in-flight catalog request", async () => {
  const h = harness(); await settle(); h.setCompact(true); await settle();
  assert.equal(h.requests[0].options.signal?.aborted, true); h.requests[0].respond({ enabled: true }); await settle();
  assert.doesNotMatch(h.text, /充值已开放/); assert.match(h.text, /可用积分/); assert.equal(h.requests.length, 1); h.unmount();
});
