import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_VERSION,
  DEFAULT_SETTINGS,
  ApplicationSettingsSchema,
  CredentialReferenceSchema,
  DevBrainError,
  ExecutionEventSchema,
  ExecutionResultSchema,
  GitRemoteSchema,
  IPC_CHANNELS,
  ProviderSchema,
  NO_CAPABILITIES,
  canTransition,
  dispatchIpc,
  ipcChannelName,
  isContractsVersionCompatible,
  isIpcChannelKey,
  newId,
  nowTimestamp,
  ProjectIdSchema,
  toErrorPayload,
  AbsolutePathSchema,
} from './index.js';

const envelope = (payload: unknown, contractsVersion: string = CONTRACTS_VERSION) => ({
  contractsVersion,
  correlationId: 'corr-12345678',
  payload,
});

describe('ids and primitives', () => {
  it('generates ids that validate against their own kind only', () => {
    const id = newId('project');
    expect(ProjectIdSchema.safeParse(id).success).toBe(true);
    expect(ProjectIdSchema.safeParse(newId('agent')).success).toBe(false);
  });

  it('accepts only absolute paths without NUL', () => {
    expect(AbsolutePathSchema.safeParse('C:\\work\\repo').success).toBe(true);
    expect(AbsolutePathSchema.safeParse('/home/me/repo').success).toBe(true);
    expect(AbsolutePathSchema.safeParse('relative/path').success).toBe(false);
    expect(AbsolutePathSchema.safeParse('C:\\a\0b').success).toBe(false);
  });
});

describe('credential safety in contracts', () => {
  it('rejects provider endpoints and git remotes that embed credentials', () => {
    const base = {
      id: newId('provider'),
      adapterKey: 'local-ollama',
      kind: 'local-model',
      displayName: 'Local',
      vendor: null,
      status: 'unknown',
      enabled: true,
      credentialRef: null,
      capabilities: NO_CAPABILITIES,
      lastCheckedAt: null,
    };
    expect(ProviderSchema.safeParse({ ...base, endpoint: 'http://127.0.0.1:11434' }).success).toBe(
      true,
    );
    expect(
      ProviderSchema.safeParse({ ...base, endpoint: 'https://user:pw@api.example.com' }).success,
    ).toBe(false);
    expect(
      GitRemoteSchema.safeParse({ name: 'origin', url: 'https://tok:x@github.com/a/b' }).success,
    ).toBe(false);
    expect(
      GitRemoteSchema.safeParse({ name: 'origin', url: 'git@github.com:a/b.git' }).success,
    ).toBe(true);
  });

  it('credential references carry a locator, never a value field', () => {
    const shape = Object.keys(CredentialReferenceSchema.shape);
    expect(shape).not.toContain('value');
    expect(shape).not.toContain('secret');
  });
});

describe('execution contracts', () => {
  it('enforces the status state machine', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('running', 'queued')).toBe(false);
  });

  it('discriminates events by type', () => {
    const base = {
      id: newId('event'),
      executionId: newId('execution'),
      sessionId: newId('session'),
      seq: 0,
      timestamp: nowTimestamp(),
    };
    expect(
      ExecutionEventSchema.safeParse({ ...base, type: 'output', stream: 'stdout', chunk: 'hi' })
        .success,
    ).toBe(true);
    expect(ExecutionEventSchema.safeParse({ ...base, type: 'output', chunk: 'hi' }).success).toBe(
      false,
    );
    expect(ExecutionEventSchema.safeParse({ ...base, type: 'bogus' }).success).toBe(false);
  });

  it('requires terminal status on results', () => {
    const result = {
      executionId: newId('execution'),
      sessionId: newId('session'),
      status: 'running',
      exitCode: null,
      startedAt: null,
      finishedAt: nowTimestamp(),
      summary: null,
      usage: null,
      error: null,
      outputTruncated: false,
    };
    expect(ExecutionResultSchema.safeParse(result).success).toBe(false);
    expect(ExecutionResultSchema.safeParse({ ...result, status: 'completed' }).success).toBe(true);
  });
});

describe('settings', () => {
  it('defaults are valid and telemetry cannot be enabled', () => {
    expect(ApplicationSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(
      ApplicationSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, telemetry: true }).success,
    ).toBe(false);
  });
});

describe('errors', () => {
  it('never leaks unknown error messages', () => {
    expect(toErrorPayload(new Error('secret path C:\\Users\\x')).message).toBe('Internal error');
    expect(toErrorPayload(new DevBrainError('NOT_FOUND', 'Project not found')).code).toBe(
      'NOT_FOUND',
    );
    expect(new DevBrainError('RATE_LIMITED', 'slow down').retryable).toBe(true);
  });
});

describe('IPC', () => {
  it('names channels with the protocol major', () => {
    expect(ipcChannelName('projects.list')).toBe('devbrain:v1:projects.list');
    expect(isIpcChannelKey('projects.list')).toBe(true);
    expect(isIpcChannelKey('toString')).toBe(false);
    expect(Object.keys(IPC_CHANNELS).length).toBeGreaterThan(10);
  });

  it('checks contract compatibility by major version', () => {
    expect(isContractsVersionCompatible(CONTRACTS_VERSION)).toBe(true);
    expect(isContractsVersionCompatible('99.0.0')).toBe(false);
  });

  it('validates input, output and envelope', async () => {
    const ok = await dispatchIpc('projects.list', envelope({}), (input) => {
      expect(input.includeArchived).toBe(false); // default applied
      return [];
    });
    expect(ok).toEqual({ ok: true, data: [], correlationId: 'corr-12345678' });

    const badInput = await dispatchIpc('projects.get', envelope({ id: 'nope' }), () => {
      throw new Error('should not run');
    });
    expect(badInput.ok === false && badInput.error.code).toBe('VALIDATION_FAILED');

    const badOutput = await dispatchIpc(
      'projects.list',
      envelope({}),
      () => [{ id: 'x' }] as never,
    );
    expect(badOutput.ok === false && badOutput.error.code).toBe('INTERNAL');

    const mismatch = await dispatchIpc('projects.list', envelope({}, '9.0.0'), () => []);
    expect(mismatch.ok === false && mismatch.error.code).toBe('CONTRACT_VERSION_MISMATCH');

    const missing = await dispatchIpc('projects.list', envelope({}), undefined);
    expect(missing.ok === false && missing.error.code).toBe('UNSUPPORTED');

    const malformed = await dispatchIpc('projects.list', { payload: {} }, () => []);
    expect(malformed.ok).toBe(false);
  });

  it('rejects unknown keys on empty-input channels', async () => {
    const res = await dispatchIpc('system.getInfo', envelope({ evil: true }), () => {
      throw new Error('should not run');
    });
    expect(res.ok).toBe(false);
  });
});
