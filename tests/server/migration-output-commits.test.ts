import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations } from "../helpers/test-d1";

test("0012 adds isolated queue output commit reservations", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const columns = database
    .prepare("PRAGMA table_info(generation_output_commits)")
    .all() as Array<{ name: string }>;
  for (const name of [
    "item_id",
    "attempt_id",
    "lease_generation",
    "upload_request_id",
    "asset_id",
    "storage_key",
    "sha256",
    "sanitization_version",
    "state",
  ]) {
    assert.equal(columns.some((column) => column.name === name), true, name);
  }
  const assetColumns = database
    .prepare("PRAGMA table_info(assets)")
    .all() as Array<{ name: string }>;
  assert.equal(
    assetColumns.some((column) => column.name === "sanitization_version"),
    true,
  );
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%sanitization_version_immutable'",
    )
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    triggers.map((entry) => entry.name).sort(),
    [
      "assets_sanitization_version_immutable",
      "generation_output_sanitization_version_immutable",
    ],
  );
  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'generation_output_commits'",
    )
    .all() as Array<{ name: string }>;
  for (const name of [
    "generation_output_commits_item_id_unique",
    "generation_output_commits_attempt_id_unique",
    "generation_output_commits_upload_request_id_unique",
    "generation_output_commits_asset_id_unique",
    "generation_output_commits_storage_key_unique",
    "idx_generation_output_commits_state_updated",
  ]) {
    assert.equal(indexes.some((index) => index.name === name), true, name);
  }
});
