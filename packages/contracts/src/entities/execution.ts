import { z } from 'zod';
import {
  AbsolutePathSchema,
  ApprovalIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  SessionIdSchema,
  TimestampSchema,
} from '../common.js';
import { DevBrainErrorSchema } from '../errors.js';
import { PermissionActionSchema } from './permissions.js';

export const ExecutionStatusSchema = z.enum([
  'queued',
  'awaiting-approval',
  'running',
  'interrupting',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export const isTerminalStatus = (status: ExecutionStatus): boolean =>
  TERMINAL_EXECUTION_STATUSES.has(status);

/** Allowed status transitions. Anything else is a bug in the execution engine. */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> =
  Object.freeze({
    queued: ['awaiting-approval', 'running', 'cancelled'],
    'awaiting-approval': ['queued', 'running', 'cancelled'],
    running: ['awaiting-approval', 'interrupting', 'completed', 'failed', 'timed-out'],
    interrupting: ['cancelled', 'failed', 'completed'],
    completed: [],
    failed: [],
    cancelled: [],
    'timed-out': [],
  });

export const canTransition = (from: ExecutionStatus, to: ExecutionStatus): boolean =>
  EXECUTION_TRANSITIONS[from].includes(to);

/** An instruction sent to an agent (natural-language prompt). */
/**
 * @since 0.8.0 — options for agents that run on the DevBrain AI gateway (`devbrain-agent`).
 * Limits are hard caps enforced by the runtime; model text can never raise them.
 */
export const GatewayAgentOptionsSchema = z.object({
  routingPolicyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{1,127}$/),
  /** Pin one model; null = intelligent routing under the policy. */
  modelId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:-]{1,127}$/)
    .nullable()
    .default(null),
  /** Commands the user pre-authorized for `run_command` (no shell; model picks by id). */
  allowedCommands: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
        executable: z.string().min(1).max(1024),
        args: z.array(z.string().max(4096)).max(64),
        timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
      }),
    )
    .max(20)
    .default([]),
  maxTurns: z.number().int().min(1).max(100).default(24),
  maxToolCalls: z.number().int().min(1).max(500).default(80),
  maxTotalTokens: z.number().int().min(1000).max(10_000_000).default(400_000),
  maxDurationMs: z
    .number()
    .int()
    .min(10_000)
    .max(4 * 60 * 60 * 1000)
    .default(20 * 60 * 1000),
  maxOutputTokensPerTurn: z.number().int().min(64).max(64_000).default(4096),
});
export type GatewayAgentOptions = z.infer<typeof GatewayAgentOptionsSchema>;

const PromptPayloadSchema = z.object({
  kind: z.literal('prompt'),
  prompt: z.string().min(1).max(1_000_000),
  /** Workspace-relative files attached as context. Content is treated as untrusted. */
  contextFiles: z.array(z.string().min(1)).max(500).default([]),
  /** @since 0.8.0 — required by gateway agents, ignored by CLI agents. */
  gateway: GatewayAgentOptionsSchema.optional(),
});

/**
 * A direct process invocation. `executable` + `args` are passed to spawn WITHOUT a shell;
 * shell strings are not accepted.
 */
const CommandPayloadSchema = z.object({
  kind: z.literal('command'),
  executable: z.string().min(1).max(1024),
  args: z.array(z.string().max(32_768)).max(1024),
});

export const ExecutionPayloadSchema = z.discriminatedUnion('kind', [
  PromptPayloadSchema,
  CommandPayloadSchema,
]);
export type ExecutionPayload = z.infer<typeof ExecutionPayloadSchema>;

export const ExecutionRequestSchema = z.object({
  id: ExecutionIdSchema,
  sessionId: SessionIdSchema,
  payload: ExecutionPayloadSchema,
  /** Must resolve inside the session's workspace. */
  workingDirectory: AbsolutePathSchema,
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000),
  /** Names of environment variables to forward (values are resolved in main, never sent). */
  envAllowlist: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(100)
    .default([]),
  /** Used to deduplicate retries after a crash or failover. */
  idempotencyKey: z.string().min(8).max(200).nullable(),
  createdAt: TimestampSchema,
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type ExecutionRequestInput = z.input<typeof ExecutionRequestSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costAmount: z.number().nonnegative().nullable(),
  costCurrency: z.string().length(3).nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

const EventBase = {
  id: EventIdSchema,
  executionId: ExecutionIdSchema,
  sessionId: SessionIdSchema,
  /** Monotonic per execution, starting at 0. Consumers use it to order and dedupe. */
  seq: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
};

/**
 * Streaming events. Text payloads (`output`, `message`) come from agents or tools and are
 * UNTRUSTED: they must never be interpreted as instructions to DevBrain.
 */
export const ExecutionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('status'), status: ExecutionStatusSchema }),
  z.object({
    ...EventBase,
    type: z.literal('output'),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string().max(1_048_576),
  }),
  z.object({
    ...EventBase,
    type: z.literal('message'),
    role: z.enum(['assistant', 'system', 'tool']),
    text: z.string().max(1_048_576),
  }),
  z.object({
    ...EventBase,
    type: z.literal('tool-call'),
    tool: z.string().max(200),
    input: z.record(z.string(), z.unknown()),
    /** @since 0.8.0 — correlation id and execution state (gateway agents). */
    callId: z.string().max(200).optional(),
    state: z
      .enum([
        'proposed',
        'invalid',
        'denied',
        'awaiting-approval',
        'running',
        'succeeded',
        'failed',
        'unknown',
      ])
      .optional(),
    /** Redacted, truncated result summary. */
    result: z.string().max(65_536).optional(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('approval-required'),
    approvalId: ApprovalIdSchema,
    action: PermissionActionSchema,
  }),
  z.object({
    ...EventBase,
    type: z.literal('file-change'),
    path: z.string().max(4096),
    change: z.enum(['created', 'modified', 'deleted', 'renamed']),
  }),
  z.object({ ...EventBase, type: z.literal('usage'), usage: UsageSchema }),
  z.object({ ...EventBase, type: z.literal('error'), error: DevBrainErrorSchema }),
  z.object({ ...EventBase, type: z.literal('heartbeat') }),
]);
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ExecutionEventType = ExecutionEvent['type'];

export const ExecutionResultSchema = z.object({
  executionId: ExecutionIdSchema,
  sessionId: SessionIdSchema,
  status: ExecutionStatusSchema.refine(isTerminalStatus, 'Result status must be terminal'),
  exitCode: z.number().int().nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema,
  /** Short redacted summary. */
  summary: z.string().max(10_000).nullable(),
  usage: UsageSchema.nullable(),
  error: DevBrainErrorSchema.nullable(),
  /** True when output was cut at `maxOutputBytes`. */
  outputTruncated: z.boolean(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ExecutionRefInputSchema = z.object({ executionId: ExecutionIdSchema });
export type ExecutionRefInput = z.infer<typeof ExecutionRefInputSchema>;

export const InterruptInputSchema = z.object({
  executionId: ExecutionIdSchema,
  /** `graceful`: ask the agent to stop; `force`: terminate the process tree. */
  mode: z.enum(['graceful', 'force']).default('graceful'),
});
export type InterruptInput = z.input<typeof InterruptInputSchema>;

export const ListExecutionEventsInputSchema = z.object({
  executionId: ExecutionIdSchema,
  afterSeq: z.number().int().min(-1).default(-1),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type ListExecutionEventsInput = z.input<typeof ListExecutionEventsInputSchema>;
