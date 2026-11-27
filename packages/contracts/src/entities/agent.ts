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

export const SessionStatusSchema = z.enum([
  'starting',
  'active',
  'idle',
  'suspended',
  'ended',
  'failed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

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
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const StartSessionInputSchema = z.object({
  agentId: AgentIdSchema,
  projectId: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  resumeFromCheckpointId: CheckpointIdSchema.optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export const SessionRefInputSchema = z.object({ sessionId: SessionIdSchema });
export type SessionRefInput = z.infer<typeof SessionRefInputSchema>;
