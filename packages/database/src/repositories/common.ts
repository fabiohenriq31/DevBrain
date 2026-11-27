import { DevBrainError } from '@devbrain/contracts';
import type { z } from 'zod';

export const json = (value: unknown): string => JSON.stringify(value);

/**
 * Parses a JSON column and validates it against its contract. Corrupt rows surface as
 * STORAGE_ERROR instead of crashing callers with a SyntaxError/ZodError.
 */
export const fromJson = <S extends z.ZodType>(
  schema: S,
  raw: unknown,
  what: string,
): z.output<S> => {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new DevBrainError('STORAGE_ERROR', `Stored ${what} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DevBrainError('STORAGE_ERROR', `Stored ${what} failed validation`);
  return parsed.data;
};

/** Validates before writing; invalid data is a programming error of the caller. */
export const validated = <S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DevBrainError('VALIDATION_FAILED', `Invalid ${what}`, {
      details: {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      },
    });
  }
  return parsed.data;
};

/** Key used for uniqueness of filesystem paths (case-insensitive on Windows/macOS). */
export const pathKey = (p: string, platform: NodeJS.Platform = process.platform): string => {
  const trimmed = p.replace(/[\\/]+$/, '') || p;
  const unified = platform === 'win32' ? trimmed.replace(/\//g, '\\') : trimmed;
  return platform === 'win32' || platform === 'darwin' ? unified.toLowerCase() : unified;
};

export const notFound = (what: string, id?: string): DevBrainError =>
  new DevBrainError('NOT_FOUND', `${what} not found`, id ? { details: { id } } : {});
