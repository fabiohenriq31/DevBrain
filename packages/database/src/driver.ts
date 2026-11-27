import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal synchronous SQL driver. Repositories depend on this interface only, so the
 * backing implementation can switch (node:sqlite today; better-sqlite3 if ever required —
 * see ADR-0004 in docs/DECISIONS.md) without touching repository code.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue>;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number };
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** File path, or `:memory:`. */
  location: string;
  readOnly?: boolean;
}

class NodeSqliteDriver implements SqlDriver {
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParams = {}): { changes: number } {
    const result = this.db.prepare(sql).run(params);
    return { changes: Number(result.changes) };
  }

  get<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = {}): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  all<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = {}): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      this.db.exec(
        this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Opens a database with safe defaults (WAL, foreign keys, busy timeout). */
export const openDatabase = (options: OpenOptions): SqlDriver => {
  const db = new DatabaseSync(options.location, {
    readOnly: options.readOnly ?? false,
    enableForeignKeyConstraints: true,
  });
  const driver = new NodeSqliteDriver(db);
  if (options.location !== ':memory:' && !options.readOnly)
    driver.exec('PRAGMA journal_mode = WAL;');
  driver.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return driver;
};
