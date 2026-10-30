import { ApiError } from "./api";
import { isInsufficientCreditsError } from "./credit-ledger";
import { JOB_AGGREGATE_ASSIGNMENTS } from "./generation-queue";

export type SafeRequeueInput = {
  itemId: string;
  action: "REQUEUE_BEFORE_PROVIDER";
  actionId: string;
};

type AdminActionRow = {
  id: string;
  action_id: string;
  item_id: string;
  attempt_id: string;
  job_id: string;
  action: string;
  actor_id: string;
  from_status: string;
  to_status: string;
  created_at: number;
};

export function parseSafeRequeueInput(value: unknown): SafeRequeueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_JSON", "请求正文必须是 JSON 对象。");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["itemId", "action", "actionId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "INVALID_FIELD", "请求包含不支持的字段。");
  }
  if (input.action !== "REQUEUE_BEFORE_PROVIDER") {
    throw new ApiError(400, "INVALID_FIELD", "action 只支持 REQUEUE_BEFORE_PROVIDER。");
  }
  const itemId = typeof input.itemId === "string" ? input.itemId.trim() : "";
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(itemId)) {
    throw new ApiError(400, "INVALID_FIELD", "itemId 无效。");
  }
  const actionId = typeof input.actionId === "string" ? input.actionId.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(actionId)) {
    throw new ApiError(400, "INVALID_FIELD", "actionId 无效。");
  }
  return { itemId, action: "REQUEUE_BEFORE_PROVIDER", actionId };
}

export async function requeueFailedBeforeProvider(
  input: SafeRequeueInput & { actorId: string; requestId: string },
  d1: D1Database,
) {
  const actionRecordId = `queue_admin_${crypto.randomUUID()}`;
  const reservationId = `billing_requeue_${input.actionId}`;
  const reserve = d1.prepare(
    `INSERT INTO credit_ledger_entries
      (id, owner_id, entry_type, amount, reservation_id, job_id, item_id,
       idempotency_key, reason_code, price_version, actor_id, request_id)
     SELECT ?, item.owner_id, 'RESERVE', previous.amount, ?, item.job_id, item.id,
            ?, 'GENERATION_SAFE_REQUEUE', previous.price_version, ?, ?
     FROM generation_job_items AS item
     JOIN credit_ledger_entries AS previous
       ON previous.reservation_id = item.billing_reservation_id
      AND previous.entry_type = 'RESERVE'
     JOIN credit_ledger_entries AS released
       ON released.reservation_id = previous.reservation_id
      AND released.entry_type = 'RELEASE'
     WHERE item.id = ? AND item.status = 'FAILED' AND item.execution_kind = 'provider'`,
  ).bind(
    `ledger_reserve_${reservationId}`,
    reservationId,
    `reserve:${reservationId}`,
    input.actorId,
    input.requestId,
    input.itemId,
  );
  const insert = d1.prepare(
    `INSERT INTO generation_queue_admin_actions
      (id, action_id, item_id, attempt_id, job_id, action, actor_id, request_id,
       from_status, to_status, from_attempt_no, from_attempt_count, reason_code)
     SELECT ?, ?, item.id, attempt.id, item.job_id, 'REQUEUE_BEFORE_PROVIDER', ?, ?,
            'FAILED', 'QUEUED', attempt.attempt_no, item.attempt_count,
            'SAFE_BEFORE_PROVIDER'
     FROM generation_job_items AS item
     JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
     WHERE item.id = ?
     RETURNING id, action_id, item_id, attempt_id, job_id, action, actor_id,
               from_status, to_status, created_at`,
  ).bind(
    actionRecordId,
    input.actionId,
    input.actorId,
    input.requestId,
    input.itemId,
  );
  const aggregate = d1.prepare(
    `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
     WHERE id = (
       SELECT job_id FROM generation_queue_admin_actions WHERE action_id = ?
     )`,
  ).bind(input.actionId);

  try {
    const [, insertResult] = await d1.batch<AdminActionRow>([reserve, insert, aggregate]);
    const inserted = insertResult?.results?.[0];
    if (inserted) return serializeAction(inserted, false);
  } catch (error) {
    const existing = await readAction(d1, input.actionId);
    if (existing) return replayOrConflict(existing, input);
    if (isInsufficientCreditsError(error)) {
      throw new ApiError(402, "INSUFFICIENT_CREDITS", "积分余额不足，不能重新排队。");
    }
    const item = await readItemSafety(d1, input.itemId);
    if (!item) {
      throw new ApiError(404, "QUEUE_ITEM_NOT_FOUND", "没有找到这个生成任务项。");
    }
    if (item.eligible === 1) throw error;
    throw new ApiError(409, "SAFE_REQUEUE_NOT_ALLOWED", "该任务不能安全地重新排队。", {
      itemStatus: item.status,
    });
  }

  const existing = await readAction(d1, input.actionId);
  if (existing) return replayOrConflict(existing, input);
  const item = await readItemSafety(d1, input.itemId);
  if (!item) {
    throw new ApiError(404, "QUEUE_ITEM_NOT_FOUND", "没有找到这个生成任务项。");
  }
  throw new ApiError(409, "SAFE_REQUEUE_NOT_ALLOWED", "该任务不能安全地重新排队。", {
    itemStatus: item.status,
  });
}

