import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  CONTRACTS_VERSION,
  DevBrainError,
  IPC_CHANNELS,
  dispatchIpc,
  ipcChannelName,
  ipcEventName,
  nowTimestamp,
  type IpcChannelKey,
  type IpcHandlerMap,
} from '@devbrain/contracts';
import type { CoreServices } from '@devbrain/core';
import type { OperationalExecutionService } from '@devbrain/execution-engine';
import { LocalGitService } from '@devbrain/git-engine';
import type { AiGateway, OllamaRuntime, ProviderCatalog } from '@devbrain/ai-gateway';
import { ContextHandoffService, ContextOptimizer, SUITES } from '@devbrain/intelligence';
import { redactString } from '@devbrain/security';
import { isTrustedRendererUrl } from './security.js';

export interface MainServices {
  core: CoreServices | null;
  engine?: OperationalExecutionService | null;
  gateway?: AiGateway | null;
  catalog?: ProviderCatalog | null;
  localRuntime?: OllamaRuntime;
  git?: LocalGitService;
  devServerUrl: string | undefined;
}

/** Drops keys whose value is `undefined` (zod output vs. exactOptionalPropertyTypes). */
const defined = <T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;

const focusedWindow = () =>
  typeof BrowserWindow?.getFocusedWindow === 'function'
    ? (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])
    : undefined;

const applyWindowTheme = (theme: 'system' | 'light' | 'dark'): void => {
  if (process.platform !== 'win32' || typeof BrowserWindow?.getAllWindows !== 'function') return;
  try {
    if (nativeTheme) nativeTheme.themeSource = theme;
    const dark =
      theme === 'dark' || (theme === 'system' && (nativeTheme?.shouldUseDarkColors ?? true));
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.setTitleBarOverlay?.({
          color: dark ? '#0d1016' : '#f3f5f8',
          symbolColor: dark ? '#9aa3b2' : '#3d4655',
          height: 38,
        });
      }
    }
  } catch {
    /* ignore in headless/non-Win32 environments */
  }
};

/**
 * IPC handlers. Channels owned by the execution engine (Codex) — adapters, dependency checks,
 * executions — have no handler yet and answer `UNSUPPORTED` (honestly reported, never
 * simulated) until their owner implements them.
 */
