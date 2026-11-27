import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  DevBrainError,
  nowTimestamp,
  type BackupResult,
  type StorageHealth,
} from '@devbrain/contracts';
import { openDatabase, type SqlDriver } from './driver.js';
import { currentSchemaVersion, migrate, MIGRATIONS } from './migrations.js';

/**
 * File-level lifecycle of the local database: open with integrity check, recover from
 * corruption, automatic and manual backups.
 *
 * Layout (all under the app's userData directory, never inside a repository):
 *   devbrain.db (+ -wal, -shm)
 *   backups/devbrain-<timestamp>.db
 *   corrupt/devbrain-<timestamp>.db  (quarantined files, kept for manual inspection)
 */
export interface StorageOptions {
  /** Database file path. */
  file: string;
  /** Backups directory (default: `<dir>/backups`). */
  backupDir?: string;
  /** Number of automatic backups kept (oldest removed). */
  backupsToKeep?: number;
}

const stamp = (): string => nowTimestamp().replace(/[:.]/g, '-');

const sidecars = (file: string) => [file, `${file}-wal`, `${file}-shm`];

export const listBackups = (backupDir: string): string[] => {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => /^devbrain-.*\.db$/.test(f))
    .sort()
    .map((f) => path.join(backupDir, f));
};

export const backupDatabase = (
  driver: SqlDriver,
  backupDir: string,
  keep: number,
): BackupResult => {
  mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `devbrain-${stamp()}.db`);
  driver.backupTo(target);
  const backups = listBackups(backupDir);
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(old, { force: true });
  }
  return { path: target, bytes: statSync(target).size, createdAt: nowTimestamp() };
};

const quarantine = (file: string): void => {
  const dir = path.join(path.dirname(file), 'corrupt');
  mkdirSync(dir, { recursive: true });
  const id = stamp();
  for (const f of sidecars(file)) {
    if (existsSync(f)) renameSync(f, path.join(dir, `${path.basename(f)}.${id}`));
  }
};

const tryOpen = (file: string): SqlDriver | null => {
  let driver: SqlDriver | null = null;
  try {
    driver = openDatabase({ location: file });
    if (!driver.quickCheck()) throw new Error('quick_check failed');
    currentSchemaVersion(driver);
    return driver;
  } catch {
    driver?.close();
    return null;
  }
};

export interface OpenedStorage {
  driver: SqlDriver;
  integrity: StorageHealth['integrity'];
  appliedMigrations: number[];
}

/**
 * Opens the database, verifying integrity. On corruption the files are quarantined and the
 * newest valid backup is restored; without a usable backup a fresh database is created.
 * Before applying migrations to an existing database a backup is taken automatically.
 */
export const openStorage = (options: StorageOptions): OpenedStorage => {
  const backupDir = options.backupDir ?? path.join(path.dirname(options.file), 'backups');
  const keep = options.backupsToKeep ?? 5;
  mkdirSync(path.dirname(options.file), { recursive: true });

  let integrity: StorageHealth['integrity'] = 'ok';
  let driver = existsSync(options.file)
    ? tryOpen(options.file)
    : openDatabase({ location: options.file });

  if (!driver) {
    quarantine(options.file);
    for (const backup of listBackups(backupDir).reverse()) {
      copyFileSync(backup, options.file);
      driver = tryOpen(options.file);
      if (driver) {
        integrity = 'recovered-from-backup';
        break;
      }
      quarantine(options.file);
    }
    if (!driver) {
      driver = openDatabase({ location: options.file });
      integrity = 'recreated';
    }
  }

  try {
    const version = currentSchemaVersion(driver);
    const latest = Math.max(...MIGRATIONS.map((m) => m.id));
    if (version > 0 && version < latest) backupDatabase(driver, backupDir, keep);
    const appliedMigrations = migrate(driver);
    return { driver, integrity, appliedMigrations };
  } catch (error) {
    driver.close();
    throw DevBrainError.is(error)
      ? error
      : new DevBrainError('STORAGE_ERROR', 'Failed to prepare database');
  }
};
