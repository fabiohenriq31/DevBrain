import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, app, safeStorage } from 'electron';
import { ipcEventName, type IpcEventKey } from '@devbrain/contracts';
import { createCoreServices, type CoreServices } from '@devbrain/core';
import { RotatingFileLogger, type Logger } from '@devbrain/security';

/**
 * Boots DevBrain Core in the main process. Everything private lives under userData
 * (%APPDATA%\DevBrain AI on Windows), never inside a repository:
 *   devbrain.db, backups/, corrupt/, logs/
 * Secrets are encrypted with Electron safeStorage (DPAPI on Windows).
 */
export interface StartedCore {
  core: CoreServices | null;
  logger: Logger;
  /** Reason when the core could not start (shown by system.getInfo / storageHealth). */
  failure: string | null;
}

const FORWARDED_EVENTS: readonly IpcEventKey[] = [
  'approval.requested',
  'approval.decided',
  'projects.changed',
  'sessions.changed',
  'providers.changed',
];

export const startCore = (): StartedCore => {
  const userData = app.getPath('userData');
  const logger: Logger = new RotatingFileLogger({
    directory: join(userData, 'logs'),
    maxFileBytes: 5 * 1024 * 1024,
    maxFiles: 5,
  }).child('main');
  try {
    const core = createCoreServices({
      databaseFile: join(userData, 'devbrain.db'),
      backupDir: join(userData, 'backups'),
      cipher: safeStorage,
      instanceId: `run_${randomUUID()}`,
      appVersion: app.getVersion(),
      logger,
      protectedPaths: [userData],
    });
    for (const key of FORWARDED_EVENTS) {
      core.events.on(key, (payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(ipcEventName(key), payload);
        }
      });
    }
    core.startBackgroundTasks();
    logger.log('info', 'Core started', { ...core.recovery, integrity: core.db.integrity });
    return { core, logger, failure: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.log('error', 'Core failed to start', { error: message });
    return { core: null, logger, failure: message };
  }
};
