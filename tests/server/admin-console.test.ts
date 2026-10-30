import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isSiteAdmin } from "../../lib/server/admin";
import { grantManagedCredits, readAdminConsole, updateManagedUser } from "../../lib/server/admin-console";
import { ApiError } from "../../lib/server/api";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'ADMIN'), (?, ?, 'USER')").run("user_admin_123", "管理员", "user_member_123", "测试用户");
  database.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, unixepoch() + 3600)").run("session_member", "user_member_123");
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}

const apiCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("unified admin accepts trusted ADMIN role or explicit email allowlist only", () => {
  const roleAdmin = { ownerId: "user_admin_123", trusted: true, setCookie: null, user: { authenticated: true, displayName: "管理员", role: "ADMIN" as const } };
  const emailAdmin = { ownerId: "chatgpt:test", trusted: true, setCookie: null, user: { authenticated: true, displayName: "管理员", email: "Admin@Example.com" } };
  assert.equal(isSiteAdmin(roleAdmin, {}), true);
  assert.equal(isSiteAdmin(emailAdmin, { ADMIN_EMAILS: "admin@example.com" }), true);
  assert.equal(isSiteAdmin({ ...emailAdmin, trusted: false }, { ADMIN_EMAILS: "admin@example.com" }), false);
  assert.equal(isSiteAdmin({ ...emailAdmin, user: { ...emailAdmin.user, authenticated: false } }, { ADMIN_EMAILS: "admin@example.com" }), false);
  assert.equal(isSiteAdmin(emailAdmin, { ADMIN_EMAILS: "other@example.com" }), false);
});

