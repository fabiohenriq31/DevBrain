import path from 'node:path';
import {
  ALWAYS_ASK_ACTIONS,
  DevBrainError,
  EvaluatePermissionInputSchema,
  nowTimestamp,
  parseOrThrow,
  type Agent,
  type AgentSession,
  type EvaluatePermissionInput,
  type PermissionAction,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionPolicy,
  type PermissionService,
  type RiskLevel,
  type Workspace,
} from '@devbrain/contracts';
import {
  ConcurrencyLimiter,
  assessCommand,
  checkWorkspaceAccess,
  evaluatePermission,
  globToRegExp,
  mostRestrictive,
  planEnforcement,
  type EnforcementPlan,
} from '@devbrain/security';
import type { ApprovalService } from './approvals.js';
import { audit, type CoreContext } from './context.js';
import type { UsageService } from './usage.js';

export interface Verdict {
  decision: PermissionDecision;
  reason: string;
  grantId: string | null;
  /** Action actually evaluated (`scope.escape` when the path is outside the workspace). */
  action: PermissionAction;
  /** Workspace-relative path, when a path was evaluated inside the workspace. */
  relativePath: string | null;
  /** Real path (links resolved), when known. */
  realPath: string | null;
}

export interface EnforceOptions {
  /** Wait for a human decision when the verdict is `ask` (default true). */
  waitForApproval?: boolean;
  signal?: AbortSignal;
  executionId?: string;
  summary?: string;
}

export interface CommandAuthorizationInput {
  agentId: string;
  workspaceId: string;
  sessionId?: string;
  executable: string;
  args: readonly string[];
  /** Working directory; must be inside the workspace. */
  cwd: string;
  untrustedOrigin?: boolean;
}

export interface ExecutionAuthorization {
  session: AgentSession;
  agent: Agent;
  workspace: Workspace;
  /** Effective policy (agent policy, combined with the project override at evaluation). */
  policy: PermissionPolicy;
  plan: EnforcementPlan;
  /** Real working directory, validated inside the workspace. */
  workingDirectory: string;
  /** Effective timeout and output limits for this execution. */
  limits: { maxExecutionMs: number; maxOutputBytes: number };
}

const FS_WRITE: ReadonlySet<PermissionAction> = new Set(['fs.write', 'fs.delete']);

const RISK: Partial<Record<PermissionAction, RiskLevel>> = {
  'fs.read': 'low',
  'fs.write': 'medium',
  'git.commit': 'medium',
  'process.spawn': 'medium',
  'network.request': 'medium',
  'package.install': 'high',
  'credential.use': 'high',
  'fs.delete': 'high',
  'git.push': 'high',
  'git.branch-delete': 'high',
  'external.publish': 'high',
  'git.force-push': 'critical',
  'git.history-rewrite': 'critical',
  'privilege.elevate': 'critical',
  'scope.escape': 'critical',
};

export const riskOf = (action: PermissionAction): RiskLevel => RISK[action] ?? 'medium';

const exeName = (value: string): string =>
  (value.split(/[\\/]/).pop() ?? value).replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();

const grantMatches = (
  grant: PermissionGrant,
  relativePath: string | null,
  executable: string | null,
): boolean => {
  if (grant.target === null) return true;
  if (grant.target.startsWith('agent:')) return executable === grant.target;
  if (executable !== null) return exeName(executable) === exeName(grant.target);
  return relativePath !== null && globToRegExp(grant.target).test(relativePath);
};

/**
 * The single enforcement point for agent actions. The execution engine MUST call
 * `enforce` / `authorizeCommand` / `authorizeExecution` before acting; it never decides on its
 * own. Order: workspace real-path scope → excluded paths → agent policy ∧ project policy (most
 * restrictive) → safety floors (ALWAYS_ASK, untrusted origin) → session/project grants
 * (only lift `ask`, never `deny`, never ALWAYS_ASK) → human approval.
 */
