import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";

test("0009 adds durable queue tables without backfilling historical jobs", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  for (let index = 0; index <= 8; index += 1) {
    const filename = migrationFilename(index);
    database.exec(readFileSync(`drizzle/${filename}`, "utf8"));
  }
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
         preservation_mode, provider_preference, output_count,
         idempotency_key, request_hash, status, finished_at)
       VALUES ('historical-success', 'owner', NULL, 'self-service', 'noon',
               'structure', 'doubao-seedream-5-0-pro-260628', 1,
               'historical-key', 'historical-hash', 'SUCCEEDED', CURRENT_TIMESTAMP)`,
    )
    .run();

  const migration = readMigrationFiles({ migrationsFolder: "drizzle" }).find(
    (entry) =>
      entry.sql.some((chunk) => chunk.includes("generation_job_items")) &&
      entry.sql.some((chunk) => chunk.includes("generation_attempts")),
  );
  assert.ok(migration);
  database.exec("BEGIN;");
  try {
    for (const statement of migration.sql) database.exec(statement);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }

  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM generation_jobs WHERE id = 'historical-success'")
      .get()?.count,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM generation_job_items").get()?.count,
    0,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM generation_attempts").get()?.count,
    0,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM pragma_table_info('generation_job_items') WHERE name = 'provider_key'",
      )
      .get()?.count,
    1,
  );
  for (const index of [
    "uidx_generation_job_items_job_ordinal",
    "idx_generation_job_items_runnable",
    "idx_generation_job_items_provider_lease",
    "idx_generation_job_items_owner_lease",
  ]) {
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM pragma_index_list('generation_job_items') WHERE name = ?")
        .get(index)?.count,
      1,
    );
  }
  const providerLeaseIndex = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_generation_job_items_provider_lease'",
    )
    .get() as { sql?: string } | undefined;
  assert.match(providerLeaseIndex?.sql ?? "", /provider_key/u);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("runtime bootstrap does not pre-create migration-owned durable tables", () => {
  const runtimeDatabaseBootstrap = readFileSync("db/index.ts", "utf8");
  for (const table of ["generation_job_items", "generation_attempts", "users", "auth_sessions", "generation_quota_admissions"]) {
    assert.doesNotMatch(runtimeDatabaseBootstrap, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
  }
});

function migrationFilename(index: number): string {
  const prefix = `${String(index).padStart(4, "0")}_`;
  const filename = readdirSync("drizzle").find(
    (name) => name.startsWith(prefix) && name.endsWith(".sql"),
  );
  assert.ok(filename, `missing migration ${prefix}`);
  return filename;
}
