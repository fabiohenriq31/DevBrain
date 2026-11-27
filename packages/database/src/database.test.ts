import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, nowTimestamp, type ExecutionRequest, type Project } from '@devbrain/contracts';
import { REDACTED } from '@devbrain/security';
import {
  MIGRATIONS,
  createDatabase,
  migrate,
  openDatabase,
  pathKey,
  type DevBrainDatabase,
} from './index.js';

const project = (overrides: Partial<Project> = {}): Project => ({
  id: newId('project'),
  name: 'Demo',
  rootPath: 'C:\\work\\demo',
  description: null,
  isGitRepository: false,
  defaultWorkspaceId: null,
  metadata: {},
  createdAt: nowTimestamp(),
  updatedAt: nowTimestamp(),
  archivedAt: null,
  ...overrides,
});

let db: DevBrainDatabase | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe('migrations', () => {
  it('applies once and is idempotent', () => {
    const driver = openDatabase({ location: ':memory:' });
    expect(migrate(driver)).toEqual([1]);
    expect(migrate(driver)).toEqual([]);
    driver.close();
  });

  it('detects modified migrations and newer schemas', () => {
    const driver = openDatabase({ location: ':memory:' });
    migrate(driver);
    const tampered = MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- changed` }));
    expect(() => migrate(driver, tampered)).toThrow(/modified/);
    expect(() => migrate(driver, [])).toThrow(/newer/);
    driver.close();
  });

  it('persists to a file with WAL', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'devbrain-db-'));
    const file = path.join(dir, 'devbrain.db');
    const first = createDatabase({ location: file });
    first.projects.insert(project());
    first.close();
    const second = createDatabase({ location: file });
    expect(second.projects.list()).toHaveLength(1);
    second.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('repositories', () => {
  it('stores projects with case-insensitive path uniqueness on Windows', () => {
    db = createDatabase({ location: ':memory:' });
    const p = db.projects.insert(project());
    expect(db.projects.findById(p.id)).toEqual(p);
    if (process.platform === 'win32') {
      expect(() => db!.projects.insert(project({ rootPath: 'c:\\WORK\\demo\\' }))).toThrow(
        /already registered/,
      );
    }
    expect(pathKey('C:/Work/Demo/', 'win32')).toBe('c:\\work\\demo');
  });

  it('keeps the audit log append-only and redacted', async () => {
    db = createDatabase({ location: ':memory:' });
    const event = await db.audit.append({
      actor: { type: 'system', component: 'test' },
      action: 'credential.stored',
      permission: null,
      projectId: null,
      target: 'https://user:tok3n@example.com',
      outcome: 'success',
      details: { token: 'abc123', note: 'Bearer abcdefghijkl' },
      correlationId: null,
    });
    expect(event.details).toEqual({ token: REDACTED, note: `Bearer ${REDACTED}` });
    expect(event.target).toContain(REDACTED);
    expect(() => db!.driver.run('DELETE FROM audit_events')).toThrow(/append-only/);
    expect(() => db!.driver.run("UPDATE audit_events SET action = 'x.y'")).toThrow(/append-only/);
    expect(await db.audit.list({ limit: 10 })).toHaveLength(1);
  });

  it('reads defaults and patches settings', async () => {
    db = createDatabase({ location: ':memory:' });
    expect((await db.settings.get()).language).toBe('pt-BR');
    const next = await db.settings.update({ execution: { maxConcurrentExecutions: 8 } });
    expect(next.execution).toEqual({
      maxConcurrentExecutions: 8,
      defaultTimeoutMs: 30 * 60 * 1000,
    });
    expect((await db.settings.get()).execution.maxConcurrentExecutions).toBe(8);
    await expect(
      db.settings.update({ execution: { maxConcurrentExecutions: 0 } }),
    ).rejects.toThrow();
  });

  it('records execution history in order and rolls back failed transactions', async () => {
    db = createDatabase({ location: ':memory:' });
    const request: ExecutionRequest = {
      id: newId('execution'),
      sessionId: newId('session'),
      payload: { kind: 'command', executable: 'git', args: ['status'] },
      workingDirectory: 'C:\\work\\demo',
      timeoutMs: 60_000,
      envAllowlist: [],
      idempotencyKey: null,
      createdAt: nowTimestamp(),
    };
    await db.executions.appendRequest(request);
    const base = {
      executionId: request.id,
      sessionId: request.sessionId,
      timestamp: nowTimestamp(),
    };
    for (const seq of [0, 1, 2]) {
      await db.executions.appendEvent({ ...base, id: newId('event'), seq, type: 'heartbeat' });
    }
    await expect(
      db.executions.appendEvent({ ...base, id: newId('event'), seq: 1, type: 'heartbeat' }),
    ).rejects.toThrow();
    const after0 = await db.executions.listEvents({ executionId: request.id, afterSeq: 0 });
    expect(after0.map((e) => e.seq)).toEqual([1, 2]);

    expect(() =>
      db!.driver.transaction(() => {
        db!.projects.insert(project({ rootPath: 'C:\\rollback' }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.projects.findByRootPath('C:\\rollback')).toBeNull();
  });
});
