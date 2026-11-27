import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitService } from './index.js';

const exec = promisify(execFile);
let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});
describe('local Git integration', () => {
  it('detects a repository and parses modified and untracked paths', async () => {
    directory = await mkdtemp(join(tmpdir(), 'devbrain-git-'));
    const run = (...args: string[]) =>
      exec(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', directory!, ...args]);
    await run('init');
    await run('config', 'user.email', 'test@example.invalid');
    await run('config', 'user.name', 'Test');
    await writeFile(join(directory, 'a file.txt'), 'before');
    await run('add', '--all');
    await run('commit', '-m', 'initial');
    await writeFile(join(directory, 'a file.txt'), 'after');
    await writeFile(join(directory, 'new file.txt'), 'new');
    const service = new LocalGitService();
    const repository = await service.detect(directory);
    expect(repository?.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
    const status = await service.status(directory);
    expect(status.clean).toBe(false);
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'a file.txt', workTree: 'modified' }),
        expect.objectContaining({ path: 'new file.txt', workTree: 'untracked' }),
      ]),
    );
    expect(await service.diff(directory)).toContain('after');
    expect((await service.commits(directory))[0]).toContain('initial');
  });
  it('creates a linked worktree and refuses to remove it with user changes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'devbrain-worktree-'));
    const run = (...args: string[]) =>
      exec(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', directory!, ...args]);
    await run('init');
    await run('config', 'user.email', 'test@example.invalid');
    await run('config', 'user.name', 'Test');
    await writeFile(join(directory, 'base.txt'), 'base');
    await run('add', '--all');
    await run('commit', '-m', 'initial');
    const path = join(directory, 'linked');
    const service = new LocalGitService();
    const linked = await service.createWorktree({
      repositoryRoot: directory,
      path,
      branch: 'feature-test',
      baseRef: 'HEAD',
    });
    expect(linked.worktrees).toHaveLength(2);
    await writeFile(join(path, 'new.txt'), 'user change');
    await expect(service.removeWorktree({ repositoryRoot: directory, path })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    await rm(join(path, 'new.txt'));
    await service.removeWorktree({ repositoryRoot: directory, path });
    expect((await service.detect(directory))?.worktrees).toHaveLength(1);
  });
});
