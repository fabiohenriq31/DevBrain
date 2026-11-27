import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  DevBrainError,
  nowTimestamp,
  type BackupResult,
  type ExecutionResult,
  type ProjectExport,
  type PruneResult,
  type StorageHealth,
} from '@devbrain/contracts';
import { backupDatabase, currentSchemaVersion } from '@devbrain/database';
import type { ApprovalService } from './approvals.js';
import { audit, type CoreContext } from './context.js';

const DAY = 24 * 60 * 60 * 1000;
const LAST_BACKUP = 'last_backup_at';
const LAST_PRUNE = 'last_prune_at';

export interface RecoveryReport {
  uncleanShutdownDetected: boolean;
  recoveredSessions: number;
  recoveredExecutions: number;
  cancelledApprovals: number;
}

/**
 * Startup recovery. Marks state owned by a previous (dead) app instance as interrupted.
 * Processes are NOT resumed — they no longer exist; the persisted state (history,
 * checkpoints) stays available so the user can consciously start a new session from it.
 */
export const recoverPreviousRun = (
  ctx: CoreContext,
  approvals: ApprovalService,
  appVersion: string | null,
): RecoveryReport => {
  const { previousUnclean } = ctx.db.runs.start(ctx.instanceId, appVersion);
  const now = nowTimestamp();
  const reason = previousUnclean
    ? 'DevBrain stopped unexpectedly while this was running'
    : 'DevBrain was closed while this was running';

  let recoveredExecutions = 0;
  let recoveredSessions = 0;
  ctx.db.driver.transaction(() => {
    for (const request of ctx.db.executions.listUnfinished()) {
      const owner = ctx.db.sessions.instanceOf(request.sessionId);
      if (owner === ctx.instanceId) continue;
      const result: ExecutionResult = {
        executionId: request.id,
        sessionId: request.sessionId,
        status: 'failed',
        exitCode: null,
        startedAt: null,
        finishedAt: now,
        summary: null,
        usage: null,
        error: { code: 'INTERRUPTED', message: reason, retryable: true },
        outputTruncated: false,
      };
      ctx.db.executions.saveResultSync(result);
      // The dead process may have consumed paid resources: account it as unknown cost.
      const owning = ctx.db.sessions.findById(request.sessionId);
      if (request.payload.kind === 'prompt' && owning) {
        ctx.db.usage.record({
          executionId: request.id,
          agentId: owning.agentId,
          providerId: ctx.db.agents.findById(owning.agentId)?.providerId ?? null,
          projectId: owning.projectId,
          usage: { inputTokens: null, outputTokens: null, costAmount: null, costCurrency: null },
        });
      }
      recoveredExecutions += 1;
    }
    for (const session of ctx.db.sessions.listOrphaned(ctx.instanceId)) {
      ctx.db.sessions.update({
        ...session,
        status: 'interrupted',
        endedAt: now,
        updatedAt: now,
        endReason: reason,
      });
      ctx.db.grants.revokeForSession(session.id, 'session interrupted', now);
      recoveredSessions += 1;
    }
    if (recoveredSessions + recoveredExecutions > 0 || previousUnclean) {
      audit(ctx, {
        action: 'system.recovered',
        actor: { type: 'system', component: 'recovery' },
        details: { previousUnclean, recoveredSessions, recoveredExecutions },
      });
    }
  });
  // Approvals requested by a dead instance can never be acted on.
  const cancelledApprovals = approvals.cancelPending({}, 'requested by a previous run');
  ctx.db.maintenance.set(
    'last_recovery',
    JSON.stringify({ at: now, previousUnclean, recoveredSessions, recoveredExecutions }),
  );
  return {
    uncleanShutdownDetected: previousUnclean,
    recoveredSessions,
    recoveredExecutions,
    cancelledApprovals,
  };
};

