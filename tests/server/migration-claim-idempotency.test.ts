import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations } from "../helpers/test-d1";

test("0011 adds durable claim idempotency fields and a unique request index", () => {
  const sql = readFileSync("drizzle/0011_nebulous_angel.sql", "utf8");
  assert.match(sql, /ADD `claim_request_id` text;/u);
  assert.match(sql, /ADD `claim_worker_id` text;/u);
  assert.match(sql, /uidx_generation_attempts_claim_request/u);
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/iu);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database, 10);
  const before = database
    .prepare("PRAGMA table_info(generation_attempts)")
    .all() as Array<{ name: string }>;
  assert.equal(
    before.some((column) => column.name === "claim_request_id"),
    false,
  );

  database.prepare(
    `INSERT INTO generation_jobs
      (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
       preservation_mode, provider_preference, output_count, idempotency_key,
       request_hash)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "job-before-0011",
    "owner-before-0011",
    "modern-warm",
    "noon",
    "structure",
    "doubao-seedream-4-5-251128",
    1,
    "idem-before-0011",
    "hash-before-0011",
  );
  database.prepare(
    `INSERT INTO generation_job_items
      (id, job_id, owner_id, ordinal, provider_preference, provider_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "qitem-before-0011",
    "job-before-0011",
    "owner-before-0011",
    0,
    "doubao-seedream-4-5-251128",
    "seedream",
  );
  database.prepare(
    `INSERT INTO generation_attempts
      (id, item_id, attempt_no, lease_token, lease_generation)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "attempt-before-0011",
    "qitem-before-0011",
    1,
    "lease-before-0011",
    1,
  );

  database.exec(sql);
  const after = database
    .prepare("PRAGMA table_info(generation_attempts)")
    .all() as Array<{ name: string; notnull: number }>;
  assert.deepEqual(
    after
      .filter((column) =>
        ["claim_request_id", "claim_worker_id"].includes(column.name),
      )
      .map((column) => [column.name, column.notnull]),
    [
      ["claim_request_id", 0],
      ["claim_worker_id", 0],
    ],
  );
  const migratedAttempt = database
    .prepare(
      "SELECT claim_request_id AS claimRequestId, claim_worker_id AS claimWorkerId FROM generation_attempts WHERE id = ?",
    )
    .get("attempt-before-0011");
  assert.equal(migratedAttempt?.claimRequestId, null);
  assert.equal(migratedAttempt?.claimWorkerId, null);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'uidx_generation_attempts_claim_request'",
      )
      .get()?.count,
    1,
  );
});
