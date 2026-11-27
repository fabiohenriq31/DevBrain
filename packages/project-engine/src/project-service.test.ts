import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import { LocalProjectService, detectTechnologies, normalizeDirectory } from './index.js';

let base: string;
let db: DevBrainDatabase;
let service: LocalProjectService;

beforeEach(async () => {
  // Real path: on Windows the temp dir may be reported in 8.3 form.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devbrain-proj-')));
  db = createDatabase({ location: ':memory:' });
  service = new LocalProjectService(db);
});
afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('LocalProjectService', () => {
  it('registers a directory with a primary workspace and audit entry', async () => {
    const repo = path.join(base, 'my-repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const project = await service.register({ rootPath: repo });

    expect(project.name).toBe('my-repo');
    expect(project.isGitRepository).toBe(true);
    const workspaces = await service.listWorkspaces(project.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.access.allowedRoots).toEqual([repo]);
    expect(project.defaultWorkspaceId).toBe(workspaces[0]?.id);
    expect((await db.audit.list({ projectId: project.id, limit: 10 }))[0]?.action).toBe(
      'project.registered',
    );
  });

  it('rejects duplicates, files, missing dirs and filesystem roots', async () => {
    const repo = path.join(base, 'dup');
    await mkdir(repo);
    await service.register({ rootPath: repo });
    await expect(service.register({ rootPath: repo })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });

    const file = path.join(base, 'file.txt');
    await writeFile(file, 'x');
    await expect(service.register({ rootPath: file })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.register({ rootPath: path.join(base, 'missing') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.register({ rootPath: path.parse(base).root })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(service.register({ rootPath: 'relative/dir' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('updates and archives', async () => {
    const repo = path.join(base, 'p');
    await mkdir(repo);
    const project = await service.register({ rootPath: repo, name: 'Original' });
    const renamed = await service.update({ id: project.id, name: 'Renamed', description: 'desc' });
    expect(renamed).toMatchObject({ name: 'Renamed', description: 'desc' });
    const archived = await service.archive(project.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(await service.list()).toHaveLength(0);
    expect(await service.list({ includeArchived: true })).toHaveLength(1);
    await expect(service.get('prj_00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('LocalProjectService — Phase 01', () => {
  it('creates a new project folder and refuses non-empty targets or invalid names', async () => {
    const created = await service.create({ parentPath: base, folderName: 'novo-projeto' });
    expect(existsSync(path.join(base, 'novo-projeto'))).toBe(true);
    expect(created).toMatchObject({ name: 'novo-projeto', isGitRepository: false });
    expect(created.lastOpenedAt).not.toBeNull();

    const busy = path.join(base, 'busy');
    await mkdir(busy);
    await writeFile(path.join(busy, 'keep.txt'), 'user data');
    await expect(service.create({ parentPath: base, folderName: 'busy' })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(await readdir(busy)).toEqual(['keep.txt']);
    for (const folderName of ['a/b', 'con', 'x:y', 'trailing.', 'a\\b']) {
      await expect(service.create({ parentPath: base, folderName })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('rejects overlapping projects, the user profile and protected paths', async () => {
    const outer = path.join(base, 'outer');
    await mkdir(path.join(outer, 'inner'), { recursive: true });
    await service.register({ rootPath: outer });
    await expect(service.register({ rootPath: path.join(outer, 'inner') })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(service.register({ rootPath: os.homedir() })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const privateDir = path.join(base, 'userdata');
    await mkdir(path.join(privateDir, 'logs'), { recursive: true });
    const guarded = new LocalProjectService(db, { protectedPaths: [privateDir] });
    await expect(
      guarded.register({ rootPath: path.join(privateDir, 'logs') }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(guarded.register({ rootPath: base })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('detects technologies from manifests (bounded, dependency folders skipped)', async () => {
    const repo = path.join(base, 'web');
    await mkdir(path.join(repo, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ dependencies: { react: '19.0.0' }, devDependencies: { vitest: '5.0.0' } }),
    );
    await writeFile(path.join(repo, 'tsconfig.json'), '{}');
    await writeFile(path.join(repo, 'node_modules', 'ignored', 'Cargo.toml'), '');
    await writeFile(path.join(repo, 'requirements.txt'), 'fastapi==0.1\n');
    const ids = (await detectTechnologies(repo)).map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(['nodejs', 'react', 'typescript', 'vitest', 'python', 'fastapi']),
    );
    expect(ids).not.toContain('rust');
    expect(ids).not.toContain('javascript');

    const project = await service.register({ rootPath: repo });
    expect(project.technologies.map((t) => t.id)).toContain('react');
    await writeFile(path.join(repo, 'go.mod'), 'module x');
    const refreshed = await service.refreshTechnologies(project.id);
    expect(refreshed.technologies.map((t) => t.id)).toContain('go');
  });

  it('removes only the registration, never the files', async () => {
    const repo = path.join(base, 'keep-files');
    await mkdir(repo);
    await writeFile(path.join(repo, 'important.txt'), 'do not delete');
    const project = await service.register({ rootPath: repo });
    await expect(service.remove({ id: project.id } as never)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await service.remove({ id: project.id, confirm: true });
    expect(existsSync(path.join(repo, 'important.txt'))).toBe(true);
    await expect(service.get(project.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const audit = await db.audit.list({ limit: 5 });
    expect(audit[0]).toMatchObject({ action: 'project.removed', details: { filesDeleted: false } });
  });

  it('archives, restores, tracks recents and validates settings', async () => {
    const a = await service.create({ parentPath: base, folderName: 'a' });
    const b = await service.create({ parentPath: base, folderName: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    await service.markOpened(a.id);
    expect((await service.listRecent(5)).map((p) => p.id)[0]).toBe(a.id);
    await service.archive(b.id);
    expect((await service.listRecent(5)).map((p) => p.id)).not.toContain(b.id);
    expect((await service.restore(b.id)).archivedAt).toBeNull();

    expect(await service.getSettings(a.id)).toMatchObject({ projectId: a.id, excludedPaths: [] });
    const next = await service.updateSettings({
      projectId: a.id,
      excludedPaths: ['secrets/**'],
      notes: 'n',
    });
    expect(next).toMatchObject({ excludedPaths: ['secrets/**'], notes: 'n' });
    await expect(
      service.updateSettings({
        projectId: a.id,
        preferredAgentId: 'agt_00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates authorized directories with real-path normalization', async () => {
    const repo = path.join(base, 'ws');
    const shared = path.join(base, 'shared');
    await mkdir(path.join(repo, 'docs'), { recursive: true });
    await mkdir(shared);
    const project = await service.register({ rootPath: repo });
    const [ws] = await service.listWorkspaces(project.id);
    const workspaceId = ws?.id ?? '';
    const access = (allowedRoots: string[], readOnlyRoots: string[] = []) =>
      service.updateWorkspaceAccess({
        workspaceId,
        allowedRoots,
        readOnlyRoots,
        allowNetwork: false,
      });

    await expect(access([shared])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(access([repo], [shared])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // A junction (Windows) / symlink is stored as its real target.
    const link = path.join(base, 'link-to-shared');
    await symlink(shared, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await normalizeDirectory(link)).toBe(shared);
    const updated = await service.updateWorkspaceAccess({
      workspaceId,
      allowedRoots: [repo, link],
      readOnlyRoots: [path.join(repo, 'docs')],
      allowNetwork: true,
    });
    expect(updated.access).toEqual({
      allowedRoots: [repo, shared],
      readOnlyRoots: [path.join(repo, 'docs')],
      allowNetwork: true,
    });
  });
});
