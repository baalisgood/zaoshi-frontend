import { ApiError } from "./api";
import { type RequestActor } from "./actor";
import { isSiteAdmin } from "./admin";

export type ReconciliationCaseState = "OPEN" | "CLOSED";

export type AddReconciliationNoteInput = {
  caseId: string;
  action: "ADD_NOTE";
  actionId: string;
  note: string;
};

type CaseRow = {
  id: string;
  item_id: string;
  attempt_id: string;
  job_id: string;
  reason_code: string;
  provider: string | null;
  model: string | null;
  provider_request_id: string | null;
  state: ReconciliationCaseState;
  resolution: string | null;
  version: number;
  opened_at: number;
  updated_at: number;
  resolved_at: number | null;
};

type Cursor = { v: 1; updatedAt: number; id: string; state: ReconciliationCaseState };

type EventRow = {
  id: string;
  case_id: string;
  action_id: string;
  action: string;
  actor_id: string;
  note: string | null;
  created_at: number;
};

export function assertReconciliationAdmin(
  _request: Request,
  actor: RequestActor,
  bindings: Record<string, unknown>,
): void {
  if (!actor.user.authenticated || actor.trusted !== true) throw new ApiError(401, "AUTH_REQUIRED", "请先完成登录。");
  if (isSiteAdmin(actor, bindings)) return;
  const email = actor.user.email?.trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
  const allowlist = String(bindings.GENERATION_RECONCILIATION_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => valid.test(value));
  if (!email || !valid.test(email) || !allowlist.includes(email)) {
    throw new ApiError(403, "ADMIN_FORBIDDEN", "没有生成任务对账权限。");
  }
}

export function parseReconciliationState(value: string | null): ReconciliationCaseState {
  if (value === null || value === "" || value === "OPEN") return "OPEN";
  if (value === "CLOSED") return "CLOSED";
  throw new ApiError(400, "INVALID_FIELD", "state 只支持 OPEN 或 CLOSED。");
}

export function parseReconciliationLimit(value: string | null): number {
  const raw = value ?? "50";
  if (!/^\d{1,3}$/u.test(raw)) throw new ApiError(400, "INVALID_FIELD", "limit 无效。");
  const limit = Number(raw);
  if (limit < 1 || limit > 100) throw new ApiError(400, "INVALID_FIELD", "limit 必须为 1 到 100。");
  return limit;
}

export function parseAddReconciliationNote(value: unknown): AddReconciliationNoteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_JSON", "请求正文必须是 JSON 对象。");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["caseId", "action", "actionId", "note"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "INVALID_FIELD", "请求包含不支持的字段。");
  }
  if (input.action !== "ADD_NOTE") {
    throw new ApiError(400, "INVALID_FIELD", "action 只支持 ADD_NOTE。");
  }
  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(caseId)) {
    throw new ApiError(400, "INVALID_FIELD", "caseId 无效。");
  }
  const actionId = typeof input.actionId === "string" ? input.actionId.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(actionId)) {
    throw new ApiError(400, "INVALID_FIELD", "actionId 无效。");
  }
  if (typeof input.note !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "note 必须是字符串。");
  }
  const note = input.note.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (Array.from(note).length < 1 || Array.from(note).length > 2000) {
    throw new ApiError(400, "INVALID_FIELD", "note 长度必须在 1 到 2000 个字符之间。");
  }
  if (Array.from(note).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint < 32 && codePoint !== 10) || codePoint === 127;
  })) {
    throw new ApiError(400, "INVALID_FIELD", "note 包含不支持的控制字符。");
  }
  return { caseId, action: "ADD_NOTE", actionId, note };
}

