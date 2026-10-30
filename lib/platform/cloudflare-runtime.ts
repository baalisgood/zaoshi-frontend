import * as cloudflareWorkers from "cloudflare:workers";

export function readRuntimeBindings(): Record<string, unknown> {
  return cloudflareWorkers.env as Record<string, unknown>;
}

export function tryWaitUntil(promise: Promise<unknown>): boolean {
  const waitUntil = (cloudflareWorkers as typeof cloudflareWorkers & {
    waitUntil?: (value: Promise<unknown>) => void;
  }).waitUntil;
  if (typeof waitUntil !== "function") return false;
  waitUntil(promise);
  return true;
}
