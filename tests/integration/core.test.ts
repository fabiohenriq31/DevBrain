import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACTS_VERSION,
  dispatchIpc,
  type IpcChannelKey,
  type IpcHandlerMap,
} from '@devbrain/contracts';
import { createCoreServices, type CoreServices } from '@devbrain/core';

/**
 * Phase 01 integration: renderer-shaped payloads → IPC validation (input AND output schemas)
 * → core services → SQLite on disk. Mirrors the handler wiring of apps/desktop/src/main/ipc.ts
 * without Electron.
 */
let base: string;
let core: CoreServices;
let handlers: IpcHandlerMap;

const call = async <T = unknown>(key: IpcChannelKey, payload: unknown) => {
  const res = await dispatchIpc(
    key,
    { contractsVersion: CONTRACTS_VERSION, correlationId: 'integration-core', payload },
    handlers[key] as never,
  );
  return res as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
};

const data = <T>(res: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!res.ok) throw new Error(`IPC failed: ${JSON.stringify(res.error)}`);
  return res.data as T;
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devbrain-int-core-')));
  core = createCoreServices({
    databaseFile: path.join(base, 'userdata', 'devbrain.db'),
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s).reverse(),
      decryptString: (b) => Buffer.from(b).reverse().toString(),
    },
    instanceId: 'run_integration',
    protectedPaths: [path.join(base, 'userdata')],
  });
  const c = core;
  handlers = {
    'projects.register': (i) => c.projects.register(i as never),
    'projects.remove': async (i) => {
      await c.projects.remove(i);
      return { removed: true as const };
    },
    'workspaces.list': (i) => c.projects.listWorkspaces(i.projectId),
    'providers.register': (i) => c.providers.register(i as never),
    'providers.listConfigured': () => c.providers.list(),
    'agents.register': (i) => c.agents.register(i as never),
    'credentials.store': (i) => c.credentials.store(i as never),
    'credentials.list': () => c.credentials.list(),
    'sessions.start': (i) => c.sessions.start(i as never),
    'sessions.history': (i) => c.sessions.history(i.sessionId),
    'permissions.evaluate': (i) => c.authorization.evaluate(i as never),
    'approvals.listPending': () => c.approvals.listPending(),
    'system.storageHealth': () => c.maintenance.health(),
    'system.backup': () => c.maintenance.backup(),
    'usage.summary': (i) => c.usage.summary(i as never),
    'settings.update': (i) => c.settings.update(i),
  };
});

afterEach(async () => {
  core.close();
  await rm(base, { recursive: true, force: true });
});

describe('core over the IPC contract', () => {
  it('runs the main flows and every response satisfies its output schema', async () => {
    const dir = path.join(base, 'repo');
    await mkdir(dir);
    const project = data<{ id: string; defaultWorkspaceId: string }>(
      await call('projects.register', { rootPath: dir }),
    );
    const provider = data<{ provider: { id: string }; readiness: string }>(
      await call('providers.register', {
        adapterKey: 'demo-cli',
        kind: 'cli-agent',
        displayName: 'Demo',
      }),
    );
    expect(provider.readiness).toBe('configured');
    const agent = data<{ id: string }>(
      await call('agents.register', { providerId: provider.provider.id, name: 'Dev' }),
    );

    const ref = data<Record<string, unknown>>(
      await call('credentials.store', {
        storage: 'os-encrypted',
        label: 'key',
        secret: 'integration-secret-value',
      }),
    );
    expect(Object.keys(ref).sort()).toEqual([
      'createdAt',
      'hint',
      'id',
      'label',
      'lastUsedAt',
      'locator',
      'providerId',
      'storage',
    ]);
    expect(JSON.stringify(data(await call('credentials.list', {})))).not.toContain(
      'integration-secret-value',
    );

    const session = data<{ id: string }>(
      await call('sessions.start', {
        agentId: agent.id,
        projectId: project.id,
        workspaceId: project.defaultWorkspaceId,
      }),
    );
    const verdict = data<Record<string, unknown>>(
      await call('permissions.evaluate', {
        agentId: agent.id,
        workspaceId: project.defaultWorkspaceId,
        action: 'fs.read',
        path: 'a.ts',
      }),
    );
    // Output schema strips engine-internal fields (real paths) before reaching the renderer.
    expect(Object.keys(verdict).sort()).toEqual(['decision', 'grantId', 'reason']);
    expect(
      data<{ session: { id: string } }>(await call('sessions.history', { sessionId: session.id }))
        .session.id,
    ).toBe(session.id);
    expect(data<unknown[]>(await call('approvals.listPending', {}))).toEqual([]);
    expect(data<{ integrity: string }>(await call('system.storageHealth', {})).integrity).toBe(
      'ok',
    );
    expect(data<{ bytes: number }>(await call('system.backup', {})).bytes).toBeGreaterThan(0);
    expect(data<{ executions: number }>(await call('usage.summary', {})).executions).toBe(0);
  });

  it('rejects invalid, private and destructive requests with stable codes', async () => {
    expect(
      await call('projects.register', { rootPath: path.join(base, 'userdata') }),
    ).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/PERMISSION_DENIED|NOT_FOUND/) },
    });
    expect(
      await call('credentials.store', { storage: 'os-encrypted', label: 'x', secret: '' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(
      await call('projects.remove', { id: 'prj_00000000-0000-4000-8000-000000000000' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await call('settings.update', { security: { approvalTimeoutMs: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    // Provider evidence has no IPC channel: the renderer cannot declare availability.
    expect(Object.keys(handlers)).not.toContain('providers.recordEvidence');
  });
});
