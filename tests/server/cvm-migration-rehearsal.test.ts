import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyNodeMigrations } from "../../lib/platform/node-d1";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

test("CVM migration rehearsal upgrades an offline 0016 backup and restores it without touching source data", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zaoshi-cvm-migration-")));
  t.after(async () => rm(root, { recursive: true }));
  const source = join(root, "source");
  const backup = join(root, "backup");
  const upgrade = join(root, "upgrade");
  const restore = join(root, "restore");
  const baselineMigrations = join(root, "migrations-0016");
  const sourceDbDirectory = join(source, "db");
  const sourceObjects = join(source, "objects");
  const sourceDatabase = join(sourceDbDirectory, "zaoshi.sqlite");
  await Promise.all([
    mkdir(sourceDbDirectory, { recursive: true, mode: 0o700 }),
    mkdir(sourceObjects, { recursive: true, mode: 0o700 }),
    mkdir(baselineMigrations, { mode: 0o700 }),
  ]);

  const migrationNames = (await readdir("drizzle"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const baselineNames = migrationNames.filter((name) => Number(name.slice(0, 4)) <= 16);
  assert.equal(baselineNames.length, 17);
  assert.equal(migrationNames.length, 36);
  assert.ok(migrationNames.includes("0026_email_auth.sql"));
  assert.equal(migrationNames.at(-1), "0035_referrals_and_generation_limits.sql");
  await Promise.all(baselineNames.map((name) => copyFile(
    join("drizzle", name),
    join(baselineMigrations, name),
  )));

  const legacy = new DatabaseSync(sourceDatabase);
  legacy.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL");
  applyNodeMigrations(legacy, baselineMigrations);
  const digest = createHash("sha256").update(PNG_BYTES).digest("hex");
  legacy.prepare(
    `INSERT INTO assets
      (id, owner_id, kind, status, original_file_name, mime_type, byte_size, sha256, storage_key)
     VALUES ('asset-legacy', 'owner-legacy', 'source', 'READY', 'legacy.png', 'image/png', ?, ?, 'uploads/legacy/input.png')`,
  ).run(PNG_BYTES.byteLength, digest);
  legacy.exec(
    `INSERT INTO generation_jobs
      (id, owner_id, source_asset_id, style_preset_id, lighting_preset,
       preservation_mode, provider_preference, output_count,
       idempotency_key, request_hash, status)
     VALUES ('job-legacy', 'owner-legacy', 'asset-legacy', 'modern', 'noon',
             'structure', 'doubao-seedream-4-5-251128', 1,
             'legacy-key', 'legacy-hash', 'QUEUED');
     INSERT INTO generation_job_items
      (id, job_id, owner_id, ordinal, provider_preference, provider_key, status)
     VALUES ('item-legacy', 'job-legacy', 'owner-legacy', 0,
             'doubao-seedream-4-5-251128', 'seedream', 'QUEUED');`,
  );
  legacy.close();
  await chmod(sourceDatabase, 0o600);

  const bucket = new NodeObjectBucket(sourceObjects);
  await bucket.put("uploads/legacy/input.png", PNG_BYTES, {
    customMetadata: { sha256: digest },
    httpMetadata: { contentType: "image/png" },
    onlyIf: { etagDoesNotMatch: "*" },
  });

  // Simulate a committed WAL left by an interrupted process. The child exits
  // without closing SQLite; no writer exists while the directory is copied.
  execFileSync(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1]);
     db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO studio_templates (id, owner_id, workflow_type, name, config_json) VALUES ('template-wal', 'owner-legacy', 'concept', 'WAL marker', '{}')");
     process.exit(0);`,
    sourceDatabase,
  ]);
  assert.ok((await stat(`${sourceDatabase}-wal`)).size > 0);
  assert.ok((await stat(`${sourceDatabase}-shm`)).size > 0);

  await cp(source, backup, { recursive: true, preserveTimestamps: true });
  assert.deepEqual(await manifest(source), await manifest(backup));
  await Promise.all([
    cp(backup, upgrade, { recursive: true, preserveTimestamps: true }),
    cp(backup, restore, { recursive: true, preserveTimestamps: true }),
  ]);
  assert.deepEqual(await manifest(backup), await manifest(upgrade));
  assert.deepEqual(await manifest(backup), await manifest(restore));

  const backupDatabase = new DatabaseSync(join(backup, "db", "zaoshi.sqlite"), { readOnly: true });
  backupDatabase.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
  assertDatabaseHealthy(backupDatabase);
  assert.equal(backupDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 17);
  assert.equal(backupDatabase.prepare("SELECT name FROM studio_templates WHERE id = 'template-wal'").get()?.name, "WAL marker");
  backupDatabase.close();

  const upgradedDatabase = new DatabaseSync(join(upgrade, "db", "zaoshi.sqlite"));
  upgradedDatabase.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  applyNodeMigrations(upgradedDatabase, join(process.cwd(), "drizzle"));
  assertDatabaseHealthy(upgradedDatabase);
  const applied = upgradedDatabase.prepare(
    "SELECT filename, sha256 FROM schema_migrations ORDER BY filename",
  ).all() as Array<{ filename: string; sha256: string }>;
  assert.deepEqual(applied.map((row) => ({ ...row })), await migrationChecksums(migrationNames));
  assert.equal(upgradedDatabase.prepare("SELECT owner_id FROM generation_jobs WHERE id = 'job-legacy'").get()?.owner_id, "owner-legacy");
  assert.equal(upgradedDatabase.prepare("SELECT space_type FROM generation_jobs WHERE id = 'job-legacy'").get()?.space_type, "unspecified");
  assert.equal(upgradedDatabase.prepare("SELECT provider_key FROM generation_job_items WHERE id = 'item-legacy'").get()?.provider_key, "seedream");
  const upgradedAsset = upgradedDatabase.prepare(
    "SELECT sha256, sanitization_version, retention_expires_at, moderation_status FROM assets WHERE id = 'asset-legacy'",
  ).get() as Record<string, unknown> | undefined;
  assert.equal(upgradedAsset?.sha256, digest);
  assert.equal(upgradedAsset?.sanitization_version, null);
  assert.ok(Number(upgradedAsset?.retention_expires_at ?? 0) > 0);
  assert.equal(upgradedAsset?.moderation_status, "UNREVIEWED");
  for (const table of ["users", "recharge_orders", "object_cleanup_tasks", "asset_deletion_events"]) {
    assert.equal(upgradedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table)?.count, 1);
  }
  assert.equal(upgradedDatabase.prepare("SELECT COUNT(*) AS count FROM users WHERE email_registration_receipt IS NOT NULL").get()?.count, 0);
  upgradedDatabase.close();
  await assertStoredObject(upgrade, digest);

  const restoredDatabase = new DatabaseSync(join(restore, "db", "zaoshi.sqlite"), { readOnly: true });
  restoredDatabase.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
  assertDatabaseHealthy(restoredDatabase);
  assert.equal(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 17);
  assert.equal(restoredDatabase.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'users'",
  ).get()?.count, 0);
  assert.equal(restoredDatabase.prepare("SELECT owner_id FROM assets WHERE id = 'asset-legacy'").get()?.owner_id, "owner-legacy");
  assert.equal(restoredDatabase.prepare("SELECT name FROM studio_templates WHERE id = 'template-wal'").get()?.name, "WAL marker");
  restoredDatabase.close();
  await assertStoredObject(restore, digest);
});

function assertDatabaseHealthy(database: DatabaseSync): void {
  assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
}

async function assertStoredObject(root: string, digest: string): Promise<void> {
  const object = await new NodeObjectBucket(join(root, "objects")).get("uploads/legacy/input.png");
  assert.ok(object);
  const bytes = new Uint8Array(await object.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  assert.equal(object.customMetadata?.sha256, digest);
}

async function migrationChecksums(names: string[]): Promise<Array<{ filename: string; sha256: string }>> {
  return Promise.all(names.map(async (filename) => ({
    filename,
    sha256: createHash("sha256").update(await readFile(join("drizzle", filename))).digest("hex"),
  })));
}

async function manifest(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push(`${relative(root, path)}:${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`);
      } else {
        assert.fail(`unexpected backup entry: ${relative(root, path)}`);
      }
    }
  }
  await walk(root);
  return files.sort();
}
