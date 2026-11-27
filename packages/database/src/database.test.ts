import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  NO_CAPABILITIES,
  newId,
  nowTimestamp,
  type AgentSession,
  type ExecutionEvent,
  type ExecutionRequest,
  type Project,
  type Workspace,
} from '@devbrain/contracts';
import { REDACTED } from '@devbrain/security';
import {
  MIGRATIONS,
  ProjectRepository,
  SessionRepository,
  SqliteExecutionHistory,
  backupDatabase,
  createDatabase,
  currentSchemaVersion,
  listBackups,
  mapSqliteError,
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
  technologies: [],
  lastOpenedAt: null,
  createdAt: nowTimestamp(),
  updatedAt: nowTimestamp(),
  archivedAt: null,
  ...overrides,
});

const workspace = (p: Project): Workspace => ({
  id: newId('workspace'),
  projectId: p.id,
  name: 'primary',
  kind: 'primary',
  rootPath: p.rootPath,
  branch: null,
  access: { allowedRoots: [p.rootPath], readOnlyRoots: [], allowNetwork: false },
  createdAt: nowTimestamp(),
  updatedAt: nowTimestamp(),
});

/** Inserts project → workspace → provider → agent → session; returns ids. */
const seed = (d: DevBrainDatabase, instanceId = 'run_test') => {
  const p = d.projects.insert(project());
  const w = d.workspaces.insert(workspace(p));
  const providerId = newId('provider');
  d.providers.upsert({
    provider: {
      id: providerId,
      adapterKey: 'test-cli',
      kind: 'cli-agent',
      displayName: 'Test',
      vendor: null,
      status: 'unknown',
      enabled: true,
      credentialRef: null,
      endpoint: null,
      capabilities: { ...NO_CAPABILITIES },
      lastCheckedAt: null,
    },
    config: {
      executablePath: null,
      defaultArgs: [],
      models: [],
      defaultModel: null,
      envAllowlist: [],
    },
    health: {
      installed: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
      authenticated: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
      operational: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
    },
  });
  const agentId = newId('agent');
  d.agents.upsert({
    id: agentId,
    providerId,
    name: 'A',
    role: null,
    model: null,
    capabilities: { ...NO_CAPABILITIES },
    permissionPolicyId: newId('policy'),
    status: 'idle',
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    metadata: {},
  });
  const session: AgentSession = {
    id: newId('session'),
    agentId,
    projectId: p.id,
    workspaceId: w.id,
    status: 'active',
    externalSessionId: null,
    lastCheckpointId: null,
    startedAt: nowTimestamp(),
    endedAt: null,
    title: null,
    endReason: null,
    resumedFromSessionId: null,
    updatedAt: nowTimestamp(),
  };
  d.sessions.insert(session, instanceId);
  return { project: p, workspace: w, providerId, agentId, session };
};

