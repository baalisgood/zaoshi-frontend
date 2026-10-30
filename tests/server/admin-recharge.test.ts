import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readAdminConsole } from "../../lib/server/admin-console";
import { listRechargeReconciliation } from "../../lib/server/admin-recharge";
import { ApiError } from "../../lib/server/api";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'USER'), (?, ?, 'USER')").run("user_alpha_123", "甲", "user_beta_123", "乙");
  const order = database.prepare("INSERT INTO recharge_orders_v2 (id, owner_id, provider, product_code, catalog_version, amount_fen, credits, status, idempotency_key, created_at, expires_at) VALUES (?, ?, 'WECHAT_PAY', 'CNY50', 'cn-recharge-v2-20261006', 5000, 5100, ?, ?, 1000, 1600)");
  const event = database.prepare("INSERT INTO recharge_reconciliation_events (id, order_id, provider, provider_transaction_id, amount_fen, paid_at, verified_at, facts_hash, reason) VALUES (?, ?, 'WECHAT_PAY', ?, 5000, ?, ?, ?, ?)");
  for (let index = 0; index < 5; index += 1) {
    const owner = index < 3 ? "user_alpha_123" : "user_beta_123";
    order.run(`order_${index}`, owner, "CANCELED", `key_${index}`);
    event.run(`reconcile_${index}`, `order_${index}`, `tx_${index}`, 1200, 2000 + index, String(index).repeat(64).slice(0, 64), index % 2 ? "OUTSIDE_PAYMENT_WINDOW" : "ORDER_NOT_PAYABLE");
  }
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}

const apiCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("recharge reconciliation keeps legacy records and pages newest first with a cursor", async () => {
  const { d1 } = setup();
  const first = await listRechargeReconciliation(d1, new URLSearchParams({ limit: "2" }));
  assert.deepEqual(first.records.map((row) => row.id), ["reconcile_4", "reconcile_3"]);
  assert.equal(first.items, first.records);
  assert.deepEqual(first.summary, { total: 5, amountFen: 25000, owners: 2 });
  assert.equal(first.records[0].owner_id, "user_beta_123");
  assert.equal(first.records[0].status, "CANCELED");
  assert.equal(first.records[0].product_code, "CNY50");
  assert.ok(first.nextCursor);
  const second = await listRechargeReconciliation(d1, new URLSearchParams({ limit: "2", cursor: first.nextCursor! }));
  assert.deepEqual(second.records.map((row) => row.id), ["reconcile_2", "reconcile_1"]);
  const third = await listRechargeReconciliation(d1, new URLSearchParams({ limit: "2", cursor: second.nextCursor! }));
  assert.deepEqual(third.records.map((row) => row.id), ["reconcile_0"]);
  assert.equal(third.nextCursor, null);
});

test("recharge reconciliation filters by reason, owner and order and rejects foreign cursors", async () => {
  const { d1 } = setup();
  const outside = await listRechargeReconciliation(d1, new URLSearchParams({ reason: "OUTSIDE_PAYMENT_WINDOW" }));
  assert.deepEqual(outside.records.map((row) => row.id), ["reconcile_3", "reconcile_1"]);
  const owner = await listRechargeReconciliation(d1, new URLSearchParams({ ownerId: "user_beta_123" }));
  assert.equal(owner.summary.total, 2);
  const order = await listRechargeReconciliation(d1, new URLSearchParams({ orderId: "order_2" }));
  assert.deepEqual(order.records.map((row) => row.order_id), ["order_2"]);
  const paged = await listRechargeReconciliation(d1, new URLSearchParams({ limit: "1" }));
  await assert.rejects(listRechargeReconciliation(d1, new URLSearchParams({ limit: "1", reason: "ORDER_NOT_PAYABLE", cursor: paged.nextCursor! })), apiCode("INVALID_CURSOR"));
  await assert.rejects(listRechargeReconciliation(d1, new URLSearchParams({ reason: "PAID" })), apiCode("INVALID_FIELD"));
  await assert.rejects(listRechargeReconciliation(d1, new URLSearchParams({ limit: "500" })), apiCode("INVALID_FIELD"));
});

test("admin alerts expose read-only counters for navigation badges", async () => {
  const { d1 } = setup();
  const request = new Request("https://example.invalid/api/admin/console?view=alerts");
  const result = await readAdminConsole(request, d1, {}) as { alerts: Record<string, number> };
  assert.deepEqual(result.alerts, { reconciliation: 0, dead_letters: 0, recharge_reconciliation: 5 });
});
