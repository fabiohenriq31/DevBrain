import { z } from 'zod';

/**
 * @since 0.7.0 — what an inference is for. Drives eligibility (hard requirements) and scoring
 * (specialty). Deterministic code classifies tasks when the caller does not.
 */
export const TaskKindSchema = z.enum([
  'architecture',
  'coding',
  'bugfix',
  'testing',
  'documentation',
  'classification',
  'summarization',
  'log-analysis',
  'security',
  'research',
  'structured-output',
  'tool-use',
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** Capacity tiers, from evidence when available, otherwise from conservative metadata. */
export const QualityTierSchema = z.enum(['basic', 'standard', 'advanced', 'frontier']);
export type QualityTier = z.infer<typeof QualityTierSchema>;

/** `critical` may use reserved capacity; `background` yields first. */
export const TaskPrioritySchema = z.enum(['critical', 'high', 'normal', 'low', 'background']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskProfileSchema = z.object({
  kind: TaskKindSchema,
  priority: TaskPrioritySchema.default('normal'),
  /** Minimum capacity the task needs. Never silently lowered by routing. */
  minQualityTier: QualityTierSchema.optional(),
  requiresTools: z.boolean().default(false),
  requiresStructuredOutput: z.boolean().default(false),
  requiresReasoning: z.boolean().default(false),
});
export type TaskProfile = z.infer<typeof TaskProfileSchema>;