const request = (
  sessionId: string,
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest => ({
  id: newId('execution'),
  sessionId,
  payload: { kind: 'command', executable: 'git', args: ['status'] },
  workingDirectory: 'C:\\work\\demo',
  timeoutMs: 60_000,
  envAllowlist: [],
  idempotencyKey: null,
  createdAt: nowTimestamp(),
  ...overrides,
});

let db: DevBrainDatabase | undefined;
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'devbrain-db-'));
});
afterEach(async () => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  db = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const driver = openDatabase({ location: ':memory:' });
    expect(migrate(driver)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(migrate(driver)).toEqual([]);
    expect(currentSchemaVersion(driver)).toBe(3);
    driver.close();
  });

  it('detects modified migrations and newer schemas', () => {
    const driver = openDatabase({ location: ':memory:' });
    migrate(driver);
    const tampered = MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- changed` }));
    expect(() => migrate(driver, tampered)).toThrow(/modified/);
    expect(() => migrate(driver, MIGRATIONS.slice(0, 1))).toThrow(/newer/);
    driver.close();
  });

  it('upgrades a 0.1.0 (v1) database preserving data and adding cascades', () => {
    const driver = openDatabase({ location: ':memory:' });
    migrate(driver, MIGRATIONS.slice(0, 1));
    const now = nowTimestamp();
    const pid = newId('project');
    const wid = newId('workspace');
    const sid = newId('session');
    const xid = newId('execution');
    driver.run(
      `INSERT INTO projects (id, name, root_path, root_path_key, is_git_repository, metadata, created_at, updated_at)
       VALUES (:id, 'Old', 'C:\\old', 'c:\\old', 1, '{}', :now, :now)`,
      { id: pid, now },
    );
    driver.run(
      `INSERT INTO workspaces (id, project_id, name, kind, root_path, access, created_at, updated_at)
       VALUES (:id, :pid, 'primary', 'primary', 'C:\\old', :access, :now, :now)`,
      {
        id: wid,
        pid,
        now,
        access: JSON.stringify({
          allowedRoots: ['C:\\old'],
          readOnlyRoots: [],
          allowNetwork: false,
        }),
      },
    );
    const agentId = newId('agent');
    const providerId = newId('provider');
    driver.run(
      "INSERT INTO providers (id, adapter_key, data, updated_at) VALUES (:id, 'old-cli', '{}', :now)",
      { id: providerId, now },
    );
    driver.run(
      "INSERT INTO agents (id, provider_id, data, updated_at) VALUES (:id, :providerId, '{}', :now)",
      { id: agentId, providerId, now },
    );
    const legacy = {
      id: sid,
      agentId,
      projectId: pid,
      workspaceId: wid,
      status: 'ended',
      externalSessionId: null,
      lastCheckpointId: null,
      startedAt: now,
      endedAt: now,
    };
    driver.run(
      `INSERT INTO agent_sessions (id, agent_id, project_id, workspace_id, status, data, started_at, ended_at)
       VALUES (:id, :agent, :pid, :wid, 'ended', :data, :now, :now)`,
      { id: sid, agent: legacy.agentId, pid, wid, data: JSON.stringify(legacy), now },
    );
    driver.run(
      `INSERT INTO executions (id, session_id, request, status, created_at)
       VALUES (:id, :sid, :req, 'completed', :now)`,
      { id: xid, sid, now, req: JSON.stringify(request(sid, { id: xid })) },
    );

    expect(migrate(driver)).toEqual([2, 3]);
    const upgraded = {
      projects: new ProjectRepository(driver),
      sessions: new SessionRepository(driver),
      executions: new SqliteExecutionHistory(driver),
    };
    const p = upgraded.projects.findById(pid);
    expect(p).toMatchObject({
      name: 'Old',
      technologies: [],
      lastOpenedAt: null,
      isGitRepository: true,
    });
    // Deprecated status is normalized on read.
    expect(upgraded.sessions.findById(sid)?.status).toBe('completed');
    expect(upgraded.executions.getRecord(xid)?.status).toBe('completed');
    expect(driver.all('PRAGMA foreign_key_check')).toEqual([]);
    // Removing the project cascades to its history.
    upgraded.projects.delete(pid);
    expect(upgraded.sessions.findById(sid)).toBeNull();
    expect(upgraded.executions.getRecord(xid)).toBeNull();
    driver.close();
  });
});

describe('storage lifecycle', () => {
  it('persists to a file (WAL) across reopen', () => {
    const file = path.join(tmp, 'devbrain.db');
    const first = createDatabase({ location: file });
    first.projects.insert(project());
    first.close();
    db = createDatabase({ location: file });
    expect(db.projects.list()).toHaveLength(1);
    expect(db.integrity).toBe('ok');
  });

  it('creates backups with rotation', () => {
    db = createDatabase({ location: path.join(tmp, 'devbrain.db') });
    const dir = path.join(tmp, 'backups');
    for (let i = 0; i < 4; i += 1) backupDatabase(db.driver, dir, 2);
    expect(listBackups(dir)).toHaveLength(2);
  });

  it('quarantines a corrupt database and restores the newest backup', () => {
    const file = path.join(tmp, 'devbrain.db');
    const first = createDatabase({ location: file });
    const p = first.projects.insert(project());
    backupDatabase(first.driver, path.join(tmp, 'backups'), 5);
    first.close();
    writeFileSync(file, Buffer.from('this is not a sqlite database '.repeat(200)));
    for (const side of ['-wal', '-shm'])
      if (existsSync(file + side)) writeFileSync(file + side, '');

    db = createDatabase({ location: file });
    expect(db.integrity).toBe('recovered-from-backup');
    expect(db.projects.findById(p.id)?.name).toBe('Demo');
    expect(readdirSync(path.join(tmp, 'corrupt')).length).toBeGreaterThan(0);
  });

  it('recreates an empty database when no backup is usable', () => {
    const file = path.join(tmp, 'devbrain.db');
    writeFileSync(file, Buffer.from('garbage'.repeat(1000)));
    db = createDatabase({ location: file });
    expect(db.integrity).toBe('recreated');
    expect(db.projects.list()).toEqual([]);
  });

  it('maps SQLite failures to typed errors', () => {
    db = createDatabase({ location: ':memory:' });
    const p = db.projects.insert(project());
    expect(() => db!.projects.insert({ ...p, id: newId('project') })).toThrow(
      expect.objectContaining({ code: 'ALREADY_EXISTS' }),
    );
    expect(() => db!.workspaces.insert({ ...workspace(p), projectId: newId('project') })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(mapSqliteError(new Error('x')).code).toBe('INTERNAL');
    expect(mapSqliteError({ errcode: 5, message: 'database is locked' })).toMatchObject({
      code: 'STORAGE_ERROR',
      retryable: true,
    });
  });
});

describe('repositories', () => {
  it('stores projects with case-insensitive path uniqueness on Windows', () => {
    db = createDatabase({ location: ':memory:' });
    const p = db.projects.insert(project());
    expect(db.projects.findById(p.id)).toEqual(p);
    if (process.platform === 'win32') {
      expect(() => db!.projects.insert(project({ rootPath: 'c:\\WORK\\demo\\' }))).toThrow(
        expect.objectContaining({ code: 'ALREADY_EXISTS' }),
      );
    }
    expect(pathKey('C:/Work/Demo/', 'win32')).toBe('c:\\work\\demo');
    const updated = db.projects.update({ ...p, name: 'Renamed', lastOpenedAt: nowTimestamp() });
    expect(db.projects.findById(p.id)?.name).toBe('Renamed');
    expect(db.projects.listRecent(5).map((x) => x.id)).toEqual([updated.id]);
  });

  it('keeps the audit log append-only, redacted, and prunable only through retention', async () => {
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
    const rejected = expect.objectContaining({ code: 'PERMISSION_DENIED' });
    expect(() => db!.driver.run('DELETE FROM audit_events')).toThrow(rejected);
    expect(() => db!.driver.run("UPDATE audit_events SET action = 'x.y'")).toThrow(rejected);

    const pruned = db.audit.pruneBefore(new Date(Date.now() + 60_000).toISOString());
    expect(pruned).toBe(1);
    const rows = await db.audit.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('audit.pruned');
    expect(rows[0]?.details).toMatchObject({ count: 1 });
    expect(() => db!.driver.run('DELETE FROM audit_events')).toThrow(rejected);
  });

  it('reads defaults and patches settings (nested sections merge)', async () => {
    db = createDatabase({ location: ':memory:' });
    expect((await db.settings.get()).language).toBe('pt-BR');
    const next = await db.settings.update({
      execution: { maxConcurrentExecutions: 8 },
      retention: { logMaxFiles: 3 },
      budget: { maxPerDay: 5 },
    });
    expect(next.execution).toEqual({
      maxConcurrentExecutions: 8,
      defaultTimeoutMs: 30 * 60 * 1000,
      maxConcurrentPerAgent: 2,
    });
    expect(next.retention).toEqual({ ...DEFAULT_RETENTION, logMaxFiles: 3 });
    expect(next.budget).toEqual({
      currency: 'USD',
      maxPerDay: 5,
      maxPerMonth: null,
      allowWithoutCostGuarantee: false,
    });
    await expect(
      db.settings.update({ execution: { maxConcurrentExecutions: 0 } }),
    ).rejects.toThrow();
  });

  it('stores only ciphertext for credentials', async () => {
    db = createDatabase({ location: ':memory:' });
    await db.secrets.set('crd_x', Buffer.from([1, 2, 3]));
    expect(await db.secrets.get('crd_x')).toEqual(Buffer.from([1, 2, 3]));
    expect(db.secrets.deleteSync('crd_x')).toBe(true);
    expect(await db.secrets.get('crd_x')).toBeNull();
  });
});

describe('execution history', () => {
  it('records events in order, rejects seq clashes, dedupes replays and rolls back', async () => {
    db = createDatabase({ location: ':memory:' });
    const { session } = seed(db);
    const req = request(session.id);
    await db.executions.appendRequest(req);
    const base = { executionId: req.id, sessionId: session.id, timestamp: nowTimestamp() };
    const events: ExecutionEvent[] = [0, 1, 2].map((seq) => ({
      ...base,
      id: newId('event'),
      seq,
      type: 'heartbeat',
    }));
    for (const e of events) await db.executions.appendEvent(e);
    expect(db.executions.appendEventSync(events[1]!).duplicate).toBe(true);
    await expect(
      db.executions.appendEvent({ ...base, id: newId('event'), seq: 1, type: 'heartbeat' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    const after0 = await db.executions.listEvents({ executionId: req.id, afterSeq: 0 });
    expect(after0.map((e) => e.seq)).toEqual([1, 2]);
    expect(db.executions.nextSeq(req.id)).toBe(3);

    expect(() =>
      db!.driver.transaction(() => {
        db!.projects.insert(project({ rootPath: 'C:\\rollback' }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.projects.findByRootPath('C:\\rollback')).toBeNull();
  });

  it('bounds stored output per execution and flags truncation', async () => {
    db = createDatabase({ location: ':memory:' });
    db.executions.setLimits({
      ...DEFAULT_RETENTION,
      maxStoredOutputBytesPerExecution: 64 * 1024,
      maxEventsPerExecution: 100,
    });
    const { session } = seed(db);
    const req = request(session.id);
    await db.executions.appendRequest(req);
    const chunk = 'x'.repeat(40 * 1024);
    let seq = 0;
    const out = () =>
      db!.executions.appendEventSync({
        id: newId('event'),
        executionId: req.id,
        sessionId: session.id,
        seq: seq++,
        timestamp: nowTimestamp(),
        type: 'output',
        stream: 'stdout',
        chunk,
      });
    expect(out()).toMatchObject({ stored: true, truncated: false });
    expect(out()).toMatchObject({ stored: true, truncated: true });
    expect(out()).toMatchObject({ stored: false, truncated: true });
    // Status events are always kept.
    expect(
      db.executions.appendEventSync({
        id: newId('event'),
        executionId: req.id,
        sessionId: session.id,
        seq: seq++,
        timestamp: nowTimestamp(),
        type: 'status',
        status: 'running',
      }).stored,
    ).toBe(true);
    for (let i = 0; i < 120; i += 1) {
      db.executions.appendEventSync({
        id: newId('event'),
        executionId: req.id,
        sessionId: session.id,
        seq: seq++,
        timestamp: nowTimestamp(),
        type: 'heartbeat',
      });
    }
    const record = db.executions.getRecord(req.id);
    expect(record?.eventCount).toBeLessThanOrEqual(101);
    expect(record?.outputTruncated).toBe(true);
    expect(record?.status).toBe('running');
    const stored = await db.executions.listEvents({ executionId: req.id, limit: 5000 });
    const bytes = stored.reduce(
      (n, e) => n + (e.type === 'output' ? Buffer.byteLength(e.chunk) : 0),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it('lists grants with and without inactive ones (regression: unused :now binding)', () => {
    db = createDatabase({ location: ':memory:' });
    const { agentId, project, session } = seed(db);
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const grant = (expiresAt: string) => {
      const approvalId = newId('approval');
      db!.approvals.save({
        id: approvalId,
        agentId,
        sessionId: session.id,
        executionId: null,
        action: 'process.spawn',
        risk: 'medium',
        summary: 's',
        details: {},
        untrustedOrigin: false,
        status: 'approved',
        requestedAt: at(-2000),
        expiresAt: at(60_000),
        decidedAt: at(-1000),
        decidedBy: 'user',
        decisionNote: null,
        projectId: project.id,
        scope: 'project',
        target: null,
      });
      return db!.grants.insert({
        id: newId('grant'),
        approvalId,
        agentId,
        projectId: project.id,
        sessionId: null,
        action: 'process.spawn',
        scope: 'project',
        target: null,
        createdAt: at(-1000),
        expiresAt,
        revokedAt: null,
        revokedReason: null,
      });
    };
    const active = grant(at(60_000));
    const expired = grant(at(-500));
    const revoked = grant(at(60_000));
    db.grants.revoke(revoked.id, 'test', at(0));
    const nowIso = at(0);
    expect(db.grants.list({ includeInactive: false, now: nowIso }).map((g) => g.id)).toEqual([
      active.id,
    ]);
    const all = db.grants.list({
      includeInactive: true,
      now: nowIso,
      agentId,
      projectId: project.id,
    });
    expect(all.map((g) => g.id).sort()).toEqual([active.id, expired.id, revoked.id].sort());
  });

  it('finds orphaned live sessions of other app instances', () => {
    db = createDatabase({ location: ':memory:' });
    const { session } = seed(db, 'run_old');
    expect(db.sessions.listOrphaned('run_new').map((s) => s.id)).toEqual([session.id]);
    expect(db.sessions.listOrphaned('run_old')).toEqual([]);
  });

  it('tracks app runs to detect unclean shutdowns', () => {
    db = createDatabase({ location: ':memory:' });
    expect(db.runs.start('run_1', '0.1.0').previousUnclean).toBe(false);
    expect(db.runs.start('run_2', '0.1.0').previousUnclean).toBe(true);
    db.runs.finish('run_2');
    expect(db.runs.start('run_3', '0.1.0').previousUnclean).toBe(false);
  });
});

describe('no plaintext on disk', () => {
  it('a database file never contains secrets handed to the ciphertext store', async () => {
    const file = path.join(tmp, 'devbrain.db');
    db = createDatabase({ location: file });
    const secret = `sk-test-${crypto.randomUUID()}`;
    // Simulated cipher output (reversed bytes) — the store must persist exactly what it gets.
    await db.secrets.set('crd_y', Buffer.from(secret).reverse());
    db.driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = undefined;
    expect(readFileSync(file).includes(secret)).toBe(false);
  });
});
