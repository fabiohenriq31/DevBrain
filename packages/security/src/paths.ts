import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { DevBrainError } from '@devbrain/contracts';

/**
 * Path confinement. All filesystem access requested by the renderer or by agents must go
 * through these helpers. They reject:
 * - NUL bytes, Windows device/UNC namespaces (`\\?\`, `\\.\`, `\\server\share`)
 * - Windows reserved device names (CON, NUL, COM1...)
 * - NTFS alternate data streams (`file.txt:stream`)
 * - traversal outside the root (`..`, absolute paths elsewhere, other drives)
 * - symlink/junction escapes (`resolveRealPathWithinRoot`)
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export interface PathOptions {
  /** Defaults to `process.platform`. Exposed for tests. */
  platform?: NodeJS.Platform;
}

const api = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

const fail = (message: string, candidate: string): never => {
  throw new DevBrainError('PATH_OUTSIDE_SCOPE', message, { details: { path: candidate } });
};

/** Validates syntactic safety of a raw path string (no filesystem access). */
export const assertSafePathSyntax = (candidate: string, options: PathOptions = {}): void => {
  const platform = options.platform ?? process.platform;
  if (typeof candidate !== 'string' || candidate.length === 0)
    fail('Empty path', String(candidate));
  if (candidate.length > 4096) fail('Path too long', candidate.slice(0, 64));
  if (candidate.includes('\0')) fail('Path contains NUL byte', candidate);
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(candidate)) fail('UNC and device paths are not allowed', candidate);
    const segments = candidate.split(/[\\/]/);
    for (const [index, segment] of segments.entries()) {
      // Drive letter "C:" is only legal as the first segment.
      const isDrive = index === 0 && /^[A-Za-z]:$/.test(segment);
      if (!isDrive && segment.includes(':'))
        fail('Alternate data streams are not allowed', candidate);
      if (WINDOWS_RESERVED.test(segment)) fail('Reserved device name in path', candidate);
      if (/[<>"|?*]/.test(segment)) fail('Invalid character in path', candidate);
    }
  }
};

const normalizeForCompare = (p: string, platform: NodeJS.Platform): string =>
  platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;

/** True if `child` is `root` itself or lies inside it (lexical check on resolved paths). */
export const isWithinRoot = (root: string, child: string, options: PathOptions = {}): boolean => {
  const platform = options.platform ?? process.platform;
  const p = api(platform);
  const relative = p.relative(
    normalizeForCompare(p.resolve(root), platform),
    normalizeForCompare(p.resolve(child), platform),
  );
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
};

/**
 * Resolves `candidate` (absolute, or relative to `root`) and guarantees the result is inside
 * `root`. Lexical only — use `resolveRealPathWithinRoot` before touching the filesystem.
 */
export const resolveWithinRoot = (
  root: string,
  candidate: string,
  options: PathOptions = {},
): string => {
  const platform = options.platform ?? process.platform;
  const p = api(platform);
  assertSafePathSyntax(root, options);
  assertSafePathSyntax(candidate, options);
  if (!p.isAbsolute(root)) fail('Root must be absolute', root);
  const resolved = p.resolve(root, candidate);
  if (!isWithinRoot(root, resolved, options)) fail('Path escapes the authorized root', candidate);
  return resolved;
};

/** Resolves against any of several roots (workspace `allowedRoots`). Returns the first match. */
export const resolveWithinAnyRoot = (
  roots: readonly string[],
  candidate: string,
  options: PathOptions = {},
): { root: string; path: string } => {
  const p = api(options.platform ?? process.platform);
  for (const root of roots) {
    const target = p.isAbsolute(candidate) ? candidate : p.resolve(root, candidate);
    if (isWithinRoot(root, target, options))
      return { root, path: resolveWithinRoot(root, target, options) };
  }
  return fail('Path is outside every authorized root', candidate);
};

/**
 * Filesystem-aware confinement: resolves symlinks/junctions of the deepest existing ancestor
 * and re-checks containment against the real path of the root. Prevents escapes through links
 * planted inside the workspace.
 */
export const resolveRealPathWithinRoot = async (
  root: string,
  candidate: string,
): Promise<string> => {
  const lexical = resolveWithinRoot(root, candidate);
  const realRoot = await realpath(root);
  let probe = lexical;
  const pending: string[] = [];
  // Walk up until an existing ancestor is found (the target may not exist yet).
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = pending.length ? path.join(real, ...pending.reverse()) : real;
      if (!isWithinRoot(realRoot, full))
        fail('Path escapes the authorized root via a link', candidate);
      return full;
    } catch (error) {
      if (DevBrainError.is(error)) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) fail('Path cannot be resolved', candidate);
      pending.push(path.basename(probe));
      probe = parent;
    }
  }
};

/** Converts a path inside `root` to a `/`-separated relative path (for globs and display). */
export const toPortableRelative = (
  root: string,
  target: string,
  options: PathOptions = {},
): string => {
  const p = api(options.platform ?? process.platform);
  return p.relative(root, target).split(p.sep).join('/');
};
