import { identityNamespace } from "./user-identity";
import { createHash } from "node:crypto";
import { resolveAiEnvironment } from "@/lib/ai/env";
import { resolveDomesticProviderConfiguration } from "@/lib/ai/domestic-config";
import { imageModelCapabilities, imageModelValues } from "@/lib/domain/image-models";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { isPublicImageGenerationEnabled } from "./runtime-policy";
import { ApiError, requireJsonObject } from "./api";
import { getAnalyticsSummary, parseAnalyticsPeriod } from "./analytics";
import { getCreditSnapshot } from "./credit-ledger";
import type { ConsumerHealthRead, ConsumerHealthSnapshot } from "@/lib/consumer/health";

type Cursor = { v: 1; view: "users" | "credits" | "tasks" | "audit"; filter: string; time: number; id: string };
type AuditAction = "USER_UPDATE" | "CREDIT_GRANT" | "CREDIT_COMPENSATION";

export async function readAdminConsole(request: Request, d1: D1Database, bindings: Record<string, unknown>) {
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "overview";
  if (view === "overview") return readOverview(d1, bindings);
  if (view === "users") return listUsers(d1, params);
  if (view === "credits") return listCredits(d1, params);
  if (view === "tasks") return listTasks(d1, params, bindings);
  if (view === "audit") return listAuditEvents(d1, params);
  if (view === "providers") return listProviders(d1, bindings);
  if (view === "analytics") return getAnalyticsSummary(d1, parseAnalyticsPeriod(params.get("period")));
  if (view === "alerts") return readAlerts(d1);
  throw new ApiError(400, "INVALID_FIELD", "不支持的管理员视图。");
}

export async function updateManagedUser(value: unknown, actorId: string, requestId: string, d1: D1Database) {
  const input = requireJsonObject(value);
  assertAllowedKeys(input, ["action", "actionId", "userId", "status", "promoterEnabled", "maxPendingOutputs", "activeConcurrencyLimit", "enabled"]);
  if (input.action !== "UPDATE_USER") throw new ApiError(400, "INVALID_FIELD", "action 只支持 UPDATE_USER。");
  const actionId = identifier(input.actionId, "actionId", 128);
  const userId = identifier(input.userId, "userId", 160);
  const status = optionalEnum(input.status, ["ACTIVE", "SUSPENDED"] as const, "status");
  const promoterEnabled = input.promoterEnabled === undefined ? undefined : booleanValue(input.promoterEnabled, "promoterEnabled");
  const pending = optionalInteger(input.maxPendingOutputs, 1, 100, "maxPendingOutputs");
  const concurrency = optionalInteger(input.activeConcurrencyLimit, 1, 16, "activeConcurrencyLimit");
  const enabled = input.enabled === undefined ? undefined : booleanValue(input.enabled, "enabled");
  if (status === undefined && promoterEnabled === undefined && pending === undefined && concurrency === undefined && enabled === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "至少需要修改一项用户状态或生成额度。");
  }
  if (userId === actorId && status === "SUSPENDED") throw new ApiError(409, "ADMIN_SELF_LOCKOUT", "管理员不能停用自己的账户。");
  const target = await d1.prepare("SELECT id, role, status FROM users WHERE id = ?").bind(userId).first<{ id: string; role: string; status: string }>();
  if (!target) throw new ApiError(404, "USER_NOT_FOUND", "没有找到这个用户。");
  if (status === "SUSPENDED" && target.role === "ADMIN" && target.status === "ACTIVE") {
    const activeAdmins = await d1.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").first<{ count: number }>();
    if (Number(activeAdmins?.count ?? 0) <= 1) throw new ApiError(409, "LAST_ADMIN_REQUIRED", "不能停用最后一个正常管理员账户。");
  }

  const detail = { ...(status ? { status } : {}), ...(promoterEnabled !== undefined ? { promoterEnabled } : {}), ...(pending !== undefined ? { maxPendingOutputs: pending } : {}), ...(concurrency !== undefined ? { activeConcurrencyLimit: concurrency } : {}), ...(enabled !== undefined ? { enabled } : {}) };
  const payloadHash = hashJson({ action: input.action, userId: await identityNamespace(d1, userId), ...detail });
  const auditId = `audit_${crypto.randomUUID()}`;
  const audit = auditInsert(d1, { id: auditId, actionId, actorId, action: "USER_UPDATE", targetType: "USER", targetId: userId, payloadHash, detail, requestId, protectLastAdmin: status === "SUSPENDED" });
  const statements: D1PreparedStatement[] = [audit];
  if (status) {
    statements.push(d1.prepare(
      "UPDATE users SET status = ?, updated_at = unixepoch() WHERE id = ? AND EXISTS (SELECT 1 FROM admin_audit_events WHERE id = ?)",
    ).bind(status, userId, auditId));
    if (status === "SUSPENDED") statements.push(d1.prepare(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE user_id = ? AND EXISTS (SELECT 1 FROM admin_audit_events WHERE id = ?)",
    ).bind(userId, auditId));
  }
  if (pending !== undefined || concurrency !== undefined || enabled !== undefined) {
    statements.push(d1.prepare(
      `INSERT INTO user_generation_limits
        (owner_id, daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled)
       SELECT ?, 20, COALESCE(?, 4), COALESCE(?, 3), COALESCE(?, 1)
       WHERE EXISTS (SELECT 1 FROM admin_audit_events WHERE id = ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         max_pending_outputs = COALESCE(?, user_generation_limits.max_pending_outputs),
         active_concurrency_limit = COALESCE(?, user_generation_limits.active_concurrency_limit),
         enabled = COALESCE(?, user_generation_limits.enabled), updated_at = unixepoch()`,
    ).bind(userId, pending ?? null, concurrency ?? null, enabled === undefined ? null : Number(enabled), auditId, pending ?? null, concurrency ?? null, enabled === undefined ? null : Number(enabled)));
  }
  if (promoterEnabled !== undefined) statements.push(d1.prepare(`INSERT INTO referral_promoters(user_id,enabled) SELECT ?,? WHERE EXISTS(SELECT 1 FROM admin_audit_events WHERE id=?) AND (?=1 OR EXISTS(SELECT 1 FROM referral_promoters WHERE user_id=?)) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated_at=unixepoch()`).bind(userId,Number(promoterEnabled),auditId,Number(promoterEnabled),userId));
  await d1.batch(statements);
  if (status === "SUSPENDED" && !await d1.prepare("SELECT 1 AS present FROM admin_audit_events WHERE action_id = ?").bind(actionId).first()) {
    throw new ApiError(409, "LAST_ADMIN_REQUIRED", "不能停用最后一个正常管理员账户。");
  }
  const replay = await verifyAudit(d1, actionId, payloadHash, auditId);
  return { user: await readUser(d1, userId), idempotentReplay: replay };
}

