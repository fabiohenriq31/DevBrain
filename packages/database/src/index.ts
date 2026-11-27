import path from 'node:path';
import { openDatabase, type OpenOptions, type SqlDriver } from './driver.js';
import { migrate } from './migrations.js';
import { CredentialRefRepository, SqliteCiphertextStore } from './repositories/credentials.js';
import { AgentRepository, PolicyRepository, ProviderRepository } from './repositories/providers.js';
import { ApprovalRepository, GrantRepository } from './repositories/permissions.js';
import {
  ProjectRepository,
  ProjectSettingsRepository,
  WorkspaceRepository,
} from './repositories/projects.js';
import {
  SessionFileRepository,
  SessionRepository,
  SqliteCheckpointStore,
  SqliteExecutionHistory,
} from './repositories/sessions.js';
import {
  AppRunRepository,
  MaintenanceStateRepository,
  SqliteAuditLog,
  SqliteSettingsStore,
  UsageRepository,
} from './repositories/system.js';
import { openStorage, type StorageOptions } from './storage.js';
import type { StorageHealth } from '@devbrain/contracts';

export * from './driver.js';
export * from './migrations.js';
export * from './storage.js';
export * from './repositories/common.js';
export * from './repositories/credentials.js';
export * from './repositories/providers.js';
export * from './repositories/permissions.js';
export * from './repositories/projects.js';
export * from './repositories/sessions.js';
export * from './repositories/system.js';

export interface DevBrainDatabase {
  driver: SqlDriver;
  /** Directory for automatic/manual backups; null for in-memory databases. */
  backupDir: string | null;
  integrity: StorageHealth['integrity'];
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  projectSettings: ProjectSettingsRepository;
  providers: ProviderRepository;
  agents: AgentRepository;
  policies: PolicyRepository;
  credentials: CredentialRefRepository;
  secrets: SqliteCiphertextStore;
  sessions: SessionRepository;
  sessionFiles: SessionFileRepository;
  executions: SqliteExecutionHistory;
  checkpoints: SqliteCheckpointStore;
  approvals: ApprovalRepository;
  grants: GrantRepository;
  usage: UsageRepository;
  audit: SqliteAuditLog;
  settings: SqliteSettingsStore;
  runs: AppRunRepository;
  maintenance: MaintenanceStateRepository;
  close(): void;
}

const wire = (
  driver: SqlDriver,
  backupDir: string | null,
  integrity: StorageHealth['integrity'],
): DevBrainDatabase => ({
  driver,
  backupDir,
  integrity,
  projects: new ProjectRepository(driver),
  workspaces: new WorkspaceRepository(driver),
  projectSettings: new ProjectSettingsRepository(driver),
  providers: new ProviderRepository(driver),
  agents: new AgentRepository(driver),
  policies: new PolicyRepository(driver),
  credentials: new CredentialRefRepository(driver),
  secrets: new SqliteCiphertextStore(driver),
  sessions: new SessionRepository(driver),
  sessionFiles: new SessionFileRepository(driver),
  executions: new SqliteExecutionHistory(driver),
  checkpoints: new SqliteCheckpointStore(driver),
  approvals: new ApprovalRepository(driver),
  grants: new GrantRepository(driver),
  usage: new UsageRepository(driver),
  audit: new SqliteAuditLog(driver),
  settings: new SqliteSettingsStore(driver),
  runs: new AppRunRepository(driver),
  maintenance: new MaintenanceStateRepository(driver),
  close: () => driver.close(),
});

/**
 * Opens the database and wires repositories.
 * - `:memory:` → ephemeral (tests).
 * - file path → integrity check, crash/corruption recovery, auto-backup before migrations.
 */
export const createDatabase = (
  options: OpenOptions & Partial<StorageOptions>,
): DevBrainDatabase => {
  if (options.location === ':memory:') {
    const driver = openDatabase(options);
    try {
      migrate(driver);
    } catch (error) {
      driver.close();
      throw error;
    }
    return wire(driver, null, 'ok');
  }
  const backupDir = options.backupDir ?? path.join(path.dirname(options.location), 'backups');
  const opened = openStorage({
    file: options.location,
    backupDir,
    ...(options.backupsToKeep !== undefined ? { backupsToKeep: options.backupsToKeep } : {}),
  });
  return wire(opened.driver, backupDir, opened.integrity);
};
