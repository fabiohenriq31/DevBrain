import { z } from 'zod';
import {
  AgentIdSchema,
  CheckpointIdSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from '../common.js';
import { AgentCapabilitiesSchema } from './provider.js';

export const AgentStatusSchema = z.enum(['idle', 'busy', 'paused', 'unavailable', 'disabled']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** A configured agent: provider + model/role + permission policy. */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  providerId: ProviderIdSchema,
  name: NonEmptyStringSchema.max(200),
  role: z.string().max(200).nullable(),
  model: z.string().max(200).nullable(),
  capabilities: AgentCapabilitiesSchema,
  permissionPolicyId: PolicyIdSchema,
  status: AgentStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Session lifecycle.
 * - `starting` / `active` / `idle`: live (owned by the running app instance).
 * - `completed`: ended normally. `cancelled`: stopped by the user.
 * - `interrupted`: the owning process died (crash, kill, shutdown) — detected at startup.
 *   The process is NOT resumed; a new session may be started from the last checkpoint.
 * - `failed`: ended with an error.
 * - `suspended`, `ended`: deprecated since 0.2.0 (accepted on read, never produced;
 *   `ended` is read as `completed`).
 */
export const SessionStatusSchema = z.enum([
  'starting',
  'active',
  'idle',
  'suspended',
  'ended',
  'failed',
  'completed',
  'cancelled',
  'interrupted',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = Object.freeze([
  'starting',
  'active',
  'idle',
]);
export const isLiveSession = (status: SessionStatus): boolean =>
  LIVE_SESSION_STATUSES.includes(status);

export const AgentSessionSchema = z.object({
  id: SessionIdSchema,
  agentId: AgentIdSchema,
  projectId: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  status: SessionStatusSchema,
  /** Provider-side session identifier, when the provider supports resuming. */
  externalSessionId: z.string().max(500).nullable(),
  lastCheckpointId: CheckpointIdSchema.nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  /** @since 0.2.0 */
  title: z.string().max(200).nullable().default(null),
  /** @since 0.2.0 — redacted reason for cancelled/interrupted/failed. */
  endReason: z.string().max(2000).nullable().default(null),
  /** @since 0.2.0 — set when started as a conscious re-run of an earlier session. */
  resumedFromSessionId: SessionIdSchema.nullable().default(null),
  /** @since 0.2.0 */
  updatedAt: TimestampSchema.nullable().default(null),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const StartSessionInputSchema = z.object({
  agentId: AgentIdSchema,
  projectId: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  resumeFromCheckpointId: CheckpointIdSchema.optional(),
  /** @since 0.2.0 */
  title: z.string().max(200).optional(),
  /** @since 0.2.0 — start a new session continuing from an earlier (ended) one. */
  resumeFromSessionId: SessionIdSchema.optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export const SessionRefInputSchema = z.object({ sessionId: SessionIdSchema });
export type SessionRefInput = z.infer<typeof SessionRefInputSchema>;