export async function grantManagedCredits(value: unknown, actorId: string, requestId: string, d1: D1Database) {
  const input = requireJsonObject(value);
  assertAllowedKeys(input, ["action", "actionId", "userId", "amount"]);
  const action = optionalEnum(input.action, ["CREDIT_GRANT", "CREDIT_COMPENSATION"] as const, "action");
  if (!action) throw new ApiError(400, "INVALID_FIELD", "action 只支持 CREDIT_GRANT 或 CREDIT_COMPENSATION。");
  const actionId = identifier(input.actionId, "actionId", 128);
  const userId = identifier(input.userId, "userId", 160);
  const amount = requiredInteger(input.amount, 1, 1_000_000, "amount");
  if (!await d1.prepare("SELECT 1 AS present FROM users WHERE id = ?").bind(userId).first()) throw new ApiError(404, "USER_NOT_FOUND", "没有找到这个用户。");
  const payloadHash = hashJson({ action, userId: await identityNamespace(d1, userId), amount });
  const auditId = `audit_${crypto.randomUUID()}`;
  const ledgerId = `ledger_credit_${crypto.randomUUID()}`;
  await d1.batch([
    auditInsert(d1, { id: auditId, actionId, actorId, action, targetType: "CREDIT_ACCOUNT", targetId: userId, payloadHash, detail: { amount }, requestId }),
    d1.prepare(
      `INSERT INTO credit_ledger_entries
        (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
       SELECT ?, ?, 'CREDIT', ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM admin_audit_events WHERE id = ?)`,
    ).bind(ledgerId, userId, amount, `admin-credit:${actionId}`, action === "CREDIT_GRANT" ? "ADMIN_GRANT" : "ADMIN_COMPENSATION", actorId, requestId, auditId),
  ]);
  const replay = await verifyAudit(d1, actionId, payloadHash, auditId);
  return { ownerId: userId, snapshot: await getCreditSnapshot(d1, userId), idempotentReplay: replay };
}

