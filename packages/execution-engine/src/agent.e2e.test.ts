/**
 * End-to-end validation of the native DevBrain agent: REAL Core (authorization, approvals,
 * sessions, checkpoints), REAL AiGateway (routing, privacy, budget, protocol translation) and a
 * scripted OpenAI-compatible upstream standing in for the model, inside a temporary Git repo.
 * No real provider, credential or paid API is used.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionEvent, GatewayAgentOptions, ModelDefinition } from '@devbrain/contracts';
import type { SecretCipher } from '@devbrain/security';
import { createCoreServices, type CoreServices } from '@devbrain/core';
import { AiGateway } from '@devbrain/ai-gateway';
import { OperationalExecutionService } from './index.js';

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
};

type Body = { model: string; messages: Record<string, unknown>[]; tools?: unknown[] };
type Turn = { content?: string; calls?: [string, Record<string, unknown>][] } | 'fail';
/** Fake upstream: replies by turn number (= assistant messages already in the history). */
const upstream = async (script: (turn: number, body: Body) => Turn) => {
  const bodies: Body[] = [];
  const server = createServer((req, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
      bodies.push(body);
      const turn = body.messages.filter((m) => m.role === 'assistant').length + 1;
      const reply = script(turn, body);
      if (reply === 'fail') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'overloaded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: reply.content ?? null,
                ...(reply.calls
                  ? {
                      tool_calls: reply.calls.map(([name, args], i) => ({
                        id: `call_${turn}_${i}`,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(args) },
                      })),
                    }
                  : {}),
              },
              finish_reason: reply.calls ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  servers.push(server);
  return { url: `http://127.0.0.1:${address.port}`, bodies };
};

const servers: ReturnType<typeof createServer>[] = [];
let base: string;
let core: CoreServices;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'devbrain-agent-')));
  core = createCoreServices({
    databaseFile: ':memory:',
    cipher,
    instanceId: `run_${crypto.randomUUID()}`,
    appVersion: 'test',
  });
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  core.close();
  await rm(base, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });

const model = (id: string, outputPerMillion = 0): ModelDefinition => ({
  id,
  providerId: 'local-runtime',
  upstreamModelId: id,
  name: id,
  capabilities: {
    input: ['text'],
    output: ['text'],
    tools: true,
    streaming: true,
    structuredOutput: false,
    reasoning: false,
    contextTokens: null,
    outputTokens: null,
  },
  pricing: {
    currency: 'USD',
    inputPerMillion: 0,
    outputPerMillion,
    cachedInputPerMillion: null,
    verifiedAt: '2026-11-27T00:00:00.000Z',
    sourceUrl: null,
  },
  lifecycle: 'active',
  sourceId: 'manual',
  verifiedAt: null,
});

