import { z } from 'zod';

/** Stable error codes. Adding codes is MINOR; removing/renaming is MAJOR. */
export const ErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'PATH_OUTSIDE_SCOPE',
  'COMMAND_NOT_ALLOWED',
  'DEPENDENCY_MISSING',
  'PROVIDER_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'TIMEOUT',
  'CANCELLED',
  'CONCURRENCY_LIMIT',
  'CREDENTIAL_UNAVAILABLE',
  'UNSUPPORTED',
  'CONTRACT_VERSION_MISMATCH',
  /** @since 0.2.0 — the owning process died; state was recovered, not resumed. */
  'INTERRUPTED',
  /** @since 0.2.0 — local database failure (busy, corrupt, disk full). */
  'STORAGE_ERROR',
  /** @since 0.2.0 */
  'BUDGET_EXCEEDED',
  /**
   * @since 0.4.0 — a financial limit applies but the integration cannot report cost, so the
   * limit cannot be enforced (unknown cost is never treated as zero).
   */
  'BUDGET_UNENFORCEABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Serializable error crossing process/IPC boundaries.
 * `message` must already be redacted; never include stack traces or secrets.
 */
export const DevBrainErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().max(2000),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
});
export type DevBrainErrorPayload = z.infer<typeof DevBrainErrorSchema>;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'CONCURRENCY_LIMIT',
]);

export class DevBrainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DevBrainError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  toPayload(correlationId?: string): DevBrainErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(correlationId ? { correlationId } : {}),
    };
  }

  static is(value: unknown): value is DevBrainError {
    return value instanceof DevBrainError;
  }
}

/** Converts any thrown value into a safe payload. Unknown errors become INTERNAL. */
export const toErrorPayload = (error: unknown, correlationId?: string): DevBrainErrorPayload => {
  if (DevBrainError.is(error)) return error.toPayload(correlationId);
  return {
    code: 'INTERNAL',
    message: 'Internal error',
    retryable: false,
    ...(correlationId ? { correlationId } : {}),
  };
};

export type Result<T, E = DevBrainErrorPayload> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Parses at a trust boundary, converting validation failures into `VALIDATION_FAILED`. */
export const parseOrThrow = <S extends z.ZodType>(
  schema: S,
  value: unknown,
  what = 'input',
): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DevBrainError('VALIDATION_FAILED', `Invalid ${what}`, {
      details: {
        issues: result.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      },
    });
  }
  return result.data;
};
