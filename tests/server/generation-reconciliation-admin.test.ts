import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NodeD1Database } from "../../lib/platform/node-d1";
import { ApiError } from "../../lib/server/api";
import {
  appendReconciliationNote,
  assertReconciliationAdmin,
  listReconciliationCases,
  parseAddReconciliationNote,
  parseReconciliationLimit,
  parseReconciliationState,
} from "../../lib/server/generation-reconciliation";

const adminActor = {
  ownerId: "chatgpt:admin",
  setCookie: null,
  trusted: true,
  user: { authenticated: true, displayName: "管理员", email: "ADMIN@example.com" },
};

function code(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

test("reconciliation admin is fail-closed and uses its separate allowlist", () => {
  const trustedRequest = new Request("https://zaoshi.example/api/admin/generation/reconciliation", {
    headers: { "oai-authenticated-user-id": "platform-admin" },
  });
  assert.doesNotThrow(() => assertReconciliationAdmin(trustedRequest, adminActor, {
    TRUST_PLATFORM_IDENTITY_HEADERS: "1",
    GENERATION_RECONCILIATION_ADMIN_EMAILS: " admin@example.com ",
  }));
  assert.throws(() => assertReconciliationAdmin(trustedRequest, { ...adminActor, trusted: false }, {
    GENERATION_RECONCILIATION_ADMIN_EMAILS: "admin@example.com",
  }), code("AUTH_REQUIRED"));
  assert.throws(() => assertReconciliationAdmin(trustedRequest, adminActor, {
    GALLERY_ADMIN_EMAILS: "admin@example.com",
  }), code("ADMIN_FORBIDDEN"));
});

test("reconciliation list keyset-paginates one state and rejects a cross-state cursor", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE generation_reconciliation_cases (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    job_id TEXT NOT NULL, reason_code TEXT NOT NULL, provider TEXT, model TEXT,
    provider_request_id TEXT, state TEXT NOT NULL, resolution TEXT, version INTEGER NOT NULL,
    opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER
  )`);
  const insert = database.prepare(`INSERT INTO generation_reconciliation_cases
    (id,item_id,attempt_id,job_id,reason_code,provider,model,provider_request_id,state,
     resolution,version,opened_at,updated_at,resolved_at)
    VALUES (?,?,?,?,?,'seedream','safe-model',?, ?,NULL,1,?,?,NULL)`);
  insert.run("case-a", "item-a", "attempt-a", "job-a", "AMBIGUOUS", "request-a", "OPEN", 90, 90);
  insert.run("case-b", "item-b", "attempt-b", "job-b", "AMBIGUOUS", "request-b", "OPEN", 100, 100);
  insert.run("case-c", "item-c", "attempt-c", "job-c", "AMBIGUOUS", "request-c", "OPEN", 100, 100);
  insert.run("case-z", "item-z", "attempt-z", "job-z", "RECOVERED", "request-z", "CLOSED", 110, 110);
  const d1 = new NodeD1Database(database);

  const first = await listReconciliationCases({ state: "OPEN", limit: 2 }, d1);
  assert.deepEqual(first.items.map((item) => item.id), ["case-c", "case-b"]);
  assert.ok(first.nextCursor);
  const second = await listReconciliationCases({ state: "OPEN", limit: 2, cursor: first.nextCursor }, d1);
  assert.deepEqual(second.items.map((item) => item.id), ["case-a"]);
  assert.equal(second.nextCursor, null);
  assert.equal(Object.hasOwn(first.items[0] ?? {}, "ownerId"), false);
  assert.equal(Object.hasOwn(first.items[0] ?? {}, "storageKey"), false);
  assert.equal(Object.hasOwn(first.items[0] ?? {}, "prompt"), false);
  await assert.rejects(
    listReconciliationCases({ state: "CLOSED", limit: 2, cursor: first.nextCursor }, d1),
    code("INVALID_CURSOR"),
  );
});

test("reconciliation query validation and page states remain explicit", () => {
  assert.equal(parseReconciliationState(null), "OPEN");
  assert.equal(parseReconciliationState("CLOSED"), "CLOSED");
  assert.throws(() => parseReconciliationState("ALL"), code("INVALID_FIELD"));
  assert.equal(parseReconciliationLimit("100"), 100);
  assert.throws(() => parseReconciliationLimit("0"), code("INVALID_FIELD"));
  assert.throws(() => parseReconciliationLimit("101"), code("INVALID_FIELD"));

  const page = readFileSync("app/admin/generation/reconciliation/page.tsx", "utf8");
  assert.match(page, /status === "loading"/u);
  assert.match(page, /status === "error"/u);
  assert.match(page, /items\.length === 0/u);
  assert.match(page, /AdminPagination/u);
  assert.match(page, /limit=25/u);
  assert.match(page, /useAdminPage/u);

});

test("ADD_NOTE is append-only, case-scoped and exactly idempotent", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE generation_reconciliation_cases (
      id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
      resolution TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE generation_reconciliation_events (
      id TEXT PRIMARY KEY NOT NULL, case_id TEXT NOT NULL, action_id TEXT NOT NULL,
      action TEXT NOT NULL, actor_id TEXT NOT NULL, from_state TEXT, to_state TEXT,
      note TEXT, request_id TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(case_id, action_id)
    );
    INSERT INTO generation_reconciliation_cases VALUES ('recon-one','OPEN',1,NULL,100);
    INSERT INTO generation_reconciliation_cases VALUES ('recon-two','CLOSED',2,'OUTPUT_COMMIT_RECOVERED',200);
  `);
  const d1 = new NodeD1Database(database);
  const input = {
    caseId: "recon-one",
    action: "ADD_NOTE" as const,
    actionId: "note-action-0001",
    note: "已向供应商核对，请等待回执。",
    actorId: "chatgpt:hashed-admin",
    requestId: "request-one",
  };
  const before = database.prepare("SELECT * FROM generation_reconciliation_cases WHERE id='recon-one'").get();
  const [first, replay] = await Promise.all([
    appendReconciliationNote(input, d1),
    appendReconciliationNote({ ...input, requestId: "request-replay" }, d1),
  ]);
  assert.deepEqual([first.idempotentReplay, replay.idempotentReplay].sort(), [false, true]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_reconciliation_events WHERE case_id='recon-one'").get()?.count, 1);
  assert.deepEqual(database.prepare("SELECT * FROM generation_reconciliation_cases WHERE id='recon-one'").get(), before);
  await assert.rejects(
    appendReconciliationNote({ ...input, note: "不同内容", requestId: "request-conflict" }, d1),
    code("IDEMPOTENCY_CONFLICT"),
  );
  const closed = await appendReconciliationNote({
    ...input,
    caseId: "recon-two",
    requestId: "request-two",
  }, d1);
  assert.equal(closed.idempotentReplay, false);
  assert.equal(database.prepare("SELECT state FROM generation_reconciliation_cases WHERE id='recon-two'").get()?.state, "CLOSED");
  await assert.rejects(
    appendReconciliationNote({ ...input, caseId: "recon-missing", actionId: "note-action-0002" }, d1),
    code("RECONCILIATION_CASE_NOT_FOUND"),
  );
});

