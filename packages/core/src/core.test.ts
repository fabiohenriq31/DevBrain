import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  newId,
  nowTimestamp,
  type Agent,
  type ExecutionRequestInput,
  type Project,
  type Workspace,
} from '@devbrain/contracts';
import type { SecretCipher } from '@devbrain/security';
import { createCoreServices, type CoreServices } from './index.js';

/** Test cipher (XOR). Real builds use Electron safeStorage (DPAPI). */
const cipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});

let base: string;
let core: CoreServices;
const open: CoreServices[] = [];

const start = (options: Partial<Parameters<typeof createCoreServices>[0]> = {}) => {
  const c = createCoreServices({
    databaseFile: ':memory:',
    cipher: cipher(),
    instanceId: `run_${crypto.randomUUID()}`,
    appVersion: 'test',
    ...options,
  });
  open.push(c);
  return c;
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devbrain-core-')));
  core = start();
});
afterEach(async () => {
  for (const c of open.splice(0)) {
    try {
      c.close();
    } catch {
      // already closed (crash simulation)
    }
  }
  await rm(base, { recursive: true, force: true });
});

interface Fixture {
  project: Project;
  workspace: Workspace;
  agent: Agent;
  providerId: string;
}

const fixture = async (c: CoreServices = core, name = 'repo'): Promise<Fixture> => {
  const dir = path.join(base, name);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.ts'), 'export {};');
  await writeFile(path.join(dir, '.env'), 'TOKEN=abc');
  const project = await c.projects.register({ rootPath: dir });
  const [workspace] = await c.projects.listWorkspaces(project.id);
  const provider = await c.providers.register({
    adapterKey: 'test-cli',
    kind: 'cli-agent',
    displayName: 'Test',
  });
  const agent = await c.agents.register({ providerId: provider.provider.id, name: 'Agent' });
  if (!workspace) throw new Error('no workspace');
  return { project, workspace, agent, providerId: provider.provider.id };
};

const instruction = (
  sessionId: string,
  cwd: string,
  extra: Partial<ExecutionRequestInput> = {},
): ExecutionRequestInput => ({
  id: newId('execution'),
  sessionId,
  payload: { kind: 'prompt', prompt: 'do it', contextFiles: ['src/index.ts'] },
  workingDirectory: cwd,
  timeoutMs: 60_000,
  idempotencyKey: null,
  createdAt: nowTimestamp(),
  ...extra,
});

// ---------------------------------------------------------------------------