export const createHandlers = ({
  core,
  engine,
  gateway,
  catalog,
  localRuntime,
  git = new LocalGitService(),
}: MainServices): IpcHandlerMap => {
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
  const g = (): AiGateway => {
    if (!gateway) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'AI gateway unavailable');
    return gateway;
  };
  const p = (): ProviderCatalog => {
    if (!catalog) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'AI catalog unavailable');
    return catalog;
  };
  const local = (): OllamaRuntime => {
    if (!localRuntime) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Local runtime unavailable');
    return localRuntime;
  };
  const pulls = new Map<string, AbortController>();
  const emitAi = (key: 'ai.inference.event' | 'ai.local.pullProgress', payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipcEventName(key), payload);
    }
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
    'providers.checkDependencies': async (input) => {
      const report = await e().checkDependencies(input.adapterKey);
      if (core) {
        const capabilities = await e()
          .getCapabilities(input.adapterKey)
          .catch(() => undefined);
        const configured = await core.providers.list();
        for (const item of configured) {
          if (item.provider.adapterKey === input.adapterKey) {
            await core.providers.recordEvidence({
              providerId: item.provider.id,
              aspect: 'installed',
              state: report.status === 'available' ? 'yes' : 'no',
              detail: report.checks[0]?.version ?? report.checks[0]?.message ?? null,
              ...(capabilities ? { capabilities } : {}),
            });
          }
        }
      }
      return report;
    },
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
    'settings.update': async (input) => {
      const updated = await c().settings.update(input);
      applyWindowTheme(updated.theme);
      return updated;
    },
    'usage.summary': (input) => c().usage.summary(defined(input)),
    'audit.list': (input) =>
      c().db.audit.list({
        limit: input.limit,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),

    // ---- read-only Git inspection of workspaces -----------------------------
    'git.status': async (input) => {
      const workspace = c().db.workspaces.findById(input.workspaceId);
      if (!workspace) {
        throw new DevBrainError('NOT_FOUND', 'Workspace not found', {
          details: { workspaceId: input.workspaceId },
        });
      }
      const repo = await git.detect(workspace.rootPath);
      if (!repo) return null;
      return git.status(workspace.rootPath);
    },
    'git.diff': async (input) => {
      const workspace = c().db.workspaces.findById(input.workspaceId);
      if (!workspace) {
        throw new DevBrainError('NOT_FOUND', 'Workspace not found', {
          details: { workspaceId: input.workspaceId },
        });
      }
      const repo = await git.detect(workspace.rootPath);
      if (!repo) {
        return {
          workspaceId: workspace.id,
          diff: '',
          truncated: false,
          capturedAt: nowTimestamp(),
        };
      }
      // Read a margin past maxBytes, redact, then cut: a secret straddling git's read boundary
      // is still matched whole by the redactor, and the cut lands on redacted text.
      const read = await git.diffBounded(workspace.rootPath, input.maxBytes + 64 * 1024);
      const redacted = Buffer.from(redactString(read.diff), 'utf8');
      let cut = Math.min(redacted.byteLength, input.maxBytes);
      while (cut > 0 && cut < redacted.byteLength && ((redacted[cut] ?? 0) & 0xc0) === 0x80)
        cut -= 1;
      const diff = redacted.subarray(0, cut).toString('utf8');
      const truncated = read.truncated || cut < redacted.byteLength;
      return { workspaceId: workspace.id, diff, truncated, capturedAt: nowTimestamp() };
    },
    'ai.catalog.list': () => p().list(),
    'ai.catalog.import': (input) => p().import(Buffer.from(input.data, 'utf8'), input.sourceId),
    'ai.endpoints.list': () => g().endpoints(),
    'ai.endpoints.save': (input) => {
      g().saveEndpoint(input);
      return input;
    },
    'ai.connections.list': () => g().connections(),
    'ai.connections.save': (input) => {
      const connection = { ...input, status: 'unknown' as const, lastVerifiedAt: null };
      g().saveConnection(connection);
      return connection;
    },
    'ai.connections.validate': (input) => g().validateConnection(input.id),
    'ai.connections.remove': (input) => {
      g().removeConnection(input.id);
      return { removed: true as const };
    },
    'ai.models.list': (input) =>
      g()
        .models()
        .filter(
          (model) =>
            !input.connectionId ||
            g()
              .routes()
              .some(
                (route) => route.modelId === model.id && route.connectionId === input.connectionId,
              ),
        ),
    'ai.models.save': (input) => {
      g().saveModel(input);
      return input;
    },
    'ai.routes.list': () => g().routes(),
    'ai.routes.save': (input) => {
      g().saveRoute(input);
      return input;
    },
    'ai.policies.configure': (input) => {
      g().configurePolicy(input);
      return input.policy;
    },
    'ai.inference.submit': async (input) => {
      if (input.projectId && !c().db.projects.findById(input.projectId))
        throw new DevBrainError('NOT_FOUND', 'Project not found');
      if (input.sessionId) {
        const session = await c().sessions.get(input.sessionId);
        if (!input.projectId || input.projectId !== session.projectId)
          throw new DevBrainError(
            'PERMISSION_DENIED',
            'Inference must use its session project policy',
          );
      }
      return { requestId: g().submit(input, (event) => emitAi('ai.inference.event', event)) };
    },
    'ai.inference.result': (input) => g().result(input.requestId),
    'ai.inference.cancel': (input) => ({ cancelled: g().cancel(input.requestId) }),
    'ai.inference.attempts': (input) => g().attempts(input.requestId),
    'ai.quota.definitions': (input) => g().ledger.definitions(input.scopeId),
    'ai.quota.observations': (input) => g().ledger.observations(input.quotaId),
    'ai.quota.reservations': (input) => g().ledger.reservations(input.quotaId),
    'ai.usage.list': (input) => g().ledger.usage(input.requestId),
    'ai.credits.get': () => null,
    // ---- Phase 02 intelligence: every decision is made here, in the main process --------
    'ai.routes.select': (input) => {
      const decision = g().explain(input);
      const top = decision.ranked[0];
      if (!top)
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'No eligible model route', {
          details: { excluded: decision.excluded.length },
        });
      return {
        requestId: decision.requestId,
        routeId: top.routeId,
        policyId: decision.policyId,
        selectedAt: decision.decidedAt,
        reason: `score ${top.score} (${top.evidence}); ${top.notes[0] ?? 'eligible'}`.slice(0, 500),
        candidateRouteIds: decision.ranked.map((r) => r.routeId),
      };
    },
    'ai.routes.explain': (input) => g().explain(input),
    'ai.projectPolicy.get': (input) => {
      if (!c().db.projects.findById(input.projectId))
        throw new DevBrainError('NOT_FOUND', 'Project not found');
      return g().intelligence.projectPolicyOrDefault(input.projectId);
    },
    'ai.projectPolicy.save': (input) => {
      if (!c().db.projects.findById(input.projectId))
        throw new DevBrainError('NOT_FOUND', 'Project not found');
      const saved = g().intelligence.saveProjectPolicy(input);
      c().db.audit.appendSync({
        actor: { type: 'user' },
        action: 'ai.project-policy.saved',
        permission: null,
        projectId: saved.projectId,
        target: saved.projectId,
        outcome: 'success',
        details: {
          privacyClass: saved.privacyClass,
          approvedProviders: saved.approvedProviderIds.length,
          allowPaid: saved.budget.allowPaid,
          allowUnboundedCost: saved.budget.allowUnboundedCost,
        },
        correlationId: null,
      });
      return saved;
    },
    'ai.privacyProfiles.list': () => g().intelligence.privacyProfiles(),
    'ai.privacyProfiles.save': (input) => {
      const saved = g().intelligence.savePrivacyProfile(input);
      c().db.audit.appendSync({
        actor: { type: 'user' },
        action: 'ai.privacy-profile.saved',
        permission: null,
        projectId: null,
        target: saved.providerId,
        outcome: 'success',
        details: { training: saved.trainingOnInputs, retention: saved.retention },
        correlationId: null,
      });
      return saved;
    },
    'ai.cost.get': (input) => g().intelligence.cost(input.requestId),
    'ai.budget.status': (input) => g().budgetStatus(input),
    'ai.quota.forecast': (input) => g().engine.quota.forecast(input.quotaId),
    'ai.benchmark.suites': () =>
      SUITES.map((suite) => ({
        id: suite.id,
        version: suite.version,
        cases: suite.cases.length,
        categories: [...new Set(suite.cases.map((x) => x.category))],
      })),
    'ai.benchmark.run': async (input) => {
      const run = await g().runBenchmark(input);
      c().db.audit.appendSync({
        actor: { type: 'user' },
        action: 'ai.benchmark.run',
        permission: null,
        projectId: input.projectId ?? null,
        target: input.routeId,
        outcome: 'success',
        details: {
          suite: `${run.suiteId}@${run.suiteVersion}`,
          passed: run.results.filter((r) => r.passed).length,
          cases: run.results.length,
        },
        correlationId: null,
      });
      return run;
    },
    'ai.benchmark.quality': (input) =>
      g()
        .models()
        .filter((m) => !input.modelId || m.id === input.modelId)
        .map((m) => g().modelEvidence(m.id)),
    'ai.context.preview': (input) =>
      new ContextOptimizer().optimize(input.messages, { budgetTokens: input.budgetTokens }).report,
    'ai.handoff.build': async (input) =>
      new ContextHandoffService().build(await c().sessions.history(input.sessionId), input.kind),
    'ai.local.list': async () => [await local().inspect()],
    'ai.local.models': (input) => (input.runtimeId === local().id ? local().models() : []),
    'ai.local.pull': (input) => {
      if (input.runtimeId !== local().id)
        throw new DevBrainError('NOT_FOUND', 'Local runtime missing');
      const operationId = `pull_${crypto.randomUUID()}`;
      const controller = new AbortController();
      pulls.set(operationId, controller);
      void (async () => {
        try {
          for await (const progress of local().pull(input.modelId, controller.signal))
            emitAi('ai.local.pullProgress', { operationId, ...progress });
        } finally {
          pulls.delete(operationId);
        }
      })().catch(() => {
        pulls.delete(operationId);
      });
      return { operationId };
    },
    'ai.local.cancelPull': (input) => {
      const controller = pulls.get(input.operationId);
      controller?.abort();
      return { cancelled: Boolean(controller) };
    },
    'ai.local.remove': async (input) => {
      if (input.runtimeId !== local().id)
        throw new DevBrainError('NOT_FOUND', 'Local runtime missing');
      await local().remove(input.modelId);
      return { removed: true };
    },
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
