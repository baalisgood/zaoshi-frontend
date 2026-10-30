import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

test("public health endpoint exposes only fixed operational alert codes", async () => {
  const [route, console] = await Promise.all([
    readFile(new URL("../../app/api/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../lib/server/admin-console.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /readQueueMonitor[\s\S]*alerts: queue\.alerts/u);
  assert.match(route, /LIFECYCLE_MAINTENANCE_STALE/u);
  assert.match(console, /CONSUMER_\$\{\(health\?\.status \?\? "unavailable"\)\.toUpperCase\(\)\}/u);
  for (const code of ["EXPIRED_LEASES", "OPEN_RECONCILIATION", "UNPROCESSED_DEAD_LETTERS", "OBJECT_CLEANUP_BLOCKED"]) assert.match(console, new RegExp(code, "u"));
  assert.doesNotMatch(route, /lastErrorCode|requestId|providerRequestId|objectKey/u);
});

test("health route keeps operational alerts ready and lifecycle staleness unavailable", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
  database.prepare("INSERT INTO object_cleanup_tasks (id,source_type,source_id,object_key,status) VALUES ('blocked-health','ASSET','asset-health','blocked/health','BLOCKED')").run();
  const bindings: Record<string, unknown> = { DB: new TestD1Database(database), ASSETS_BUCKET: new TestR2Bucket(), BACKEND_PROFILE: "sites-demo", GENERATION_INTERNAL_API_ENABLED: "0", ZAOSHI_LIFECYCLE_HEALTH: { enabled: false } };
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")] = bindings;
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/health/route.ts") as { GET(): Promise<Response> };
    const ready = await route.GET();
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ready.json(), { ok: true, alerts: ["OBJECT_CLEANUP_BLOCKED"] });

    bindings.ZAOSHI_LIFECYCLE_HEALTH = { enabled: true, startedAt: Date.now() - 121_000, lastCompletedAt: null, intervalSeconds: 60 };
    const stale = await route.GET();
    assert.equal(stale.status, 503);
    assert.deepEqual(await stale.json(), { ok: false, alerts: ["LIFECYCLE_MAINTENANCE_STALE"] });
  } finally {
    await server.close();
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")];
  }
});
