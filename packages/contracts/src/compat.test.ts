import { describe, expect, it } from 'vitest';
import {
  AgentSessionSchema,
  ApplicationSettingsSchema,
  ApprovalRequestSchema,
  CONTRACTS_VERSION,
  DEFAULT_RETENTION,
  IPC_CHANNELS,
  ProjectSchema,
  SettingsPatchSchema,
  StoreCredentialInputSchema,
  CreateProjectInputSchema,
  DEFAULT_SETTINGS,
  ErrorCodeSchema,
  UsageSummarySchema,
  newId,
  nowTimestamp,
} from './index.js';

/** 0.2.0 is additive: payloads written by 0.1.0 must still parse. */
describe('contracts 0.2.0 backward compatibility', () => {
  it('is a MINOR bump of 0.1.0', () => {
    // 0.3.0 adds Git; 0.4.0 adds budget fields; 0.5.0 adds AI resources. All additive.
    expect(CONTRACTS_VERSION).toBe('0.8.0');
  });

  it('reads 0.1.0 projects, sessions, approvals and settings with defaults', () => {
    const now = nowTimestamp();
    const project = ProjectSchema.parse({
      id: newId('project'),
      name: 'Old',
      rootPath: 'C:\\old',
      description: null,
      isGitRepository: false,
      defaultWorkspaceId: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    expect(project).toMatchObject({ technologies: [], lastOpenedAt: null });

    const session = AgentSessionSchema.parse({
      id: newId('session'),
      agentId: newId('agent'),
      projectId: newId('project'),
      workspaceId: newId('workspace'),
      status: 'ended',
      externalSessionId: null,
      lastCheckpointId: null,
      startedAt: now,
      endedAt: now,
    });
    expect(session).toMatchObject({
      title: null,
      endReason: null,
      resumedFromSessionId: null,
      updatedAt: null,
    });

    const approval = ApprovalRequestSchema.parse({
      id: newId('approval'),
      agentId: newId('agent'),
      sessionId: null,
      executionId: null,
      action: 'git.push',
      risk: 'high',
      summary: 'push',
      details: {},
      untrustedOrigin: false,
      status: 'pending',
      requestedAt: now,
      expiresAt: now,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
    });
    expect(approval).toMatchObject({ scope: 'once', projectId: null, target: null });

    const settings = ApplicationSettingsSchema.parse({
      schemaVersion: 1,
      language: 'pt-BR',
      theme: 'system',
      execution: { maxConcurrentExecutions: 4, defaultTimeoutMs: 60_000 },
      security: { approvalTimeoutMs: 60_000, extraApprovalActions: [] },
      telemetry: false,
    });
    expect(settings.retention).toEqual(DEFAULT_RETENTION);
    expect(settings.execution.maxConcurrentPerAgent).toBe(2);
  });

  it('patch schemas do not inject defaults', () => {
    expect(SettingsPatchSchema.parse({ execution: { maxConcurrentExecutions: 3 } })).toEqual({
      execution: { maxConcurrentExecutions: 3 },
    });
  });

  it('credential input never round-trips a value field to the renderer', () => {
    const channel = IPC_CHANNELS['credentials.list'];
    const parsed = channel.response.parse([
      {
        id: newId('credential'),
        label: 'x',
        providerId: null,
        storage: 'os-encrypted',
        locator: 'crd_x',
        hint: null,
        createdAt: nowTimestamp(),
        lastUsedAt: null,
        secret: 'leak',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('leak');
    expect(
      StoreCredentialInputSchema.safeParse({
        storage: 'environment',
        label: 'x',
        variable: 'BAD NAME',
      }).success,
    ).toBe(false);
  });

  it('validates Windows folder names for new projects', () => {
    const ok = { parentPath: 'C:\\work' };
    expect(CreateProjectInputSchema.safeParse({ ...ok, folderName: 'meu-app' }).success).toBe(true);
    for (const folderName of ['a/b', 'a\\b', 'nul', 'COM1.txt', 'x.', 'a:b']) {
      expect(CreateProjectInputSchema.safeParse({ ...ok, folderName }).success).toBe(false);
    }
  });

  it('exposes no channel through which the renderer could declare provider evidence', () => {
    expect(Object.keys(IPC_CHANNELS).filter((k) => /evidence/i.test(k))).toEqual([]);
    expect(Object.keys(IPC_CHANNELS)).toContain('projects.restore');
  });
});

describe('contracts 0.3.0: read-only Git channels', () => {
  const workspaceId = newId('workspace');

  it('addresses workspaces by id, never by path', () => {
    const status = IPC_CHANNELS['git.status'];
    expect(status.request.safeParse({ workspaceId }).success).toBe(true);
    expect(status.request.safeParse({ rootPath: 'C:\\\\repo' }).success).toBe(false);
    expect(status.response.safeParse(null).success).toBe(true);
  });

  it('caps diff size with a default and rejects out-of-range limits', () => {
    const diff = IPC_CHANNELS['git.diff'];
    expect(diff.request.parse({ workspaceId })).toEqual({ workspaceId, maxBytes: 2 * 1024 * 1024 });
    expect(diff.request.safeParse({ workspaceId, maxBytes: 10 }).success).toBe(false);
    expect(diff.request.safeParse({ workspaceId, maxBytes: 64 * 1024 * 1024 }).success).toBe(false);
    expect(
      diff.response.safeParse({
        workspaceId,
        diff: '',
        truncated: false,
        capturedAt: nowTimestamp(),
      }).success,
    ).toBe(true);
  });

  it('exposes no channel that writes to Git', () => {
    const gitChannels = Object.keys(IPC_CHANNELS).filter((k) => k.startsWith('git.'));
    expect(gitChannels.sort()).toEqual(['git.diff', 'git.status']);
  });
});

describe('contracts 0.4.0: unknown cost is never zero', () => {
  it('reads 0.3.0 settings and usage summaries with conservative defaults', () => {
    const settings = ApplicationSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      budget: { currency: 'USD', maxPerDay: 5, maxPerMonth: null },
    });
    expect(settings.budget.allowWithoutCostGuarantee).toBe(false);
    const summary = UsageSummarySchema.parse({
      period: 'day',
      since: nowTimestamp(),
      executions: 1,
      inputTokens: 0,
      outputTokens: 0,
      cost: {},
    });
    expect(summary.unknownCostExecutions).toBe(0);
    expect(ErrorCodeSchema.options).toContain('BUDGET_UNENFORCEABLE');
  });

  it('lets a settings patch opt in explicitly without resetting other budget fields', () => {
    expect(SettingsPatchSchema.parse({ budget: { allowWithoutCostGuarantee: true } })).toEqual({
      budget: { allowWithoutCostGuarantee: true },
    });
  });
});
