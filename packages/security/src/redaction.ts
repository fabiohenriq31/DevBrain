/**
 * Redaction of sensitive data before logging, persisting audit details, or displaying
 * agent output. Heuristic by nature: it reduces exposure but is not a substitute for never
 * handling secret values outside the credential vault.
 */

export const REDACTED = '[REDACTED]';

interface Pattern {
  name: string;
  regex: RegExp;
  /** Replace only this capture group (1-based) instead of the whole match. */
  group?: number;
}

const PATTERNS: readonly Pattern[] = [
  {
    name: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer', regex: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, group: 2 },
  { name: 'url-credentials', regex: /(\/\/[^/\s:@]+:)([^/\s@]+)(@)/g, group: 2 },
  {
    name: 'assignment',
    regex:
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi,
    group: 2,
  },
];

const SENSITIVE_KEY =
  /^(?:.*[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|session[_-]?key)s?$/i;

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

export const redactString = (input: string): string => {
  let output = input;
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.group === undefined) {
      output = output.replace(pattern.regex, REDACTED);
    } else {
      const group = pattern.group;
      output = output.replace(pattern.regex, (...args: unknown[]) => {
        const groups = args.slice(1, -2) as (string | undefined)[];
        return groups.map((g, i) => (i + 1 === group ? REDACTED : (g ?? ''))).join('');
      });
    }
  }
  return output;
};

/** Deep-redacts a JSON-like value: sensitive keys are masked, strings are pattern-scanned. */
export const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 20) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] =
        isSensitiveKey(key) && v !== null && v !== undefined && v !== ''
          ? REDACTED
          : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
};

export const redactRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  redactValue(value) as Record<string, unknown>;

/** Removes `user:password@` from URLs (used for git remotes and endpoints). */
export const stripUrlCredentials = (url: string): string => url.replace(/(\/\/)[^/@\s]+@/, '$1');