export class MaintenanceService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly approvals: ApprovalService,
    private readonly recovery: RecoveryReport,
  ) {}

  /** Applies retention: old events of finished executions, old audit rows, expirations. */
  prune(now = Date.now()): PruneResult {
    const { retention } = this.ctx.db.settings.getSync();
    this.ctx.db.executions.setLimits(retention);
    const eventsBefore = new Date(now - retention.executionEventsMaxAgeDays * DAY).toISOString();
    const auditBefore = new Date(now - retention.auditMaxAgeDays * DAY).toISOString();
    const result: PruneResult = {
      executionEvents: this.ctx.db.maintenance.pruneExecutionEvents(eventsBefore),
      auditEvents: this.ctx.db.audit.pruneBefore(auditBefore),
      expiredApprovals: this.approvals.sweep(),
      expiredGrants: this.ctx.db.grants.markExpired(new Date(now).toISOString()),
    };
    this.ctx.db.maintenance.set(LAST_PRUNE, nowTimestamp());
    return result;
  }

  backup(): BackupResult {
    if (!this.ctx.db.backupDir)
      throw new DevBrainError('UNSUPPORTED', 'In-memory databases have no backups');
    const { retention } = this.ctx.db.settings.getSync();
    const result = backupDatabase(
      this.ctx.db.driver,
      this.ctx.db.backupDir,
      retention.backupsToKeep,
    );
    this.ctx.db.maintenance.set(LAST_BACKUP, result.createdAt);
    audit(this.ctx, {
      action: 'system.backup-created',
      actor: { type: 'system', component: 'maintenance' },
      details: { bytes: result.bytes },
    });
    return result;
  }

  /** Daily automatic backup; returns null when a recent one exists. */
  backupIfDue(now = Date.now()): BackupResult | null {
    if (!this.ctx.db.backupDir) return null;
    const last = this.ctx.db.maintenance.get(LAST_BACKUP);
    if (last && now - Date.parse(last) < DAY) return null;
    return this.backup();
  }

  health(): StorageHealth {
    const location = this.ctx.db.driver.location;
    let bytes = 0;
    if (location !== ':memory:') {
      for (const f of [location, `${location}-wal`]) {
        try {
          bytes += statSync(f).size;
        } catch {
          // sidecar may not exist
        }
      }
    }
    return {
      schemaVersion: currentSchemaVersion(this.ctx.db.driver),
      integrity: this.ctx.db.integrity,
      uncleanShutdownDetected: this.recovery.uncleanShutdownDetected,
      recoveredSessions: this.recovery.recoveredSessions,
      recoveredExecutions: this.recovery.recoveredExecutions,
      lastBackupAt: this.ctx.db.maintenance.get(LAST_BACKUP),
      databaseBytes: bytes,
    };
  }

  /**
   * JSON export of one project's DevBrain data. Contains no secrets: credential values are
   * never in these tables, and execution events (raw agent output) are excluded.
   */
  exportProject(projectId: string): ProjectExport {
    const project = this.ctx.db.projects.findById(projectId);
    if (!project) throw new DevBrainError('NOT_FOUND', 'Project not found');
    const sessions = this.ctx.db.sessions.list({ projectId, limit: 100_000 });
    return {
      format: 'devbrain.project-export',
      version: 1,
      exportedAt: nowTimestamp(),
      project,
      workspaces: this.ctx.db.workspaces.listByProject(projectId),
      settings: this.ctx.db.projectSettings.get(projectId),
      sessions,
      executions: sessions.flatMap((s) => this.ctx.db.executions.listBySession(s.id, 100_000)),
      checkpoints: this.ctx.db.checkpoints.listByProject(projectId, 100_000),
    };
  }

  async writeProjectExport(projectId: string, file: string): Promise<BackupResult> {
    const data = JSON.stringify(this.exportProject(projectId), null, 2);
    await writeFile(file, data, { encoding: 'utf8', flag: 'w' });
    audit(this.ctx, {
      action: 'project.exported',
      projectId,
      details: { bytes: Buffer.byteLength(data) },
    });
    return { path: file, bytes: Buffer.byteLength(data), createdAt: nowTimestamp() };
  }
}
