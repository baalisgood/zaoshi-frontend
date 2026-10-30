import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ApiError } from "../../lib/server/api";
import * as rechargeModule from "../../lib/server/recharge-orders";
import {
  createRechargeOrder,
  getRechargeOrder,
  rechargeProducts,
} from "../../lib/server/recharge-orders";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.prepare("INSERT INTO users (id, display_name) VALUES (?, ?), (?, ?)")
    .run("user_recharge_a", "A", "user_recharge_b", "B");
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}

function code(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

function insertVerifiedPayment(
  database: DatabaseSync,
  order: { id: string; provider: string; amountFen: number; createdAt: number; expiresAt: number },
  overrides: Partial<{ eventId: string; transactionId: string; amountFen: number; payloadHash: string; paidAt: number }> = {},
) {
  const paidAt = overrides.paidAt ?? Math.min(order.createdAt + 10, order.expiresAt);
  return database.prepare(
    `INSERT INTO recharge_payment_events
      (id,order_id,provider,provider_event_id,provider_transaction_id,amount_fen,payload_hash,paid_at,verified_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,provider_event_id) DO NOTHING`,
  ).run(`event_${crypto.randomUUID()}`, order.id, order.provider, overrides.eventId ?? "notify-001",
    overrides.transactionId ?? "trade-001", overrides.amountFen ?? order.amountFen,
    overrides.payloadHash ?? "a".repeat(64), paidAt, paidAt + 1);
}

test("recharge catalog creates one immutable pending order per idempotency key", async () => {
  assert.deepEqual(rechargeProducts, {
    CNY10: { amountFen: 1_000, credits: 1_000 },
    CNY30: { amountFen: 3_000, credits: 3_000 },
    CNY50: { amountFen: 5_000, credits: 5_000 },
    CNY100: { amountFen: 10_000, credits: 10_000 },
  });
  const { database, d1 } = setup();
  const input = { ownerId: "user_recharge_a", provider: "WECHAT_PAY" as const, productCode: "CNY10" as const, idempotencyKey: "checkout-1" };
  const first = await createRechargeOrder(d1, input);
  assert.equal(first.idempotentReplay, false);
  assert.equal(first.order.status, "PENDING");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM credit_ledger_entries").get()?.count, 0);
  const replay = await createRechargeOrder(d1, input);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.order.id, first.order.id);
  await assert.rejects(() => createRechargeOrder(d1, { ...input, productCode: "CNY30" }), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(() => getRechargeOrder(d1, "user_recharge_b", first.order.id), code("RECHARGE_ORDER_NOT_FOUND"));
  assert.throws(() => database.prepare(
    "UPDATE recharge_orders SET status = 'PAID', paid_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
  ).run(first.order.id), /invalid recharge order transition/u);
  assert.throws(() => database.prepare("DELETE FROM recharge_orders WHERE id = ?").run(first.order.id), /append-preserved/u);
});

test("one verified payment atomically credits once and rejects mismatches", async () => {
  const { database, d1 } = setup();
  const created = await createRechargeOrder(d1, {
    ownerId: "user_recharge_a", provider: "ALIPAY", productCode: "CNY30", idempotencyKey: "checkout-paid",
  });
  assert.equal(insertVerifiedPayment(database, created.order).changes, 1);
  assert.equal((await getRechargeOrder(d1, "user_recharge_a", created.order.id)).status, "CREDITED");
  assert.equal(insertVerifiedPayment(database, created.order).changes, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM recharge_payment_events").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM credit_ledger_entries WHERE reason_code = 'RECHARGE_PAID'").get()?.count, 1);
  assert.throws(() => insertVerifiedPayment(database, created.order, { payloadHash: "b".repeat(64) }), /does not match/u);
  assert.throws(() => database.prepare("UPDATE recharge_orders SET amount_fen = 1 WHERE id = ?").run(created.order.id), /invalid recharge order transition/u);
  assert.throws(() => database.prepare("UPDATE recharge_payment_events SET amount_fen = 1").run(), /append-only/u);
});

test("no application function accepts self-declared verification; wrong, expired or reused events never add credits", async () => {
  const { database, d1 } = setup();
  assert.equal("creditVerifiedRechargePayment" in rechargeModule, false);
  const first = await createRechargeOrder(d1, {
    ownerId: "user_recharge_a", provider: "WECHAT_PAY", productCode: "CNY10", idempotencyKey: "checkout-a",
  });
  assert.throws(() => insertVerifiedPayment(database, first.order, { amountFen: 3_000 }), /does not match/u);
  assert.throws(() => insertVerifiedPayment(database, first.order, { paidAt: first.order.expiresAt + 1 }), /does not match/u);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM credit_ledger_entries").get()?.count, 0);
  assert.throws(() => database.prepare(
    `INSERT INTO recharge_orders
      (id,owner_id,provider,product_code,catalog_version,amount_fen,credits,status,idempotency_key,expires_at,created_at,updated_at)
     VALUES ('forged','user_recharge_a','WECHAT_PAY','CNY10','cn-recharge-v1-20260913',1,1000000,'PENDING','forged',unixepoch()+1800,unixepoch(),unixepoch())`,
  ).run(), /CHECK constraint failed/u);

  insertVerifiedPayment(database, first.order, { eventId: "notify-a", transactionId: "trade-shared", payloadHash: "c".repeat(64) });
  const second = await createRechargeOrder(d1, {
    ownerId: "user_recharge_b", provider: "WECHAT_PAY", productCode: "CNY10", idempotencyKey: "checkout-b",
  });
  assert.throws(() => insertVerifiedPayment(database, second.order, { eventId: "notify-b", transactionId: "trade-shared" }), /UNIQUE constraint/u);
  assert.equal((await getRechargeOrder(d1, "user_recharge_b", second.order.id)).status, "PENDING");
  assert.throws(() => database.prepare(
    `INSERT INTO credit_ledger_entries
      (id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id)
     VALUES ('fake','user_recharge_b','CREDIT',1000,'fake','RECHARGE_PAID','payment:WECHAT_PAY','fake')`,
  ).run(), /no verified payment/u);
});
