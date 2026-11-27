import {
  ALWAYS_ASK_ACTIONS,
  ApprovalDecisionInputSchema,
  DevBrainError,
  newId,
  nowTimestamp,
  parseOrThrow,
  type ApprovalDecisionInput,
  type ApprovalRequest,
  type ApprovalScope,
  type ApprovalService as ApprovalServiceContract,
  type PermissionGrant,
} from '@devbrain/contracts';
import { redactString, redactValue } from '@devbrain/security';
import { addMs, audit, type CoreContext } from './context.js';

export type NewApprovalInput = Pick<
  ApprovalRequest,
  'agentId' | 'action' | 'risk' | 'summary' | 'untrustedOrigin'
> &
  Partial<Pick<ApprovalRequest, 'sessionId' | 'executionId' | 'details' | 'projectId' | 'target'>>;

interface Waiter {
  resolve: (approval: ApprovalRequest) => void;
}

/**
 * Human approvals. Decisions can only come from `decide`, which the desktop shell exposes
 * exclusively to the renderer's top-level frame (user action) — never to agents.
 */
export class ApprovalService implements ApprovalServiceContract {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: CoreContext) {}

  private settings() {
    return this.ctx.db.settings.getSync();
  }

  private settle(approval: ApprovalRequest): void {
    const timer = this.timers.get(approval.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(approval.id);
    for (const w of this.waiters.get(approval.id) ?? []) w.resolve(approval);
    this.waiters.delete(approval.id);
  }

  private require(id: string): ApprovalRequest {
    const approval = this.ctx.db.approvals.findById(id);
    if (!approval) throw new DevBrainError('NOT_FOUND', 'Approval not found', { details: { id } });
    return approval;
  }

  async request(input: NewApprovalInput): Promise<ApprovalRequest> {
    const now = Date.now();
    const approval: ApprovalRequest = {
      id: newId('approval'),
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      executionId: input.executionId ?? null,
      action: input.action,
      risk: input.risk,
      summary: redactString(input.summary).slice(0, 2000),
      details: redactValue(input.details ?? {}) as Record<string, unknown>,
      untrustedOrigin: input.untrustedOrigin,
      status: 'pending',
      requestedAt: new Date(now).toISOString(),
      expiresAt: addMs(this.settings().security.approvalTimeoutMs, now),
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      projectId: input.projectId ?? null,
      scope: 'once',
      target: input.target ?? null,
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.approvals.save(approval);
      audit(this.ctx, {
        action: 'approval.requested',
        actor: { type: 'agent', agentId: approval.agentId },
        permission: approval.action,
        projectId: approval.projectId,
        target: approval.target,
        outcome: 'pending',
        details: {
          approvalId: approval.id,
          risk: approval.risk,
          untrustedOrigin: approval.untrustedOrigin,
        },
      });
    });
    this.ctx.events.emit('approval.requested', approval);
    return approval;
  }

  async get(id: string): Promise<ApprovalRequest> {
    return this.require(id);
  }

  async listPending(): Promise<ApprovalRequest[]> {
    this.sweep();
    return this.ctx.db.approvals.listByStatus('pending');
  }

  /** Human decision. Creates a grant when approved with scope `session` / `project`. */
  async decide(input: ApprovalDecisionInput): Promise<ApprovalRequest> {
    const parsed = parseOrThrow(ApprovalDecisionInputSchema, input);
    this.sweep();
    const current = this.require(parsed.approvalId);
    if (current.status !== 'pending') {
      throw new DevBrainError('CONFLICT', `Approval is already ${current.status}`, {
        details: { status: current.status },
      });
    }
    const scope: ApprovalScope = parsed.decision === 'approved' ? (parsed.scope ?? 'once') : 'once';
    if (scope !== 'once' && ALWAYS_ASK_ACTIONS.includes(current.action)) {
      throw new DevBrainError('VALIDATION_FAILED', `${current.action} can only be approved once`);
    }
    if (scope !== 'once' && current.untrustedOrigin) {
      throw new DevBrainError(
        'VALIDATION_FAILED',
        'Requests from untrusted content can only be approved once',
      );
    }
    if (scope === 'session' && !current.sessionId) {
      throw new DevBrainError(
        'VALIDATION_FAILED',
        'This request has no session to scope the approval to',
      );
    }
    if (scope === 'project' && !current.projectId) {
      throw new DevBrainError(
        'VALIDATION_FAILED',
        'This request has no project to scope the approval to',
      );
    }
    const at = nowTimestamp();
    const decided: ApprovalRequest = {
      ...current,
      status: parsed.decision,
      decidedAt: at,
      decidedBy: 'user',
      decisionNote: parsed.note ? redactString(parsed.note) : null,
      scope,
    };
    let grant: PermissionGrant | null = null;
    if (decided.status === 'approved' && scope !== 'once') {
      grant = {
        id: newId('grant'),
        approvalId: decided.id,
        agentId: decided.agentId,
        projectId: decided.projectId,
        sessionId: scope === 'session' ? decided.sessionId : null,
        action: decided.action,
        scope,
        target: decided.target,
        createdAt: at,
        expiresAt: addMs(parsed.grantTtlMs ?? this.settings().security.defaultGrantTtlMs),
        revokedAt: null,
        revokedReason: null,
      };
    }
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.approvals.save(decided);
      if (grant) this.ctx.db.grants.insert(grant);
      audit(this.ctx, {
        action: 'approval.decided',
        permission: decided.action,
        projectId: decided.projectId,
        target: decided.target,
        outcome: decided.status === 'approved' ? 'success' : 'denied',
        details: {
          approvalId: decided.id,
          decision: decided.status,
          scope,
          grantId: grant?.id ?? null,
        },
      });
    });
    this.settle(decided);
    this.ctx.events.emit('approval.decided', decided);
    return decided;
  }

  /** Resolves when the approval is decided, expires or is cancelled. */
  async waitFor(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    const current = this.require(approvalId);
    if (current.status !== 'pending') return current;
    if (signal?.aborted) throw new DevBrainError('CANCELLED', 'Aborted while waiting for approval');
    return new Promise<ApprovalRequest>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (a) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(a);
        },
      };
      const onAbort = () => {
        this.waiters.get(approvalId)?.delete(waiter);
        reject(new DevBrainError('CANCELLED', 'Aborted while waiting for approval'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      let set = this.waiters.get(approvalId);
      if (!set) {
        set = new Set();
        this.waiters.set(approvalId, set);
      }
      set.add(waiter);
      if (!this.timers.has(approvalId)) {
        const delay = Math.max(0, Date.parse(current.expiresAt) - Date.now());
        const timer = setTimeout(() => this.sweep(), delay + 5);
        timer.unref?.();
        this.timers.set(approvalId, timer);
      }
    });
  }

  private close(
    approval: ApprovalRequest,
    status: 'expired' | 'cancelled',
    reason: string,
  ): ApprovalRequest {
    const closed: ApprovalRequest = {
      ...approval,
      status,
      decidedAt: nowTimestamp(),
      decisionNote: reason,
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.approvals.save(closed);
      audit(this.ctx, {
        action: status === 'expired' ? 'approval.expired' : 'approval.cancelled',
        actor: { type: 'system', component: 'approvals' },
        permission: closed.action,
        projectId: closed.projectId,
        target: closed.target,
        outcome: 'denied',
        details: { approvalId: closed.id, reason },
      });
    });
    this.settle(closed);
    this.ctx.events.emit('approval.decided', closed);
    return closed;
  }

  /** Expires overdue requests (expired = denied). Returns how many were expired. */
  sweep(): number {
    const expired = this.ctx.db.approvals.listExpired(nowTimestamp());
    for (const a of expired) this.close(a, 'expired', 'timed out');
    return expired.length;
  }

  /** Cancels pending requests of a session (session ended) — or all (startup recovery). */
  cancelPending(filter: { sessionId?: string }, reason: string): number {
    const pending = this.ctx.db.approvals
      .listByStatus('pending', 10_000)
      .filter((a) => filter.sessionId === undefined || a.sessionId === filter.sessionId);
    for (const a of pending) this.close(a, 'cancelled', reason);
    return pending.length;
  }

  // ---- grants ------------------------------------------------------------

  async listGrants(filter: {
    agentId?: string;
    projectId?: string;
    includeInactive?: boolean;
  }): Promise<PermissionGrant[]> {
    return this.ctx.db.grants.list({
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      includeInactive: filter.includeInactive ?? false,
      now: nowTimestamp(),
    });
  }

  async revokeGrant(id: string, reason?: string): Promise<PermissionGrant> {
    const grant = this.ctx.db.grants.findById(id);
    if (!grant) throw new DevBrainError('NOT_FOUND', 'Grant not found', { details: { id } });
    if (grant.revokedAt) return grant;
    return this.ctx.db.driver.transaction(() => {
      const revoked = this.ctx.db.grants.revoke(
        id,
        reason ? redactString(reason) : 'revoked by user',
        nowTimestamp(),
      );
      audit(this.ctx, {
        action: 'permission.grant-revoked',
        permission: grant.action,
        projectId: grant.projectId,
        target: grant.target,
        details: { grantId: id },
      });
      return revoked;
    });
  }

  /** Clears waiters/timers (shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waiters.clear();
  }
}