async function readOverview(d1: D1Database, bindings: Record<string, unknown>) {
  const [users, tasks, credits, analytics, queue, rechargeIssues] = await Promise.all([
    d1.prepare("SELECT COUNT(*) AS total, SUM(status = 'ACTIVE') AS active, SUM(status = 'SUSPENDED') AS suspended FROM users").first<Record<string, number>>(),
    d1.prepare("SELECT COUNT(*) AS total, SUM(status NOT IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED','CANCELED')) AS pending, SUM(status = 'SUCCEEDED') AS succeeded, SUM(status = 'FAILED') AS failed FROM generation_job_items WHERE execution_kind = 'provider'").first<Record<string, number>>(),
    globalCreditSummary(d1),
    getAnalyticsSummary(d1, "day"),
    readQueueMonitor(d1, bindings),
    d1.prepare("SELECT COUNT(*) AS total FROM recharge_reconciliation_events").first<{ total: number }>(),
  ]);
  return {
    users: numericRecord(users, ["total", "active", "suspended"]),
    tasks: numericRecord(tasks, ["total", "pending", "succeeded", "failed"]),
    issues: { reconciliation: queue.metrics.openReconciliation, dead_letters: queue.metrics.unprocessedDeadLetters, recharge_reconciliation: Number(rechargeIssues?.total ?? 0) },
    queue,
    credits,
    analytics,
    recharge: analytics.recharge,
  };
}

// Lightweight counters for the admin navigation; read-only and safe to poll.
async function readAlerts(d1: D1Database) {
  const row = await d1.prepare(
    `SELECT (SELECT COUNT(*) FROM generation_reconciliation_cases WHERE state = 'OPEN') AS reconciliation,
            (SELECT COUNT(*) FROM generation_dead_letter_entries AS dead WHERE NOT EXISTS (
               SELECT 1 FROM generation_queue_admin_actions AS action
               WHERE action.item_id = dead.item_id AND action.attempt_id = dead.attempt_id AND action.action = 'REQUEUE_BEFORE_PROVIDER')) AS dead_letters,
            (SELECT COUNT(*) FROM recharge_reconciliation_events) AS recharge_reconciliation`,
  ).first<Record<string, number>>();
  return { alerts: numericRecord(row, ["reconciliation", "dead_letters", "recharge_reconciliation"]) };
}

async function listUsers(d1: D1Database, params: URLSearchParams) {
  const limit = parseLimit(params.get("limit"));
  const status = params.get("status") ?? "ALL";
  if (!new Set(["ALL", "ACTIVE", "SUSPENDED"]).has(status)) throw new ApiError(400, "INVALID_FIELD", "用户状态筛选无效。");
  const query = (params.get("q") ?? "").normalize("NFKC").trim().slice(0, 120);
  const filter = hashJson({ status, query, order: "pinned-v1" });
  const cursor = decodeCursor(params.get("cursor"), "users", filter);
  const rows = await d1.prepare(
    `SELECT account.id, account.display_name, account.status, account.role,
            account.created_at, account.updated_at,
            COALESCE((SELECT enabled FROM referral_promoters WHERE user_id=account.id),0) AS promoter_enabled,
            COALESCE(limits.daily_output_limit, 20) AS daily_output_limit,
            COALESCE(limits.max_pending_outputs, 4) AS max_pending_outputs,
            COALESCE(limits.active_concurrency_limit, 3) AS active_concurrency_limit,
            COALESCE(limits.enabled, 1) AS enabled,
            (SELECT COUNT(*) FROM auth_sessions AS session WHERE session.user_id = account.id AND session.revoked_at IS NULL AND session.expires_at > unixepoch()) AS active_sessions,
            (SELECT COUNT(*) FROM generation_jobs AS job WHERE job.owner_id = account.id) AS job_count,
            COALESCE((SELECT SUM(CASE WHEN entry_type = 'CREDIT' THEN amount WHEN entry_type = 'RESERVE' THEN -amount WHEN entry_type = 'RELEASE' THEN amount ELSE 0 END) FROM credit_ledger_entries WHERE owner_id = account.id), 0) AS available_credits
     FROM users AS account LEFT JOIN user_generation_limits AS limits ON limits.owner_id = account.id
     WHERE (? = 'ALL' OR account.status = ?)
       AND (? = '' OR instr(lower(account.id), lower(?)) > 0 OR instr(lower(account.display_name), lower(?)) > 0)
       AND (? IS NULL OR (account.id<>'ADMIN001' AND (?='ADMIN001' OR account.created_at < ? OR (account.created_at = ? AND account.id < ?))))
     ORDER BY (account.id='ADMIN001') DESC, account.created_at DESC, account.id DESC LIMIT ?`,
  ).bind(status, status, query, query, query, cursor?.time ?? null, cursor?.id ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null, limit + 1).all<Record<string, unknown>>();
  const page = (rows.results ?? []).slice(0, limit);
  return { items: page.map(serializeUser), nextCursor: nextCursor(rows.results ?? [], page, limit, "users", "created_at", filter) };
}

