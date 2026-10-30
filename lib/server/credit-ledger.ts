import { ApiError } from "./api";

export type GenerationBilling = {
  amountPerItem: number;
  priceVersion: string;
};

export type GenerationPriceExpectation = {
  expectedPriceVersion: string;
  expectedTotalCredits: number;
};

export type CreditSnapshot = {
  credited: number;
  available: number;
  reserved: number;
  spent: number;
};

export function validateGenerationBilling(value: GenerationBilling): GenerationBilling {
  if (!Number.isSafeInteger(value.amountPerItem) || value.amountPerItem < 1 || value.amountPerItem > 1_000_000_000) {
    throw new ApiError(503, "GENERATION_PRICING_INVALID", "生成积分价格配置无效。");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value.priceVersion)) {
    throw new ApiError(503, "GENERATION_PRICING_INVALID", "生成积分价格版本无效。");
  }
  return value;
}

export function assertGenerationPriceExpectation(billing: GenerationBilling, expectation: GenerationPriceExpectation, outputCount: number): void {
  if (expectation.expectedPriceVersion !== billing.priceVersion || expectation.expectedTotalCredits !== billing.amountPerItem * outputCount) {
    throw new ApiError(409, "PRICE_VERSION_CHANGED", "积分价格已经更新，请确认最新报价后重新提交。");
  }
}

export async function creditCredits(
  d1: D1Database,
  input: {
    ownerId: string;
    amount: number;
    idempotencyKey: string;
    reasonCode: string;
    actorId: string;
    requestId: string;
  },
): Promise<{ created: boolean; snapshot: CreditSnapshot }> {
  requireIdentifier(input.ownerId, "ownerId", 160);
  requireIdentifier(input.idempotencyKey, "idempotencyKey", 128);
  requireIdentifier(input.reasonCode, "reasonCode", 80);
  requireIdentifier(input.actorId, "actorId", 160);
  requireIdentifier(input.requestId, "requestId", 160);
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 1_000_000_000) {
    throw new ApiError(400, "INVALID_CREDIT_AMOUNT", "积分数量无效。");
  }
  const id = `ledger_credit_${crypto.randomUUID()}`;
  const result = await d1.prepare(
    `INSERT INTO credit_ledger_entries
      (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
     VALUES (?, ?, 'CREDIT', ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, idempotency_key) DO NOTHING`,
  ).bind(
    id,
    input.ownerId,
    input.amount,
    input.idempotencyKey,
    input.reasonCode,
    input.actorId,
    input.requestId,
  ).run();
  const existing = await d1.prepare(
    `SELECT entry_type, amount, reason_code, actor_id
     FROM credit_ledger_entries
     WHERE owner_id = ? AND idempotency_key = ?`,
  ).bind(input.ownerId, input.idempotencyKey).first<{
    entry_type: string;
    amount: number;
    reason_code: string;
    actor_id: string;
  }>();
  if (!existing) throw new ApiError(500, "CREDIT_WRITE_FAILED", "积分入账未能可靠保存。");
  if (existing.entry_type !== "CREDIT" || existing.amount !== input.amount || existing.reason_code !== input.reasonCode || existing.actor_id !== input.actorId) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "该积分入账标识已经用于其他操作。");
  }
  return {
    created: (result.meta?.changes ?? 0) === 1,
    snapshot: await getCreditSnapshot(d1, input.ownerId),
  };
}

export async function getCreditSnapshot(d1: D1Database, ownerId: string): Promise<CreditSnapshot> {
  requireIdentifier(ownerId, "ownerId", 160);
  // ponytail: derive balances from the immutable ledger until real account volume justifies a projection table.
  const row = await d1.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credited,
       COALESCE(SUM(CASE
         WHEN entry_type = 'CREDIT' THEN amount
         WHEN entry_type = 'RESERVE' THEN -amount
         WHEN entry_type = 'RELEASE' THEN amount
         ELSE 0 END), 0) AS available,
       COALESCE(SUM(CASE
         WHEN entry_type = 'RESERVE' THEN amount
         WHEN entry_type IN ('SETTLE','RELEASE') THEN -amount
         ELSE 0 END), 0) AS reserved,
       COALESCE(SUM(CASE WHEN entry_type = 'SETTLE' THEN amount ELSE 0 END), 0) AS spent
     FROM credit_ledger_entries WHERE owner_id = ?`,
  ).bind(ownerId).first<CreditSnapshot>();
  const snapshot = row
    ? { credited: row.credited, available: row.available, reserved: row.reserved, spent: row.spent }
    : { credited: 0, available: 0, reserved: 0, spent: 0 };
  if (Object.values(snapshot).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ApiError(500, "CREDIT_LEDGER_INVALID", "积分账本余额校验失败。");
  }
  return snapshot;
}

export function isInsufficientCreditsError(error: unknown): boolean {
  return error instanceof Error && /insufficient credits/u.test(error.message);
}

function requireIdentifier(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new ApiError(400, "INVALID_CREDIT_FIELD", `${field} 无效。`);
  }
  return value;
}
