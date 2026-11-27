import {
  ALWAYS_ASK_ACTIONS,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionRule,
  type PermissionVerdict,
} from '@devbrain/contracts';

/**
 * Pure permission evaluation. Inputs are already-confined paths (see `paths.ts`).
 *
 * Order:
 * 1. Candidate rules = rules for the action whose `paths`/`executables` filters match.
 * 2. Most specific wins (rules with filters beat unfiltered rules); on ties the most
 *    restrictive wins (deny > ask > allow).
 * 3. No candidate -> policy.defaultDecision.
 * 4. Floors: ALWAYS_ASK_ACTIONS and requests of untrusted origin can never be auto-allowed.
 */

const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

export const mostRestrictive = (
  a: PermissionDecision,
  b: PermissionDecision,
): PermissionDecision => (RANK[a] >= RANK[b] ? a : b);

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. Paths use `/`. */
export const globToRegExp = (glob: string): RegExp => {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
};

export interface EvaluationInput {
  action: PermissionAction;
  /** Workspace-relative, `/`-separated path. */
  relativePath?: string;
  executable?: string;
  untrustedOrigin?: boolean;
  /** Extra actions configured in settings to always require approval. */
  extraAskActions?: readonly PermissionAction[];
}

const executableName = (value: string): string =>
  (value.split(/[\\/]/).pop() ?? value).replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();

const ruleMatches = (rule: PermissionRule, input: EvaluationInput): boolean => {
  if (rule.action !== input.action) return false;
  if (rule.paths) {
    if (input.relativePath === undefined) return false;
    const target = input.relativePath;
    if (!rule.paths.some((g) => globToRegExp(g).test(target))) return false;
  }
  if (rule.executables) {
    if (input.executable === undefined) return false;
    const name = executableName(input.executable);
    if (!rule.executables.some((e) => executableName(e) === name)) return false;
  }
  return true;
};

const specificity = (rule: PermissionRule): number =>
  (rule.paths ? 1 : 0) + (rule.executables ? 1 : 0);

export const evaluatePermission = (
  policy: PermissionPolicy,
  input: EvaluationInput,
): PermissionVerdict => {
  const candidates = policy.rules.filter((rule) => ruleMatches(rule, input));
  let decision: PermissionDecision;
  let reason: string;
  if (candidates.length === 0) {
    decision = policy.defaultDecision;
    reason = `default decision of policy "${policy.name}"`;
  } else {
    const top = Math.max(...candidates.map(specificity));
    decision = candidates
      .filter((r) => specificity(r) === top)
      .map((r) => r.decision)
      .reduce(mostRestrictive);
    reason = `rule for ${input.action} in policy "${policy.name}"`;
  }

  if (decision === 'allow') {
    if (
      ALWAYS_ASK_ACTIONS.includes(input.action) ||
      input.extraAskActions?.includes(input.action)
    ) {
      return { decision: 'ask', reason: `${input.action} always requires human approval` };
    }
    if (input.untrustedOrigin && input.action !== 'fs.read') {
      return { decision: 'ask', reason: 'request originated from untrusted content' };
    }
  }
  return { decision, reason };
};

/** Conservative default policy for newly configured agents. */
export const createDefaultPolicy = (
  id: string,
  name = 'Default (restrictive)',
): PermissionPolicy => ({
  id,
  name,
  version: 1,
  defaultDecision: 'ask',
  rules: [
    { action: 'fs.read', decision: 'allow' },
    { action: 'fs.write', decision: 'allow' },
    {
      action: 'fs.read',
      decision: 'deny',
      paths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*'],
    },
    { action: 'fs.write', decision: 'deny', paths: ['.git/**', '**/.git/**'] },
    { action: 'git.commit', decision: 'allow' },
    { action: 'credential.use', decision: 'deny' },
    { action: 'privilege.elevate', decision: 'deny' },
    { action: 'git.force-push', decision: 'deny' },
  ],
  limits: {
    maxConcurrentExecutions: 2,
    maxExecutionMs: 30 * 60 * 1000,
    maxOutputBytes: 16 * 1024 * 1024,
  },
  budget: null,
});