async function readAction(d1: D1Database, actionId: string) {
  return d1.prepare(
    `SELECT id, action_id, item_id, attempt_id, job_id, action, actor_id,
            from_status, to_status, created_at
     FROM generation_queue_admin_actions WHERE action_id = ?`,
  ).bind(actionId).first<AdminActionRow>();
}

async function readItemSafety(d1: D1Database, itemId: string) {
  return d1.prepare(
    `SELECT item.id, item.status,
            CASE WHEN item.execution_kind = 'provider'
              AND item.status = 'FAILED'
              AND item.attempt_count < item.max_attempts
              AND item.lease_token IS NULL
              AND item.lease_owner IS NULL
              AND item.lease_expires_at IS NULL
              AND attempt.id = item.current_attempt_id
              AND attempt.lease_generation = item.lease_generation
              AND attempt.state = 'FAILED'
              AND attempt.retry_class IN ('safe-before-provider','not-retryable')
              AND attempt.provider IS NULL
              AND attempt.model IS NULL
              AND attempt.provider_account_slot IS NULL
              AND attempt.provider_request_id IS NULL
              AND attempt.provider_started_at IS NULL
              AND attempt.provider_responded_at IS NULL
              AND item.last_error_code IS attempt.error_code
              AND item.last_error_message IS attempt.error_message
              AND EXISTS (
                SELECT 1 FROM credit_ledger_entries AS reserved
                JOIN credit_ledger_entries AS released
                  ON released.reservation_id = reserved.reservation_id
                 AND released.entry_type = 'RELEASE'
                WHERE reserved.reservation_id = item.billing_reservation_id
                  AND reserved.entry_type = 'RESERVE'
                  AND reserved.owner_id = item.owner_id
                  AND reserved.job_id = item.job_id
                  AND reserved.item_id = item.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_attempts AS historical
                WHERE historical.item_id = item.id
                  AND (
                    historical.provider IS NOT NULL
                    OR historical.model IS NOT NULL
                    OR historical.provider_account_slot IS NOT NULL
                    OR historical.provider_request_id IS NOT NULL
                    OR historical.provider_started_at IS NOT NULL
                    OR historical.provider_responded_at IS NOT NULL
                    OR historical.state IN ('PROVIDER_DISPATCHING','PROVIDER_RESPONDED','STORING','AMBIGUOUS','SUCCEEDED')
                    OR historical.retry_class = 'ambiguous-after-provider'
                  )
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_output_commits AS output
                WHERE output.item_id = item.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_job_outputs AS output
                WHERE output.job_id = item.job_id AND output.ordinal = item.ordinal
              )
              AND NOT EXISTS (
                SELECT 1 FROM generation_reconciliation_cases AS reconciliation
                WHERE reconciliation.item_id = item.id
              )
            THEN 1 ELSE 0 END AS eligible
     FROM generation_job_items AS item
     LEFT JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
     WHERE item.id = ?`,
  ).bind(itemId).first<{ id: string; status: string; eligible: number }>();
}

function replayOrConflict(
  existing: AdminActionRow,
  input: SafeRequeueInput & { actorId: string },
) {
  if (
    existing.action !== input.action ||
    existing.item_id !== input.itemId ||
    existing.actor_id !== input.actorId
  ) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "actionId 已用于不同的管理员操作。");
  }
  return serializeAction(existing, true);
}

function serializeAction(row: AdminActionRow, idempotentReplay: boolean) {
  return {
    actionId: row.action_id,
    action: "REQUEUE_BEFORE_PROVIDER" as const,
    itemId: row.item_id,
    jobId: row.job_id,
    itemStatus: "QUEUED" as const,
    createdAt: row.created_at,
    idempotentReplay,
  };
}