/** Temp Git project with a real bug and a real test; Core project, agent, session, gateway. */
const scenario = async (
  routes: { url: string; id: string; localOnly?: boolean; outputPerMillion?: number }[],
) => {
  const root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(
    join(root, 'test.js'),
    "const sum = require('./src/sum');\nif (sum(2, 3) !== 5) { console.error('FAIL sum(2,3)=' + sum(2, 3)); process.exit(1); }\nconsole.log('PASS');\n",
  );
  await writeFile(join(root, '.env'), 'SECRET_TOKEN=do-not-read\n');
  await writeFile(join(base, 'outside.txt'), 'outside the workspace\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');

  const project = await core.projects.register({ rootPath: root });
  const [workspace] = await core.projects.listWorkspaces(project.id);
  const provider = await core.providers.register({
    adapterKey: 'devbrain-agent',
    kind: 'http-api',
    displayName: 'DevBrain Agent',
  });
  const agent = await core.agents.register({ providerId: provider.provider.id, name: 'Coder' });
  const session = await core.sessions.start({
    agentId: agent.id,
    projectId: project.id,
    workspaceId: workspace!.id,
    title: 'Fix sum',
  });

  const gateway = new AiGateway(core.db.driver, async () => {
    throw new Error('no credential may be resolved in this test');
  });
  gateway.configurePolicy({
    policy: {
      id: 'free-local',
      strategy: 'priority',
      billingPolicyId: 'free',
      privacyPolicyId: 'privacy',
      maxAttempts: 2,
      requireTools: true,
    },
    billing: {
      id: 'free',
      allowPaid: false,
      allowUnknownCost: false,
      maxCostPerRequest: null,
      maxCostPerDay: null,
      currency: 'USD',
    },
    privacy: {
      id: 'privacy',
      mode: 'any-configured',
      allowedProviderIds: [],
      allowPromptLogging: false,
    },
  });
  for (const [index, route] of routes.entries()) {
    gateway.saveEndpoint({
      id: `endpoint-${route.id}`,
      providerId: 'local-runtime',
      baseUrl: `${route.url}/v1`,
      protocol: 'openai-chat',
      documentationUrl: null,
    });
    gateway.saveConnection({
      id: `connection-${route.id}`,
      endpointId: `endpoint-${route.id}`,
      providerId: 'local-runtime',
      credentialId: null,
      enabled: true,
      status: 'ready',
      lastVerifiedAt: null,
    });
    gateway.saveModel(model(route.id, route.outputPerMillion));
    gateway.saveRoute({
      id: `route-${route.id}`,
      modelId: route.id,
      connectionId: `connection-${route.id}`,
      priority: index,
      enabled: true,
      localOnly: route.localOnly ?? true,
    });
  }
  const engine = new OperationalExecutionService(core, undefined, gateway);
  const events: ExecutionEvent[] = [];
  engine.subscribe((event) => events.push(event));
  // Human stand-in: approves running the pre-authorized test command, denies everything else.
  const approved: string[] = [];
  const denied: string[] = [];
  const approver = setInterval(() => {
    void core.approvals.listPending().then(async (pending) => {
      for (const request of pending) {
        const ok = request.action === 'process.spawn';
        (ok ? approved : denied).push(`${request.action}:${request.target ?? ''}`);
        await core.approvals
          .decide({ approvalId: request.id, decision: ok ? 'approved' : 'denied', scope: 'once' })
          .catch(() => undefined);
      }
    });
  }, 15);
  const run = async (prompt: string, options: Partial<GatewayAgentOptions> = {}) => {
    const handle = await engine.submit({
      sessionId: session.id,
      payload: {
        kind: 'prompt',
        prompt,
        contextFiles: [],
        gateway: {
          routingPolicyId: 'free-local',
          modelId: null,
          allowedCommands: [
            { id: 'test', executable: process.execPath, args: ['test.js'], timeoutMs: 30_000 },
            {
              id: 'slow',
              executable: process.execPath,
              args: ['-e', 'setTimeout(() => {}, 20000)'],
              timeoutMs: 60_000,
            },
          ],
          maxTurns: 24,
          maxToolCalls: 80,
          maxTotalTokens: 400_000,
          maxDurationMs: 120_000,
          maxOutputTokensPerTurn: 1024,
          ...options,
        },
      },
    });
    return { handle, result: () => engine.wait(handle.executionId) };
  };
  return {
    root,
    engine,
    events,
    run,
    approved,
    denied,
    session,
    project,
    gateway,
    stop: () => clearInterval(approver),
  };
};

const toolEvents = (events: ExecutionEvent[]) =>
  events.flatMap((e) => (e.type === 'tool-call' ? [`${e.tool}:${e.state}`] : []));

