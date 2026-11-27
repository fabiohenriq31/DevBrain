import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CONTRACTS_VERSION,
  dispatchIpc,
  type IpcChannelKey,
  type IpcInput,
  type IpcOutput,
} from '@devbrain/contracts';
import { createCoreServices } from '@devbrain/core';
import { OperationalExecutionService } from '@devbrain/execution-engine';
import { LocalGitService } from '@devbrain/git-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandlers } from './ipc.js';
import { isTrustedRendererUrl } from './security.js';

const exec = promisify(execFile);
const gitCmd = (cwd: string, ...args: string[]) =>
  exec(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', cwd, ...args]);

const testCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
};

describe('desktop main IPC handlers & security boundaries', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbrain-ipc-test-'));
    tempDirs.push(root);
    const core = createCoreServices({
      databaseFile: join(root, 'devbrain.db'),
      backupDir: join(root, 'backups'),
      cipher: testCipher,
      instanceId: 'run_ipc_test',
      appVersion: '0.1.0-test',
    });
    const engine = new OperationalExecutionService(core);
    const git = new LocalGitService();
    const handlers = createHandlers({ core, engine, git, devServerUrl: undefined });

    const call = async <K extends IpcChannelKey>(
      key: K,
      payload: IpcInput<K>,
    ): Promise<IpcOutput<K>> => {
      const res = await dispatchIpc(
        key,
        {
          contractsVersion: CONTRACTS_VERSION,
          correlationId: 'corr-test-1234',
          payload,
        },
        handlers[key] as never,
      );
      if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
      return res.data;
    };

    return { root, core, engine, handlers, call };
  };

  it('enforces trusted renderer origins and rejects malformed/mismatched IPC envelopes', async () => {
    expect(isTrustedRendererUrl('file:///C:/app/out/renderer/index.html', undefined)).toBe(true);
    expect(isTrustedRendererUrl('https://evil.example.com', undefined)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', 'http://localhost:5173')).toBe(
      true,
    );
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/index.html', 'http://localhost:5173')).toBe(
      false,
    );

    const { core, engine, handlers } = await setup();
    try {
      const badMajor = await dispatchIpc(
        'projects.list',
        { contractsVersion: '9.0.0', correlationId: 'corr-bad-major', payload: {} },
        handlers['projects.list'],
      );
      expect(badMajor.ok).toBe(false);
      if (!badMajor.ok) expect(badMajor.error.code).toBe('CONTRACT_VERSION_MISMATCH');

      const badEnvelope = await dispatchIpc('projects.list', null, handlers['projects.list']);
      expect(badEnvelope.ok).toBe(false);
      if (!badEnvelope.ok) expect(badEnvelope.error.code).toBe('VALIDATION_FAILED');
    } finally {
      await engine.close();
      core.close();
    }
  });

  it('imports, inspects Git status/diff with secret redaction + size cap, and removes registration without deleting disk files', async () => {
    const { root, core, engine, call } = await setup();
    try {
      const repoDir = join(root, 'repo');
      await mkdir(repoDir, { recursive: true });
      await gitCmd(repoDir, 'init');
      const trackedFile = join(repoDir, 'config.ts');
      await writeFile(trackedFile, 'export const mode = "dev";\n');
      await gitCmd(repoDir, 'add', '--all');
      await gitCmd(
        repoDir,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'init',
      );

      const proj = await call('projects.register', { rootPath: repoDir });
      expect(proj.isGitRepository).toBe(true);
      const wsId = proj.defaultWorkspaceId!;

      // Modify tracked file including a token-like secret to verify redaction + diff
      const fakeToken = 'sk-' + 'a'.repeat(32);
      await writeFile(
        trackedFile,
        `export const mode = "prod";\nexport const key = "${fakeToken}";\n${'x'.repeat(2048)}\n`,
      );

      const status = await call('git.status', { workspaceId: wsId });
      expect(status?.clean).toBe(false);
      expect(status?.files.some((f) => f.path === 'config.ts')).toBe(true);

      const fullDiff = await call('git.diff', { workspaceId: wsId });
      expect(fullDiff.diff).toContain('config.ts');
      expect(fullDiff.diff).not.toContain(fakeToken);
      expect(fullDiff.truncated).toBe(false);

      const cappedDiff = await call('git.diff', { workspaceId: wsId, maxBytes: 1024 });
      expect(cappedDiff.truncated).toBe(true);
      expect(Buffer.byteLength(cappedDiff.diff, 'utf8')).toBeLessThanOrEqual(1024);

      // Safe project removal NEVER deletes files on disk
      await call('projects.remove', { id: proj.id, confirm: true });
      expect(existsSync(trackedFile)).toBe(true);
      expect(await call('projects.list', { includeArchived: true })).toHaveLength(0);
    } finally {
      await engine.close();
      core.close();
    }
  });

  it('records provider dependency evidence and runs/cancels/approves executions end-to-end', async () => {
    const { root, core, engine, call } = await setup();
    try {
      const workDir = join(root, 'app');
      await mkdir(workDir, { recursive: true });
      const proj = await call('projects.register', { rootPath: workDir });

      const adapters = await call('providers.listAdapters', {});
      expect(adapters.map((a) => a.adapterKey)).toEqual(
        expect.arrayContaining(['openai-codex-cli', 'claude-code-cli', 'google-antigravity-cli']),
      );

      const prov = await call('providers.register', {
        adapterKey: 'claude-code-cli',
        kind: 'cli-agent',
        displayName: 'Claude Code',
      });
      await call('providers.checkDependencies', { adapterKey: 'claude-code-cli' });
      const refreshedProv = await call('providers.get', { id: prov.provider.id });
      expect(refreshedProv.health.installed.source).toBe('execution-engine');

      const agent = await call('agents.register', {
        providerId: prov.provider.id,
        name: 'Claude Local',
      });
      const session = await call('sessions.start', {
        agentId: agent.id,
        projectId: proj.id,
        workspaceId: proj.defaultWorkspaceId!,
      });

      // Submit a long-running node command, approve it with session scope, then cancel it!
      const handle = await call('executions.submit', {
        sessionId: session.id,
        payload: {
          kind: 'command',
          executable: 'node',
          args: ['-e', 'setInterval(() => {}, 200)'],
        },
      });

      // Wait for approval request and approve with session scope (creates revocable grant)
      for (let i = 0; i < 40; i++) {
        const pending = await call('approvals.listPending', {});
        if (pending.length > 0) {
          for (const req of pending) {
            await call('approvals.decide', {
              approvalId: req.id,
              decision: 'approved',
              scope: 'session',
            });
          }
          // Wait briefly so the second approval (command after session approval) can also be approved
        }
        const events = await call('executions.listEvents', { executionId: handle.executionId });
        if (events.some((ev) => ev.type === 'status' && ev.status === 'running')) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Cancel execution
      await call('executions.interrupt', { executionId: handle.executionId, mode: 'force' });
      let finalStatus = '';
      for (let i = 0; i < 40; i++) {
        const res = await call('executions.getResult', { executionId: handle.executionId });
        if (res) {
          finalStatus = res.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(finalStatus).toBe('cancelled');

      // Revoke active session grant
      const grants = await call('permissions.listGrants', { includeInactive: false });
      expect(grants.length).toBeGreaterThan(0);
      const revoked = await call('permissions.revokeGrant', {
        id: grants[0]!.id,
        reason: 'test revoke',
      });
      expect(revoked.revokedAt).not.toBeNull();
    } finally {
      await engine.close();
      core.close();
    }
  });
});
