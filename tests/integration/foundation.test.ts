import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, dispatchIpc, type IpcHandlerMap } from '@devbrain/contracts';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import { LocalProjectService } from '@devbrain/project-engine';

/**
 * Cross-package integration: the same validation path the Electron main process uses
 * (dispatchIpc -> service -> SQLite), without Electron.
 */
let base: string;
let db: DevBrainDatabase;
let handlers: IpcHandlerMap;

const call = (key: Parameters<typeof dispatchIpc>[0], payload: unknown) =>
  dispatchIpc(
    key,
    { contractsVersion: CONTRACTS_VERSION, correlationId: 'integration-test', payload },
    handlers[key] as never,
  );

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'devbrain-int-'));
  db = createDatabase({ location: path.join(base, 'devbrain.db') });
  const projects = new LocalProjectService(db);
  handlers = {
    'projects.register': (input) => projects.register(input as never),
    'projects.list': (input) => projects.list(input),
    'audit.list': (input) => db.audit.list({ limit: input.limit }),
  };
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('foundation integration', () => {
  it('registers a project over the IPC contract and audits it', async () => {
    const dir = path.join(base, 'repo');
    await mkdir(dir);
    const registered = await call('projects.register', { rootPath: dir, name: 'Repo' });
    expect(registered.ok).toBe(true);

    const listed = await call('projects.list', {});
    expect(listed.ok && (listed.data as unknown[]).length).toBe(1);

    const audit = await call('audit.list', {});
    expect(audit.ok && (audit.data as { action: string }[])[0]?.action).toBe('project.registered');
  });

  it('maps service errors to stable error codes without leaking internals', async () => {
    const res = await call('projects.register', { rootPath: path.join(base, 'missing') });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const unsupported = await call('sessions.start', {});
    expect(unsupported.ok).toBe(false);
  });
});
