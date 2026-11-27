import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  CONTRACTS_VERSION,
  IPC_CHANNELS,
  dispatchIpc,
  ipcChannelName,
  type IpcChannelKey,
  type IpcHandlerMap,
} from '@devbrain/contracts';
import type { DevBrainDatabase } from '@devbrain/database';
import { LocalProjectService } from '@devbrain/project-engine';
import { isTrustedRendererUrl } from './security.js';

export interface MainServices {
  db: DevBrainDatabase | null;
  devServerUrl: string | undefined;
}

/**
 * Handlers implemented in the foundation. Channels without a handler answer `UNSUPPORTED`
 * (honestly reported, never simulated) until their owner implements them.
 */
export const createHandlers = ({ db }: MainServices): IpcHandlerMap => {
  const projects = db ? new LocalProjectService(db) : null;
  const requireDb = <T>(value: T | null): T => {
    if (value === null) throw new Error('Database unavailable');
    return value;
  };

  return {
    'system.getInfo': () => ({
      appVersion: app.getVersion(),
      contractsVersion: CONTRACTS_VERSION,
      platform:
        process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32',
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.versions.node,
      dataDirectoryConfigured: db !== null,
    }),
    'projects.list': (input) => requireDb(projects).list(input),
    'projects.get': (input) => requireDb(projects).get(input.id),
    'projects.register': (input) =>
      requireDb(projects).register({
        rootPath: input.rootPath,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      }),
    'projects.update': (input) =>
      requireDb(projects).update({
        id: input.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      }),
    'projects.archive': (input) => requireDb(projects).archive(input.id),
    'projects.pickDirectory': async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { properties: ['openDirectory' as const], title: 'Selecionar projeto' };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'settings.get': () => requireDb(db).settings.get(),
    'settings.update': (input) => requireDb(db).settings.update(input),
    'audit.list': (input) =>
      requireDb(db).audit.list({
        limit: input.limit,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
  };
};

/** Rejects IPC from any frame that is not the app's own top-level renderer. */
const isTrustedSender = (event: IpcMainInvokeEvent, devServerUrl: string | undefined): boolean => {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isTrustedRendererUrl(frame.url, devServerUrl);
};

export const registerIpc = (services: MainServices): void => {
  const handlers = createHandlers(services);
  for (const key of Object.keys(IPC_CHANNELS) as IpcChannelKey[]) {
    ipcMain.handle(ipcChannelName(key), async (event, envelope: unknown) => {
      if (!isTrustedSender(event, services.devServerUrl)) {
        return {
          ok: false,
          correlationId: 'untrusted-sender',
          error: { code: 'PERMISSION_DENIED', message: 'Untrusted IPC sender', retryable: false },
        };
      }
      return dispatchIpc(key, envelope, handlers[key] as never);
    });
  }
};
