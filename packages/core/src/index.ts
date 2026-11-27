import {
  SettingsPatchSchema,
  parseOrThrow,
  type ApplicationSettings,
  type SettingsPatch,
} from '@devbrain/contracts';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import { LocalProjectService } from '@devbrain/project-engine';
import type { Logger, SecretCipher } from '@devbrain/security';
import { ApprovalService } from './approvals.js';
import { AuthorizationService } from './authorization.js';
import { audit, createContext, type CoreContext, type CoreEvents } from './context.js';
import { CredentialService } from './credentials.js';
import { MaintenanceService, recoverPreviousRun, type RecoveryReport } from './maintenance.js';
import { AgentService, PolicyService, ProviderService } from './providers.js';
import { SessionManager } from './sessions.js';
import { UsageService } from './usage.js';

export * from './approvals.js';
export * from './authorization.js';
export * from './context.js';
export * from './credentials.js';
export * from './maintenance.js';
export * from './providers.js';
export * from './sessions.js';
export * from './usage.js';

export class SettingsService {
  constructor(private readonly ctx: CoreContext) {}

  async get(): Promise<ApplicationSettings> {
    return this.ctx.db.settings.getSync();
  }

  async update(patch: SettingsPatch): Promise<ApplicationSettings> {
    const parsed = parseOrThrow(SettingsPatchSchema, patch);
    const next = await this.ctx.db.settings.update(parsed);
    this.ctx.db.executions.setLimits(next.retention);
    audit(this.ctx, { action: 'settings.updated', details: { sections: Object.keys(parsed) } });
    return next;
  }
}

export interface CoreServices {
  context: CoreContext;
  db: DevBrainDatabase;
  events: CoreEvents;
  recovery: RecoveryReport;
  projects: LocalProjectService;
  providers: ProviderService;
  agents: AgentService;
  policies: PolicyService;
  credentials: CredentialService;
  approvals: ApprovalService;
  authorization: AuthorizationService;
  sessions: SessionManager;
  usage: UsageService;
  settings: SettingsService;
  maintenance: MaintenanceService;
  /** Starts periodic maintenance (expirations, retention, daily backup). */
  startBackgroundTasks(intervalMs?: number): void;
  /** Clean shutdown: stops timers, marks the run as cleanly finished, closes the database. */
  close(): void;
}

export interface CoreOptions {
  /** Database file, or `:memory:` (tests). */
  databaseFile: string;
  backupDir?: string;
  cipher: SecretCipher;
  instanceId: string;
  appVersion?: string | null;
  logger?: Logger;
  /** Directories that can never be registered as projects (e.g. userData). */
  protectedPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Opens storage, runs crash recovery and wires every core service. */
export const createCoreServices = (options: CoreOptions): CoreServices => {
  const db = createDatabase({
    location: options.databaseFile,
    ...(options.backupDir ? { backupDir: options.backupDir } : {}),
  });
  try {
    const ctx = createContext(db, {
      instanceId: options.instanceId,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    db.executions.setLimits(db.settings.getSync().retention);
    const approvals = new ApprovalService(ctx);
    const usage = new UsageService(ctx);
    const recovery = recoverPreviousRun(ctx, approvals, options.appVersion ?? null);
    if (recovery.uncleanShutdownDetected || recovery.recoveredSessions > 0) {
      ctx.logger.log('warn', 'Recovered state from a previous run', { ...recovery });
    }
    const maintenance = new MaintenanceService(ctx, approvals, recovery);
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const tick = () => {
      try {
        maintenance.prune();
        maintenance.backupIfDue();
      } catch (error) {
        ctx.logger.log('error', 'Maintenance task failed', { error: String(error) });
      }
    };

    return {
      context: ctx,
      db,
      events: ctx.events,
      recovery,
      projects: new LocalProjectService(db, {
        protectedPaths: options.protectedPaths ?? [],
        onChanged: (projectId) => ctx.events.emit('projects.changed', { projectId }),
      }),
      providers: new ProviderService(ctx),
      agents: new AgentService(ctx),
      policies: new PolicyService(ctx),
      credentials: new CredentialService(ctx, options.cipher, options.env ?? process.env),
      approvals,
      authorization: new AuthorizationService(ctx, approvals, usage),
      sessions: new SessionManager(ctx, approvals),
      usage,
      settings: new SettingsService(ctx),
      maintenance,
      startBackgroundTasks(intervalMs = 60_000) {
        if (timer || closed) return;
        tick();
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
      },
      close() {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        approvals.dispose();
        try {
          db.runs.finish(ctx.instanceId);
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
};
