import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DevBrainError } from '@devbrain/contracts';

/**
 * Minimal synchronous SQL driver. Repositories depend on this interface only, so the
 * backing implementation can switch (node:sqlite today; better-sqlite3 if ever required —
 * see ADR-0004 in docs/DECISIONS.md) without touching repository code.
 *
 * Every SQLite error leaving the driver is a `DevBrainError` (see `mapSqliteError`); errors
 * thrown by application code inside `transaction` propagate unchanged after rollback.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue>;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDriver {
  readonly location: string;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number };
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[];
  /** Nested calls use savepoints. Top-level uses BEGIN IMMEDIATE (single writer). */
  transaction<T>(fn: () => T): T;
  /** Consistent online copy (`VACUUM INTO`). Target must not exist. */
  backupTo(targetPath: string): void;
  /** `PRAGMA quick_check` — true when the database is structurally sound. */
  quickCheck(): boolean;
  close(): void;
}

export interface OpenOptions {
  /** File path, or `:memory:`. */
  location: string;
  readOnly?: boolean;
  /** Milliseconds to wait on a locked database before failing (default 5000). */
  busyTimeoutMs?: number;
}

// SQLite primary result codes (https://www.sqlite.org/rescode.html).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CONSTRAINT = 19;
const SQLITE_NOTADB = 26;
// Extended constraint codes.
const CONSTRAINT_FOREIGNKEY = 787;
const CONSTRAINT_TRIGGER = 1811;
const CONSTRAINT_PRIMARYKEY = 1555;
const CONSTRAINT_UNIQUE = 2067;

interface SqliteErrorLike {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

/** Translates node:sqlite errors to stable DevBrain error codes (no raw SQL in messages). */
export const mapSqliteError = (error: unknown): DevBrainError => {
  if (DevBrainError.is(error)) return error;
  const e = (error ?? {}) as SqliteErrorLike;
  const message = typeof e.message === 'string' ? e.message : String(error);
  const errcode = typeof e.errcode === 'number' ? e.errcode : -1;
  const primary = errcode & 0xff;
  const details = { sqlite: message.slice(0, 300), errcode };

  if (primary === SQLITE_CONSTRAINT) {
    if (errcode === CONSTRAINT_UNIQUE || errcode === CONSTRAINT_PRIMARYKEY) {
      return new DevBrainError('ALREADY_EXISTS', 'Record already exists', { details });
    }
    if (errcode === CONSTRAINT_FOREIGNKEY) {
      return new DevBrainError('CONFLICT', 'Referenced record is missing or still in use', {
        details,
      });
    }
    if (errcode === CONSTRAINT_TRIGGER) {
      return new DevBrainError('PERMISSION_DENIED', 'Operation rejected by a database rule', {
        details,
      });
    }
    return new DevBrainError('VALIDATION_FAILED', 'Database constraint violated', { details });
  }
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
    return new DevBrainError('STORAGE_ERROR', 'Database is busy', { details, retryable: true });
  }
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) {
    return new DevBrainError('STORAGE_ERROR', 'Database file is corrupt', { details });
  }
  if (primary === SQLITE_FULL) {
    return new DevBrainError('STORAGE_ERROR', 'Disk is full', { details });
  }
  if (primary === SQLITE_READONLY || primary === SQLITE_IOERR) {
    return new DevBrainError('STORAGE_ERROR', 'Database I/O failure', { details });
  }
  if (e.code === 'ERR_SQLITE_ERROR' || /sqlite|SQL/.test(message)) {
    return new DevBrainError('STORAGE_ERROR', 'Database error', { details });
  }
  return new DevBrainError('INTERNAL', 'Unexpected storage failure', { details, cause: error });
};

/** Errors raised by node:sqlite (as opposed to application errors thrown inside a transaction). */
const isSqliteError = (error: unknown): boolean => {
  const e = error as SqliteErrorLike | null;
  return (
    typeof e?.errcode === 'number' || (e as { code?: unknown } | null)?.code === 'ERR_SQLITE_ERROR'
  );
};

const isBusy = (error: unknown): boolean => {
  const code = (error as SqliteErrorLike)?.errcode;
  return (
    typeof code === 'number' && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)
  );
};

class NodeSqliteDriver implements SqlDriver {
  private depth = 0;
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    readonly location: string,
  ) {}

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  exec(sql: string): void {
    this.guard(() => this.db.exec(sql));
  }

  run(sql: string, params: SqlParams = {}): { changes: number; lastInsertRowid: number } {
    return this.guard(() => {
      const result = this.statement(sql).run(params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    });
  }

  get<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = {}): T | undefined {
    return this.guard(() => this.statement(sql).get(params) as T | undefined);
  }

  all<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = {}): T[] {
    return this.guard(() => this.statement(sql).all(params) as T[]);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const savepoint = `sp_${this.depth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.depth += 1;
      try {
        const result = fn();
        this.depth -= 1;
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.depth -= 1;
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw isSqliteError(error) ? mapSqliteError(error) : error;
      }
    }
    // busy_timeout already waits; retry a few times for writers racing on BEGIN IMMEDIATE.
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (!isBusy(error) || attempt >= 3) throw mapSqliteError(error);
      }
    }
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.depth = 0;
      return result;
    } catch (error) {
      this.depth = 0;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite (e.g. constraint at COMMIT)
      }
      // Application errors propagate unchanged; only SQLite failures are translated.
      throw isSqliteError(error) ? mapSqliteError(error) : error;
    }
  }

  backupTo(targetPath: string): void {
    const literal = `'${targetPath.replace(/'/g, "''")}'`;
    this.guard(() => this.db.exec(`VACUUM INTO ${literal}`));
  }

  quickCheck(): boolean {
    try {
      const rows = this.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      return rows.length === 1 && rows[0]?.quick_check === 'ok';
    } catch {
      return false;
    }
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}

/** Opens a database with safe defaults (WAL, foreign keys, busy timeout, synchronous=NORMAL). */
export const openDatabase = (options: OpenOptions): SqlDriver => {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.location, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
    });
  } catch (error) {
    throw mapSqliteError(error);
  }
  const driver = new NodeSqliteDriver(db, options.location);
  try {
    driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))};`);
    if (options.location !== ':memory:' && !options.readOnly) {
      // WAL survives crashes (committed transactions are durable; partial ones are discarded).
      driver.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    driver.exec('PRAGMA foreign_keys = ON;');
  } catch (error) {
    driver.close();
    throw error;
  }
  return driver;
};
