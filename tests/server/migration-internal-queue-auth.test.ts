import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations } from "../helpers/test-d1";

test("0010 adds only the bounded internal nonce replay table and index", () => {
  const sql = readFileSync("drizzle/0010_round_aaron_stack.sql", "utf8");
  assert.match(sql, /CREATE TABLE `generation_internal_nonces`/u);
  assert.match(sql, /PRIMARY KEY NOT NULL/u);
  assert.match(sql, /idx_generation_internal_nonces_expires/u);
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT)\b/iu);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database, 9);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'generation_internal_nonces'",
      )
      .get()?.count,
    0,
  );
  database.exec(sql);
  const columns = database
    .prepare("PRAGMA table_info(generation_internal_nonces)")
    .all() as Array<{ name: string; notnull: number; pk: number }>;
  assert.deepEqual(
    columns.map((column) => [column.name, column.notnull, column.pk]),
    [
      ["nonce_hash", 1, 1],
      ["key_id", 1, 0],
      ["created_at", 1, 0],
      ["expires_at", 1, 0],
    ],
  );
  database
    .prepare(
      "INSERT INTO generation_internal_nonces (nonce_hash, key_id, expires_at) VALUES (?, ?, ?)",
    )
    .run("hash-a", "current", 123);
  assert.throws(() =>
    database
      .prepare(
        "INSERT INTO generation_internal_nonces (nonce_hash, key_id, expires_at) VALUES (?, ?, ?)",
      )
      .run("hash-a", "current", 124),
  );
});
