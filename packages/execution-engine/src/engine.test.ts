import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, type ExecutionEvent, type ExecutionResult } from '@devbrain/contracts';
import type { CoreServices } from '@devbrain/core';
import { ProviderRegistry, type ProviderAdapter } from '@devbrain/provider-sdk';
import { OperationalExecutionService, buildAgentCommand } from './index.js';

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});
const setup = async () => {
  directory = await mkdtemp(join(tmpdir(), 'devbrain-exec-'));
  const sessionId = newId('session'),
    workspaceId = newId('workspace'),
    agentId = newId('agent'),
    providerId = newId('provider');
  const events: ExecutionEvent[] = [];
  const results = new Map<string, ExecutionResult>();
  const registry = new ProviderRegistry();
  registry.register({
    key: 'test-cli',
    descriptor: {
      adapterKey: 'test-cli',
      kind: 'cli-agent',
      displayName: 'Test',
      vendor: null,
      documentationUrl: null,
      capabilities: {
        streaming: true,
        interrupt: true,
        resumeSession: false,
        toolUse: false,
        fileEdits: false,
        shellCommands: false,
        mcp: false,
        structuredOutput: false,
        maxConcurrentSessions: null,
        contextWindowTokens: null,
        costModel: 'unknown',
        enforcement: 'none',
      },
    },
    checkDependencies: async () => ({
      adapterKey: 'test-cli',
      status: 'available',
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: 'node',
          required: true,
          found: true,
          version: process.version,
          minimumVersion: null,
          resolvedPath: process.execPath,
          message: null,
        },
      ],
    }),
    getCapabilities: async () => registry.get('test-cli').descriptor.capabilities,
    startSession: async ({ sessionId: id }) => ({ sessionId: id, externalSessionId: null }),
    execute: () => {
      throw new Error('not used by command execution');
    },
    endSession: async () => undefined,
  } satisfies ProviderAdapter);
  const core = {
    sessions: {
      get: async () => ({ id: sessionId, agentId, workspaceId }),
      recordInstruction: async (request: unknown) => request,
      recordEvent: async (event: ExecutionEvent) => {
        events.push(event);
        return { stored: true, truncated: false, duplicate: false };
      },
      recordResult: async (value: ExecutionResult) => {
        results.set(value.executionId, value);
      },
      saveCheckpoint: async () => undefined,
    },
    settings: {
      get: async () => ({
        execution: { defaultTimeoutMs: 5000 },
        retention: { maxStoredOutputBytesPerExecution: 100000 },
      }),
    },
    db: {
      workspaces: { findById: () => ({ id: workspaceId, rootPath: directory }) },
      agents: { findById: () => ({ id: agentId, providerId }) },
      providers: { findById: () => ({ provider: { id: providerId, adapterKey: 'test-cli' } }) },
      executions: { getResult: async (id: string) => results.get(id) ?? null },
    },
    providers: { recordEvidence: async () => undefined },
    authorization: {
      authorizeExecution: async () => ({
        workingDirectory: directory,
        plan: { sandboxMode: 'read-only' },
        limits: { maxExecutionMs: 10000, maxOutputBytes: 100000 },
      }),
      acquireSlot: async () => () => undefined,
      authorizeCommand: async () => undefined,
    },
    events: { emit: () => undefined },
  } as unknown as CoreServices;
  const engine = new OperationalExecutionService(core, registry);
  return { engine, events, sessionId };
};
describe('operational process execution', () => {
  it('streams output, records ordered events and requires zero exit status', async () => {
    const { engine, events, sessionId } = await setup();
    const handle = await engine.submit({
      sessionId,
      payload: {
        kind: 'command',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("hello")'],
      },
    });
    const result = await engine.wait(handle.executionId);
    expect(result.status).toBe('completed');
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.some((event) => event.type === 'output' && event.chunk === 'hello')).toBe(true);
    const failed = await engine.submit({
      sessionId,
      payload: { kind: 'command', executable: process.execPath, args: ['-e', 'process.exit(2)'] },
    });
    expect((await engine.wait(failed.executionId)).status).toBe('failed');
  });
  it('times out and terminates a child process', async () => {
    const { engine, sessionId } = await setup();
    const handle = await engine.submit({
      sessionId,
      timeoutMs: 1000,
      payload: {
        kind: 'command',
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
      },
    });
    expect((await engine.wait(handle.executionId)).status).toBe('timed-out');
  });
  it('cancels a running process', async () => {
    const { engine, sessionId, events } = await setup();
    const handle = await engine.submit({
      sessionId,
      payload: {
        kind: 'command',
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
      },
    });
    for (
      let attempt = 0;
      attempt < 100 &&
      !events.some((event) => event.type === 'status' && event.status === 'running');
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    await engine.interrupt({ executionId: handle.executionId, mode: 'force' });
    expect((await engine.wait(handle.executionId)).status).toBe('cancelled');
  });
  it('reports an unavailable executable without spawning', async () => {
    const { engine, sessionId } = await setup();
    const handle = await engine.submit({
      sessionId,
      payload: { kind: 'command', executable: 'no-such-devbrain-test-executable', args: [] },
    });
    expect(await engine.wait(handle.executionId)).toMatchObject({
      status: 'failed',
      error: { code: 'DEPENDENCY_MISSING' },
    });
  });
});

describe('agent command lines', () => {
  const options = { readOnly: false, workingDirectory: 'C:\\work\\app', timeoutMs: 90_500 };
  const hostile = '--dangerously-bypass-approvals-and-sandbox --dangerously-skip-permissions';

  it('never lets an untrusted prompt be parsed as a CLI flag', () => {
    for (const key of ['openai-codex-cli', 'claude-code-cli']) {
      const { args } = buildAgentCommand(key, hostile, options);
      expect(args.at(-1)).toBe(hostile);
      expect(args.at(-2)).toBe('--');
      expect(args.filter((a) => a.startsWith('--dangerously'))).toEqual([hostile]);
    }
    const agy = buildAgentCommand('google-antigravity-cli', hostile, options);
    expect(agy.args.at(-1)).toBe(`--print=${hostile}`);
    expect(agy.args.filter((a) => a.startsWith('--dangerously'))).toEqual([]);
  });

  it('maps the authorized sandbox mode and never uses auto-approve modes', () => {
    const write = buildAgentCommand('claude-code-cli', 'x', options).args;
    expect(write).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits', '--verbose']),
    );
    const read = buildAgentCommand('claude-code-cli', 'x', { ...options, readOnly: true }).args;
    expect(read).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    const codex = buildAgentCommand('openai-codex-cli', 'x', { ...options, readOnly: true }).args;
    expect(codex.slice(0, 4)).toEqual(['exec', '--json', '--sandbox', 'read-only']);
    const agy = buildAgentCommand('google-antigravity-cli', 'x', options).args;
    expect(agy).toEqual(
      expect.arrayContaining([
        '--mode',
        'accept-edits',
        '--output-format',
        'json',
        '--print-timeout',
        '91s',
      ]),
    );
    expect(agy).not.toContain('auto');
    expect(() => buildAgentCommand('unknown-cli', 'x', options)).toThrow(/does not support/);
  });
});
