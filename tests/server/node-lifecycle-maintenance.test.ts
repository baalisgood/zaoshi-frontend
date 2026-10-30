import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

test("CVM maintenance run purges expired analytics and records completion only on success", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
  database.prepare("INSERT INTO site_page_views (id,visitor_hash,path,started_at) VALUES ('expired',?,'/',unixepoch()-91*86400)").run("a".repeat(64));
  const d1 = new TestD1Database(database) as unknown as D1Database;
  const bindings = { DB: d1, ASSETS_BUCKET: new TestR2Bucket(), BACKEND_PROFILE: "sites-demo" };
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")] = bindings;
  const previousRuntime = process.env.ZAOSHI_RUNTIME; process.env.ZAOSHI_RUNTIME = "node";
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const runtime = await server.ssrLoadModule("/lib/platform/node-lifecycle-maintenance.ts") as { runLifecycleMaintenance(state: unknown): Promise<void> };
    const health = { enabled: true, startedAt: Date.now(), lastCompletedAt: null as number | null, intervalSeconds: 3600 };
    await runtime.runLifecycleMaintenance({ bindings: { DB: d1 }, lifecycleHealth: health });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_page_views WHERE id='expired'").get()!.count, 0);
    assert.equal(typeof health.lastCompletedAt, "number");

    const failedHealth = { enabled: true, startedAt: Date.now(), lastCompletedAt: null as number | null, intervalSeconds: 3600 };
    const originalError = console.error; console.error = () => undefined;
    try { await runtime.runLifecycleMaintenance({ bindings: { DB: { prepare() { throw new Error("offline"); } } }, lifecycleHealth: failedHealth }); }
    finally { console.error = originalError; }
    assert.equal(failedHealth.lastCompletedAt, null);
  } finally {
    await server.close();
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("zaoshi.test.cloudflare.bindings")];
    if (previousRuntime === undefined) delete process.env.ZAOSHI_RUNTIME; else process.env.ZAOSHI_RUNTIME = previousRuntime;
  }
});
