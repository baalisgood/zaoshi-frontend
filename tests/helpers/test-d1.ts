import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const TEST_GENERATION_BILLING = {
  amountPerItem: 1,
  priceVersion: "test-v1",
} as const;

export function creditTestOwner(database: DatabaseSync, ownerId: string, amount = 100): void {
  database.prepare(
    `INSERT OR IGNORE INTO credit_ledger_entries
      (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
     VALUES (?, ?, 'CREDIT', ?, ?, 'TEST_CREDIT', 'test', ?)`,
  ).run(
    `ledger_credit_${ownerId.replace(/[^A-Za-z0-9_-]/gu, "_")}`,
    ownerId,
    amount,
    `credit:test:${ownerId}`,
    `test:${ownerId}`,
  );
}

export function applyMigrations(
  database: DatabaseSync,
  maximumIndex = Number.POSITIVE_INFINITY,
): void {
  const migrations = readdirSync("drizzle")
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const filename of migrations) {
    const index = Number(filename.slice(0, 4));
    if (index <= maximumIndex) {
      database.exec(readFileSync(`drizzle/${filename}`, "utf8"));
    }
  }
}

export class TestD1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): TestD1PreparedStatement {
    return new TestD1PreparedStatement(
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
    return this.execute<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.sql).all(...this.values) as T[];
    return { success: true, results: rows, meta: { changes: 0 } };
  }

  async raw<T = unknown>(): Promise<T[]> {
    const statement = this.database.prepare(this.sql);
    const columns = statement.columns().map((column) => column.name);
    return statement.all(...this.values).map((row) => columns.map((column) => (row as Record<string, unknown>)[column])) as T[];
  }

  execute<T = unknown>(): D1Result<T> {
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const rows = this.database.prepare(this.sql).all(...this.values) as T[];
      return { success: true, results: rows, meta: { changes: rows.length } };
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  sqlText(): string {
    return this.sql;
  }
}

export class TestD1Database {
  constructor(
    private readonly database: DatabaseSync,
    private readonly beforeBatchStatement?: (
      statement: TestD1PreparedStatement,
      index: number,
    ) => void,
  ) {}

  prepare(sql: string): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch<T = unknown>(
    statements: TestD1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const results = statements.map((statement, index) => {
        this.beforeBatchStatement?.(statement, index);
        return statement.execute<T>();
      });
      this.database.exec("COMMIT;");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async exec(sql: string): Promise<D1Result> {
    this.database.exec(sql);
    return { success: true, meta: { changes: 0 } };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("not implemented in test adapter");
  }
}
