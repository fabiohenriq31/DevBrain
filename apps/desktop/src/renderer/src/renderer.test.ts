import { NO_CAPABILITIES, newId, nowTimestamp, type ExecutionEvent } from '@devbrain/contracts';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './components/DiffViewer.js';
import { UiClientError, describeError } from './lib/bridge.js';
import {
  describeEnforcement,
  describeProviderStates,
  formatExecutionStatus,
  formatSessionStatus,
  formatUsageHonest,
} from './lib/i18n.js';
import { DEFAULT_UI_PREFERENCES, parseUiPreferences } from './lib/preferences.js';
import {
  createStreamSnapshot,
  extractPlainTranscript,
  mergeExecutionEvents,
  sanitizeTerminalChunk,
  tokenizeCommandArgs,
} from './lib/stream.js';

describe('renderer stream buffer, terminal sanitization and diff parser', () => {
  it('merges live and replayed events in monotonic seq order without duplicates and flags gaps', () => {
    const executionId = newId('execution');
    const sessionId = newId('session');
    const mk = (seq: number, chunk: string): ExecutionEvent => ({
      id: newId('event'),
      executionId,
      sessionId,
      seq,
      timestamp: nowTimestamp(),
      type: 'output',
      stream: 'stdout',
      chunk,
    });

    const s0 = createStreamSnapshot(executionId);
    // Arrive with a gap (seq 0 and seq 2, missing seq 1)
    const step1 = mergeExecutionEvents(s0, [mk(2, 'world\n'), mk(0, 'hello ')]);
    expect(step1.snapshot.events.map((e) => e.seq)).toEqual([0, 2]);
    expect(step1.snapshot.highestSeq).toBe(2);
    expect(step1.snapshot.hasGap).toBe(true);

    // Replay from persistence supplies seq 0, 1, 2 -> deduplicates 0 & 2, fills gap 1
    const step2 = mergeExecutionEvents(step1.snapshot, [
      mk(0, 'hello '),
      mk(1, 'dear '),
      mk(2, 'world\n'),
    ]);
    expect(step2.appended.map((e) => e.seq)).toEqual([1]);
    expect(step2.snapshot.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(step2.snapshot.hasGap).toBe(false);
    expect(extractPlainTranscript(step2.snapshot.events)).toContain('dear');
  });

  it('strips OSC 52 clipboard/title escape sequences while preserving SGR colors and CRLF', () => {
    const osc52 = '\u001b]52;c;SGVsbG8=\u0007\u001b[32mok\u001b[0m\n\u001b[2Jafter';
    const clean = sanitizeTerminalChunk(osc52);
    expect(clean).not.toContain('52;c;');
    expect(clean).not.toContain('\u001b[2J');
    expect(clean).toBe('\u001b[32mok\u001b[0m\r\nafter');
  });

  it('tokenizes shell-free command arguments preserving quoted spaces', () => {
    expect(tokenizeCommandArgs('-e \'console.log("hello world")\'')).toEqual([
      '-e',
      'console.log("hello world")',
    ]);
    expect(tokenizeCommandArgs('-e\nprocess.stdout.write("a b")')).toEqual([
      '-e',
      'process.stdout.write("a b")',
    ]);
  });

  it('parses unified Git diffs into structured file hunks and counts', () => {
    const sample = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
    ].join('\n');

    const parsed = parseUnifiedDiff(sample);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.filePath).toBe('src/app.ts');
    expect(parsed[0]?.additions).toBe(2);
    expect(parsed[0]?.deletions).toBe(1);
  });
});