export class AuthorizationService implements PermissionService {
  private readonly global = new Map<number, ConcurrencyLimiter>();
  private readonly perAgent = new Map<string, { limit: number; limiter: ConcurrencyLimiter }>();

  constructor(
    private readonly ctx: CoreContext,
    private readonly approvals: ApprovalService,
    private readonly usage: UsageService,
  ) {}

  private agent(id: string): Agent {
    const agent = this.ctx.db.agents.findById(id);
    if (!agent) throw new DevBrainError('NOT_FOUND', 'Agent not found', { details: { id } });
    return agent;
  }

  private workspace(id: string): Workspace {
    const ws = this.ctx.db.workspaces.findById(id);
    if (!ws) throw new DevBrainError('NOT_FOUND', 'Workspace not found', { details: { id } });
    return ws;
  }

  /** Agent policy plus the project override (if any), evaluated most-restrictive. */
  policiesFor(agent: Agent, projectId: string): PermissionPolicy[] {
    const policies: PermissionPolicy[] = [];
    const own = this.ctx.db.policies.findById(agent.permissionPolicyId);
    if (!own) throw new DevBrainError('PERMISSION_DENIED', 'Agent has no valid permission policy');
    policies.push(own);
    const overrideId = this.ctx.db.projectSettings.get(projectId)?.permissionPolicyId;
    if (overrideId) {
      const override = this.ctx.db.policies.findById(overrideId);
      if (override) policies.push(override);
    }
    return policies;
  }

  /** Pure evaluation (no side effects besides reading). Used by `permissions.evaluate`. */
  async evaluate(input: EvaluatePermissionInput): Promise<Verdict> {
    const parsed = parseOrThrow(EvaluatePermissionInputSchema, input);
    const deny = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({
      decision: 'deny',
      reason,
      grantId: null,
      action: parsed.action,
      relativePath: null,
      realPath: null,
      ...extra,
    });
    const agent = this.agent(parsed.agentId);
    const workspace = this.workspace(parsed.workspaceId);
    if (agent.status === 'disabled') return deny('agent is disabled');
    const project = this.ctx.db.projects.findById(workspace.projectId);
    if (!project || project.archivedAt) return deny('project is archived or missing');

    let session: AgentSession | null = null;
    if (parsed.sessionId) {
      session = this.ctx.db.sessions.findById(parsed.sessionId);
      if (!session || session.agentId !== agent.id || session.workspaceId !== workspace.id) {
        return deny('session does not belong to this agent and workspace');
      }
      if (!['starting', 'active', 'idle'].includes(session.status))
        return deny(`session is ${session.status}`);
    }

    let action = parsed.action;
    let relativePath: string | null = null;
    let realPath: string | null = null;
    if (parsed.path !== undefined) {
      const excluded = this.ctx.db.projectSettings.get(project.id)?.excludedPaths ?? [];
      const mode = FS_WRITE.has(parsed.action) ? 'write' : 'read';
      const candidate = path.isAbsolute(parsed.path)
        ? parsed.path
        : path.resolve(workspace.rootPath, parsed.path);
      const access = await checkWorkspaceAccess(workspace.access, candidate, mode, excluded);
      if (!access.allowed) {
        if (access.reason !== 'outside-scope') {
          return deny(access.message, { realPath: access.realPath });
        }
        // Outside every authorized directory: evaluated as a scope escape (never auto-allowed).
        action = 'scope.escape';
        realPath = access.realPath;
      } else {
        relativePath = access.relativePath;
        realPath = access.realPath;
      }
    }

    const settings = this.ctx.db.settings.getSync();
    const evaluations = this.policiesFor(agent, project.id).map((policy) =>
      evaluatePermission(policy, {
        action,
        ...(relativePath !== null ? { relativePath } : {}),
        ...(parsed.executable !== undefined ? { executable: parsed.executable } : {}),
        untrustedOrigin: parsed.untrustedOrigin,
        extraAskActions: settings.security.extraApprovalActions,
      }),
    );
    const decision = evaluations.map((e) => e.decision).reduce(mostRestrictive);
    const reason = evaluations.find((e) => e.decision === decision)?.reason ?? 'policy';
    const base: Verdict = { decision, reason, grantId: null, action, relativePath, realPath };
    if (action === 'scope.escape')
      base.reason = `path is outside the authorized directories (${reason})`;

    const liftable =
      decision === 'ask' &&
      !ALWAYS_ASK_ACTIONS.includes(action) &&
      !settings.security.extraApprovalActions.includes(action) &&
      !(parsed.untrustedOrigin && action !== 'fs.read');
    if (liftable) {
      const grant = this.ctx.db.grants
        .findActive({
          agentId: agent.id,
          action,
          projectId: project.id,
          sessionId: session?.id ?? null,
          now: nowTimestamp(),
        })
        .find((g) => grantMatches(g, relativePath, parsed.executable ?? null));
      if (grant)
        return {
          ...base,
          decision: 'allow',
          reason: `granted by approval (${grant.scope})`,
          grantId: grant.id,
        };
    }
    return base;
  }