describe('providers: readiness comes only from execution-engine evidence', () => {
  it('walks the readiness ladder', async () => {
    const p = await core.providers.register({
      adapterKey: 'x-cli',
      kind: 'cli-agent',
      displayName: 'X',
    });
    expect(p.readiness).toBe('configured');
    expect(p.provider.capabilities.enforcement).toBeUndefined();
    const id = p.provider.id;
    expect(
      (
        await core.providers.recordEvidence({
          providerId: id,
          aspect: 'installed',
          state: 'yes',
          detail: 'v1.2.3',
        })
      ).readiness,
    ).toBe('available');
    const failing = await core.providers.recordEvidence({
      providerId: id,
      aspect: 'authenticated',
      state: 'no',
      detail: 'token sk-abcdefghijklmnopqrstuvwx rejected',
    });
    expect(failing.readiness).toBe('failing');
    expect(failing.provider.status).toBe('unauthenticated');
    expect(failing.health.authenticated.detail).not.toContain('sk-abcdefghijklmnop');
    const ok = await core.providers.recordEvidence({
      providerId: id,
      aspect: 'operational',
      state: 'yes',
      detail: null,
    });
    expect(ok.readiness).toBe('operational');
    expect(ok.health.authenticated.state).toBe('yes');
    expect((await core.providers.setEnabled({ id, enabled: false })).readiness).toBe('disabled');
    await core.providers.setEnabled({ id, enabled: true });
    // Changing configuration invalidates earlier evidence.
    const changed = await core.providers.update({
      id,
      config: { executablePath: path.join(base, 'x.exe') },
    });
    expect(changed.readiness).toBe('configured');
    expect(changed.config.executablePath).toBe(path.join(base, 'x.exe'));
    expect(changed.config.defaultArgs).toEqual([]);
  });

  it('agents get a restrictive default policy and providers in use cannot be removed', async () => {
    const { agent, providerId } = await fixture();
    const policy = core.policies.get(agent.permissionPolicyId);
    expect(policy.defaultDecision).toBe('ask');
    await expect(core.providers.remove(providerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const saved = await core.policies.save({ ...policy, defaultDecision: 'deny' });
    expect(saved.version).toBe(policy.version + 1);
  });
});

describe('credentials', () => {
  it('stores OS-encrypted secrets as ciphertext only and audits every use', async () => {
    const secret = `sk-live-${crypto.randomUUID()}`;
    const ref = await core.credentials.store({ storage: 'os-encrypted', label: 'API', secret });
    expect(JSON.stringify(ref)).not.toContain(secret);
    expect(ref.hint).toBe(secret.slice(-4));
    const rows = core.db.driver.all('SELECT * FROM credential_secrets');
    const refs = core.db.driver.all('SELECT * FROM credential_refs');
    const audit = core.db.driver.all('SELECT data FROM audit_events');
    const dump = JSON.stringify([
      rows.map((r) => Buffer.from(r['ciphertext'] as Uint8Array).toString('latin1')),
      refs,
      audit,
    ]);
    expect(dump).not.toContain(secret);

    await expect(core.credentials.resolve(ref.id, { reason: 'test' })).resolves.toBe(secret);
    const used = (await core.db.audit.list({ limit: 5 })).find(
      (e) => e.action === 'credential.used',
    );
    expect(used?.permission).toBe('credential.use');
    expect(JSON.stringify(used)).not.toContain(secret);

    const env = await core.credentials.store({
      storage: 'environment',
      label: 'Env',
      variable: 'DEVBRAIN_TEST_TOKEN',
    });
    await expect(core.credentials.resolve(env.id, { reason: 'test' })).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
    });

    const provider = await core.providers.register({
      adapterKey: 'y-cli',
      kind: 'cli-agent',
      displayName: 'Y',
      credentialRef: ref.id,
    });
    await expect(core.credentials.remove(ref.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await core.providers.update({ id: provider.provider.id, credentialRef: null });
    await core.credentials.remove(ref.id);
    expect(core.db.driver.all('SELECT * FROM credential_secrets')).toHaveLength(0);
  });

  it('refuses to store secrets without OS encryption (no plaintext fallback)', async () => {
    const noCrypto = start({ cipher: cipher(false) });
    await expect(
      noCrypto.credentials.store({ storage: 'os-encrypted', label: 'x', secret: 'abc' }),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
    });
    expect(await noCrypto.credentials.list()).toEqual([]);
  });
});

describe('sessions and history', () => {
  it('records instructions, events, files, results, usage and checkpoints', async () => {
    const { project, workspace, agent } = await fixture();
    const session = await core.sessions.start({
      agentId: agent.id,
      projectId: project.id,
      workspaceId: workspace.id,
      title: 'T',
    });
    expect(session.status).toBe('active');

    await expect(
      core.sessions.recordInstruction(instruction(session.id, base)),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
    const req = await core.sessions.recordInstruction(
      instruction(session.id, workspace.rootPath, { idempotencyKey: 'key-12345678' }),
    );
    const again = await core.sessions.recordInstruction(
      instruction(session.id, workspace.rootPath, { idempotencyKey: 'key-12345678' }),
    );
    expect(again.id).toBe(req.id);

    const ev = (seq: number, extra: object) => ({
      id: newId('event'),
      executionId: req.id,
      sessionId: session.id,
      seq,
      timestamp: nowTimestamp(),
      ...extra,
    });
    await core.sessions.recordEvent(ev(0, { type: 'status', status: 'running' }) as never);
    await core.sessions.recordEvent(
      ev(1, {
        type: 'file-change',
        path: path.join(workspace.rootPath, 'src', 'a.ts'),
        change: 'created',
      }) as never,
    );
    await core.sessions.recordEvent(
      ev(2, {
        type: 'file-change',
        path: path.join(base, 'outside.txt'),
        change: 'modified',
      }) as never,
    );

    await expect(core.sessions.stop(session.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await core.sessions.recordResult({
      executionId: req.id,
      sessionId: session.id,
      status: 'completed',
      exitCode: 0,
      startedAt: nowTimestamp(),
      finishedAt: nowTimestamp(),
      summary: 'done',
      usage: { inputTokens: 10, outputTokens: 5, costAmount: 0.25, costCurrency: 'USD' },
      error: null,
      outputTruncated: false,
    });
    const checkpoint = await core.sessions.saveCheckpoint({
      sessionId: session.id,
      label: 'after step 1',
      state: {
        version: 1,
        task: 'x',
        plan: ['a'],
        summary: 's',
        filesTouched: ['src/a.ts'],
        nextSteps: ['b'],
        providerRef: null,
        lastExecutionId: req.id,
      },
    });

    const history = await core.sessions.history(session.id);
    expect(history.session.lastCheckpointId).toBe(checkpoint.id);
    expect(history.executions).toHaveLength(1);
    expect(history.executions[0]).toMatchObject({ status: 'completed', eventCount: 3 });
    expect(history.files.map((f) => `${f.change}:${f.path}`).sort()).toEqual([
      'created:src/a.ts',
      'referenced:src/index.ts',
    ]);
    expect(history.checkpoints.map((c) => c.id)).toEqual([checkpoint.id]);

    const usage = await core.usage.summary({ period: 'day' });
    expect(usage).toMatchObject({
      executions: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: { USD: 0.25 },
    });

    const ended = await core.sessions.stop(session.id);
    expect(ended).toMatchObject({ status: 'completed', endReason: 'stopped by user' });
    await expect(
      core.sessions.recordInstruction(instruction(session.id, workspace.rootPath)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A conscious re-run links the previous session and its last checkpoint.
    const rerun = await core.sessions.start({
      agentId: agent.id,
      projectId: project.id,
      workspaceId: workspace.id,
      resumeFromSessionId: session.id,
    });
    expect(rerun).toMatchObject({
      resumedFromSessionId: session.id,
      lastCheckpointId: checkpoint.id,
    });
  });

  it('refuses sessions for disabled providers, archived projects and foreign workspaces', async () => {
    const a = await fixture(core, 'a');
    const b = await fixture(core, 'b');
    await expect(
      core.sessions.start({
        agentId: a.agent.id,
        projectId: a.project.id,
        workspaceId: b.workspace.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await core.projects.archive(b.project.id);
    await expect(
      core.sessions.start({
        agentId: a.agent.id,
        projectId: b.project.id,
        workspaceId: b.workspace.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await core.providers.setEnabled({ id: a.providerId, enabled: false });
    await expect(
      core.sessions.start({
        agentId: a.agent.id,
        projectId: a.project.id,
        workspaceId: a.workspace.id,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('refuses to remove a project with live sessions; removal cascades history only', async () => {
    const { project, workspace, agent } = await fixture();
    const s = await core.sessions.start({
      agentId: agent.id,
      projectId: project.id,
      workspaceId: workspace.id,
    });
    await expect(core.projects.remove({ id: project.id, confirm: true })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await core.sessions.end(s.id, 'cancelled', 'user');
    await core.projects.remove({ id: project.id, confirm: true });
    expect(core.db.sessions.findById(s.id)).toBeNull();
    expect(readFileSync(path.join(workspace.rootPath, 'src', 'index.ts'), 'utf8')).toBe(
      'export {};',
    );
  });
});

describe('crash recovery', () => {
  it('marks orphaned sessions/executions interrupted and never resumes them', async () => {
    const file = path.join(base, 'data', 'devbrain.db');
    const first = start({ databaseFile: file });
    const { project, workspace, agent } = await fixture(first);
    const session = await first.sessions.start({
      agentId: agent.id,
      projectId: project.id,
      workspaceId: workspace.id,
    });
    const req = await first.sessions.recordInstruction(instruction(session.id, workspace.rootPath));
    const approval = await first.approvals.request({
      agentId: agent.id,
      sessionId: session.id,
      action: 'process.spawn',
      risk: 'medium',
      summary: 'x',
      untrustedOrigin: false,
    });
    // Crash: the process dies without `close()` (no clean-shutdown mark).
    first.db.driver.close();

    const second = start({ databaseFile: file });
    expect(second.recovery).toMatchObject({
      uncleanShutdownDetected: true,
      recoveredSessions: 1,
      recoveredExecutions: 1,
      cancelledApprovals: 1,
    });
    const recovered = await second.sessions.get(session.id);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.endReason).toMatch(/unexpectedly/);
    const record = second.sessions.executionRecord(req.id);
    expect(record?.status).toBe('failed');
    expect(record?.result?.error?.code).toBe('INTERRUPTED');
    expect((await second.approvals.get(approval.id)).status).toBe('cancelled');
    await expect(
      second.sessions.recordInstruction(instruction(session.id, workspace.rootPath)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(second.maintenance.health()).toMatchObject({
      uncleanShutdownDetected: true,
      recoveredSessions: 1,
      schemaVersion: 5,
    });

    // Clean shutdown is not reported as a crash.
    second.close();
    const third = start({ databaseFile: file });
    expect(third.recovery.uncleanShutdownDetected).toBe(false);
  });
});

describe('authorization (effectively enforced)', () => {
  it('applies real-path workspace scope, exclusions and read-only roots', async () => {
    const f = await fixture();
    const ctx = { agentId: f.agent.id, workspaceId: f.workspace.id };
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.read', path: 'src/index.ts' }))
        .decision,
    ).toBe('allow');
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.read', path: '.env' })).decision,
    ).toBe('deny');
    const outside = await core.authorization.evaluate({
      ...ctx,
      action: 'fs.write',
      path: path.join(base, 'elsewhere.txt'),
    });
    expect(outside).toMatchObject({ action: 'scope.escape', decision: 'ask' });
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.read', path: '../escape.txt' }))
        .decision,
    ).not.toBe('allow');

    // Junction inside the workspace pointing outside: treated as outside.
    const target = path.join(base, 'outside-dir');
    await mkdir(target);
    await writeFile(path.join(target, 'secret.txt'), 'x');
    await symlink(
      target,
      path.join(f.workspace.rootPath, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const viaLink = await core.authorization.evaluate({
      ...ctx,
      action: 'fs.read',
      path: 'link/secret.txt',
    });
    expect(viaLink.decision).not.toBe('allow');

    await core.projects.updateSettings({
      projectId: f.project.id,
      excludedPaths: ['src/private/**'],
    });
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.read', path: 'src/private/a.ts' }))
        .decision,
    ).toBe('deny');

    await mkdir(path.join(f.workspace.rootPath, 'docs'));
    await core.projects.updateWorkspaceAccess({
      workspaceId: f.workspace.id,
      allowedRoots: [f.workspace.rootPath],
      readOnlyRoots: [path.join(f.workspace.rootPath, 'docs')],
      allowNetwork: false,
    });
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.write', path: 'docs/a.md' }))
        .decision,
    ).toBe('deny');
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'fs.read', path: 'docs/a.md' }))
        .decision,
    ).toBe('allow');

    await expect(
      core.authorization.enforce({ ...ctx, action: 'fs.read', path: '.env' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      core.authorization.enforce(
        { ...ctx, action: 'fs.write', path: path.join(base, 'x') },
        { waitForApproval: false },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const denied = (await core.db.audit.list({ limit: 50 })).filter(
      (e) => e.action === 'permission.checked' && e.outcome === 'denied',
    );
    expect(denied.length).toBeGreaterThan(0);
  });

  it('project override policy is combined most-restrictive', async () => {
    const f = await fixture();
    const strict = await core.policies.save({
      ...core.policies.get(f.agent.permissionPolicyId),
      id: newId('policy'),
      name: 'strict',
      defaultDecision: 'deny',
      rules: [{ action: 'fs.write', decision: 'deny' }],
    });
    await core.projects.updateSettings({ projectId: f.project.id, permissionPolicyId: strict.id });
    const v = await core.authorization.evaluate({
      agentId: f.agent.id,
      workspaceId: f.workspace.id,
      action: 'fs.write',
      path: 'src/index.ts',
    });
    expect(v.decision).toBe('deny');
  });

  it('waits for a human decision; grants lift only `ask` and die with the session', async () => {
    const f = await fixture();
    const session = await core.sessions.start({
      agentId: f.agent.id,
      projectId: f.project.id,
      workspaceId: f.workspace.id,
    });
    const ctx = { agentId: f.agent.id, workspaceId: f.workspace.id, sessionId: session.id };

    const pending = core.authorization.enforce({
      ...ctx,
      action: 'process.spawn',
      executable: 'npm',
    });
    await new Promise((r) => setTimeout(r, 10));
    const [request] = await core.approvals.listPending();
    expect(request).toMatchObject({
      action: 'process.spawn',
      target: 'npm',
      projectId: f.project.id,
    });
    await core.approvals.decide({
      approvalId: request!.id,
      decision: 'approved',
      scope: 'session',
    });
    await expect(pending).resolves.toMatchObject({ decision: 'allow' });

    const lifted = await core.authorization.evaluate({
      ...ctx,
      action: 'process.spawn',
      executable: 'npm.cmd',
    });
    expect(lifted.decision).toBe('allow');
    expect(lifted.grantId).not.toBeNull();
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'process.spawn', executable: 'cargo' }))
        .decision,
    ).toBe('ask');
    // Never lifts deny.
    expect((await core.authorization.evaluate({ ...ctx, action: 'credential.use' })).decision).toBe(
      'deny',
    );

    await core.approvals.revokeGrant(lifted.grantId!);
    expect(
      (await core.authorization.evaluate({ ...ctx, action: 'process.spawn', executable: 'npm' }))
        .decision,
    ).toBe('ask');

    // Destructive actions can only be approved once.
    const del = await core.approvals.request({
      agentId: f.agent.id,
      sessionId: session.id,
      projectId: f.project.id,
      action: 'fs.delete',
      risk: 'high',
      summary: 'rm',
      untrustedOrigin: false,
    });
    await expect(
      core.approvals.decide({ approvalId: del.id, decision: 'approved', scope: 'project' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await core.approvals.decide({ approvalId: del.id, decision: 'denied' })).status).toBe(
      'denied',
    );
    await expect(
      core.approvals.decide({ approvalId: del.id, decision: 'approved' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A project grant survives the session; session grants are revoked when it ends.
    const p2 = core.authorization.enforce({ ...ctx, action: 'process.spawn', executable: 'make' });
    await new Promise((r) => setTimeout(r, 10));
    const [r2] = await core.approvals.listPending();
    await core.approvals.decide({ approvalId: r2!.id, decision: 'approved', scope: 'session' });
    await p2;
    await core.sessions.end(session.id, 'completed');
    expect(await core.approvals.listGrants({ agentId: f.agent.id })).toHaveLength(0);
  });

  it('expires and cancels approvals; waiting callers are released', async () => {
    const f = await fixture();
    const approval = await core.approvals.request({
      agentId: f.agent.id,
      action: 'network.request',
      risk: 'medium',
      summary: 'x',
      untrustedOrigin: false,
    });
    const waiting = core.approvals.waitFor(approval.id);
    core.db.approvals.save({ ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(core.approvals.sweep()).toBe(1);
    await expect(waiting).resolves.toMatchObject({ status: 'expired' });
    await expect(
      core.approvals.decide({ approvalId: approval.id, decision: 'approved' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const abort = new AbortController();
    const other = await core.approvals.request({
      agentId: f.agent.id,
      action: 'network.request',
      risk: 'medium',
      summary: 'y',
      untrustedOrigin: true,
    });
    const w2 = core.approvals.waitFor(other.id, abort.signal);
    abort.abort();
    await expect(w2).rejects.toMatchObject({ code: 'CANCELLED' });
    // Untrusted-origin requests cannot become standing grants.
    await expect(
      core.approvals.decide({ approvalId: other.id, decision: 'approved', scope: 'project' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('authorizes commands without a shell and blocks dangerous ones', async () => {
    const f = await fixture();
    const base0 = { agentId: f.agent.id, workspaceId: f.workspace.id, cwd: f.workspace.rootPath };
    await expect(
      core.authorization.authorizeCommand({ ...base0, executable: 'format', args: ['C:'] }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
    await expect(
      core.authorization.authorizeCommand(
        { ...base0, executable: 'powershell', args: ['-c', 'x'] },
        { waitForApproval: false },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(
      core.authorization.authorizeCommand(
        { ...base0, cwd: base, executable: 'git', args: ['status'] },
        { waitForApproval: false },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const pendingActions = (await core.approvals.listPending()).map((a) => a.action);
    expect(pendingActions).toEqual(expect.arrayContaining(['process.spawn', 'scope.escape']));
  });

  it('gates executions: per-session approval without enforcement, budgets and concurrency', async () => {
    const f = await fixture();
    const session = await core.sessions.start({
      agentId: f.agent.id,
      projectId: f.project.id,
      workspaceId: f.workspace.id,
    });
    // No verified enforcement capability → most restrictive mode + explicit approval.
    const err = await core.authorization
      .authorizeExecution({ sessionId: session.id }, { waitForApproval: false })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const [req] = await core.approvals.listPending();
    await core.approvals.decide({ approvalId: req!.id, decision: 'approved', scope: 'session' });
    const auth = await core.authorization.authorizeExecution(
      { sessionId: session.id },
      { waitForApproval: false },
    );
    expect(auth.plan).toMatchObject({
      level: 'none',
      requiresSessionApproval: true,
      networkAllowed: false,
    });
    expect(auth.plan.limitations.map((l) => l.id)).toContain('no-enforcement');
    expect(auth.workingDirectory).toBe(f.workspace.rootPath);

    await expect(
      core.authorization.authorizeExecution(
        { sessionId: session.id, workingDirectory: base },
        { waitForApproval: false },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    // Unknown cost is never zero: with a limit and an agent that cannot report cost, the
    // limit cannot be enforced, so the execution is refused unless explicitly opted in.
    await core.settings.update({ budget: { maxPerDay: 1 } });
    await expect(
      core.authorization.authorizeExecution({ sessionId: session.id }, { waitForApproval: false }),
    ).rejects.toMatchObject({ code: 'BUDGET_UNENFORCEABLE' });
    // Plain commands carry no provider cost: the budget gate does not apply to them.
    await expect(
      core.authorization.authorizeExecution(
        { sessionId: session.id, costBearing: false },
        { waitForApproval: false },
      ),
    ).resolves.toMatchObject({ session: { id: session.id } });
    await core.settings.update({ budget: { allowWithoutCostGuarantee: true } });
    await expect(
      core.authorization.authorizeExecution({ sessionId: session.id }, { waitForApproval: false }),
    ).resolves.toMatchObject({ session: { id: session.id } });
    core.db.usage.record({
      executionId: newId('execution'),
      agentId: f.agent.id,
      providerId: f.providerId,
      projectId: f.project.id,
      usage: { inputTokens: 1, outputTokens: 1, costAmount: 2, costCurrency: 'USD' },
    });
    await expect(
      core.authorization.authorizeExecution({ sessionId: session.id }, { waitForApproval: false }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    // An execution without reported cost is counted as unknown, never as zero.
    core.db.usage.record({
      executionId: newId('execution'),
      agentId: f.agent.id,
      providerId: f.providerId,
      projectId: f.project.id,
      usage: { inputTokens: null, outputTokens: null, costAmount: null, costCurrency: null },
    });
    const summary = await core.usage.summary({ period: 'day' });
    expect(summary).toMatchObject({ executions: 2, cost: { USD: 2 }, unknownCostExecutions: 1 });
    await core.settings.update({
      budget: { maxPerDay: null, allowWithoutCostGuarantee: false },
    });

    // Concurrency: per-agent limit 2 (settings) → the third waits.
    const r1 = await core.authorization.acquireSlot(f.agent.id);
    const r2 = await core.authorization.acquireSlot(f.agent.id);
    let third = false;
    const p3 = core.authorization.acquireSlot(f.agent.id).then((release) => {
      third = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
  });
});

describe('maintenance', () => {
  it('backs up, prunes, reports health and exports without secrets', async () => {
    const file = path.join(base, 'm', 'devbrain.db');
    const c = start({ databaseFile: file });
    const f = await fixture(c);
    await c.credentials.store({
      storage: 'os-encrypted',
      label: 'k',
      secret: 'super-secret-export-value',
    });
    const backup = c.maintenance.backup();
    expect(backup.bytes).toBeGreaterThan(0);
    expect(c.maintenance.backupIfDue()).toBeNull();
    const pruned = c.maintenance.prune(Date.now() + 400 * 24 * 60 * 60 * 1000);
    expect(pruned.auditEvents).toBeGreaterThan(0);
    expect(c.maintenance.health()).toMatchObject({
      integrity: 'ok',
      lastBackupAt: backup.createdAt,
    });
    const out = path.join(base, 'export.json');
    await c.maintenance.writeProjectExport(f.project.id, out);
    const text = readFileSync(out, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ format: 'devbrain.project-export', version: 1 });
    expect(text).not.toContain('super-secret-export-value');
  });

  it('emits change events for the desktop shell', async () => {
    const seen: string[] = [];
    core.events.on('projects.changed', () => seen.push('projects'));
    core.events.on('providers.changed', () => seen.push('providers'));
    core.events.on('sessions.changed', (s) => seen.push(`session:${s.status}`));
    const f = await fixture();
    await core.sessions.start({
      agentId: f.agent.id,
      projectId: f.project.id,
      workspaceId: f.workspace.id,
    });
    expect(seen).toEqual(expect.arrayContaining(['projects', 'providers', 'session:active']));
  });
});
