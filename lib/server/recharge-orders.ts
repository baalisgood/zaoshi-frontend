import type { RechargeOrderStatus, RechargeProvider } from "@/db/schema";
import { ApiError } from "./api";

export const RECHARGE_CATALOG_VERSION = "cn-recharge-v1-20260913";
export const RECHARGE_ORDER_TTL_SECONDS = 30 * 60;

export const rechargeProducts = {
  CNY10: { amountFen: 1_000, credits: 1_000 },
  CNY30: { amountFen: 3_000, credits: 3_000 },
  CNY50: { amountFen: 5_000, credits: 5_000 },
  CNY100: { amountFen: 10_000, credits: 10_000 },
} as const;

export type RechargeProductCode = keyof typeof rechargeProducts;

export type RechargeOrder = {
  id: string;
  ownerId: string;
  provider: RechargeProvider;
  productCode: RechargeProductCode;
  catalogVersion: typeof RECHARGE_CATALOG_VERSION;
  amountFen: number;
  credits: number;
  status: RechargeOrderStatus;
  expiresAt: number;
  paidAt: number | null;
  creditedAt: number | null;
  createdAt: number;
};

export async function createRechargeOrder(
  d1: D1Database,
  input: {
    ownerId: string;
    provider: RechargeProvider;
    productCode: RechargeProductCode;
    idempotencyKey: string;
  },
): Promise<{ order: RechargeOrder; idempotentReplay: boolean }> {
  const ownerId = identifier(input.ownerId, "ownerId", 160);
  const provider = enumeration(input.provider, ["WECHAT_PAY", "ALIPAY"] as const, "provider");
  const productCode = enumeration(input.productCode, Object.keys(rechargeProducts) as RechargeProductCode[], "productCode");
  const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 128);
  const now = Math.floor(Date.now() / 1000);
  const account = await d1.prepare("SELECT status FROM users WHERE id = ?").bind(ownerId).first<{ status: string }>();
  if (!account) throw new ApiError(404, "USER_NOT_FOUND", "没有找到这个用户。");
  if (account.status !== "ACTIVE") throw new ApiError(403, "USER_SUSPENDED", "当前账户不可创建充值订单。");

  const product = rechargeProducts[productCode];
  const id = `recharge_${crypto.randomUUID()}`;
  const created = await d1.prepare(
    `INSERT INTO recharge_orders
      (id, owner_id, provider, product_code, catalog_version, amount_fen, credits,
       status, idempotency_key, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
     ON CONFLICT(owner_id, idempotency_key) DO NOTHING`,
  ).bind(id, ownerId, provider, productCode, RECHARGE_CATALOG_VERSION, product.amountFen, product.credits,
    idempotencyKey, now + RECHARGE_ORDER_TTL_SECONDS, now, now).run();
  const order = await readOrderByIdempotency(d1, ownerId, idempotencyKey);
  if (!order) throw new ApiError(500, "RECHARGE_ORDER_WRITE_FAILED", "充值订单未能可靠保存。");
  if (order.provider !== provider || order.productCode !== productCode || order.catalogVersion !== RECHARGE_CATALOG_VERSION
    || order.amountFen !== product.amountFen || order.credits !== product.credits) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "该充值请求标识已经用于其他订单。");
  }
  return { order, idempotentReplay: (created.meta?.changes ?? 0) === 0 };
}

export async function getRechargeOrder(d1: D1Database, ownerId: string, orderId: string): Promise<RechargeOrder> {
  const order = await readOrder(d1, identifier(orderId, "orderId", 160));
  if (!order || order.ownerId !== identifier(ownerId, "ownerId", 160)) throw new ApiError(404, "RECHARGE_ORDER_NOT_FOUND", "没有找到这笔充值订单。");
  return order;
}

async function readOrderByIdempotency(d1: D1Database, ownerId: string, key: string): Promise<RechargeOrder | null> {
  return serializeOrder(await d1.prepare(
    "SELECT * FROM recharge_orders WHERE owner_id = ? AND idempotency_key = ?",
  ).bind(ownerId, key).first<Record<string, unknown>>());
}

async function readOrder(d1: D1Database, orderId: string): Promise<RechargeOrder | null> {
  return serializeOrder(await d1.prepare("SELECT * FROM recharge_orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>());
}

function serializeOrder(row: Record<string, unknown> | null): RechargeOrder | null {
  if (!row) return null;
  return {
    id: String(row.id), ownerId: String(row.owner_id), provider: row.provider as RechargeProvider,
    productCode: row.product_code as RechargeProductCode, catalogVersion: row.catalog_version as typeof RECHARGE_CATALOG_VERSION,
    amountFen: Number(row.amount_fen), credits: Number(row.credits), status: row.status as RechargeOrderStatus,
    expiresAt: Number(row.expires_at), paidAt: row.paid_at === null ? null : Number(row.paid_at),
    creditedAt: row.credited_at === null ? null : Number(row.credited_at), createdAt: Number(row.created_at),
  };
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ApiError(400, "INVALID_FIELD", `${field} 无效。`);
  return value as T;
}

function identifier(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) return invalid(field);
  return value;
}

function invalid(field: string): never {
  throw new ApiError(400, "INVALID_FIELD", `${field} 无效。`);
}
