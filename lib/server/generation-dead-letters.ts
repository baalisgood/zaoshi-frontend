import { ApiError } from "./api";

export type DeadLetterState = "OPEN" | "RESOLVED";

type DeadLetterRow = {
  id: string;
  item_id: string;
  attempt_id: string;
  job_id: string;
  classification: "SAFE_BEFORE_PROVIDER_FAILURE";
  reason_code: string;
  retry_class: string;
  attempt_no: number;
  attempt_count: number;
  max_attempts: number;
  opened_at: number;
  state: DeadLetterState;
};

type Cursor = { v: 1; state: DeadLetterState; openedAt: number; id: string };

export function parseDeadLetterState(value: string | null): DeadLetterState {
  if (value === null || value === "" || value === "OPEN") return "OPEN";
  if (value === "RESOLVED") return "RESOLVED";
  throw new ApiError(400, "INVALID_FIELD", "state 只支持 OPEN 或 RESOLVED。");
}

export function parseDeadLetterLimit(value: string | null): number {
  const raw = value ?? "50";
  if (!/^\d{1,3}$/u.test(raw)) throw new ApiError(400, "INVALID_FIELD", "limit 无效。");
  const limit = Number(raw);
  if (limit < 1 || limit > 100) throw new ApiError(400, "INVALID_FIELD", "limit 必须为 1 到 100。");
  return limit;
}

export async function listDeadLetters(input: {
  state: DeadLetterState;
  limit: number;
  cursor?: string | null;
}, d1: D1Database) {
  const cursor = input.cursor ? decodeCursor(input.cursor, input.state) : null;
  const rows = await d1.prepare(
    `SELECT dead.id, dead.item_id, dead.attempt_id, dead.job_id,
            dead.classification, dead.reason_code, dead.retry_class,
            dead.attempt_no, dead.attempt_count, dead.max_attempts, dead.opened_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM generation_queue_admin_actions AS action
              WHERE action.item_id = dead.item_id AND action.attempt_id = dead.attempt_id
                AND action.job_id = dead.job_id AND action.action = 'REQUEUE_BEFORE_PROVIDER'
            ) THEN 'RESOLVED' ELSE 'OPEN' END AS state
     FROM generation_dead_letter_entries AS dead
     WHERE ((? = 'OPEN' AND NOT EXISTS (
              SELECT 1 FROM generation_queue_admin_actions AS action
              WHERE action.item_id = dead.item_id AND action.attempt_id = dead.attempt_id
                AND action.job_id = dead.job_id AND action.action = 'REQUEUE_BEFORE_PROVIDER'
            )) OR (? = 'RESOLVED' AND EXISTS (
              SELECT 1 FROM generation_queue_admin_actions AS action
              WHERE action.item_id = dead.item_id AND action.attempt_id = dead.attempt_id
                AND action.job_id = dead.job_id AND action.action = 'REQUEUE_BEFORE_PROVIDER'
            )))
       AND (? IS NULL OR dead.opened_at < ? OR (dead.opened_at = ? AND dead.id < ?))
     ORDER BY dead.opened_at DESC, dead.id DESC
     LIMIT ?`,
  ).bind(
    input.state,
    input.state,
    cursor?.openedAt ?? null,
    cursor?.openedAt ?? null,
    cursor?.openedAt ?? null,
    cursor?.id ?? null,
    input.limit + 1,
  ).all<DeadLetterRow>();
  const page = (rows.results ?? []).slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      attemptId: row.attempt_id,
      jobId: row.job_id,
      classification: row.classification,
      reasonCode: row.reason_code,
      retryClass: row.retry_class,
      attemptNo: row.attempt_no,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      state: row.state,
      openedAt: row.opened_at,
    })),
    nextCursor:
      (rows.results?.length ?? 0) > input.limit && last
        ? encodeCursor({ v: 1, state: input.state, openedAt: last.opened_at, id: last.id })
        : null,
  };
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string, state: DeadLetterState): Cursor {
  try {
    if (raw.length > 512) throw new Error();
    const decoded = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(decoded) as Partial<Cursor>;
    if (
      value.v !== 1 || value.state !== state || !Number.isSafeInteger(value.openedAt) ||
      typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(value.id)
    ) throw new Error();
    return value as Cursor;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "分页位置无效，请重新加载。");
  }
}