async function listCredits(d1: D1Database, params: URLSearchParams) {
  const limit = parseLimit(params.get("limit"));
  const ownerId = (params.get("ownerId") ?? "").trim().slice(0, 160);
  const filter = hashJson({ ownerId });
  const cursor = decodeCursor(params.get("cursor"), "credits", filter);
  const rows = await d1.prepare(
    `SELECT id, owner_id, entry_type, amount, reservation_id, job_id, item_id, optimization_id,
            reason_code, price_version, actor_id, created_at
     FROM credit_ledger_entries
     WHERE (? = '' OR owner_id = ?)
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(ownerId, ownerId, cursor?.time ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null, limit + 1).all<Record<string, unknown>>();
  const page = (rows.results ?? []).slice(0, limit);
  return {
    summary: await globalCreditSummary(d1),
    ...(ownerId ? { owner: await getCreditSnapshot(d1, ownerId), ownerId } : {}),
    items: page.map((row) => ({ id: row.id, ownerId: row.owner_id, entryType: row.entry_type, amount: Number(row.amount), reservationId: row.reservation_id, jobId: row.job_id, itemId: row.item_id, optimizationId: row.optimization_id, reasonCode: row.reason_code, priceVersion: row.price_version, actorId: row.actor_id, createdAt: Number(row.created_at) })),
    nextCursor: nextCursor(rows.results ?? [], page, limit, "credits", "created_at", filter),
  };
}

async function listTasks(d1: D1Database, params: URLSearchParams, bindings: Record<string, unknown>) {
  const limit = parseLimit(params.get("limit"));
  const status = (params.get("status") ?? "ALL").trim();
  const allowed = new Set(["ALL", "QUEUED", "LEASED", "PREPROCESSING", "SUBMITTING", "PERSISTING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "CANCELED"]);
  if (!allowed.has(status)) throw new ApiError(400, "INVALID_FIELD", "任务状态筛选无效。");
  const filter = hashJson({ status });
  const cursor = decodeCursor(params.get("cursor"), "tasks", filter);
  const [summary, rows, queue] = await Promise.all([
    d1.prepare("SELECT status, COUNT(*) AS count FROM generation_job_items WHERE execution_kind = 'provider' GROUP BY status").all<{ status: string; count: number }>(),
    d1.prepare(
      `SELECT item.id, item.job_id, item.owner_id, item.ordinal, item.status,
              item.provider_key, item.provider_preference, item.attempt_count,
              item.max_attempts, item.lease_expires_at, item.last_error_code,
              item.billing_reservation_id, item.updated_at,
              attempt.state AS attempt_state, attempt.model,
              CASE WHEN item.billing_reservation_id IS NULL THEN 'UNBILLED'
                   WHEN EXISTS (SELECT 1 FROM credit_ledger_entries WHERE reservation_id = item.billing_reservation_id AND entry_type = 'SETTLE') THEN 'SETTLED'
                   WHEN EXISTS (SELECT 1 FROM credit_ledger_entries WHERE reservation_id = item.billing_reservation_id AND entry_type = 'RELEASE') THEN 'RELEASED'
                   ELSE 'RESERVED' END AS billing_state
       FROM generation_job_items AS item
       LEFT JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
       WHERE item.execution_kind = 'provider' AND (? = 'ALL' OR item.status = ?)
         AND (? IS NULL OR item.updated_at < ? OR (item.updated_at = ? AND item.id < ?))
       ORDER BY item.updated_at DESC, item.id DESC LIMIT ?`,
    ).bind(status, status, cursor?.time ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null, limit + 1).all<Record<string, unknown>>(),
    readQueueMonitor(d1, bindings),
  ]);
  const page = (rows.results ?? []).slice(0, limit);
  return {
    summary: Object.fromEntries((summary.results ?? []).map((row) => [row.status, Number(row.count)])),
    queue,
    items: page.map((row) => ({ id: row.id, jobId: row.job_id, ownerId: row.owner_id, ordinal: Number(row.ordinal), status: row.status, providerKey: row.provider_key, providerPreference: row.provider_preference, model: row.model, attemptState: row.attempt_state, attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), leaseExpiresAt: row.lease_expires_at, errorCode: row.last_error_code, billingState: row.billing_state, updatedAt: Number(row.updated_at) })),
    nextCursor: nextCursor(rows.results ?? [], page, limit, "tasks", "updated_at", filter),
  };
}

const auditSources = ["ALL", "ADMIN", "QUEUE", "RECONCILIATION", "ASSET_MAINTENANCE", "ASSET_MODERATION", "ASSET_DELETION", "GALLERY"] as const;

async function listAuditEvents(d1: D1Database, params: URLSearchParams) {
  const limit = parseLimit(params.get("limit"));
  const source = params.get("source") ?? "ALL";
  if (!auditSources.includes(source as typeof auditSources[number])) throw new ApiError(400, "INVALID_FIELD", "审计来源筛选无效。");
  const actorId = (params.get("actorId") ?? "").normalize("NFKC").trim().slice(0, 160);
  const targetId = (params.get("targetId") ?? "").normalize("NFKC").trim().slice(0, 180);
  const filter = hashJson({ source, actorId, targetId });
  const cursor = decodeCursor(params.get("cursor"), "audit", filter);
  const rows = await d1.prepare(
    `WITH audit AS (
       SELECT 'ADMIN' AS source, 'ADMIN:' || id AS id, id AS event_id, action_id, actor_id, action, target_type, target_id, created_at, detail_json, CAST(NULL AS TEXT) AS detail_a, CAST(NULL AS TEXT) AS detail_b, CAST(NULL AS TEXT) AS detail_c
       FROM admin_audit_events
       UNION ALL
       SELECT 'QUEUE', 'QUEUE:' || id, id, action_id, actor_id, action, 'QUEUE_ITEM', item_id, created_at, CAST(NULL AS TEXT), from_status, to_status, reason_code
       FROM generation_queue_admin_actions
       UNION ALL
       SELECT 'RECONCILIATION', 'RECONCILIATION:' || id, id, action_id, actor_id, action, 'RECONCILIATION_CASE', case_id, created_at, CAST(NULL AS TEXT), from_state, to_state, CAST(NULL AS TEXT)
       FROM generation_reconciliation_events
       UNION ALL
       SELECT 'ASSET_MAINTENANCE', 'ASSET_MAINTENANCE:' || id, id, action_id, actor_id, action, 'ASSET_CLEANUP', action_id, created_at, CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
       FROM asset_maintenance_events
       UNION ALL
       SELECT 'ASSET_MODERATION', 'ASSET_MODERATION:' || id, id, action_id, reviewer_id, decision, 'ASSET', asset_id, created_at, CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
       FROM asset_moderation_events
       UNION ALL
       SELECT 'ASSET_DELETION', 'ASSET_DELETION:' || id, id, action_id, actor_id, source, 'ASSET', asset_id, created_at, CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
       FROM asset_deletion_events
       UNION ALL
       SELECT 'GALLERY', 'GALLERY:' || id, id, action_id, actor_id, action, 'GALLERY', gallery_id, created_at, CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
       FROM gallery_audit_events
     )
     SELECT * FROM audit
     WHERE (? = 'ALL' OR source = ?) AND (? = '' OR actor_id = ?) AND (? = '' OR target_id = ?)
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(source, source, actorId, actorId, targetId, targetId, cursor?.time ?? null, cursor?.time ?? null, cursor?.time ?? null, cursor?.id ?? null, limit + 1).all<Record<string, unknown>>();
  const page = (rows.results ?? []).slice(0, limit);
  return {
    items: page.map(serializeAuditEvent),
    nextCursor: nextCursor(rows.results ?? [], page, limit, "audit", "created_at", filter),
  };
}

function serializeAuditEvent(row: Record<string, unknown>) {
  const detail = row.source === "ADMIN" ? safeAdminAuditDetail(row.detail_json) : Object.fromEntries([
    ["from", row.detail_a], ["to", row.detail_b], ["reasonCode", row.detail_c],
  ].filter((entry) => entry[1] !== null));
  return { id: row.id, eventId: row.event_id, source: row.source, actionId: row.action_id, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id, detail, createdAt: Number(row.created_at) };
}

function safeAdminAuditDetail(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    const allowed = new Set(["status", "dailyOutputLimit", "promoterEnabled", "maxPendingOutputs", "activeConcurrencyLimit", "enabled", "amount"]);
    return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => allowed.has(key) && ["string", "number", "boolean"].includes(typeof item)));
  } catch { return {}; }
}

