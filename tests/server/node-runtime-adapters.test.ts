import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NodeD1Database, openNodeD1Database } from "../../lib/platform/node-d1";
import { NodeObjectBucket } from "../../lib/platform/node-object-store";

test("Node D1 adapter applies the immutable migration set and batches atomically", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-d1-")),
  );
  const databasePath = join(root, "zaoshi.sqlite");
  const d1 = openNodeD1Database({
    databasePath,
    migrationsDirectory: join(process.cwd(), "drizzle"),
  });
  const migrations = await d1
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .first<{ count: number }>();
  assert.equal(migrations?.count, (await readdir("drizzle")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).length);
  assert.ok(await d1.prepare("SELECT 1 FROM schema_migrations WHERE filename = '0026_email_auth.sql'").first());
  for (const name of ["auth_email_credentials", "auth_email_challenges", "auth_email_rate_limits"]) {
    assert.ok(await d1.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").bind(name).first());
  }
  assert.ok(await d1.prepare("SELECT 1 AS present FROM pragma_table_info('generation_jobs') WHERE name = 'space_type'").first());
  assert.ok(await d1.prepare("SELECT 1 AS present FROM pragma_table_info('generation_jobs') WHERE name = 'design_scheme_id'").first());
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'generation_output_commits'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'generation_reconciliation_cases'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'generation_queue_admin_actions'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'generation_dead_letter_entries'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'auth_sessions'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'generation_quota_admissions'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'recharge_orders'")
      .first(),
  );
  assert.ok(
    await d1
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'site_page_views'")
      .first(),
  );

  await d1.batch([
    d1.prepare("INSERT INTO generation_internal_nonces (nonce_hash, key_id, expires_at) VALUES (?, ?, ?)").bind("one", "key", 1),
    d1.prepare("INSERT INTO generation_internal_nonces (nonce_hash, key_id, expires_at) VALUES (?, ?, ?)").bind("two", "key", 1),
  ]);
  assert.equal(
    await d1.prepare("SELECT COUNT(*) FROM generation_internal_nonces").first<number>("COUNT(*)"),
    2,
  );
});

test("Node D1 batch rolls back every statement after a conflict", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE values_table (id TEXT PRIMARY KEY)");
  const d1 = new NodeD1Database(database);
  await assert.rejects(
    d1.batch([
      d1.prepare("INSERT INTO values_table (id) VALUES (?)").bind("same"),
      d1.prepare("INSERT INTO values_table (id) VALUES (?)").bind("same"),
    ]),
  );
  assert.equal(
    await d1.prepare("SELECT COUNT(*) FROM values_table").first<number>("COUNT(*)"),
    0,
  );
});

test("Node D1 adapter rejects symlinked or broadly readable database files", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-d1-unsafe-")),
  );
  const target = join(root, "target.sqlite");
  await writeFile(target, "", { mode: 0o600 });
  const link = join(root, "linked.sqlite");
  await symlink(target, link);
  assert.throws(
    () =>
      openNodeD1Database({
        databasePath: link,
        migrationsDirectory: join(process.cwd(), "drizzle"),
      }),
    /Unsafe SQLite database file/u,
  );

  const broad = join(root, "broad.sqlite");
  await writeFile(broad, "", { mode: 0o600 });
  await chmod(broad, 0o644);
  assert.throws(
    () =>
      openNodeD1Database({
        databasePath: broad,
        migrationsDirectory: join(process.cwd(), "drizzle"),
      }),
    /permissions must be 0600/u,
  );

  const broadDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-d1-broad-dir-")),
  );
  await chmod(broadDirectory, 0o755);
  assert.throws(
    () =>
      openNodeD1Database({
        databasePath: join(broadDirectory, "zaoshi.sqlite"),
        migrationsDirectory: join(process.cwd(), "drizzle"),
      }),
    /SQLite directory permissions must be 700/u,
  );
});

test("Node object bucket persists metadata and rejects overwrite and traversal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-objects-")),
  );
  const bucket = new NodeObjectBucket(root);
  const bytes = new TextEncoder().encode("zaoshi");
  const stored = await bucket.put("uploads/session:owner/image.png", bytes, {
    customMetadata: { sha256: "demo" },
    httpMetadata: { contentType: "image/png" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  assert.ok(stored);
  assert.equal(
    await bucket.put("uploads/session:owner/image.png", bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
    null,
  );
  const object = await bucket.get("uploads/session:owner/image.png");
  assert.ok(object);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  assert.equal(object.httpMetadata?.contentType, "image/png");
  assert.equal(object.customMetadata?.sha256, "demo");
  await chmod(join(root, "data", "uploads", "session:owner", "image.png"), 0o644);
  await assert.rejects(
    bucket.get("uploads/session:owner/image.png"),
    /Object data file permissions must be 600/u,
  );
  await chmod(join(root, "data", "uploads", "session:owner", "image.png"), 0o600);
  const concurrent = await Promise.all([
    bucket.put("uploads/session:owner/concurrent.png", bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
    bucket.put("uploads/session:owner/concurrent.png", bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1);
  await assert.rejects(bucket.get("../escape"));
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-outside-")),
  );
  await mkdir(join(root, "data", "unsafe"), { recursive: true, mode: 0o700 });
  await symlink(outside, join(root, "data", "unsafe", "link"));
  await assert.rejects(bucket.get("unsafe/link/image.png"), /Unsafe object storage directory/u);
  await bucket.delete("uploads/session:owner/image.png");
  assert.equal(await bucket.get("uploads/session:owner/image.png"), null);

  const dataRoot = join(root, "data");
  assert.equal((await stat(dataRoot)).isDirectory(), true);
  await readFile(join(root, "metadata", "uploads", "session:owner", "image.png.json")).then(
    () => assert.fail("metadata should have been deleted"),
    (error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
  );
});

test("Node object bucket rejects a broadly accessible storage root", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zaoshi-node-objects-broad-")),
  );
  await chmod(root, 0o755);
  const bucket = new NodeObjectBucket(root);
  await assert.rejects(
    bucket.put("uploads/demo/image.png", new Uint8Array([1])),
    /Object storage directory permissions must be 700/u,
  );
});
