import { z } from 'zod';
import {
  AgentIdSchema,
  ApprovalIdSchema,
  ExecutionIdSchema,
  NonEmptyStringSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  TimestampSchema,
} from '../common.js';

/** Sensitive actions an agent may attempt. New actions are a MINOR contract change. */
export const PermissionActionSchema = z.enum([
  'fs.read',
  'fs.write',
  'fs.delete',
  'process.spawn',
  'network.request',
  'git.commit',
  'git.push',
  'git.force-push',
  'git.branch-delete',
  'git.history-rewrite',
  'package.install',
  'credential.use',
  'privilege.elevate',
  'external.publish',
  'scope.escape',
]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const PermissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PermissionRuleSchema = z.object({
  action: PermissionActionSchema,
  decision: PermissionDecisionSchema,
  /**
   * Optional path globs (workspace-relative, `/` separators) the rule applies to.
   * Omitted = applies to every path.
   */
  paths: z.array(z.string().min(1)).optional(),
  /** Optional executable names (for `process.spawn`). */
  executables: z.array(z.string().min(1)).optional(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const ExecutionLimitsSchema = z.object({
  maxConcurrentExecutions: z.number().int().min(1).max(64),
  maxExecutionMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024),
});
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

export const BudgetSchema = z.object({
  currency: z.string().length(3),
  maxPerExecution: z.number().nonnegative().nullable(),
  maxPerDay: z.number().nonnegative().nullable(),
});
export type Budget = z.infer<typeof BudgetSchema>;

/**
 * Per-agent permission policy. Evaluation order (see `@devbrain/security`):
 * 1. Most specific matching rule wins; `deny` beats `ask` beats `allow` on ties.
 * 2. No rule matches -> `defaultDecision`.
 * 3. Actions in `ALWAYS_ASK_ACTIONS` are raised to at least `ask` regardless of the policy.
 */
export const PermissionPolicySchema = z.object({
  id: PolicyIdSchema,
  name: NonEmptyStringSchema.max(200),
  version: z.number().int().min(1),
  defaultDecision: PermissionDecisionSchema,
  rules: z.array(PermissionRuleSchema),
  limits: ExecutionLimitsSchema,
  budget: BudgetSchema.nullable(),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/**
 * Actions that always require explicit human approval (destructive operations,
 * privilege elevation, external publication, access outside the authorized scope).
 * A policy may `deny` them but can never auto-`allow` them.
 */
export const ALWAYS_ASK_ACTIONS: readonly PermissionAction[] = Object.freeze([
  'fs.delete',
  'git.push',
  'git.force-push',
  'git.branch-delete',
  'git.history-rewrite',
  'privilege.elevate',
  'external.publish',
  'scope.escape',
]);

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * How far an approval reaches.
 * - `once`: only the execution/action that requested it.
 * - `session`: same agent + action (+ target filter) for the rest of the session.
 * - `project`: same agent + action (+ target filter) in the project until revoked/expired.
 * Actions in ALWAYS_ASK_ACTIONS can only be approved `once`.
 */
export const ApprovalScopeSchema = z.enum(['once', 'session', 'project']);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z.object({
  id: ApprovalIdSchema,
  agentId: AgentIdSchema,
  sessionId: SessionIdSchema.nullable(),
  executionId: ExecutionIdSchema.nullable(),
  action: PermissionActionSchema,
  risk: RiskLevelSchema,
  /** Human-readable summary. Already redacted. */
  summary: z.string().min(1).max(2000),
  /** Structured, redacted details (command, paths, remote...). */
  details: z.record(z.string(), z.unknown()),
  /** True if the request was triggered by content from an untrusted source. */
  untrustedOrigin: z.boolean(),
  status: ApprovalStatusSchema,
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  /** `user` only. Agents can never decide approvals. */
  decidedBy: z.literal('user').nullable(),
  decisionNote: z.string().max(2000).nullable(),
  /** @since 0.2.0 */
  projectId: ProjectIdSchema.nullable().default(null),
  /** @since 0.2.0 — scope granted by the user when approving. */
  scope: ApprovalScopeSchema.default('once'),
  /** @since 0.2.0 — workspace-relative path / executable the request is about. */
  target: z.string().max(4096).nullable().default(null),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionInputSchema = z.object({
  approvalId: ApprovalIdSchema,
  decision: z.enum(['approved', 'denied']),
  note: z.string().max(2000).optional(),
  /** @since 0.2.0 */
  scope: ApprovalScopeSchema.optional(),
  /** @since 0.2.0 — lifetime of a session/project grant (default: settings). */
  grantTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;