type QueueMonitor = {
  enabled: boolean;
  consumer: {
    status: ConsumerHealthRead["status"] | "disabled";
    state: ConsumerHealthSnapshot["state"] | null;
    updatedAt: string | null;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
    counters: ConsumerHealthSnapshot["counters"] | null;
  };
  metrics: {
    dueCandidates: number;
    oldestCandidateAgeSeconds: number | null;
    dueRetries: number;
    expiredLeases: number;
    successesLastHour: number;
    failuresLastHour: number;
    averageCompletionSeconds: number | null;
    openReconciliation: number;
    unprocessedDeadLetters: number;
    blockedObjectCleanup: number;
  };
  alerts: string[];
};

export async function readQueueMonitor(d1: D1Database, bindings: Record<string, unknown>): Promise<QueueMonitor> {
  const [items, attempts, issues] = await Promise.all([
    d1.prepare(
      `SELECT
         SUM(CASE WHEN item.status IN ('QUEUED','RETRY_WAIT')
                    AND item.next_attempt_at <= unixepoch()
                    AND item.attempt_count < item.max_attempts
                    AND (item.lease_expires_at IS NULL OR item.lease_expires_at <= unixepoch())
                    AND EXISTS (SELECT 1 FROM generation_jobs AS job WHERE job.id = item.job_id AND job.status = 'QUEUED')
                  THEN 1 ELSE 0 END) AS due_candidates,
         MIN(CASE WHEN item.status IN ('QUEUED','RETRY_WAIT')
                    AND item.next_attempt_at <= unixepoch()
                    AND item.attempt_count < item.max_attempts
                    AND (item.lease_expires_at IS NULL OR item.lease_expires_at <= unixepoch())
                    AND EXISTS (SELECT 1 FROM generation_jobs AS job WHERE job.id = item.job_id AND job.status = 'QUEUED')
                  THEN item.created_at END) AS oldest_candidate_at,
         SUM(CASE WHEN item.status = 'RETRY_WAIT' AND item.next_attempt_at <= unixepoch() AND item.attempt_count < item.max_attempts THEN 1 ELSE 0 END) AS due_retries,
         SUM(CASE WHEN item.status IN ('LEASED','PREPROCESSING','SUBMITTING','PERSISTING') AND item.lease_expires_at <= unixepoch() THEN 1 ELSE 0 END) AS expired_leases
       FROM generation_job_items AS item WHERE item.execution_kind = 'provider'`,
    ).first<Record<string, number | null>>(),
    d1.prepare(
      `SELECT
         SUM(CASE WHEN attempt.state = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN attempt.state IN ('FAILED','AMBIGUOUS') THEN 1 ELSE 0 END) AS failed,
         AVG(CASE WHEN attempt.state = 'SUCCEEDED' THEN attempt.finished_at - attempt.started_at END) AS average_completion_seconds
       FROM generation_attempts AS attempt
       JOIN generation_job_items AS item ON item.id = attempt.item_id
       WHERE item.execution_kind = 'provider' AND attempt.finished_at >= unixepoch() - 3600`,
    ).first<Record<string, number | null>>(),
    d1.prepare("SELECT (SELECT COUNT(*) FROM generation_reconciliation_cases WHERE state = 'OPEN') AS reconciliation, (SELECT COUNT(*) FROM generation_dead_letter_entries AS dead WHERE NOT EXISTS (SELECT 1 FROM generation_queue_admin_actions AS action WHERE action.item_id = dead.item_id AND action.attempt_id = dead.attempt_id AND action.action = 'REQUEUE_BEFORE_PROVIDER')) AS dead_letters, (SELECT COUNT(*) FROM object_cleanup_tasks WHERE status = 'BLOCKED') AS blocked_cleanup").first<Record<string, number>>(),
  ]);
  const enabled = String(bindings.GENERATION_INTERNAL_API_ENABLED ?? "0") === "1";
  const health = enabled ? await readConsumerHealthBinding(bindings) : null;
  const oldest = Number(items?.oldest_candidate_at ?? 0);
  const metrics = {
    dueCandidates: Number(items?.due_candidates ?? 0),
    oldestCandidateAgeSeconds: oldest ? Math.max(0, Math.floor(Date.now() / 1000) - oldest) : null,
    dueRetries: Number(items?.due_retries ?? 0),
    expiredLeases: Number(items?.expired_leases ?? 0),
    successesLastHour: Number(attempts?.succeeded ?? 0),
    failuresLastHour: Number(attempts?.failed ?? 0),
    averageCompletionSeconds: attempts?.average_completion_seconds == null ? null : Math.max(0, Math.round(Number(attempts.average_completion_seconds))),
    openReconciliation: Number(issues?.reconciliation ?? 0),
    unprocessedDeadLetters: Number(issues?.dead_letters ?? 0),
    blockedObjectCleanup: Number(issues?.blocked_cleanup ?? 0),
  };
  const alerts = [
    ...(enabled && health?.status !== "ready" ? [`CONSUMER_${(health?.status ?? "unavailable").toUpperCase()}`] : []),
    ...(enabled && metrics.expiredLeases ? ["EXPIRED_LEASES"] : []),
    ...(metrics.openReconciliation ? ["OPEN_RECONCILIATION"] : []),
    ...(metrics.unprocessedDeadLetters ? ["UNPROCESSED_DEAD_LETTERS"] : []),
    ...(metrics.blockedObjectCleanup ? ["OBJECT_CLEANUP_BLOCKED"] : []),
  ];
  return {
    enabled,
    consumer: {
      status: enabled ? health?.status ?? "unavailable" : "disabled",
      state: health?.snapshot?.state ?? null,
      updatedAt: health?.snapshot?.updatedAt ?? null,
      lastSuccessAt: health?.snapshot?.lastSuccessAt ?? null,
      lastErrorCode: health?.snapshot?.lastErrorCode ?? null,
      counters: health?.snapshot?.counters ?? null,
    },
    metrics,
    alerts,
  };
}

