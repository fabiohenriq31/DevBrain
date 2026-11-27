import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  CONTRACTS_VERSION,
  DevBrainError,
  IPC_CHANNELS,
  dispatchIpc,
  ipcChannelName,
  type IpcChannelKey,
  type IpcHandlerMap,
} from '@devbrain/contracts';
import type { CoreServices } from '@devbrain/core';
import type { OperationalExecutionService } from '@devbrain/execution-engine';
import { isTrustedRendererUrl } from './security.js';

export interface MainServices {
  core: CoreServices | null;
  engine?: OperationalExecutionService | null;
  devServerUrl: string | undefined;
}

/** Drops keys whose value is `undefined` (zod output vs. exactOptionalPropertyTypes). */
const defined = <T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;

const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

/**
 * IPC handlers. Channels owned by the execution engine (Codex) — adapters, dependency checks,
 * executions — have no handler yet and answer `UNSUPPORTED` (honestly reported, never
 * simulated) until their owner implements them.
 */
export const createHandlers = ({ core, engine }: MainServices): IpcHandlerMap => {
  const c = (): CoreServices => {
    if (!core)
      throw new DevBrainError(
        'STORAGE_ERROR',
        'DevBrain Core is not available (database failed to open)',
      );
    return core;
  };
  const e = (): OperationalExecutionService => {
    if (!engine) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Execution engine unavailable');
    return engine;
  };

  return {
    'system.getInfo': () => ({
      appVersion: app.getVersion(),
      contractsVersion: CONTRACTS_VERSION,
      platform:
        process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32',
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.versions.node,
      dataDirectoryConfigured: core !== null,
    }),
    'system.storageHealth': () => c().maintenance.health(),
    'system.backup': () => c().maintenance.backup(),

    // ---- projects ----------------------------------------------------------
    'projects.list': (input) => c().projects.list(input),
    'projects.get': (input) => c().projects.get(input.id),
    'projects.register': (input) => c().projects.register(defined(input)),
    'projects.create': (input) => c().projects.create(defined(input)),
    'projects.update': (input) => c().projects.update(defined(input)),
    'projects.archive': (input) => c().projects.archive(input.id),
    'projects.restore': (input) => c().projects.restore(input.id),
    'projects.remove': async (input) => {
      await c().projects.remove(input);
      return { removed: true as const };
    },
    'projects.listRecent': (input) => c().projects.listRecent(input.limit),
    'projects.markOpened': (input) => c().projects.markOpened(input.id),
    'projects.detectTechnologies': (input) => c().projects.refreshTechnologies(input.id),
    'projects.getSettings': (input) => c().projects.getSettings(input.id),
    'projects.updateSettings': (input) => c().projects.updateSettings(defined(input)),
    'projects.export': async (input) => {
      const project = await c().projects.get(input.id);
      const window = focusedWindow();
      const options = {
        title: 'Exportar dados do projeto',
        defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '_')}.devbrain.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      return c().maintenance.writeProjectExport(project.id, result.filePath);
    },
    'projects.pickDirectory': async () => {
      const window = focusedWindow();
      const options = { properties: ['openDirectory' as const], title: 'Selecionar projeto' };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'workspaces.list': (input) => c().projects.listWorkspaces(input.projectId),
    'workspaces.updateAccess': (input) => c().projects.updateWorkspaceAccess(input),

    // ---- providers & agents -------------------------------------------------
    'providers.listAdapters': () => e().listAdapters(),
    'providers.checkDependencies': (input) => e().checkDependencies(input.adapterKey),
    'providers.getCapabilities': (input) => e().getCapabilities(input.adapterKey),
    'providers.listConfigured': () => c().providers.list(),
    'providers.get': (input) => c().providers.get(input.id),
    'providers.register': (input) => c().providers.register(defined(input)),
    'providers.update': (input) => c().providers.update(defined(input)),
    'providers.setEnabled': (input) => c().providers.setEnabled(input),
    'providers.remove': async (input) => {
      await c().providers.remove(input.id);
      return { removed: true as const };
    },
    'agents.list': () => c().agents.list(),
    'agents.register': (input) => c().agents.register(defined(input)),
    'agents.update': (input) => c().agents.update(defined(input)),

    // ---- credentials (values flow in only) ----------------------------------
    'credentials.list': () => c().credentials.list(),
    'credentials.store': (input) => c().credentials.store(defined(input) as never),
    'credentials.remove': async (input) => {
      await c().credentials.remove(input.id);
      return { removed: true as const };
    },

    // ---- sessions -------------------------------------------------------------
    'sessions.start': (input) => c().sessions.start(defined(input)),
    'sessions.stop': (input) => c().sessions.stop(input.sessionId),
    'sessions.listByProject': (input) => c().sessions.listByProject(input.projectId),
    'sessions.get': (input) => c().sessions.get(input.sessionId),
    'sessions.list': (input) => c().sessions.list(defined(input)),
    'sessions.history': (input) => c().sessions.history(input.sessionId),
    'checkpoints.get': (input) => c().sessions.getCheckpoint(input.id),
    'executions.listEvents': (input) => c().db.executions.listEvents(input),
    'executions.getResult': (input) => c().db.executions.getResult(input.executionId),
    'executions.submit': (input) => e().submit(input),
    'executions.interrupt': (input) => e().interrupt(input),

    // ---- permissions & approvals ------------------------------------------------
    'approvals.listPending': () => c().approvals.listPending(),
    // Reachable only from the trusted top-level renderer frame (a user action).
    'approvals.decide': (input) => c().approvals.decide(defined(input)),
    'permissions.listPolicies': () => c().policies.list(),
    'permissions.savePolicy': (input) => c().policies.save(input),
    'permissions.listGrants': (input) => c().approvals.listGrants(defined(input)),
    'permissions.revokeGrant': (input) => c().approvals.revokeGrant(input.id, input.reason),
    'permissions.evaluate': (input) => c().authorization.evaluate(defined(input)),

    // ---- settings, usage, audit ---------------------------------------------------
    'settings.get': () => c().settings.get(),
    'settings.update': (input) => c().settings.update(input),
    'usage.summary': (input) => c().usage.summary(defined(input)),
    'audit.list': (input) =>
      c().db.audit.list({
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