describe('native DevBrain agent on the AI gateway', () => {
  it('reads code, finds the bug, runs the authorized test, fixes it and records evidence', async () => {
    const model = await upstream((turn) => {
      switch (turn) {
        case 1: // parallel calls
          return {
            calls: [
              ['list_files', { path: '.' }],
              ['read_file', { path: 'src/sum.js' }],
            ],
          };
        case 2:
          return { calls: [['run_command', { commandId: 'test' }]] };
        case 3: // denied by policy (.env) and by the user (outside the workspace)
          return {
            calls: [
              ['read_file', { path: '.env' }],
              ['read_file', { path: '../outside.txt' }],
              ['run_command', { commandId: 'rm-rf' }],
              ['write_file', { path: 'src/sum.js', content: 'x' }],
            ],
          };
        case 4:
          return {
            calls: [
              [
                'apply_edit',
                { path: 'src/sum.js', oldText: '(a, b) => a - b', newText: '(a, b) => a + b' },
              ],
            ],
          };
        case 5:
          return { calls: [['run_command', { commandId: 'test' }]] };
        case 6:
          return { calls: [['git_diff', {}]] };
        default:
          return { content: 'Fixed sum(): it subtracted instead of adding. Test passes.' };
      }
    });
    const s = await scenario([{ url: model.url, id: 'local-coder' }]);
    try {
      const { result } = await s.run('The test fails. Find and fix the bug, then run the test.');
      const outcome = await result();
      expect(outcome.status).toBe('completed');
      expect(await readFile(join(s.root, 'src', 'sum.js'), 'utf8')).toBe(
        'module.exports = (a, b) => a + b;\n',
      );
      expect(toolEvents(s.events)).toEqual([
        'list_files:running',
        'list_files:succeeded',
        'read_file:running',
        'read_file:succeeded',
        'run_command:running',
        'run_command:failed',
        'read_file:running',
        'read_file:denied',
        'read_file:running',
        'read_file:denied',
        'run_command:running',
        'run_command:invalid',
        'write_file:running',
        'write_file:failed',
        'apply_edit:running',
        'apply_edit:succeeded',
        'run_command:running',
        'run_command:succeeded',
        'git_diff:running',
        'git_diff:succeeded',
      ]);
      // .env denied by policy without asking; the scope escape was asked and refused.
      expect(s.denied.some((d) => d.startsWith('scope.escape'))).toBe(true);
      expect(s.approved.every((a) => a.startsWith('process.spawn'))).toBe(true);
      // The secret never reached the model.
      expect(JSON.stringify(model.bodies)).not.toContain('do-not-read');
      // Tool results go back correlated with their call ids.
      const last = model.bodies.at(-1)!;
      expect(last.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_5_0')).toBe(
        true,
      );
      expect(s.events.some((e) => e.type === 'file-change' && e.path === 'src/sum.js')).toBe(true);
      expect(outcome.usage).toMatchObject({ inputTokens: 700, outputTokens: 140, costAmount: 0 });
      const history = await core.sessions.history(s.session.id);
      const checkpoint = history.checkpoints.at(-1)!;
      expect(checkpoint.state).toMatchObject({
        filesTouched: ['src/sum.js'],
        nextSteps: [],
      });
      expect(JSON.stringify(checkpoint.state)).toContain('apply_edit src/sum.js succeeded');
    } finally {
      s.stop();
    }
  });

  it('falls back to a second controlled route and records the switch at a turn boundary', async () => {
    const first = await upstream((turn) =>
      turn === 1 ? { calls: [['read_file', { path: 'src/sum.js' }]] } : 'fail',
    );
    const second = await upstream(() => ({ content: 'Done after fallback.' }));
    const s = await scenario([
      { url: first.url, id: 'primary' },
      { url: second.url, id: 'secondary' },
    ]);
    try {
      const outcome = await (await s.run('Inspect sum.')).result();
      expect(outcome.status).toBe('completed');
      expect(
        s.events.some(
          (e) =>
            e.type === 'message' && e.role === 'system' && e.text.includes('primary -> secondary'),
        ),
      ).toBe(true);
      // The fallback model received the whole structured history, nothing partial.
      const handed = second.bodies[0]!.messages;
      expect(handed.some((m) => Array.isArray(m.tool_calls))).toBe(true);
      expect(handed.some((m) => m.role === 'tool')).toBe(true);
    } finally {
      s.stop();
    }
  });

  it('skips paid routes under a free policy and never calls them', async () => {
    const paid = await upstream(() => ({ content: 'should never run' }));
    const free = await upstream(() => ({ content: 'free route answered' }));
    const s = await scenario([
      // Non-local routes in a public project: only the price decides eligibility here.
      { url: paid.url, id: 'paid-model', outputPerMillion: 10, localOnly: false },
      { url: free.url, id: 'free-model', outputPerMillion: 0, localOnly: false },
    ]);
    try {
      s.gateway.intelligence.saveProjectPolicy({
        projectId: s.project.id,
        privacyClass: 'public',
        approvedProviderIds: [],
        budget: {
          currency: 'USD',
          maxPerDayMicros: null,
          maxPerSessionMicros: null,
          maxPerInferenceMicros: null,
          allowPaid: false,
          allowUnboundedCost: false,
        },
      });
      const outcome = await (await s.run('Anything.')).result();
      expect(outcome.status).toBe('completed');
      expect(paid.bodies).toHaveLength(0);
      expect(free.bodies).toHaveLength(1);
    } finally {
      s.stop();
    }
  });

  it('keeps restricted projects on local routes only', async () => {
    const remote = await upstream(() => ({ content: 'remote' }));
    const s = await scenario([{ url: remote.url, id: 'not-local', localOnly: false }]);
    try {
      s.gateway.intelligence.saveProjectPolicy({
        projectId: s.project.id,
        privacyClass: 'restricted',
        approvedProviderIds: [],
        budget: {
          currency: 'USD',
          maxPerDayMicros: null,
          maxPerSessionMicros: null,
          maxPerInferenceMicros: null,
          allowPaid: false,
          allowUnboundedCost: false,
        },
      });
      const outcome = await (await s.run('Anything.')).result();
      expect(outcome.status).toBe('failed');
      expect(remote.bodies).toHaveLength(0);
    } finally {
      s.stop();
    }
  });

  it('cancels a running command, marks its outcome unknown and recovers on the next run', async () => {
    let second = false;
    const model = await upstream((turn, body) => {
      if (second)
        return {
          content: body.messages.some((m) =>
            String(m.content).includes('Verify the outcome of: run_command'),
          )
            ? 'Verified state.'
            : 'no recovery context',
        };
      return turn === 1 ? { calls: [['run_command', { commandId: 'slow' }]] } : { content: 'x' };
    });
    const s = await scenario([{ url: model.url, id: 'local-coder' }]);
    try {
      const { handle, result } = await s.run('Run the slow job.');
      for (let i = 0; i < 400; i++) {
        if (s.events.some((e) => e.type === 'tool-call' && e.state === 'running')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 300));
      await s.engine.interrupt({ executionId: handle.executionId, mode: 'force' });
      const outcome = await result();
      expect(outcome.status).toBe('cancelled');
      expect(toolEvents(s.events)).toContain('run_command:unknown');
      const checkpoint = (await core.sessions.history(s.session.id)).checkpoints.at(-1)!;
      expect(JSON.stringify(checkpoint.state)).toContain('Verify the outcome of: run_command');

      second = true;
      const again = await (await s.run('Continue.')).result();
      expect(again.status).toBe('completed');
      expect(s.events.some((e) => e.type === 'message' && e.text === 'Verified state.')).toBe(true);
    } finally {
      s.stop();
    }
  }, 30_000);

  it('stops a model that repeats the same call and enforces the turn limit', async () => {
    const looping = await upstream(() => ({ calls: [['read_file', { path: 'src/sum.js' }]] }));
    const s = await scenario([{ url: looping.url, id: 'local-coder' }]);
    try {
      const outcome = await (await s.run('Loop.')).result();
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('repeated the same read_file call');
      const limited = await (await s.run('Loop again.', { maxTurns: 1 })).result();
      expect(limited.status).toBe('failed');
      expect(limited.summary).toContain('Turn limit');
    } finally {
      s.stop();
    }
  });
});