async function readConsumerHealthBinding(bindings: Record<string, unknown>): Promise<ConsumerHealthRead> {
  const reader = bindings.ZAOSHI_CONSUMER_HEALTH;
  if (typeof reader !== "function") return { status: "unavailable", snapshot: null };
  try {
    return await (reader as () => Promise<ConsumerHealthRead>)();
  } catch {
    return { status: "unavailable", snapshot: null };
  }
}

async function listProviders(d1: D1Database, bindings: Record<string, unknown>) {
  const environment = resolveAiEnvironment(bindings as never);
  const stats = await d1.prepare(
    `SELECT COALESCE(attempt.model, item.provider_preference) AS model,
            COUNT(*) AS attempts,
            SUM(attempt.state = 'SUCCEEDED') AS succeeded,
            SUM(attempt.state IN ('FAILED','AMBIGUOUS')) AS failed,
            MAX(attempt.started_at) AS last_attempt_at
     FROM generation_attempts AS attempt
     JOIN generation_job_items AS item ON item.id = attempt.item_id
     WHERE item.execution_kind = 'provider'
     GROUP BY COALESCE(attempt.model, item.provider_preference)`,
  ).all<{ model: string; attempts: number; succeeded: number; failed: number; last_attempt_at: number | null }>();
  const byModel = new Map((stats.results ?? []).map((row) => [row.model, row]));
  return {
    queueEnabled: String(bindings.GENERATION_INTERNAL_API_ENABLED ?? "0") === "1",
    publicGenerationEnabled: isPublicImageGenerationEnabled(environment),
    liveProbe: false,
    balanceStatus: "not_integrated",
    models: imageModelValues.map((model) => {
      const row = byModel.get(model);
      return {
        model,
        label: imageModelCapabilities[model].label,
        provider: imageModelCapabilities[model].provider,
        configured: isDomesticImageModel(model) ? Boolean(resolveDomesticProviderConfiguration(model, environment)) : environment.OVERSEAS_RELAY_ENABLED === "1",
        attempts: Number(row?.attempts ?? 0),
        succeeded: Number(row?.succeeded ?? 0),
        failed: Number(row?.failed ?? 0),
        lastAttemptAt: row?.last_attempt_at ?? null,
      };
    }),
  };
}