export async function appendReconciliationNote(
  input: AddReconciliationNoteInput & { actorId: string; requestId: string },
  d1: D1Database,
) {
  const eventId = `recon_event_${crypto.randomUUID()}`;
  let inserted: EventRow | undefined;
  try {
    const result = await d1.prepare(
      `INSERT INTO generation_reconciliation_events
        (id, case_id, action_id, action, actor_id, note, request_id)
       SELECT ?, ?, ?, 'ADD_NOTE', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM generation_reconciliation_cases WHERE id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM generation_reconciliation_events
           WHERE case_id = ? AND action_id = ?
         )
       RETURNING id, case_id, action_id, action, actor_id, note, created_at`,
    ).bind(
      eventId,
      input.caseId,
      input.actionId,
      input.actorId,
      input.note,
      input.requestId,
      input.caseId,
      input.caseId,
      input.actionId,
    ).run<EventRow>();
    inserted = result.results?.[0];
  } catch (error) {
    const existing = await readEvent(d1, input.caseId, input.actionId);
    if (!existing) throw error;
    return replayOrConflict(existing, input);
  }
  if (inserted) return serializeNoteEvent(inserted, false);
  const existing = await readEvent(d1, input.caseId, input.actionId);
  if (existing) return replayOrConflict(existing, input);
  const reconciliationCase = await d1.prepare(
    "SELECT id FROM generation_reconciliation_cases WHERE id = ?",
  ).bind(input.caseId).first<{ id: string }>();
  if (!reconciliationCase) {
    throw new ApiError(404, "RECONCILIATION_CASE_NOT_FOUND", "对账任务不存在。");
  }
  throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "备注写入发生冲突，请刷新后重试。");
}

export async function listReconciliationCases(input: {
  state: ReconciliationCaseState;
  limit: number;
  cursor?: string | null;
}, d1: D1Database) {
  const cursor = input.cursor ? decodeCursor(input.cursor, input.state) : null;
  const rows = await d1
    .prepare(
      `SELECT id, item_id, attempt_id, job_id, reason_code, provider, model,
              provider_request_id, state, resolution, version, opened_at,
              updated_at, resolved_at
       FROM generation_reconciliation_cases
       WHERE state = ?
         AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(
      input.state,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      input.limit + 1,
    )
    .all<CaseRow>();
  const page = (rows.results ?? []).slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map(serializeCase),
    nextCursor:
      (rows.results?.length ?? 0) > input.limit && last
        ? encodeCursor({ v: 1, state: input.state, updatedAt: last.updated_at, id: last.id })
        : null,
  };
}

function serializeCase(row: CaseRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    reasonCode: row.reason_code,
    provider: row.provider,
    model: row.model,
    providerRequestId: row.provider_request_id,
    state: row.state,
    resolution: row.resolution,
    version: row.version,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

async function readEvent(d1: D1Database, caseId: string, actionId: string) {
  return d1.prepare(
    `SELECT id, case_id, action_id, action, actor_id, note, created_at
     FROM generation_reconciliation_events
     WHERE case_id = ? AND action_id = ?`,
  ).bind(caseId, actionId).first<EventRow>();
}

function replayOrConflict(
  existing: EventRow,
  input: AddReconciliationNoteInput & { actorId: string },
) {
  if (
    existing.action !== input.action ||
    existing.actor_id !== input.actorId ||
    existing.note !== input.note
  ) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "actionId 已用于不同的备注内容。");
  }
  return serializeNoteEvent(existing, true);
}

function serializeNoteEvent(row: EventRow, idempotentReplay: boolean) {
  return {
    caseId: row.case_id,
    action: "ADD_NOTE" as const,
    actionId: row.action_id,
    eventId: row.id,
    createdAt: row.created_at,
    idempotentReplay,
  };
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string, state: ReconciliationCaseState): Cursor {
  try {
    if (raw.length > 512) throw new Error();
    const decoded = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(decoded) as Partial<Cursor>;
    if (value.v !== 1 || value.state !== state || !Number.isSafeInteger(value.updatedAt) || typeof value.id !== "string" || !value.id) throw new Error();
    return value as Cursor;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "分页游标无效。");
  }
}
