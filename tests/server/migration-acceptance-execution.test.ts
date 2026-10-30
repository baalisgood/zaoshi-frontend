import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations } from "../helpers/test-d1";

test("0013 isolates acceptance execution rows and validates their enums", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);

  const itemColumns = database
    .prepare("PRAGMA table_info(generation_job_items)")
    .all() as Array<{ name: string; dflt_value: string | null }>;
  const executionKind = itemColumns.find(
    (column) => column.name === "execution_kind",
  );
  assert.equal(executionKind?.dflt_value, "'provider'");

  for (const name of [
    "generation_acceptance_runs_item_id_unique",
    "idx_generation_acceptance_runs_updated",
    "idx_generation_job_items_execution_runnable",
  ]) {
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get(name),
      name,
    );
  }
  for (const name of [
    "generation_job_items_execution_kind_insert",
    "generation_job_items_execution_kind_update",
    "generation_acceptance_runs_scenario_insert",
    "generation_acceptance_runs_scenario_update",
  ]) {
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(name),
      name,
    );
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