test("user management is audited, idempotent and revokes sessions on suspension", async () => {
  const { database, d1 } = setup();
  const input = { action: "UPDATE_USER", actionId: "action_user_001", userId: "user_member_123", status: "SUSPENDED", promoterEnabled: true, maxPendingOutputs: 5, activeConcurrencyLimit: 2, enabled: false };
  const first = await updateManagedUser(input, "user_admin_123", "request-1", d1);
  assert.equal(first.idempotentReplay, false);
  assert.equal(first.user.status, "SUSPENDED");
  assert.equal(first.user.limits.dailyOutputLimit, null);
  assert.equal(first.user.promoterEnabled, true);
  assert.equal(first.user.limits.enabled, false);
  assert.equal(database.prepare("SELECT revoked_at IS NOT NULL FROM auth_sessions WHERE user_id = ?").get("user_member_123")!["revoked_at IS NOT NULL"], 1);
  const replay = await updateManagedUser(input, "user_admin_123", "request-2", d1);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").get()!.count, 1);
  await assert.rejects(() => updateManagedUser({ ...input, status: "ACTIVE" }, "user_admin_123", "request-3", d1), apiCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(() => updateManagedUser({ ...input, actionId: "action_user_role", role: "ADMIN" }, "user_admin_123", "request-4", d1), apiCode("INVALID_FIELD"));
  await assert.rejects(() => updateManagedUser({ action: "UPDATE_USER", actionId: "action_last_admin", userId: "user_admin_123", status: "SUSPENDED" }, "user_admin_123", "request-5", d1), apiCode("ADMIN_SELF_LOCKOUT"));
});

test("concurrent admin suspensions cannot remove the last active administrator", async () => {
  const { database, d1 } = setup();
  database.prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'ADMIN')").run("user_admin_456", "第二管理员");
  const results = await Promise.allSettled([
    updateManagedUser({ action: "UPDATE_USER", actionId: "action_suspend_admin_1", userId: "user_admin_123", status: "SUSPENDED" }, "external_admin", "request-admin-1", d1),
    updateManagedUser({ action: "UPDATE_USER", actionId: "action_suspend_admin_2", userId: "user_admin_456", status: "SUSPENDED" }, "external_admin", "request-admin-2", d1),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof ApiError && result.reason.code === "LAST_ADMIN_REQUIRED").length, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_audit_events WHERE action = 'USER_UPDATE'").get()!.count, 1);
});

test("admin credit grants are positive-only, idempotent and append-only", async () => {
  const { database, d1 } = setup();
  const input = { action: "CREDIT_GRANT", actionId: "action_credit_001", userId: "user_member_123", amount: 25 };
  const first = await grantManagedCredits(input, "user_admin_123", "request-credit-1", d1);
  assert.equal(first.idempotentReplay, false);
  assert.deepEqual(first.snapshot, { credited: 25, available: 25, reserved: 0, spent: 0 });
  const replay = await grantManagedCredits(input, "user_admin_123", "request-credit-2", d1);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.snapshot.credited, 25);
  await assert.rejects(() => grantManagedCredits({ ...input, amount: 30 }, "user_admin_123", "request-credit-3", d1), apiCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(() => grantManagedCredits({ ...input, actionId: "action_credit_negative", amount: -1 }, "user_admin_123", "request-credit-4", d1), apiCode("INVALID_FIELD"));
  assert.throws(() => database.prepare("UPDATE admin_audit_events SET target_id = 'changed'").run(), /append-only/u);
  assert.throws(() => database.prepare("DELETE FROM admin_audit_events").run(), /append-only/u);
});

test("admin views expose truthful users, credits, tasks and provider configuration", async () => {
  const { d1 } = setup();
  await grantManagedCredits({ action: "CREDIT_COMPENSATION", actionId: "action_credit_view", userId: "user_member_123", amount: 9 }, "user_admin_123", "request-view", d1);
  const users = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=users&q=%E6%B5%8B%E8%AF%95"), d1, {}) as { items: Array<{ id: string; availableCredits: number }> };
  assert.deepEqual(users.items.map((item) => item.id), ["user_member_123"]);
  assert.equal(users.items[0].availableCredits, 9);
  const credits = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=credits&ownerId=user_member_123"), d1, {}) as unknown as { summary: { credited: number }; owner: { available: number }; items: unknown[] };
  assert.equal(credits.summary.credited, 9);
  assert.equal(credits.owner.available, 9);
  assert.equal(credits.items.length, 1);
  const tasks = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=tasks"), d1, {}) as { items: unknown[] };
  assert.deepEqual(tasks.items, []);
  const providers = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=providers"), d1, { ARK_API_KEY: "secret", BACKEND_PROFILE: "cn-production" }) as { publicGenerationEnabled: boolean; liveProbe: boolean; balanceStatus: string; models: Array<{ provider: string; configured: boolean }> };
  assert.equal(providers.publicGenerationEnabled, false);
  assert.equal(providers.liveProbe, false);
  assert.equal(providers.balanceStatus, "not_integrated");
  assert.equal(providers.models.filter((item) => item.provider === "seedream").every((item) => item.configured), true);
  assert.equal(JSON.stringify(providers).includes("secret"), false);
});

test("admin cursors are bound to their active filters", async () => {
  const { d1 } = setup();
  const first = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=users&limit=1"), d1, {}) as { nextCursor: string };
  assert.equal(typeof first.nextCursor, "string");
  await assert.rejects(
    () => readAdminConsole(new Request(`https://zaoshi.example/api/admin/console?view=users&limit=1&status=SUSPENDED&cursor=${encodeURIComponent(first.nextCursor)}`), d1, {}),
    apiCode("INVALID_CURSOR"),
  );
});

test("audit view merges immutable events and exposes only allowlisted details", async () => {
  const { database, d1 } = setup();
  await updateManagedUser({ action: "UPDATE_USER", actionId: "action_audit_user", userId: "user_member_123", promoterEnabled: true }, "user_admin_123", "private-request-id", d1);
  await grantManagedCredits({ action: "CREDIT_GRANT", actionId: "action_audit_credit", userId: "user_member_123", amount: 5 }, "user_admin_123", "private-credit-request", d1);
  database.prepare("INSERT INTO asset_maintenance_events (id,action_id,actor_id,action,detail_hash,request_id,created_at) VALUES ('maintenance-audit','maintenance-audit-action','user_admin_123','RETRY_BLOCKED_CLEANUP',?,'secret-request',unixepoch()+1)").run("a".repeat(64));
  database.prepare("INSERT INTO assets (id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,sanitization_version,storage_key,created_at) VALUES ('asset-audit','user_member_123','source','READY','room.png','image/png',4,?,'canonical-image-v1','private/object/path',CURRENT_TIMESTAMP)").run("b".repeat(64));
  database.prepare("INSERT INTO asset_moderation_events (id,action_id,asset_id,reviewer_id,decision,reason_hash,created_at) VALUES ('moderation-audit','moderation-audit-action','asset-audit','user_admin_123','APPROVED',?,unixepoch()+2)").run("c".repeat(64));
  database.prepare("INSERT INTO asset_deletion_events (id,action_id,asset_id,actor_id,source,detail_hash,created_at) VALUES ('deletion-audit','deletion-audit-action','asset-audit','user_member_123','USER_REQUEST',?,unixepoch()+3)").run("d".repeat(64));

  const result = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=audit"), d1, {}) as { items: Array<{ source: string; detail: Record<string, unknown>; targetId: string }> };
  assert.deepEqual(result.items.map((item) => item.source), ["ASSET_DELETION", "ASSET_MODERATION", "ASSET_MAINTENANCE", "ADMIN", "ADMIN"]);
  assert.deepEqual(result.items.find((item) => "promoterEnabled" in item.detail)?.detail, { promoterEnabled: true });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-request-id|private-credit-request|secret-request|private\/object\/path|reason_hash|detail_hash/u);

  const first = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=audit&limit=1&source=ADMIN"), d1, {}) as { nextCursor: string };
  assert.equal(typeof first.nextCursor, "string");
  await assert.rejects(() => readAdminConsole(new Request(`https://zaoshi.example/api/admin/console?view=audit&limit=1&source=ASSET_MAINTENANCE&cursor=${encodeURIComponent(first.nextCursor)}`), d1, {}), apiCode("INVALID_CURSOR"));
  await assert.rejects(() => readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=audit&source=UNKNOWN"), d1, {}), apiCode("INVALID_FIELD"));
});

test("admin queue monitor combines durable backlog with consumer health without leaking details", async () => {
  const { database, d1 } = setup();
  const now = Math.floor(Date.now() / 1000);
  database.prepare(
    `INSERT INTO generation_jobs
      (id,owner_id,source_asset_id,style_preset_id,lighting_preset,preservation_mode,
       provider_preference,output_count,idempotency_key,request_hash,status)
     VALUES ('job-monitor','user_member_123',NULL,'modern-warm','noon','structure',
             'doubao-seedream-4-5-251128',3,'monitor-idem','monitor-hash','QUEUED')`,
  ).run();
  const insertItem = database.prepare(
    `INSERT INTO generation_job_items
      (id,job_id,owner_id,ordinal,provider_preference,provider_key,execution_kind,status,
       attempt_count,max_attempts,next_attempt_at,lease_token,lease_generation,lease_owner,
       lease_expires_at,last_error_code,last_error_message,created_at,updated_at)
     VALUES (?,'job-monitor','user_member_123',?,'doubao-seedream-4-5-251128','seedream','provider',
             ?,?,3,?,?,1,?,?,?,'private prompt and object path',?,?)`,
  );
  insertItem.run("item-monitor-queued", 0, "QUEUED", 0, now - 1, null, null, null, null, now - 600, now - 600);
  insertItem.run("item-monitor-retry", 1, "RETRY_WAIT", 1, now - 1, null, null, null, "SAFE_RETRY", now - 120, now - 120);
  insertItem.run("item-monitor-expired", 2, "LEASED", 1, now, "lease-monitor-expired", "worker-monitor", now - 1, "LEASE_EXPIRED", now - 60, now - 60);
  database.prepare(
    `INSERT INTO generation_attempts
      (id,item_id,attempt_no,lease_token,lease_generation,state,started_at,finished_at)
     VALUES ('attempt-monitor-success','item-monitor-queued',1,'lease-monitor-success',1,'SUCCEEDED',?,?),
            ('attempt-monitor-failed','item-monitor-retry',1,'lease-monitor-failed',1,'FAILED',?,?)`,
  ).run(now - 50, now - 30, now - 20, now - 10);
  const health = {
    status: "ready",
    snapshot: {
      version: 1,
      state: "ready",
      startedAt: new Date((now - 120) * 1000).toISOString(),
      updatedAt: new Date(now * 1000).toISOString(),
      lastSuccessAt: new Date(now * 1000).toISOString(),
      lastErrorCode: null,
      counters: { completed: 2, safeFailures: 1, reconciliationRequired: 0, controlPlaneFailures: 0, sweeps: 3, quarantineRemoved: 0 },
    },
  };
  const data = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=tasks"), d1, {
    GENERATION_INTERNAL_API_ENABLED: "1",
    ZAOSHI_CONSUMER_HEALTH: async () => health,
    ARK_API_KEY: "top-secret-provider-key",
  }) as unknown as { queue: { consumer: { status: string }; metrics: Record<string, number | null>; alerts: string[] } };
  assert.equal(data.queue.consumer.status, "ready");
  assert.equal(data.queue.metrics.dueCandidates, 2);
  assert.ok(Number(data.queue.metrics.oldestCandidateAgeSeconds) >= 599);
  assert.equal(data.queue.metrics.dueRetries, 1);
  assert.equal(data.queue.metrics.expiredLeases, 1);
  assert.equal(data.queue.metrics.successesLastHour, 1);
  assert.equal(data.queue.metrics.failuresLastHour, 1);
  assert.equal(data.queue.metrics.averageCompletionSeconds, 20);
  assert.deepEqual(data.queue.alerts, ["EXPIRED_LEASES"]);
  assert.equal(JSON.stringify(data).includes("top-secret-provider-key"), false);
  assert.equal(JSON.stringify(data).includes("private prompt and object path"), false);

  const disabled = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=tasks"), d1, {
    GENERATION_INTERNAL_API_ENABLED: "0",
  }) as unknown as { queue: { consumer: { status: string }; alerts: string[] } };
  assert.equal(disabled.queue.consumer.status, "disabled");
  assert.deepEqual(disabled.queue.alerts, []);

  database.prepare("INSERT INTO object_cleanup_tasks (id,source_type,source_id,object_key,status) VALUES ('blocked-monitor','ASSET','asset-monitor','blocked/monitor','BLOCKED')").run();
  const blocked = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=tasks"), d1, {
    GENERATION_INTERNAL_API_ENABLED: "0",
  }) as unknown as { queue: { metrics: { blockedObjectCleanup: number }; alerts: string[] } };
  assert.equal(blocked.queue.metrics.blockedObjectCleanup, 1);
  assert.deepEqual(blocked.queue.alerts, ["OBJECT_CLEANUP_BLOCKED"]);

  const unavailable = await readAdminConsole(new Request("https://zaoshi.example/api/admin/console?view=tasks"), d1, {
    GENERATION_INTERNAL_API_ENABLED: "1",
  }) as unknown as { queue: { consumer: { status: string }; alerts: string[] } };
  assert.equal(unavailable.queue.consumer.status, "unavailable");
  assert.equal(unavailable.queue.alerts[0], "CONSUMER_UNAVAILABLE");
});
