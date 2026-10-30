import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATION_NAME = /^\d{4}_.+\.sql$/u;

class NodeD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new NodeD1PreparedStatement(
      this.database,
      this.sql,
      values as SQLInputValue[],
    );
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.values) as T[];
      return { success: true, results, meta: { changes: results.length } };
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sql).all(...this.values) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async raw<T = unknown>(): Promise<T[]> {
    const rows = this.database.prepare(this.sql).all(...this.values) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => Object.values(row)) as T[];
  }

  execute<T = unknown>(): D1Result<T> {
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.values) as T[];
      return { success: true, results, meta: { changes: results.length } };
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

export class NodeD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new NodeD1PreparedStatement(this.database, sql);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof NodeD1PreparedStatement)) {
          throw new Error("Node SQLite received an incompatible statement");
        }
        return statement.execute<T>();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<D1Result> {
    this.database.exec(sql);
    return { success: true, meta: { changes: 0 } };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("SQLite dump is not exposed through the application runtime");
  }
}

export function openNodeD1Database(options: {
  databasePath: string;
  migrationsDirectory: string;
}): D1Database {
  const databasePath = safeAbsoluteFilePath(options.databasePath);
  const parent = dirname(databasePath);
  ensurePrivateDirectory(parent);
  ensurePrivateDatabaseFile(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA synchronous=FULL");
  applyNodeMigrations(database, options.migrationsDirectory);
  return new NodeD1Database(database);
}

function ensurePrivateDatabaseFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe SQLite database file: ${path}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("SQLite database file must be owned by the runtime user");
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("SQLite database file permissions must be 0600");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

export function applyNodeMigrations(
  database: DatabaseSync,
  migrationsDirectory: string,
): void {
  const directory = resolve(migrationsDirectory);
  if (!isAbsolute(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error("ZAOSHI_MIGRATIONS_DIR must be an existing directory");
  }
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const files = readdirSync(directory).filter((name) => MIGRATION_NAME.test(name)).sort();
  for (const filename of files) {
    const body = readFileSync(join(directory, filename), "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const existing = database
      .prepare("SELECT sha256 FROM schema_migrations WHERE filename = ?")
      .get(filename) as { sha256: string } | undefined;
    if (existing) {
      if (existing.sha256 !== sha256) {
        throw new Error(`Migration checksum mismatch: ${filename}`);
      }
      continue;
    }

    const statements = body
      .split(/\s*--> statement-breakpoint\s*/u)
      .map((statement) => statement.trim())
      .filter(Boolean);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) database.exec(statement);
      database
        .prepare("INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)")
        .run(filename, sha256);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const violation = database.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("SQLite foreign key integrity check failed");
}

function safeAbsoluteFilePath(value: string): string {
  const path = resolve(value);
  if (!isAbsolute(value) || path === "/") {
    throw new Error("ZAOSHI_SQLITE_PATH must be an absolute file path");
  }
  return path;
}

function ensurePrivateDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe SQLite directory: ${path}`);
    }
    assertPrivateOwnerAndMode(stat, "SQLite directory", 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const verified = lstatSync(path);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error(`Unsafe SQLite directory: ${path}`);
  }
  assertPrivateOwnerAndMode(verified, "SQLite directory", 0o700);
  if (realpathSync(path) !== resolve(path)) {
    throw new Error(`SQLite directory must not resolve through a symlink: ${path}`);
  }
}

function assertPrivateOwnerAndMode(
  stat: Stats,
  label: string,
  requiredMode: number,
): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the runtime user`);
  }
  if ((stat.mode & 0o777) !== requiredMode) {
    throw new Error(`${label} permissions must be ${requiredMode.toString(8)}`);
  }
}
