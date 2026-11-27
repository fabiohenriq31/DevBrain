import { z } from 'zod';

/** ISO-8601 UTC timestamp, e.g. `2026-11-27T12:00:00.000Z`. */
export const TimestampSchema = z.iso.datetime({ offset: false });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const nowTimestamp = (): Timestamp => new Date().toISOString();

/** Entity id prefixes. Ids are `<prefix>_<uuid-v4>`. */
export const ID_PREFIXES = {
  project: 'prj',
  workspace: 'wks',
  provider: 'prv',
  agent: 'agt',
  session: 'ses',
  execution: 'exe',
  event: 'evt',
  policy: 'pol',
  approval: 'apr',
  credential: 'crd',
  checkpoint: 'chk',
  audit: 'aud',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const idSchema = <K extends IdKind>(kind: K) =>
  z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[kind]}_${UUID}$`), `Invalid ${kind} id`)
    .describe(`${kind} id`);

export const newId = (kind: IdKind): string => `${ID_PREFIXES[kind]}_${crypto.randomUUID()}`;

export const ProjectIdSchema = idSchema('project');
export const WorkspaceIdSchema = idSchema('workspace');
export const ProviderIdSchema = idSchema('provider');
export const AgentIdSchema = idSchema('agent');
export const SessionIdSchema = idSchema('session');
export const ExecutionIdSchema = idSchema('execution');
export const EventIdSchema = idSchema('event');
export const PolicyIdSchema = idSchema('policy');
export const ApprovalIdSchema = idSchema('approval');
export const CredentialIdSchema = idSchema('credential');
export const CheckpointIdSchema = idSchema('checkpoint');
export const AuditIdSchema = idSchema('audit');

/**
 * Absolute filesystem path as provided by a caller. This schema only checks shape;
 * confinement (no traversal, inside workspace) is enforced by `@devbrain/security`.
 */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'Path must not contain NUL bytes')
  .refine((p) => /^(?:[A-Za-z]:[\\/]|\/)/.test(p), 'Path must be absolute');
export type AbsolutePath = z.infer<typeof AbsolutePathSchema>;

/** Workspace-relative path (forward or back slashes). */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'Path must not contain NUL bytes');

export const NonEmptyStringSchema = z.string().trim().min(1);

/** Free-form JSON-safe metadata. Must never carry secret values. */
export const MetadataSchema = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof MetadataSchema>;

export const PageRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type PageRequest = z.input<typeof PageRequestSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
