import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  DevBrainError,
  nowTimestamp,
  type GitRepository,
  type GitService,
  type GitStatus,
} from '@devbrain/contracts';

const runFile = promisify(execFile);
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
/**
 * Repositories are untrusted (agents can write `.git/config`). Options that would make
 * DevBrain's own read-only inspection run repository-configured programs are forced off:
 * fsmonitor hooks, external diff and textconv drivers.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'diff.external='];
const git = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await runFile(GIT, [...SAFE_CONFIG, '-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch {
    throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Git command failed');
  }
};
const state = (code: string): GitStatus['files'][number]['index'] =>
  (
    ({
      '.': 'unmodified',
      M: 'modified',
      A: 'added',
      D: 'deleted',
      R: 'renamed',
      C: 'copied',
      U: 'conflicted',
      '?': 'untracked',
      '!': 'ignored',
    }) as Record<string, GitStatus['files'][number]['index']>
  )[code] ?? 'modified';

export class LocalGitService implements GitService {
  async detect(directory: string): Promise<GitRepository | null> {
    let root: string;
    try {
      root = (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      return null;
    }
    const [gitDir, branch, commit, bare, remotes] = await Promise.all([
      git(root, ['rev-parse', '--absolute-git-dir']),
      git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(root, ['rev-parse', '--is-bare-repository']),
      git(root, ['remote']).catch(() => ''),
    ]);
    const worktrees = (await git(root, ['worktree', 'list', '--porcelain']))
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((entry, index) => {
        const line = (key: string) =>
          entry
            .split(/\r?\n/)
            .find((v) => v.startsWith(`${key} `))
            ?.slice(key.length + 1) ?? null;
        const worktreePath = line('worktree') ?? root;
        return {
          path: worktreePath,
          branch: line('branch')?.replace(/^refs\/heads\//, '') ?? null,
          head: line('HEAD'),
          isMain: index === 0,
          locked: entry.includes('\nlocked'),
        };
      });
    return {
      rootPath: await realpath(root),
      gitDir: gitDir.trim(),
      isBare: bare.trim() === 'true',
      headBranch: branch.trim() || null,
      headCommit: commit.trim() || null,
      remotes: await Promise.all(
        remotes
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map(async (name) => ({
            name,
            url: (await git(root, ['remote', 'get-url', name]))
              .trim()
              .replace(/(\/\/)[^/@\s]+@/, '$1'),
          })),
      ),
      worktrees,
    };
  }

  async status(rootPath: string): Promise<GitStatus> {
    const repo = await this.detect(rootPath);
    if (!repo) throw new DevBrainError('NOT_FOUND', 'Git repository not found');
    const entries = (
      await git(repo.rootPath, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ])
    ).split('\0');
    let branch = repo.headBranch,
      upstream: string | null = null,
      ahead = 0,
      behind = 0;
    const files: GitStatus['files'] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.startsWith('# branch.head '))
        branch = entry.slice(14) === '(detached)' ? null : entry.slice(14);
      else if (entry.startsWith('# branch.upstream ')) upstream = entry.slice(18);
      else if (entry.startsWith('# branch.ab ')) {
        const match = /\+(\d+) -(\d+)/.exec(entry);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (entry.startsWith('? ') || entry.startsWith('! '))
        files.push({
          path: entry.slice(2),
          originalPath: null,
          index: state(entry[0] ?? '?'),
          workTree: state(entry[0] ?? '?'),
        });
      else if (/^[12u] /.test(entry)) {
        const parts = entry.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(entry.startsWith('1 ') ? 8 : 10).join(' ');
        const originalPath = entry.startsWith('2 ') ? (entries[++i] ?? null) : null;
        files.push({
          path,
          originalPath,
          index: state(xy[0] ?? '.'),
          workTree: state(xy[1] ?? '.'),
        });
      }
    }
    return {
      rootPath: repo.rootPath,
      branch,
      detached: branch === null,
      upstream,
      ahead,
      behind,
      files,
      clean: files.length === 0,
      capturedAt: nowTimestamp(),
    };
  }
  async diff(rootPath: string): Promise<string> {
    return git(rootPath, ['diff', '--no-ext-diff', '--no-textconv', '--']);
  }
  /**
   * Working-tree diff read up to `maxBytes` (the process is stopped there), so a huge diff
   * is truncated instead of failing. The cut never splits a UTF-8 sequence.
   */
  async diffBounded(
    rootPath: string,
    maxBytes: number,
  ): Promise<{ diff: string; truncated: boolean }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        GIT,
        [...SAFE_CONFIG, '-C', rootPath, 'diff', '--no-ext-diff', '--no-textconv', '--'],
        {
          shell: false,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size > maxBytes) {
          truncated = true;
          child.kill();
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new DevBrainError('PROVIDER_UNAVAILABLE', 'Git command failed'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (!truncated && code !== 0) {
          reject(new DevBrainError('PROVIDER_UNAVAILABLE', 'Git command failed'));
          return;
        }
        let buffer = Buffer.concat(chunks);
        if (buffer.byteLength > maxBytes) {
          let cut = maxBytes;
          while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
          buffer = buffer.subarray(0, cut);
        }
        resolvePromise({ diff: buffer.toString('utf8'), truncated });
      });
    });
  }
  async commits(rootPath: string, limit = 20): Promise<string[]> {
    return (await git(rootPath, ['log', `-${Math.min(Math.max(limit, 1), 100)}`, '--format=%H %s']))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  }
  async createWorktree(input: {
    repositoryRoot: string;
    path: string;
    branch: string;
    baseRef: string;
  }): Promise<GitRepository> {
    const repository = await this.detect(input.repositoryRoot);
    if (!repository || repository.isBare)
      throw new DevBrainError('NOT_FOUND', 'Working Git repository not found');
    if (
      !isAbsolute(input.path) ||
      !/^[-A-Za-z0-9_./]+$/.test(input.branch) ||
      input.branch.startsWith('-')
    )
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid worktree path or branch');
    await git(repository.rootPath, ['check-ref-format', '--branch', input.branch]);
    await git(repository.rootPath, ['rev-parse', '--verify', '--end-of-options', input.baseRef]);
    await git(repository.rootPath, [
      'worktree',
      'add',
      '-b',
      input.branch,
      input.path,
      input.baseRef,
    ]);
    const created = await this.detect(input.path);
    if (!created) throw new DevBrainError('INTERNAL', 'Created worktree could not be detected');
    return created;
  }
  async removeWorktree(input: { repositoryRoot: string; path: string }): Promise<void> {
    const repository = await this.detect(input.repositoryRoot);
    if (!repository) throw new DevBrainError('NOT_FOUND', 'Git repository not found');
    const target = repository.worktrees.find(
      (tree) => resolve(tree.path).toLowerCase() === resolve(input.path).toLowerCase(),
    );
    if (!target || target.isMain)
      throw new DevBrainError('VALIDATION_FAILED', 'Target is not a linked worktree');
    const status = await this.status(target.path);
    if (!status.clean) throw new DevBrainError('CONFLICT', 'Worktree has uncommitted changes');
    await git(repository.rootPath, ['worktree', 'remove', '--', target.path]);
  }
}
export const GIT_ENGINE_IMPLEMENTED = true as const;