  /**
   * Evaluates and APPLIES the decision: resolves on allow, throws PERMISSION_DENIED on deny,
   * and on ask creates an approval and waits for the human (or throws APPROVAL_REQUIRED when
   * `waitForApproval` is false). Every non-allow outcome is audited.
   */
  async enforce(input: EvaluatePermissionInput, options: EnforceOptions = {}): Promise<Verdict> {
    const verdict = await this.evaluate(input);
    const workspace = this.workspace(input.workspaceId);
    const target =
      verdict.relativePath ?? verdict.realPath ?? input.path ?? input.executable ?? null;
    const record = (
      outcome: 'success' | 'denied' | 'pending',
      details: Record<string, unknown> = {},
    ) =>
      audit(this.ctx, {
        action: 'permission.checked',
        actor: { type: 'agent', agentId: input.agentId },
        permission: verdict.action,
        projectId: workspace.projectId,
        target,
        outcome,
        details: {
          decision: verdict.decision,
          reason: verdict.reason,
          grantId: verdict.grantId,
          ...details,
        },
      });

    if (verdict.decision === 'allow') {
      if (verdict.grantId) record('success');
      return verdict;
    }
    if (verdict.decision === 'deny') {
      record('denied');
      throw new DevBrainError(
        verdict.action === 'scope.escape' ? 'PATH_OUTSIDE_SCOPE' : 'PERMISSION_DENIED',
        `Denied: ${verdict.reason}`,
        { details: { action: verdict.action } },
      );
    }
    const approval = await this.approvals.request({
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      executionId: options.executionId ?? null,
      projectId: workspace.projectId,
      action: verdict.action,
      risk: riskOf(verdict.action),
      summary: options.summary ?? `${verdict.action}${target ? ` → ${target}` : ''}`,
      details: { reason: verdict.reason, path: target, executable: input.executable ?? null },
      untrustedOrigin: input.untrustedOrigin ?? false,
      target: verdict.relativePath ?? (input.executable ? exeName(input.executable) : null),
    });
    if (options.waitForApproval === false) {
      throw new DevBrainError('APPROVAL_REQUIRED', 'Human approval required', {
        details: { approvalId: approval.id, action: verdict.action },
      });
    }
    const decided = await this.approvals.waitFor(approval.id, options.signal);
    if (decided.status !== 'approved') {
      throw new DevBrainError('PERMISSION_DENIED', `Approval ${decided.status}`, {
        details: { approvalId: decided.id, action: verdict.action },
      });
    }
    return { ...verdict, decision: 'allow', reason: `approved by user (${decided.scope})` };
  }

