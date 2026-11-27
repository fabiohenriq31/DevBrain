#!/usr/bin/env node
/**
 * Manual subscription-backed verification. Never run in CI: it invokes a signed-in
 * Codex CLI and may consume the user's subscription quota. No API key is required.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCoreServices } from '../packages/core/dist/index.js';
import { OperationalExecutionService } from '../packages/execution-engine/dist/index.js';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'devbrain-real-engine-'));
const projectRoot = join(directory, 'project');
const fs = await import('node:fs/promises');
await fs.mkdir(projectRoot);
const git = (...args) =>
  exec(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', projectRoot, ...args]);
await git('init');
await writeFile(join(projectRoot, 'counter.js'), 'export const double = (n) => n + n;\n');
await git('add', '--all');
await git(
  '-c',
  'user.name=DevBrain Test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'baseline',
);
const core = createCoreServices({
  databaseFile: join(directory, 'devbrain.db'),
  backupDir: join(directory, 'backups'),
  cipher: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('Credentials not used in this verification');
    },
    decryptString: () => {
      throw new Error('Credentials not used in this verification');
    },
  },
  instanceId: `real_${crypto.randomUUID()}`,
});
const engine = new OperationalExecutionService(core);
const decided = new Set();
const approvalTimer = setInterval(async () => {
  try {
    for (const approval of await core.approvals.listPending()) {
      if (decided.has(approval.id)) continue;
      decided.add(approval.id);
      // This temporary project and the exact prompt below are the user's authorized test.
      await core.approvals.decide({
        approvalId: approval.id,
        decision: 'approved',
        scope: 'session',
      });
    }
  } catch {
    /* the result will report any authorization failure */
  }
}, 100);
try {
  const project = await core.projects.register({ rootPath: projectRoot });
  const [workspace] = await core.projects.listWorkspaces(project.id);
  const provider = await core.providers.register({
    adapterKey: 'openai-codex-cli',
    kind: 'cli-agent',
    displayName: 'OpenAI Codex',
  });
  const agent = await core.agents.register({
    providerId: provider.provider.id,
    name: 'Codex verification',
  });
  const session = await core.sessions.start({
    agentId: agent.id,
    projectId: project.id,
    workspaceId: workspace.id,
  });
  const handle = await engine.submit({
    sessionId: session.id,
    timeoutMs: 120_000,
    payload: {
      kind: 'prompt',
      prompt:
        'In counter.js, add an exported function triple(n) returning n * 3. Change only that file and finish.',
    },
  });
  const result = await engine.wait(handle.executionId);
  const events = await core.db.executions.listEvents({ executionId: handle.executionId });
  const code = await readFile(join(projectRoot, 'counter.js'), 'utf8');
  const history = await core.sessions.history(session.id);
  const evidence = {
    directory,
    result: result.status,
    exitCode: result.exitCode,
    events: events.length,
    fileChange: events.some((event) => event.type === 'file-change' && event.path === 'counter.js'),
    modifiedCode: code.includes('triple'),
    checkpoints: history.checkpoints.length,
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (
    result.status !== 'completed' ||
    !evidence.modifiedCode ||
    !evidence.fileChange ||
    evidence.checkpoints < 1
  )
    process.exitCode = 1;
} finally {
  clearInterval(approvalTimer);
  await engine.close();
  core.close();
}