test("ADD_NOTE input and route contract reject expanded actions and unsafe text", () => {
  assert.deepEqual(parseAddReconciliationNote({
    caseId: "recon-one",
    action: "ADD_NOTE",
    actionId: "note-action-0001",
    note: " 第一行\r\n第二行 ",
  }), {
    caseId: "recon-one",
    action: "ADD_NOTE",
    actionId: "note-action-0001",
    note: "第一行\n第二行",
  });
  assert.throws(() => parseAddReconciliationNote({ caseId: "recon-one", action: "RETRY", actionId: "note-action-0001", note: "x" }), code("INVALID_FIELD"));
  assert.throws(() => parseAddReconciliationNote({ caseId: "recon-one", action: "ADD_NOTE", actionId: "short", note: "x" }), code("INVALID_FIELD"));
  assert.throws(() => parseAddReconciliationNote({ caseId: "recon-one", action: "ADD_NOTE", actionId: "note-action-0001", note: "bad\u0000note" }), code("INVALID_FIELD"));
  assert.throws(() => parseAddReconciliationNote({ caseId: "recon-one", action: "ADD_NOTE", actionId: "note-action-0001", note: "x", retry: true }), code("INVALID_FIELD"));

  const route = readFileSync("app/api/admin/generation/reconciliation/route.ts", "utf8");
  assert.match(route, /export async function POST/u);
  assert.match(route, /assertReconciliationAdmin\(request, actor, readRuntimeBindings\(\)\)/u);
  assert.match(route, /assertSameOriginMutation\(request\)/u);
  assert.match(route, /readJsonBody\(request, 8 \* 1024\)/u);
  assert.doesNotMatch(route, /RETRY|MARK_SUCCEEDED|REFUND/u);
});
