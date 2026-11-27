import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import { LocalProjectService } from './index.js';

let base: string;
let db: DevBrainDatabase;
let service: LocalProjectService;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'devbrain-proj-'));
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
