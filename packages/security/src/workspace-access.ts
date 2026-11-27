import { realpath as realpathCb } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { DevBrainError, type WorkspaceAccessPolicy } from '@devbrain/contracts';
import { globToRegExp } from './policy.js';
import {
  assertSafePathSyntax,
  isWithinRoot,
  resolveRealPathWithinRoot,
  toPortableRelative,
} from './paths.js';

const realpathNative = promisify(realpathCb.native);

/** Paths never exposed to agents regardless of policy (private config and secrets). */
export const DEFAULT_EXCLUDED_GLOBS: readonly string[] = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.claude/settings.local.json',
]);

export type AccessMode = 'read' | 'write';

export type AccessResult =
  | {
      allowed: true;
      /** Real (symlink/junction-resolved) absolute path. */
      realPath: string;
      root: string;
      /** `/`-separated path relative to the matching root. */
      relativePath: string;
    }
  | {
      allowed: false;
      reason: 'outside-scope' | 'read-only' | 'excluded' | 'invalid-path';
      message: string;
      realPath: string | null;
    };

const realRoot = async (root: string): Promise<string> => {
  try {
    return await realpathNative(root);
  } catch {
    return root;
  }
};

/**
 * Central workspace access check (real paths). Junctions and symlinks are resolved before
 * containment is evaluated, so a link inside the workspace pointing outside is treated as
 * outside. `excludedGlobs` are relative to the matching root.
 */
export const checkWorkspaceAccess = async (
  access: WorkspaceAccessPolicy,
  candidate: string,
  mode: AccessMode,
  excludedGlobs: readonly string[] = [],
): Promise<AccessResult> => {
  try {
    assertSafePathSyntax(candidate);
  } catch (error) {
    return {
      allowed: false,
      reason: 'invalid-path',
      message: DevBrainError.is(error) ? error.message : 'Invalid path',
      realPath: null,
    };
  }
  const roots = await Promise.all(access.allowedRoots.map(realRoot));
  const readOnly = await Promise.all(access.readOnlyRoots.map(realRoot));

  for (const [index, root] of roots.entries()) {
    const configuredRoot = access.allowedRoots[index] ?? root;
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(configuredRoot, candidate);
    // Accept candidates expressed against either the configured or the real root.
    const base = isWithinRoot(configuredRoot, absolute)
      ? configuredRoot
      : isWithinRoot(root, absolute)
        ? root
        : null;
    if (!base) continue;
    let real: string;
    try {
      real = await resolveRealPathWithinRoot(base, absolute);
    } catch (error) {
      return {
        allowed: false,
        reason: 'outside-scope',
        message: DevBrainError.is(error) ? error.message : 'Path escapes the workspace',
        realPath: null,
      };
    }
    if (!isWithinRoot(root, real)) {
      return {
        allowed: false,
        reason: 'outside-scope',
        message: 'Path resolves outside the workspace',
        realPath: real,
      };
    }
    const relativePath = toPortableRelative(root, real);
    const globs = [...DEFAULT_EXCLUDED_GLOBS, ...excludedGlobs];
    if (relativePath && globs.some((g) => globToRegExp(g).test(relativePath))) {
      return {
        allowed: false,
        reason: 'excluded',
        message: 'Path is excluded from agent access',
        realPath: real,
      };
    }
    if (mode === 'write' && readOnly.some((r) => isWithinRoot(r, real))) {
      return { allowed: false, reason: 'read-only', message: 'Path is read-only', realPath: real };
    }
    return { allowed: true, realPath: real, root, relativePath };
  }
  return {
    allowed: false,
    reason: 'outside-scope',
    message: 'Path is outside every authorized directory',
    realPath: null,
  };
};
