#!/usr/bin/env node
/**
 * Manual, subscription-backed verification of a REAL agent CLI through the real Core and
 * OperationalExecutionService. Never run in CI: it invokes a signed-in agent CLI and may
 * consume the user's subscription quota. No API key is used or required.
 *
 *   node scripts/verify-real-agent.mjs [openai-codex-cli|claude-code-cli|google-antigravity-cli]
 *
 * Everything happens in a new temporary Git project. The executable is resolved from PATH
 * only (as in the app); DEVBRAIN_EXTRA_PATH may prepend directories for this run.
 *
 * Flow: dependency check -> capabilities -> session -> budget gate (no spend) -> approval ->
 * real file edit with streaming -> change detection + user-change preservation -> Git diff ->
 * result/checkpoint/history -> cancellation of a second execution.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createCoreServices } from '../packages/core/dist/index.js';
import { OperationalExecutionService } from '../packages/execution-engine/dist/index.js';
import { LocalGitService } from '../packages/git-engine/dist/index.js';

const adapterKey = process.argv[2] ?? 'openai-codex-cli';
if (process.env.DEVBRAIN_EXTRA_PATH)
  process.env.PATH = `${process.env.DEVBRAIN_EXTRA_PATH}${delimiter}${process.env.PATH ?? ''}`;

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'devbrain-real-engine-'));
const projectRoot = join(directory, 'project');
await mkdir(projectRoot);
const git = (...args) =>
  exec(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', projectRoot, ...args]);
await git('init');
await writeFile(join(projectRoot, 'counter.js'), 'export const double = (n) => n + n;\n');
await writeFile(join(projectRoot, 'notes.md'), '# notes\n');
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
// A pre-existing, uncommitted user change that the agent is told not to touch.
const userChange = '# notes\n\nuser draft - do not lose\n';
await writeFile(join(projectRoot, 'notes.md'), userChange);

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
const streamed = [];
engine.subscribe((event) => streamed.push(event));
const approvalsSeen = [];
const approvalTimer = setInterval(async () => {
  try {
    for (const approval of await core.approvals.listPending()) {
      if (approvalsSeen.some((a) => a.id === approval.id)) continue;
      approvalsSeen.push({ id: approval.id, action: approval.action, summary: approval.summary });
      // This temporary project and the exact prompts below are the user's authorized test.
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

const evidence = { adapterKey, directory };
try {
  const dependency = await engine.checkDependencies(adapterKey);
  evidence.dependency = {
    status: dependency.status,
    version: dependency.checks[0]?.version ?? null,
    message: dependency.checks[0]?.message ?? null,
  };
  evidence.capabilities = await engine.getCapabilities(adapterKey);

  const project = await core.projects.register({ rootPath: projectRoot });
  const [workspace] = await core.projects.listWorkspaces(project.id);
  const provider = await core.providers.register({
    adapterKey,
    kind: 'cli-agent',
    displayName: adapterKey,
  });
  const agent = await core.agents.register({
    providerId: provider.provider.id,
    name: `${adapterKey} verification`,
  });
  const session = await core.sessions.start({
    agentId: agent.id,
    projectId: project.id,
    workspaceId: workspace.id,
  });

  // Budget gate: with a limit and an agent that cannot report cost, nothing may start.
  await core.settings.update({ budget: { maxPerDay: 1 } });
  const blocked = await engine.submit({
    sessionId: session.id,
    payload: { kind: 'prompt', prompt: 'This prompt must never reach the agent.' },
  });
  const blockedResult = await engine.wait(blocked.executionId);
  evidence.budgetGate = {
    status: blockedResult.status,
    code: blockedResult.error?.code ?? null,
    startedAt: blockedResult.startedAt,
  };
  await core.settings.update({ budget: { maxPerDay: null } });

  const handle = await engine.submit({
    sessionId: session.id,
    timeoutMs: 180_000,
    payload: {
      kind: 'prompt',
      prompt:
        'In counter.js, add an exported function triple(n) returning n * 3. Change only counter.js; do not touch any other file. Then finish.',
    },
  });
  const result = await engine.wait(handle.executionId);
  const events = await core.db.executions.listEvents({ executionId: handle.executionId });
  const code = await readFile(join(projectRoot, 'counter.js'), 'utf8');
  const notes = await readFile(join(projectRoot, 'notes.md'), 'utf8');
  const status = await new LocalGitService().status(projectRoot);
  const diff = await new LocalGitService().diffBounded(projectRoot, 1 << 20);
  evidence.execution = {
    status: result.status,
    exitCode: result.exitCode,
    error: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
    persistedEvents: events.length,
    streamedEvents: streamed.filter((e) => e.executionId === handle.executionId).length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    fileChangeDetected: events.some((e) => e.type === 'file-change' && e.path === 'counter.js'),
    modifiedCode: code.includes('triple'),
    userChangePreserved: notes === userChange,
    gitChangedFiles: status.files.map((f) => f.path),
    diffMentionsTriple: diff.diff.includes('triple'),
    usage: result.usage,
  };
  const outputSample = events
    .filter((e) => e.type === 'output' && e.stream === 'stderr')
    .map((e) => e.chunk)
    .join('')
    .slice(0, 400);
  if (outputSample) evidence.execution.stderrSample = outputSample;

  // Cancellation of a real running agent process.
  let cancelled = null;
  if (result.status === 'completed') {
    const longRun = await engine.submit({
      sessionId: session.id,
      timeoutMs: 180_000,
      payload: {
        kind: 'prompt',
        prompt:
          'Write a detailed 2000-word essay about the history of version control into essay.md.',
      },
    });
    for (let i = 0; i < 200; i++) {
      const evs = await core.db.executions.listEvents({ executionId: longRun.executionId });
      if (evs.some((e) => e.type === 'status' && e.status === 'running')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 3000));
    await engine.interrupt({ executionId: longRun.executionId, mode: 'graceful' });
    const cancelResult = await engine.wait(longRun.executionId);
    cancelled = { status: cancelResult.status };
  }
  evidence.cancellation = cancelled;

  const history = await core.sessions.history(session.id);
  evidence.history = {
    executions: history.executions.length,
    checkpoints: history.checkpoints.length,
    files: history.files?.map((f) => f.path) ?? null,
  };
  evidence.approvals = approvalsSeen.map((a) => a.action);
  evidence.usageSummary = await core.usage.summary({ period: 'day' });
  console.log(JSON.stringify(evidence, null, 2));
  if (
    evidence.budgetGate.code !== 'BUDGET_UNENFORCEABLE' ||
    result.status !== 'completed' ||
    !evidence.execution.modifiedCode ||
    !evidence.execution.fileChangeDetected ||
    !evidence.execution.userChangePreserved ||
    evidence.history.checkpoints < 1 ||
    cancelled?.status !== 'cancelled'
  )
    process.exitCode = 1;
} catch (error) {
  evidence.fatal = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(approvalTimer);
  await engine.close();
  core.close();
}