  /**
   * Authorizes a command spawned WITHOUT a shell. Every action the command implies
   * (`process.spawn`, `git.push`, `package.install`, ...) is enforced; the classifier floor
   * (e.g. shells and elevation) is combined most-restrictive.
   */
  async authorizeCommand(
    input: CommandAuthorizationInput,
    options: EnforceOptions = {},
  ): Promise<Verdict[]> {
    const assessment = assessCommand({ executable: input.executable, args: input.args });
    const base = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      untrustedOrigin: input.untrustedOrigin ?? false,
    };
    // The working directory itself must be inside the workspace.
    await this.enforce({ ...base, action: 'fs.read', path: input.cwd }, options);
    if (assessment.decision === 'deny') {
      audit(this.ctx, {
        action: 'permission.checked',
        actor: { type: 'agent', agentId: input.agentId },
        permission: 'process.spawn',
        target: exeName(input.executable),
        outcome: 'denied',
        details: { reasons: assessment.reasons },
      });
      throw new DevBrainError(
        'COMMAND_NOT_ALLOWED',
        `Command not allowed: ${assessment.reasons.join('; ')}`,
      );
    }
    const verdicts: Verdict[] = [];
    for (const action of assessment.actions) {
      const floorAsk = assessment.decision === 'ask' && action === 'process.spawn';
      const verdict = await this.enforce(
        {
          ...base,
          action,
          executable: input.executable,
          // A classifier "ask" (shell / interpreter) can never be lifted by a grant.
          ...(floorAsk ? { untrustedOrigin: true } : {}),
        },
        {
          ...options,
          summary:
            options.summary ?? `${exeName(input.executable)} ${input.args.join(' ')}`.slice(0, 500),
        },
      );
      verdicts.push(verdict);
    }
    return verdicts;
  }

  /**
   * Gate before the execution engine starts (or sends an instruction to) an agent process.
   * Validates session/agent/provider state, working directory scope and budget, computes the
   * enforcement plan, and — when the integration cannot enforce per-action permissions —
   * requires an explicit per-session human approval for running the agent.
   */
  async authorizeExecution(
    input: { sessionId: string; workingDirectory?: string },
    options: EnforceOptions = {},
  ): Promise<ExecutionAuthorization> {
    const session = this.ctx.db.sessions.findById(input.sessionId);
    if (!session) throw new DevBrainError('NOT_FOUND', 'Session not found');
    if (!['starting', 'active', 'idle'].includes(session.status)) {
      throw new DevBrainError('CONFLICT', `Session is ${session.status}`);
    }
    const agent = this.agent(session.agentId);
    if (agent.status === 'disabled' || agent.status === 'paused') {
      throw new DevBrainError('PERMISSION_DENIED', `Agent is ${agent.status}`);
    }
    const provider = this.ctx.db.providers.findById(agent.providerId);
    if (!provider?.provider.enabled)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider is disabled');
    const workspace = this.workspace(session.workspaceId);
    const [policy, ...overrides] = this.policiesFor(agent, session.projectId);
    if (!policy)
      throw new DevBrainError('PERMISSION_DENIED', 'Agent has no valid permission policy');

    const cwd = input.workingDirectory ?? workspace.rootPath;
    const access = await this.enforce(
      {
        agentId: agent.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        action: 'fs.read',
        path: cwd,
      },
      options,
    );
    this.usage.assertWithinBudget({ agentId: agent.id, policies: [policy, ...overrides] });

    // Most restrictive plan across the agent policy and the project override.
    const plans = [policy, ...overrides].map((p) =>
      planEnforcement(agent.capabilities, p, workspace.access.allowNetwork),
    );
    const plan = plans.reduce((a, b) => ({
      level: a.level,
      sandboxMode:
        a.sandboxMode === 'read-only' || b.sandboxMode === 'read-only'
          ? 'read-only'
          : a.sandboxMode,
      networkAllowed: a.networkAllowed && b.networkAllowed,
      requiresSessionApproval: a.requiresSessionApproval || b.requiresSessionApproval,
      limitations: [
        ...a.limitations,
        ...b.limitations.filter((l) => !a.limitations.some((x) => x.id === l.id)),
      ],
    }));

    if (plan.requiresSessionApproval) {
      const target = `agent:${provider.provider.adapterKey}`;
      const grant = this.ctx.db.grants
        .findActive({
          agentId: agent.id,
          action: 'process.spawn',
          projectId: session.projectId,
          sessionId: session.id,
          now: nowTimestamp(),
        })
        .find((g) => g.scope === 'session' && g.target === target);
      if (!grant) {
        const approval = await this.approvals.request({
          agentId: agent.id,
          sessionId: session.id,
          projectId: session.projectId,
          action: 'process.spawn',
          risk: 'high',
          summary: `Run ${provider.provider.displayName} in ${workspace.rootPath} without per-action enforcement`,
          details: {
            enforcement: plan.level,
            limitations: plan.limitations.map((l) => l.id),
            sandboxMode: plan.sandboxMode,
          },
          untrustedOrigin: false,
          target,
        });
        if (options.waitForApproval === false) {
          throw new DevBrainError(
            'APPROVAL_REQUIRED',
            'Approve running this agent for the session',
            {
              details: { approvalId: approval.id, limitations: plan.limitations },
            },
          );
        }
        const decided = await this.approvals.waitFor(approval.id, options.signal);
        if (decided.status !== 'approved') {
          throw new DevBrainError('PERMISSION_DENIED', `Session approval ${decided.status}`, {
            details: { approvalId: decided.id },
          });
        }
      }
    }

    const limits = [policy, ...overrides].reduce(
      (acc, p) => ({
        maxExecutionMs: Math.min(acc.maxExecutionMs, p.limits.maxExecutionMs),
        maxOutputBytes: Math.min(acc.maxOutputBytes, p.limits.maxOutputBytes),
      }),
      {
        maxExecutionMs: this.ctx.db.settings.getSync().execution.defaultTimeoutMs,
        maxOutputBytes: Number.MAX_SAFE_INTEGER,
      },
    );
    audit(this.ctx, {
      action: 'execution.authorized',
      actor: { type: 'agent', agentId: agent.id },
      permission: 'process.spawn',
      projectId: session.projectId,
      target: access.realPath,
      details: {
        sessionId: session.id,
        enforcement: plan.level,
        sandboxMode: plan.sandboxMode,
        network: plan.networkAllowed,
      },
    });
    return {
      session,
      agent,
      workspace,
      policy,
      plan,
      workingDirectory: access.realPath ?? cwd,
      limits,
    };
  }

  /**
   * Reserves an execution slot (global and per agent, from settings, policy limits and the
   * provider's verified max sessions). Returns the release function.
   */
  async acquireSlot(agentId: string, signal?: AbortSignal): Promise<() => void> {
    const settings = this.ctx.db.settings.getSync();
    const agent = this.agent(agentId);
    const policy = this.ctx.db.policies.findById(agent.permissionPolicyId);
    const perAgentLimit = Math.min(
      settings.execution.maxConcurrentPerAgent,
      policy?.limits.maxConcurrentExecutions ?? 1,
      agent.capabilities.maxConcurrentSessions ?? Number.MAX_SAFE_INTEGER,
    );
    const globalLimit = settings.execution.maxConcurrentExecutions;
    let global = this.global.get(globalLimit);
    if (!global) {
      global = new ConcurrencyLimiter(globalLimit, 1000);
      this.global.clear();
      this.global.set(globalLimit, global);
    }
    let entry = this.perAgent.get(agentId);
    if (!entry || entry.limit !== perAgentLimit) {
      entry = { limit: perAgentLimit, limiter: new ConcurrencyLimiter(perAgentLimit, 1000) };
      this.perAgent.set(agentId, entry);
    }
    const releaseAgent = await entry.limiter.acquire(signal);
    try {
      const releaseGlobal = await global.acquire(signal);
      return () => {
        releaseGlobal();
        releaseAgent();
      };
    } catch (error) {
      releaseAgent();
      throw error;
    }
  }
}
