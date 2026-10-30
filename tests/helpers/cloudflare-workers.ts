const KEY = Symbol.for("zaoshi.test.cloudflare.bindings");
const scope = globalThis as typeof globalThis & { [KEY]?: Record<string, unknown> };

export const env = scope[KEY] ??= {};
export function waitUntil(promise: Promise<unknown>): void { void promise; }