async function readUser(d1: D1Database, userId: string) {
  const row = await d1.prepare(
    `SELECT account.id, account.display_name, account.status, account.role, account.created_at, account.updated_at,
            COALESCE((SELECT enabled FROM referral_promoters WHERE user_id=account.id),0) AS promoter_enabled,
            COALESCE(limits.daily_output_limit, 20) AS daily_output_limit,
            COALESCE(limits.max_pending_outputs, 4) AS max_pending_outputs,
            COALESCE(limits.active_concurrency_limit, 3) AS active_concurrency_limit,
            COALESCE(limits.enabled, 1) AS enabled,
            (SELECT COUNT(*) FROM auth_sessions AS session WHERE session.user_id = account.id AND session.revoked_at IS NULL AND session.expires_at > unixepoch()) AS active_sessions,
            (SELECT COUNT(*) FROM generation_jobs AS job WHERE job.owner_id = account.id) AS job_count,
            COALESCE((SELECT SUM(CASE WHEN entry_type = 'CREDIT' THEN amount WHEN entry_type = 'RESERVE' THEN -amount WHEN entry_type = 'RELEASE' THEN amount ELSE 0 END) FROM credit_ledger_entries WHERE owner_id = account.id), 0) AS available_credits
     FROM users AS account LEFT JOIN user_generation_limits AS limits ON limits.owner_id = account.id WHERE account.id = ?`,
  ).bind(userId).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "USER_NOT_FOUND", "没有找到这个用户。");
  return serializeUser(row);
}

