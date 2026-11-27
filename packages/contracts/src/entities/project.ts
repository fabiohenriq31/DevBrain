import { z } from 'zod';
import {
  AbsolutePathSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ProjectIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from '../common.js';

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: NonEmptyStringSchema.max(200),
  rootPath: AbsolutePathSchema,
  description: z.string().max(4000).nullable(),
  isGitRepository: z.boolean(),
  defaultWorkspaceId: WorkspaceIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  metadata: MetadataSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Workspace access policy. All paths are absolute and every agent operation must be
 * confined to `allowedRoots` (enforced by `@devbrain/security`).
 */
export const WorkspaceAccessPolicySchema = z.object({
  allowedRoots: z.array(AbsolutePathSchema).min(1),
  readOnlyRoots: z.array(AbsolutePathSchema),
  allowNetwork: z.boolean(),
});
export type WorkspaceAccessPolicy = z.infer<typeof WorkspaceAccessPolicySchema>;

export const WorkspaceKindSchema = z.enum(['primary', 'git-worktree']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

/**
 * A working directory of a project. `git-worktree` workspaces isolate *code changes*
 * between tasks; they are NOT security sandboxes (see docs/SECURITY.md).
 */
export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema.max(200),
  kind: WorkspaceKindSchema,
  rootPath: AbsolutePathSchema,
  branch: z.string().nullable(),
  access: WorkspaceAccessPolicySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const RegisterProjectInputSchema = z.object({
  rootPath: AbsolutePathSchema,
  name: NonEmptyStringSchema.max(200).optional(),
  description: z.string().max(4000).optional(),
});
export type RegisterProjectInput = z.infer<typeof RegisterProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  id: ProjectIdSchema,
  name: NonEmptyStringSchema.max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const ListProjectsInputSchema = z.object({
  includeArchived: z.boolean().default(false),
});
export type ListProjectsInput = z.input<typeof ListProjectsInputSchema>;

export const ProjectRefInputSchema = z.object({ id: ProjectIdSchema });
export type ProjectRefInput = z.infer<typeof ProjectRefInputSchema>;
