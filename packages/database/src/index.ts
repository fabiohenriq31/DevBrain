import { openDatabase, type OpenOptions, type SqlDriver } from './driver.js';
import { migrate } from './migrations.js';
import {
  ProjectRepository,
  SqliteAuditLog,
  SqliteCheckpointStore,
  SqliteExecutionHistory,
  SqliteSettingsStore,
  WorkspaceRepository,
} from './repositories.js';

export * from './driver.js';
export * from './migrations.js';
export * from './repositories.js';

export interface DevBrainDatabase {
  driver: SqlDriver;
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  audit: SqliteAuditLog;
  settings: SqliteSettingsStore;
  executions: SqliteExecutionHistory;
  checkpoints: SqliteCheckpointStore;
  close(): void;
}

/** Opens the database, applies pending migrations and wires repositories. */
export const createDatabase = (options: OpenOptions): DevBrainDatabase => {
  const driver = openDatabase(options);
  try {
    migrate(driver);
  } catch (error) {
    driver.close();
    throw error;
  }
  return {
    driver,
    projects: new ProjectRepository(driver),
    workspaces: new WorkspaceRepository(driver),
    audit: new SqliteAuditLog(driver),
    settings: new SqliteSettingsStore(driver),
    executions: new SqliteExecutionHistory(driver),
    checkpoints: new SqliteCheckpointStore(driver),
    close: () => driver.close(),
  };
};
