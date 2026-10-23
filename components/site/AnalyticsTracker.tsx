"use client";

import { useEffect } from "react";

const tracked = new Set(["/", "/studio", "/pro", "/self-service", "/library", "/profile"]);

export function AnalyticsTracker({ path }: { path: string }) {
  useEffect(() => {
    if (!tracked.has(path)) return;
    const viewId = `view_${crypto.randomUUID()}`;
    const started = performance.now();
    let finished = false;
    void send({ action: "start", viewId, path });
    const finish = () => {
      if (finished) return;
      finished = true;
      void send({ action: "end", viewId, durationSeconds: (performance.now() - started) / 1000 });
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") finish(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", finish);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", finish);
      finish();
    };
  }, [path]);
  return null;
}

function send(body: Record<string, unknown>) {
  return fetch("/api/analytics", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
