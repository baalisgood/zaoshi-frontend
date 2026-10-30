import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { parseCreateJobInput } from "../../lib/server/job-contract";

test("0008 is split into one executable SQL statement per Drizzle migration chunk", () => {
  const migration = readMigrationFiles({ migrationsFolder: "drizzle" }).find((entry) => entry.sql.some((chunk) => chunk.includes("generation_jobs_new")));
  assert.ok(migration);
  assert.equal(migration.sql.length, 20);
  assert.equal(migration.bps, true);
  for (const chunk of migration.sql) {
    const executableSql = chunk.replace(/--[^\n]*/gu, "").trim();
    assert.equal((executableSql.match(/;/gu) ?? []).length, 1, `chunk must contain one SQL statement: ${chunk}`);
  }
  assert.match(migration.sql[0], /PRAGMA defer_foreign_keys=ON;/u);
  assert.match(migration.sql.at(-1) ?? "", /PRAGMA defer_foreign_keys=OFF;/u);
});

test("0008 preserves jobs and outputs while allowing a null source", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  for (let index = 0; index <= 7; index += 1) {
    const filename = readdirSync("drizzle").find((name) => name.startsWith(`${String(index).padStart(4, "0")}_`) && name.endsWith(".sql"));
    assert.ok(filename);
    database.exec(readFileSync(`drizzle/${filename}`, "utf8"));
  }
  database.exec(`
    INSERT INTO assets (id, owner_id, kind, original_file_name, mime_type, byte_size, sha256, storage_key)
    VALUES ('asset-source', 'owner', 'source', 'room.png', 'image/png', 8, 'hash-source', 'source-key'),
           ('asset-output', 'owner', 'output', 'result.png', 'image/png', 8, 'hash-output', 'output-key');
    INSERT INTO generation_jobs (id, owner_id, source_asset_id, style_preset_id, lighting_preset, preservation_mode, provider_preference, output_count, idempotency_key, request_hash)
    VALUES ('job-1', 'owner', 'asset-source', 'modern-minimalist', 'noon', 'structure', 'doubao-seedream-5-0-pro-260628', 1, 'migration-key', 'migration-hash');
    INSERT INTO generation_job_outputs (job_id, asset_id, ordinal) VALUES ('job-1', 'asset-output', 0);
  `);
  const migration = readMigrationFiles({ migrationsFolder: "drizzle" }).find((entry) => entry.sql.some((chunk) => chunk.includes("generation_jobs_new")));
  assert.ok(migration);
  database.exec("BEGIN;");
  try {
    for (const statement of migration.sql) database.exec(statement);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }

  assert.equal(database.prepare("SELECT count(*) AS count FROM generation_jobs WHERE id = 'job-1'").get()?.count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM generation_job_outputs WHERE job_id = 'job-1' AND asset_id = 'asset-output'").get()?.count, 1);
  assert.equal(database.prepare("SELECT \"notnull\" AS nullable_flag FROM pragma_table_info('generation_jobs') WHERE name = 'source_asset_id'").get()?.nullable_flag, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_index_list('generation_jobs') WHERE name = 'uidx_generation_jobs_owner_idempotency'").get()?.count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_index_list('generation_job_outputs') WHERE name = 'uidx_generation_job_outputs_asset'").get()?.count, 1);
  assert.equal(database.prepare("SELECT \"table\" AS target FROM pragma_foreign_key_list('generation_job_outputs') WHERE \"from\" = 'job_id'").get()?.target, "generation_jobs");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.prepare("INSERT INTO generation_jobs (id, owner_id, source_asset_id, style_preset_id, lighting_preset, preservation_mode, provider_preference, output_count, idempotency_key, request_hash) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)").run("job-self", "owner", "self-service", "noon", "structure", "doubao-seedream-5-0-pro-260628", 1, "self-key", "self-hash");
  assert.equal(database.prepare("SELECT source_asset_id FROM generation_jobs WHERE id = 'job-self'").get()?.source_asset_id, null);
  assert.throws(() => parseCreateJobInput({ workflowType: "concept", sourceAssetId: null, stylePresetId: "modern-minimalist", lightingPreset: "noon", preservationMode: "structure", providerPreference: "doubao-seedream-5-0-pro-260628", outputCount: 1, idempotencyKey: "non-self-null" }), /sourceAssetId/u);
});
