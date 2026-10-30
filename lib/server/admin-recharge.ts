import { createHash } from "node:crypto";
import { ApiError } from "./api";

// Read-only view of verified WeChat payments that could not be credited automatically.
// The source table is append-only; this module never writes or resolves records.
type Cursor = { v: 1; view: "recharge"; filter: string; time: number; id: string };
const reasons = ["ALL", "OUTSIDE_PAYMENT_WINDOW", "ORDER_NOT_PAYABLE"] as const;
type Reason = typeof reasons[number];

export async function listRechargeReconciliation(d1: D1Database, params: URLSearchParams) {
  const limit = parseLimit(params.get("limit"));
  const reason = (params.get("reason") ?? "ALL").trim() as Reason;
  if (!reasons.includes(reason)) throw new ApiError(400, "INVALID_FIELD", "对账原因筛选无效。");
  const ownerId = exactId(params.get("ownerId"), 160);
  const orderId = exactId(params.get("orderId"), 180);
  const filter = createHash("sha256").update(JSON.stringify({ reason, ownerId, orderId })).digest("hex");
  const cursor = decodeCursor(params.get("cursor"), filter);
  const where = `(? = 'ALL' OR r.reason = ?) AND (? = '' OR o.owner_id = ?) AND (? = '' OR r.order_id = ?)`;
  const bindings = [reason, reason, ownerId, ownerId, orderId, orderId];
  const [rows, summary] = await Promise.all([
    d1.prepare(
      `SELECT r.id, r.order_id, r.provider, r.provider_transaction_id, r.amount_fen, r.paid_at, r.verified_at, r.reason,
              o.owner_id, o.status, o.product_code, o.credits, o.created_at AS order_created_at, o.expires_at
       FROM recharge_reconciliation_events r JOIN recharge_orders_v2 o ON o.id = r.order_id
       WHERE ${where} AND (? IS NULL OR r.verified_at < ? OR (r.verified_at = ? AND r.id < ?))
       ORDER BY r.verified_at DESC, r.id DESC LIMIT ?`,
    ).bind(...bindings, cursor?.time ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null, limit + 1).all<Record<string, unknown>>(),
    d1.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(r.amount_fen), 0) AS amount_fen, COUNT(DISTINCT o.owner_id) AS owners
       FROM recharge_reconciliation_events r JOIN recharge_orders_v2 o ON o.id = r.order_id WHERE ${where}`,
    ).bind(...bindings).first<Record<string, number | null>>(),
  ]);
  const all = rows.results ?? [];
  const page = all.slice(0, limit);
  const records = page.map((row) => ({
    id: String(row.id),
    order_id: String(row.order_id),
    owner_id: String(row.owner_id),
    status: String(row.status),
    amount_fen: Number(row.amount_fen),
    paid_at: Number(row.paid_at),
    verified_at: Number(row.verified_at),
    reason: String(row.reason),
    provider: String(row.provider),
    provider_transaction_id: String(row.provider_transaction_id),
    product_code: String(row.product_code),
    credits: Number(row.credits),
    order_created_at: Number(row.order_created_at),
    expires_at: Number(row.expires_at),
  }));
  const last = page.at(-1);
  return {
    // `records` keeps the original response field; `items` lets the shared admin pager read the same rows.
    records,
    items: records,
    summary: { total: Number(summary?.total ?? 0), amountFen: Number(summary?.amount_fen ?? 0), owners: Number(summary?.owners ?? 0) },
    nextCursor: all.length > limit && last ? encodeCursor({ v: 1, view: "recharge", filter, time: Number(last.verified_at), id: String(last.id) }) : null,
  };
}

function exactId(raw: string | null, max: number): string {
  const value = (raw ?? "").normalize("NFKC").trim();
  if (value.length > max) throw new ApiError(400, "INVALID_FIELD", "筛选 ID 过长。");
  return value;
}

function parseLimit(raw: string | null): number {
  if (!raw) return 25;
  if (!/^\d{1,3}$/u.test(raw)) throw new ApiError(400, "INVALID_FIELD", "limit 无效。");
  const value = Number(raw);
  if (value < 1 || value > 100) throw new ApiError(400, "INVALID_FIELD", "limit 必须为1到100。");
  return value;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string | null, filter: string): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 512) throw new Error();
    const value = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))) as Partial<Cursor>;
    if (value.v !== 1 || value.view !== "recharge" || value.filter !== filter || !Number.isSafeInteger(value.time) || typeof value.id !== "string" || value.id.length > 180) throw new Error();
    return value as Cursor;
  } catch { throw new ApiError(400, "INVALID_CURSOR", "分页位置无效，请重新加载。"); }
}