function serializeUser(row: Record<string, unknown>) {
  return { promoterEnabled: Boolean(row.promoter_enabled), id: row.id, displayName: row.display_name, status: row.status, role: row.role, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), activeSessions: Number(row.active_sessions), jobCount: Number(row.job_count), availableCredits: Number(row.available_credits), limits: { dailyOutputLimit: null, dailyUnlimited: true, maxPendingOutputs: Number(row.max_pending_outputs), activeConcurrencyLimit: Number(row.active_concurrency_limit), enabled: Boolean(row.enabled) } };
}

async function globalCreditSummary(d1: D1Database) {
  const row = await d1.prepare(
    `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credited,
            COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount WHEN entry_type = 'RESERVE' THEN -amount WHEN entry_type = 'RELEASE' THEN amount ELSE 0 END), 0) AS available,
            COALESCE(SUM(CASE WHEN entry_type = 'RESERVE' THEN amount WHEN entry_type IN ('SETTLE','RELEASE') THEN -amount ELSE 0 END), 0) AS reserved,
            COALESCE(SUM(CASE WHEN entry_type = 'SETTLE' THEN amount ELSE 0 END), 0) AS spent
     FROM credit_ledger_entries`,
  ).first<Record<string, number>>();
  return numericRecord(row, ["credited", "available", "reserved", "spent"]);
}

function auditInsert(d1: D1Database, input: { id: string; actionId: string; actorId: string; action: AuditAction; targetType: "USER" | "CREDIT_ACCOUNT"; targetId: string; payloadHash: string; detail: Record<string, unknown>; requestId: string; protectLastAdmin?: boolean }) {
  return d1.prepare(
    `INSERT INTO admin_audit_events
      (id, action_id, actor_id, action, target_type, target_id, payload_hash, detail_json, request_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'ADMIN' AND status = 'ACTIVE') OR (SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE') > 1)
     ON CONFLICT(action_id) DO NOTHING`,
  ).bind(input.id, input.actionId, input.actorId, input.action, input.targetType, input.targetId, input.payloadHash, JSON.stringify(input.detail), input.requestId, input.targetId, Number(Boolean(input.protectLastAdmin)), input.targetId);
}

async function verifyAudit(d1: D1Database, actionId: string, payloadHash: string, insertedId: string): Promise<boolean> {
  const row = await d1.prepare("SELECT id, payload_hash FROM admin_audit_events WHERE action_id = ?").bind(actionId).first<{ id: string; payload_hash: string }>();
  if (!row) throw new ApiError(500, "ADMIN_ACTION_NOT_SAVED", "管理员操作未能可靠保存。");
  if (row.payload_hash !== payloadHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "actionId 已用于不同的管理员操作。");
  return row.id !== insertedId;
}

function nextCursor(rows: Record<string, unknown>[], page: Record<string, unknown>[], limit: number, view: Cursor["view"], timeKey: string, filter: string) {
  if (rows.length <= limit) return null;
  const last = page.at(-1);
  return last ? encodeCursor({ v: 1, view, filter, time: Number(last[timeKey]), id: String(last.id) }) : null;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string | null, view: Cursor["view"], filter: string): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 512) throw new Error();
    const value = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))) as Partial<Cursor>;
    if (value.v !== 1 || value.view !== view || value.filter !== filter || !Number.isSafeInteger(value.time) || typeof value.id !== "string" || value.id.length > 180) throw new Error();
    return value as Cursor;
  } catch { throw new ApiError(400, "INVALID_CURSOR", "分页位置无效，请重新加载。"); }
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  if (!/^\d{1,3}$/u.test(raw)) throw new ApiError(400, "INVALID_FIELD", "limit 无效。");
  const value = Number(raw);
  if (value < 1 || value > 100) throw new ApiError(400, "INVALID_FIELD", "limit 必须为1到100。");
  return value;
}

function numericRecord(row: Record<string, number> | null, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, Number(row?.[key] ?? 0)]));
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: string[]) {
  const set = new Set(allowed);
  if (Object.keys(input).some((key) => !set.has(key))) throw new ApiError(400, "INVALID_FIELD", "请求包含不支持的字段。");
}

function identifier(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length < 8 || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) throw new ApiError(400, "INVALID_FIELD", `${field} 无效。`);
  return value;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) throw new ApiError(400, "INVALID_FIELD", `${field} 无效。`);
  return value as T;
}

function requiredInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new ApiError(400, "INVALID_FIELD", `${field} 必须为${min}到${max}的整数。`);
  return Number(value);
}

function optionalInteger(value: unknown, min: number, max: number, field: string): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, min, max, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, "INVALID_FIELD", `${field} 必须为布尔值。`);
  return value;
}

function hashJson(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