describe('honest usage/cost, enforcement warnings, provider states and error remediation', () => {
  it('never treats unknown/null cost as zero cost', () => {
    const sub = formatUsageHonest(
      { inputTokens: 120, outputTokens: 45, costAmount: null, costCurrency: null },
      'subscription',
      'pt-BR',
    );
    expect(sub.isCostKnown).toBe(false);
    expect(sub.costLabel).toContain('Custo desconhecido');
    expect(sub.costLabel).not.toContain('0.00');

    const metered = formatUsageHonest(
      { inputTokens: 100, outputTokens: 50, costAmount: 0.0125, costCurrency: 'USD' },
      'metered',
      'pt-BR',
    );
    expect(metered.isCostKnown).toBe(true);
    expect(metered.costLabel).toBe('USD 0.0125');
  });

  it('surfaces security limitations when per-action enforcement is unavailable', () => {
    const none = describeEnforcement({ ...NO_CAPABILITIES, enforcement: 'none' }, 'pt-BR');
    expect(none.requiresSessionApproval).toBe(true);
    expect(none.warnings.join(' ')).toContain('permissões do seu usuário');

    const sandbox = describeEnforcement(
      { ...NO_CAPABILITIES, enforcement: 'adapter-sandbox' },
      'pt-BR',
    );
    expect(sandbox.requiresSessionApproval).toBe(true);
    expect(sandbox.warnings.length).toBeGreaterThan(0);

    const perAction = describeEnforcement(
      { ...NO_CAPABILITIES, enforcement: 'per-action' },
      'pt-BR',
    );
    expect(perAction.requiresSessionApproval).toBe(false);
    expect(perAction.warnings).toHaveLength(0);
  });

  it('distinguishes installed, missing, unauthenticated, configured, available and running states', () => {
    const baseProfile = {
      provider: {
        id: newId('provider'),
        adapterKey: 'openai-codex-cli',
        kind: 'cli-agent' as const,
        displayName: 'OpenAI Codex',
        vendor: 'OpenAI',
        status: 'unknown' as const,
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
        installed: {
          state: 'unknown' as const,
          checkedAt: null,
          source: 'none' as const,
          detail: null,
        },
        authenticated: {
          state: 'unknown' as const,
          checkedAt: null,
          source: 'none' as const,
          detail: null,
        },
        operational: {
          state: 'unknown' as const,
          checkedAt: null,
          source: 'none' as const,
          detail: null,
        },
      },
      readiness: 'configured' as const,
    };

    expect(describeProviderStates(baseProfile, false, 'pt-BR').primary.label).toContain(
      'Configurado',
    );
    expect(describeProviderStates(baseProfile, true, 'pt-BR').primary.label).toBe('Em execução');

    const missing = {
      ...baseProfile,
      provider: { ...baseProfile.provider, status: 'missing-dependency' as const },
    };
    expect(describeProviderStates(missing, false, 'pt-BR').primary.label).toBe('Não instalado');

    const unauth = {
      ...baseProfile,
      provider: { ...baseProfile.provider, status: 'unauthenticated' as const },
    };
    expect(describeProviderStates(unauth, false, 'pt-BR').primary.label).toBe('Não autenticado');

    const avail = {
      ...baseProfile,
      readiness: 'available' as const,
      health: {
        ...baseProfile.health,
        installed: {
          state: 'yes' as const,
          checkedAt: nowTimestamp(),
          source: 'execution-engine' as const,
          detail: '0.9.0',
        },
      },
    };
    const availDesc = describeProviderStates(avail, false, 'pt-BR');
    expect(availDesc.primary.label).toBe('Disponível');
    expect(availDesc.secondary.some((b) => b.label.includes('Instalado'))).toBe(true);
  });

  it('maps error codes and session/execution statuses without leaking unknown internals', () => {
    const uiErr = new UiClientError({
      code: 'DEPENDENCY_MISSING',
      message: 'Executable unavailable: claude',
      retryable: false,
    });
    const desc = describeError(uiErr, 'pt-BR');
    expect(desc.code).toBe('DEPENDENCY_MISSING');
    expect(desc.remediation).toContain('CLI');

    expect(formatSessionStatus('interrupted', 'pt-BR').label).toBe('Interrompida');
    expect(formatSessionStatus('future-unknown-state', 'pt-BR').label).toBe('Desconhecido');
    expect(formatExecutionStatus('awaiting-approval', 'pt-BR').label).toBe('Aguardando aprovação');
  });

  it('sanitizes persisted UI preferences and strips arbitrary/secret fields', () => {
    const raw = JSON.stringify({
      onboardingState: 'completed',
      sidebarCollapsed: true,
      sidebarWidth: 9999,
      activeProjectId: 'prj_1234567890ab',
      apiKey: 'sk-should-never-persist',
    });
    const parsed = parseUiPreferences(raw);
    expect(parsed.onboardingState).toBe('completed');
    expect(parsed.sidebarCollapsed).toBe(true);
    expect(parsed.sidebarWidth).toBe(360);
    expect('apiKey' in parsed).toBe(false);
    expect(parseUiPreferences('{corrupt')).toEqual(DEFAULT_UI_PREFERENCES);
  });
});
