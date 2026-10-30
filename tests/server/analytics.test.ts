import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getAnalyticsSummary, parseAnalyticsPeriod, purgeExpiredAnalytics, recordAnalyticsEvent } from "../../lib/server/analytics";
import { ApiError } from "../../lib/server/api";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

function request(body: Record<string, unknown>, cookie?: string) {
  return new Request("https://zaoshi.example/api/analytics", { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
}

test("traffic analytics records low-privacy idempotent views and bounded dwell time", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON"); applyMigrations(database);
  const d1 = new TestD1Database(database) as unknown as D1Database;
  const viewId = "view_123e4567-e89b-12d3-a456-426614174000";
  const started = await recordAnalyticsEvent(request({ action: "start", viewId, path: "/studio" }), d1);
  assert.equal(started.accepted, true);
  assert.ok(started.setCookie);
  const cookie = started.setCookie!.split(";", 1)[0];
  assert.equal((await recordAnalyticsEvent(request({ action: "start", viewId, path: "/studio" }, cookie), d1)).accepted, false);
  assert.equal((await recordAnalyticsEvent(request({ action: "end", viewId, durationSeconds: 9999 }, cookie), d1)).accepted, true);
  assert.equal((await recordAnalyticsEvent(request({ action: "end", viewId, durationSeconds: 10 }, cookie), d1)).accepted, false);
  const row = database.prepare("SELECT path, duration_seconds, length(visitor_hash) AS hash_length FROM site_page_views").get()!;
  assert.deepEqual({ path: row.path, duration: row.duration_seconds, hashLength: row.hash_length }, { path: "/studio", duration: 1800, hashLength: 64 });
  assert.equal(JSON.stringify(row).includes("user_"), false);
  await assert.rejects(() => recordAnalyticsEvent(request({ action: "start", viewId: "view_223e4567-e89b-12d3-a456-426614174000", path: "/admin" }), d1), (error: unknown) => error instanceof ApiError && error.code === "INVALID_ANALYTICS_PATH");
  const repaired = await recordAnalyticsEvent(request({ action: "start", viewId: "view_623e4567-e89b-12d3-a456-426614174000", path: "/" }, "zaoshi_analytics=bad"), d1);
  assert.match(repaired.setCookie ?? "", /^zaoshi_analytics=[A-Za-z0-9_-]{43};/u);

  const summary = await getAnalyticsSummary(d1, "day");
  assert.equal(summary.pv, 2);
  assert.equal(summary.uv, 2);
  assert.equal(summary.averageDwellSeconds, 1800);
  assert.deepEqual(summary.recharge, { status: "verified_ledger", users: 0, amountFen: 0, currency: "CNY" });
});

test("analytics period parsing is closed to day week and month", () => {
  assert.equal(parseAnalyticsPeriod(null), "day");
  assert.equal(parseAnalyticsPeriod("week"), "week");
  assert.equal(parseAnalyticsPeriod("month"), "month");
  assert.throws(() => parseAnalyticsPeriod("year"), (error: unknown) => error instanceof ApiError && error.code === "INVALID_FIELD");
});

test("analytics periods use Beijing day, Monday week and calendar month boundaries", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON"); applyMigrations(database);
  const d1 = new TestD1Database(database) as unknown as D1Database;
  const beijingSeconds = (year: number, month: number, day: number, hour = 0) => Date.UTC(year, month - 1, day, hour - 8) / 1000;
  database.prepare("INSERT INTO site_page_views (id, visitor_hash, path, started_at) VALUES (?, ?, '/', ?), (?, ?, '/', ?), (?, ?, '/', ?)").run(
    "view_323e4567-e89b-12d3-a456-426614174000", "a".repeat(64), beijingSeconds(2026, 9, 13, 23),
    "view_423e4567-e89b-12d3-a456-426614174000", "b".repeat(64), beijingSeconds(2026, 9, 14, 0),
    "view_523e4567-e89b-12d3-a456-426614174000", "c".repeat(64), beijingSeconds(2026, 8, 31, 23),
  );
  const now = beijingSeconds(2026, 9, 16, 12);
  assert.equal((await getAnalyticsSummary(d1, "day", now)).pv, 0);
  assert.equal((await getAnalyticsSummary(d1, "week", now)).pv, 1);
  assert.equal((await getAnalyticsSummary(d1, "month", now)).pv, 2);
});

test("analytics storage has a global daily ceiling and scheduled 90-day retention", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON"); applyMigrations(database);
  const insert = database.prepare("INSERT INTO site_page_views (id, visitor_hash, path, started_at) VALUES (?, ?, '/', ?)");
  database.exec("BEGIN");
  insert.run("old", "f".repeat(64), Math.floor(Date.now() / 1000) - 91 * 86400);
  for (let index = 0; index < 10_000; index += 1) insert.run(`today-${index}`, index.toString(16).padStart(64, "0"), Math.floor(Date.now() / 1000));
  database.exec("COMMIT");
  const d1 = new TestD1Database(database) as unknown as D1Database;
  const result = await recordAnalyticsEvent(request({ action: "start", viewId: "view_723e4567-e89b-12d3-a456-426614174000", path: "/" }), d1);
  assert.equal(result.accepted, false);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_page_views WHERE id = 'old'").get()!.count, 1);
  await purgeExpiredAnalytics(d1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_page_views WHERE id = 'old'").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_page_views").get()!.count, 10_000);
});

test("scheduled analytics retention keeps the exact 90-day boundary and is idempotent", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON"); applyMigrations(database);
  const now = 2_000_000_000, cutoff = now - 90 * 86400;
  database.prepare("INSERT INTO site_page_views (id, visitor_hash, path, started_at) VALUES ('older', ?, '/', ?), ('boundary', ?, '/', ?), ('newer', ?, '/', ?)").run("a".repeat(64), cutoff - 1, "b".repeat(64), cutoff, "c".repeat(64), cutoff + 1);
  const d1 = new TestD1Database(database) as unknown as D1Database;
  assert.equal((await purgeExpiredAnalytics(d1, now)).meta?.changes, 1);
  assert.deepEqual(database.prepare("SELECT id FROM site_page_views ORDER BY id").all().map((row) => row.id), ["boundary", "newer"]);
  assert.equal((await purgeExpiredAnalytics(d1, now)).meta?.changes, 0);
});
