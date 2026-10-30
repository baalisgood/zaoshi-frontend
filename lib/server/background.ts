import { tryWaitUntil } from "@/lib/platform/cloudflare-runtime";

export function scheduleBackground(promise: Promise<unknown>): void {
  if (tryWaitUntil(promise)) return;

  // This branch is only expected in a non-Workers local demo/test runtime.
  void promise.catch((error) => {
    console.error("Local background task failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  });
}
