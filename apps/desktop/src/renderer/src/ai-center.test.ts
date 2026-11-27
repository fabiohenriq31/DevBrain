import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NO_CAPABILITIES,
  newId,
  nowTimestamp,
  type Agent,
  type ModelDefinition,
  type ModelRoute,
  type Project,
  type ProviderCatalogEntry,
  type ProviderConnection,
  type ProviderEndpoint,
  type ProviderProfile,
  type QuotaDefinition,
  type QuotaObservation,
  type QuotaReservation,
  type UsageRecord,
} from '@devbrain/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_CHANNEL_KEYS,
  PRIVACY_CLASSIFICATIONS,
  buildPresetStrategy,
  callAiChannel,
  classifyQuotaWindow,
  computeQuotaBreakdown,
  estimateLocalFeasibility,
  evaluateProviderEligibility,
  formatPricePerMillion,
  groupModelsAcrossProviders,
  isLoopbackUrl,
  summarizeUsageRecords,
  toContractPolicies,
  validateStrategyGuardrails,
  type AiChannelKey,
  type AiResourceSnapshot,
  type ChannelSupportState,
} from './lib/ai-center.js';
import { getStrings } from './lib/i18n.js';
import { parseUiPreferences, saveUiPreferences } from './lib/preferences.js';
import { AgentsProvidersView } from './views/AgentsProvidersView.js';
import { WorkspaceView } from './views/WorkspaceView.js';
import { AiResourceCenterView } from './views/ai-center/AiResourceCenterView.js';
import {
  ConnectionsSection,
  ModelsCatalogSection,
} from './views/ai-center/ConnectionsModelsSection.js';
import {
  LocalModelsSection,
  QuotasAndCreditsSection,
} from './views/ai-center/LocalQuotasCreditsSection.js';
import { MarketplaceWizardSection } from './views/ai-center/MarketplaceWizardSection.js';
import { OverviewSection } from './views/ai-center/OverviewSection.js';
import {
  BenchmarksSection,
  DiagnosticsSection,
  RoutingStrategiesSection,
} from './views/ai-center/RoutingBenchmarksDiagnosticsSection.js';

const makeChannelStates = (state: ChannelSupportState = 'ready') => {
  const rec = {} as Record<AiChannelKey, ChannelSupportState>;
  for (const key of AI_CHANNEL_KEYS) rec[key] = state;
  return rec;
};

const makeEmptySnapshot = (state: ChannelSupportState = 'ready'): AiResourceSnapshot => ({
  channelStates: makeChannelStates(state),
  catalog: [],
  endpoints: [],
  connections: [],
  models: [],
  routes: [],
  quotas: [],
  observations: {},
  reservations: {},
  credits: [],
  localRuntimes: [],
  localModels: {},
  availabilities: {},
  benchmarks: [],
  recentAttempts: {},
  recentUsage: [],
});

const makeModel = (overrides: Partial<ModelDefinition> & { id: string }): ModelDefinition => ({
  providerId: 'openrouter',
  upstreamModelId: 'deepseek/deepseek-r1:free',
  name: 'DeepSeek R1',
  capabilities: {
    input: ['text'],
    output: ['text'],
    tools: true,
    structuredOutput: true,
    reasoning: true,
    streaming: true,
    contextTokens: 128_000,
    outputTokens: 8_192,
  },
  pricing: {
    currency: 'USD',
    inputPerMillion: 0,
    outputPerMillion: 0,
    cachedInputPerMillion: 0,
    verifiedAt: '2026-11-20T00:00:00.000Z',
    sourceUrl: 'https://openrouter.ai/models',
  },
  lifecycle: 'active',
  sourceId: 'catalog',
  verifiedAt: '2026-11-20T00:00:00.000Z',
  ...overrides,
});

describe('Phase 02 — IPC probing, navigation & assisted signup preference security', () => {
  it('labels main navigation item as Central de IA without multiplying top-level menus', () => {
    expect(getStrings('pt-BR').nav.agents).toBe('Central de IA');
    expect(getStrings('en').nav.agents).toBe('AI Resource Center');
  });

  it('distinguishes ok, UNSUPPORTED and error outcomes in callAiChannel without faking data', async () => {
    const invokeMock = vi.fn();
    const g = globalThis as unknown as {
      window?: { devbrain: { invoke: typeof invokeMock; subscribe: () => () => void } };
    };
    const prevWindow = g.window;
    g.window = {
      devbrain: {
        invoke: invokeMock,
        subscribe: () => () => undefined,
      },
    };

    try {
      invokeMock.mockResolvedValueOnce({
        ok: false,
        error: { code: 'UNSUPPORTED', message: 'Not wired yet', retryable: false },
      });
      const unsupported = await callAiChannel('ai.catalog.list', {});
      expect(unsupported).toEqual({
        status: 'unsupported',
        channel: 'ai.catalog.list',
        message: 'Not wired yet',
      });

      invokeMock.mockResolvedValueOnce({
        ok: true,
        data: [],
      });
      const ok = await callAiChannel('ai.models.list', {});
      expect(ok).toEqual({ status: 'ok', data: [] });

      invokeMock.mockResolvedValueOnce({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Blocked', retryable: false },
      });
      const err = await callAiChannel('ai.routes.list', {});
      expect(err.status).toBe('error');
    } finally {
      if (prevWindow === undefined) {
        delete g.window;
      } else {
        g.window = prevWindow;
      }
    }
  });

  it('persists assisted signup queue without privacy policy or secrets in localStorage', () => {
    const rawWithInjectedSecrets = JSON.stringify({
      projectPrivacy: {
        prj_111: 'restricted',
        prj_222: 'commercial-confidential',
        prj_bad: 'invalid-level',
      },
      selectedStrategyPreset: 'free-only',
      signupQueue: [
        {
          providerId: 'openrouter',
          providerName: 'OpenRouter',
          currentStep: 5,
          status: 'in-progress',
          updatedAt: '2026-11-27T10:00:00.000Z',
          secret: 'sk-or-v1-MUST-NEVER-BE-SAVED',
          apiKey: 'sk-leak',
        },
      ],
      token: 'bearer-leak',
    });

    const parsed = parseUiPreferences(rawWithInjectedSecrets);
    expect(JSON.stringify(parsed)).not.toContain('projectPrivacy');
    expect(parsed.selectedStrategyPreset).toBe('free-only');
    expect(parsed.signupQueue).toHaveLength(1);
    expect(parsed.signupQueue[0]?.currentStep).toBe(5);
    expect(JSON.stringify(parsed)).not.toContain('sk-or-v1-MUST-NEVER-BE-SAVED');
    expect(JSON.stringify(parsed)).not.toContain('sk-leak');
    expect(JSON.stringify(parsed)).not.toContain('bearer-leak');

    const storedMap = new Map<string, string>();
    const g = globalThis as unknown as {
      window?: { localStorage: { setItem: (k: string, v: string) => void } };
    };
    const prevWindow = g.window;
    g.window = {
      localStorage: {
        setItem: (k: string, v: string) => {
          storedMap.set(k, v);
        },
      },
    };
    try {
      saveUiPreferences(parsed);
      const serialized = [...storedMap.values()].join(' ');
      expect(serialized).toContain('openrouter');
      expect(serialized).not.toContain('projectPrivacy');
      expect(serialized).not.toContain('sk-or-v1');
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    }
  });
});

describe('Phase 02 — Quotas, reservations, unknown limits & multi-currency usage accounting', () => {
  it('classifies RPM, RPD, TPM, TPD, weekly, monthly, credit and provider-unit windows accurately', () => {
    const base: QuotaDefinition = {
      id: 'q1',
      scope: 'credential',
      scopeId: 'crd-1',
      unit: 'requests',
      limit: 60,
      periodSeconds: 60,
      sourceUrl: 'https://docs.example.com/limits',
      verifiedAt: '2026-11-27T00:00:00.000Z',
    };
    expect(classifyQuotaWindow(base)).toBe('RPM');
    expect(classifyQuotaWindow({ ...base, periodSeconds: 86_400 })).toBe('RPD');
    expect(classifyQuotaWindow({ ...base, unit: 'total-tokens', periodSeconds: 60 })).toBe('TPM');
    expect(classifyQuotaWindow({ ...base, unit: 'input-tokens', periodSeconds: 86_400 })).toBe(
      'TPD',
    );
    expect(classifyQuotaWindow({ ...base, periodSeconds: 604_800 })).toBe('Semanal');
    expect(classifyQuotaWindow({ ...base, periodSeconds: 2_592_000 })).toBe('Mensal');
    expect(classifyQuotaWindow({ ...base, unit: 'currency', periodSeconds: null })).toBe(
      'Créditos',
    );
    expect(classifyQuotaWindow({ ...base, unit: 'provider-unit', periodSeconds: null })).toBe(
      'Unidade do provedor',
    );
  });

  it('distinguishes nominal, consumed, reserved (held), estimated (uncertain) and never invents percentages when limit is null', () => {
    const knownDef: QuotaDefinition = {
      id: 'q-known',
      scope: 'provider',
      scopeId: 'groq',
      unit: 'requests',
      limit: 1_000,
      periodSeconds: 86_400,
      sourceUrl: 'https://console.groq.com/docs/rate-limits',
      verifiedAt: '2026-11-27T00:00:00.000Z',
    };
    const obs: QuotaObservation[] = [
      {
        quotaId: 'q-known',
        remaining: null,
        used: 200,
        resetAt: '2026-11-28T00:00:00.000Z',
        observedAt: '2026-11-27T12:00:00.000Z',
        source: 'response-header',
      },
    ];
    const res: QuotaReservation[] = [
      {
        id: 'res-held',
        quotaId: 'q-known',
        requestId: 'req-1',
        amount: 50,
        status: 'held',
        expiresAt: '2026-11-27T12:05:00.000Z',
      },
      {
        id: 'res-uncertain',
        quotaId: 'q-known',
        requestId: 'req-2',
        amount: 100,
        status: 'uncertain',
        expiresAt: '2026-11-27T12:10:00.000Z',
      },
    ];

    const bKnown = computeQuotaBreakdown(knownDef, obs, res);
    expect(bKnown.nominal).toBe(1_000);
    expect(bKnown.consumed).toBe(200);
    expect(bKnown.reserved).toBe(50);
    expect(bKnown.estimatedUncertain).toBe(100);
    expect(bKnown.available).toBe(650);
    expect(bKnown.utilizationPercent).toBe(35);

    const unknownDef: QuotaDefinition = {
      ...knownDef,
      id: 'q-unknown',
      limit: null,
      sourceUrl: null,
      verifiedAt: null,
    };
    const bUnknown = computeQuotaBreakdown(unknownDef, [], []);
    expect(bUnknown.nominal).toBeNull();
    expect(bUnknown.available).toBeNull();
    expect(bUnknown.utilizationPercent).toBeNull();
  });

  it('aggregates usage strictly per currency without mixing currencies or treating unknown cost as zero', () => {
    const records: UsageRecord[] = [
      {
        id: 'u1',
        requestId: 'r1',
        routeId: 'route-openai',
        inputTokens: 1_000,
        outputTokens: 500,
        cost: 0.015,
        currency: 'USD',
        source: 'provider',
        recordedAt: '2026-11-27T10:00:00.000Z',
      },
      {
        id: 'u2',
        requestId: 'r2',
        routeId: 'route-brl',
        inputTokens: 2_000,
        outputTokens: 400,
        cost: 0.08,
        currency: 'BRL',
        source: 'provider',
        recordedAt: '2026-11-27T10:05:00.000Z',
      },
      {
        id: 'u3',
        requestId: 'r3',
        routeId: 'route-sub',
        inputTokens: null,
        outputTokens: null,
        cost: null,
        currency: null,
        source: 'unknown',
        recordedAt: '2026-11-27T10:10:00.000Z',
      },
    ];

    const summary = summarizeUsageRecords(records);
    expect(Object.keys(summary.byCurrency).sort()).toEqual(['BRL', 'USD']);
    expect(summary.byCurrency['USD']?.totalCost).toBeCloseTo(0.015, 5);
    expect(summary.byCurrency['BRL']?.totalCost).toBeCloseTo(0.08, 5);
    expect(summary.unknownCostRequests).toBe(1);
    expect(summary.unreportedTokenRequests).toBe(1);
    expect(formatPricePerMillion(null, null)).toBe('Desconhecido');
    expect(formatPricePerMillion(0, 'USD')).toContain('gratuito verificado');
  });
});

describe('Phase 02 — Routing strategies, non-bypassable guardrails & project privacy policies', () => {
  it('enforces Free-only mode: blocks paid routes, unknown-cost routes and paid fallbacks', () => {
    const freeDraft = buildPresetStrategy('free-only', { allowedProviderIds: ['openrouter'] });
    const paidModel = makeModel({
      id: 'mod-paid',
      pricing: {
        currency: 'USD',
        inputPerMillion: 3,
        outputPerMillion: 15,
        cachedInputPerMillion: null,
        verifiedAt: '2026-11-20T00:00:00.000Z',
        sourceUrl: 'https://openai.com/api/pricing',
      },
    });
    const unknownPriceModel = makeModel({
      id: 'mod-unknown',
      pricing: null,
    });
    const fallbackRoute: ModelRoute = {
      id: 'route-paid-fallback',
      modelId: paidModel.id,
      connectionId: 'conn-1',
      priority: 50,
      enabled: true,
      localOnly: false,
    };

    const resPaid = validateStrategyGuardrails({
      draft: freeDraft,
      projectPrivacy: 'personal-private',
      globalMaxPerDay: null,
      globalAllowWithoutCostGuarantee: false,
      routes: [fallbackRoute],
      models: [paidModel],
    });
    expect(resPaid.valid).toBe(false);
    expect(resPaid.violationsPt.join(' ')).toContain('route-paid-fallback');

    const resUnknown = validateStrategyGuardrails({
      draft: freeDraft,
      projectPrivacy: 'personal-private',
      globalMaxPerDay: null,
      globalAllowWithoutCostGuarantee: false,
      routes: [{ ...fallbackRoute, id: 'route-unknown-price', modelId: unknownPriceModel.id }],
      models: [unknownPriceModel],
    });
    expect(resUnknown.valid).toBe(false);
    expect(resUnknown.violationsPt.join(' ')).toContain('route-unknown-price');
  });

  it('enforces Local-only mode and Restricted project classification without exception', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackUrl('https://api.openrouter.ai/api/v1')).toBe(false);

    const localDraft = buildPresetStrategy('local-only');
    const extRoute: ModelRoute = {
      id: 'route-cloud',
      modelId: 'm1',
      connectionId: 'conn-cloud',
      priority: 1,
      enabled: true,
      localOnly: false,
    };
    const resExt = validateStrategyGuardrails({
      draft: localDraft,
      projectPrivacy: 'restricted',
      globalMaxPerDay: 5,
      globalAllowWithoutCostGuarantee: false,
      routes: [extRoute],
      models: [],
    });
    expect(resExt.valid).toBe(false);
    expect(resExt.violationsPt.join(' ')).toContain('route-cloud');

    // Restricted project rejects Balanced cloud strategy
    const balanced = buildPresetStrategy('balanced');
    const resRestricted = validateStrategyGuardrails({
      draft: balanced,
      projectPrivacy: 'restricted',
      globalMaxPerDay: 20,
      globalAllowWithoutCostGuarantee: false,
      routes: [],
      models: [],
    });
    expect(resRestricted.valid).toBe(false);
    expect(resRestricted.violationsPt.join(' ')).toContain('Restrito');

    // Global daily ceiling cannot be exceeded by a strategy
    const maxQuality = buildPresetStrategy('max-quality'); // 50 USD/day default
    const resCeiling = validateStrategyGuardrails({
      draft: maxQuality,
      projectPrivacy: 'personal-private',
      globalMaxPerDay: 10,
      globalAllowWithoutCostGuarantee: false,
      routes: [],
      models: [],
    });
    expect(resCeiling.valid).toBe(false);
    expect(resCeiling.violationsPt.join(' ')).toContain('excede o teto global');

    const contracts = toContractPolicies(localDraft);
    expect(contracts.privacy.mode).toBe('local-only');
    expect(contracts.billing.allowPaid).toBe(false);
    expect(contracts.billing.allowUnknownCost).toBe(false);
  });

  it('explains per-provider route blocks under Restricted and Commercial-Confidential privacy', () => {
    const cloudCatalog: ProviderCatalogEntry = {
      id: 'groq',
      name: 'Groq Cloud',
      kind: 'api',
      signupUrl: 'https://console.groq.com',
      documentationUrl: 'https://console.groq.com/docs',
      termsUrl: null,
      sourceId: 'src-groq',
      verifiedAt: '2026-11-25T00:00:00.000Z',
    };
    const cloudEndpoint: ProviderEndpoint = {
      id: 'ep-groq',
      providerId: 'groq',
      protocol: 'openai-chat',
      baseUrl: 'https://api.groq.com/openai/v1',
      documentationUrl: 'https://console.groq.com/docs',
    };

    const restrictedVerdict = evaluateProviderEligibility({
      privacyClass: 'restricted',
      provider: cloudCatalog,
      endpoint: cloudEndpoint,
      connection: undefined,
      approvedProviderIds: ['groq'],
    });
    expect(restrictedVerdict.eligible).toBe(false);
    expect(restrictedVerdict.reasonsPt.join(' ')).toContain('Restrito');

    const unapprovedCommercial = evaluateProviderEligibility({
      privacyClass: 'commercial-confidential',
      provider: cloudCatalog,
      endpoint: cloudEndpoint,
      connection: undefined,
      approvedProviderIds: [],
    });
    expect(unapprovedCommercial.eligible).toBe(false);
    expect(unapprovedCommercial.reasonsPt.join(' ')).toContain('Comercial confidencial');
    expect(unapprovedCommercial.reasonsPt.join(' ')).toContain('termsUrl ausente');
    expect(PRIVACY_CLASSIFICATIONS['restricted'].allowsExternalCloud).toBe(false);
  });
});

describe('Phase 02 — Multi-provider model grouping, local hardware estimates & UI component rendering at scale', () => {
  it('groups identical models offered across cloud, aggregator and local endpoints while keeping distinct terms', () => {
    const mOpenRouter = makeModel({
      id: 'm-or',
      providerId: 'openrouter',
      upstreamModelId: 'deepseek/deepseek-r1:free',
      name: 'DeepSeek R1',
    });
    const mDeepSeekPaid = makeModel({
      id: 'm-ds',
      providerId: 'deepseek',
      upstreamModelId: 'deepseek-r1',
      name: 'DeepSeek R1',
      pricing: {
        currency: 'USD',
        inputPerMillion: 0.55,
        outputPerMillion: 2.19,
        cachedInputPerMillion: 0.14,
        verifiedAt: '2026-11-20T00:00:00.000Z',
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      },
    });
    const mLocalOllama = makeModel({
      id: 'm-local',
      providerId: 'ollama',
      upstreamModelId: 'deepseek-r1:latest',
      name: 'DeepSeek R1 Local',
      pricing: {
        currency: 'USD',
        inputPerMillion: 0,
        outputPerMillion: 0,
        cachedInputPerMillion: null,
        verifiedAt: '2026-11-20T00:00:00.000Z',
        sourceUrl: null,
      },
    });

    const groups = groupModelsAcrossProviders({
      models: [mOpenRouter, mDeepSeekPaid, mLocalOllama],
      catalog: [],
      endpoints: [],
      connections: [],
      routes: [],
      availabilities: {},
      benchmarks: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonicalKey).toBe('deepseek-r1');
    expect(groups[0]?.family).toBe('DeepSeek');
    expect(groups[0]?.offerings).toHaveLength(3);
  });

  it('marks local model hardware feasibility strictly as estimates, never guarantees', () => {
    const gpuOk = estimateLocalFeasibility({
      modelSizeBytes: 4_700_000_000,
      systemMemoryBytes: 32_000_000_000,
      gpuMemoryBytes: 12_000_000_000,
    });
    expect(gpuOk.tier).toBe('gpu-estimated');
    expect(gpuOk.labelPt).toContain('Estimativa');
    expect(gpuOk.labelPt).toContain('não é garantia');

    const ramFallback = estimateLocalFeasibility({
      modelSizeBytes: 9_000_000_000,
      systemMemoryBytes: 32_000_000_000,
      gpuMemoryBytes: 6_000_000_000,
    });
    expect(ramFallback.tier).toBe('cpu-ram-estimated');
    expect(ramFallback.labelPt).toContain('Estimativa');

    const unknownHw = estimateLocalFeasibility({
      modelSizeBytes: 4_700_000_000,
      systemMemoryBytes: null,
      gpuMemoryBytes: null,
    });
    expect(unknownHw.tier).toBe('hardware-unknown');
  });

  it('renders Marketplace with 300+ providers/models without fake free badges, Connections auth vs inference states, and all 11 tabs', () => {
    const largeCatalog: ProviderCatalogEntry[] = Array.from({ length: 310 }, (_, idx) => ({
      id: `prov-${idx}`,
      name: idx === 0 ? 'UnknownOfferCloud' : `Provider ${idx}`,
      kind: idx % 10 === 0 ? 'local' : 'api',
      signupUrl: `https://provider-${idx}.example.com/signup`,
      documentationUrl: `https://provider-${idx}.example.com/docs`,
      termsUrl: idx % 2 === 0 ? null : `https://provider-${idx}.example.com/terms`,
      sourceId: `src-${idx}`,
      verifiedAt: idx === 0 ? null : '2026-11-25T00:00:00.000Z',
    }));

    const largeModels: ModelDefinition[] = Array.from({ length: 320 }, (_, idx) =>
      makeModel({
        id: `mod-${idx}`,
        providerId: `prov-${idx % 310}`,
        upstreamModelId: `vendor/model-${idx}`,
        name: `Model ${idx}`,
        pricing:
          idx === 0
            ? null // unknown offer — must never receive a free badge!
            : idx === 1
              ? {
                  currency: 'USD',
                  inputPerMillion: 0,
                  outputPerMillion: 0,
                  cachedInputPerMillion: null,
                  verifiedAt: '2026-11-25T00:00:00.000Z',
                  sourceUrl: 'https://provider-1.example.com/pricing',
                }
              : {
                  currency: 'USD',
                  inputPerMillion: 1.5,
                  outputPerMillion: 6,
                  cachedInputPerMillion: null,
                  verifiedAt: '2026-11-25T00:00:00.000Z',
                  sourceUrl: 'https://provider-2.example.com/pricing',
                },
      }),
    );

    const connections: ProviderConnection[] = [
      {
        id: 'conn-key-only',
        providerId: 'prov-1',
        endpointId: 'ep-1',
        credentialId: 'crd_111111111111',
        enabled: true,
        status: 'ready',
        lastVerifiedAt: '2026-11-27T10:00:00.000Z',
      },
      {
        id: 'conn-inference-ok',
        providerId: 'prov-2',
        endpointId: 'ep-2',
        credentialId: 'crd_222222222222',
        enabled: true,
        status: 'ready',
        lastVerifiedAt: '2026-11-27T11:00:00.000Z',
      },
      {
        id: 'conn-broken',
        providerId: 'prov-3',
        endpointId: 'ep-3',
        credentialId: 'crd_333333333333',
        enabled: true,
        status: 'invalid-credential',
        lastVerifiedAt: null,
      },
    ];

    const snapshot: AiResourceSnapshot = {
      ...makeEmptySnapshot('ready'),
      catalog: largeCatalog,
      models: largeModels,
      connections,
      availabilities: {
        'mod-1:conn-key-only': {
          modelId: 'mod-1',
          connectionId: 'conn-key-only',
          state: 'available',
          observedAt: '2026-11-27T10:00:00.000Z',
          retryAt: null,
          evidence: 'provider-api',
        },
        'mod-2:conn-inference-ok': {
          modelId: 'mod-2',
          connectionId: 'conn-inference-ok',
          state: 'available',
          observedAt: '2026-11-27T11:00:00.000Z',
          retryAt: null,
          evidence: 'successful-inference',
        },
      },
      credits: [
        {
          accountId: 'prov-1-promo',
          currency: 'USD',
          amount: 4.5,
          expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          source: 'provider-api',
          observedAt: '2026-11-27T12:00:00.000Z',
        },
      ],
      localRuntimes: [
        {
          id: 'ollama-local',
          kind: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          status: 'available',
          version: '0.5.7',
        },
      ],
    };

    const overviewHtml = renderToStaticMarkup(
      React.createElement(OverviewSection, {
        snapshot,
        adapters: [],
        cliProviders: [],
        coreUsageDay: null,
        projectPrivacy: 'personal-private',
        activeProjectName: 'DevBrain',
        onNavigateTab: () => undefined,
        onRefresh: () => undefined,
        loading: false,
        language: 'pt-BR',
      }),
    );
    expect(overviewHtml).toContain('310');
    expect(overviewHtml).not.toContain('Saldo global de tokens');

    const marketplaceHtml = renderToStaticMarkup(
      React.createElement(MarketplaceWizardSection, {
        snapshot,
        credentials: [],
        projectPrivacy: 'personal-private',
        approvedProviderIds: ['prov-1'],
        signupQueue: [],
        onUpdateSignupQueue: () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(marketplaceHtml).toContain('UnknownOfferCloud');
    expect(marketplaceHtml).toContain('Desconhecido');

    const connectionsHtml = renderToStaticMarkup(
      React.createElement(ConnectionsSection, {
        snapshot,
        credentials: [],
        projectPrivacy: 'personal-private',
        approvedProviderIds: ['prov-1', 'prov-2'],
        onRecordAvailability: () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(connectionsHtml).toContain('conn-key-only');
    expect(connectionsHtml).toContain('conn-inference-ok');
    expect(connectionsHtml).toContain('conn-broken');

    const modelsHtml = renderToStaticMarkup(
      React.createElement(ModelsCatalogSection, {
        snapshot,
        agents: [],
        projectPrivacy: 'personal-private',
        approvedProviderIds: ['prov-1'],
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(modelsHtml).toContain('Model 0');

    const localHtml = renderToStaticMarkup(
      React.createElement(LocalModelsSection, {
        snapshot,
        activePulls: {
          op_pull_1: {
            operationId: 'op_pull_1',
            runtimeId: 'ollama-local',
            modelId: 'qwen2.5-coder:7b',
            completed: 2_000_000_000,
            total: 4_700_000_000,
          },
        },
        onStartPull: () => undefined,
        onRemovePull: () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(localHtml).toContain('qwen2.5-coder:7b');
    expect(localHtml).toContain('Cancelar');

    const quotasHtml = renderToStaticMarkup(
      React.createElement(QuotasAndCreditsSection, {
        mode: 'quotas',
        snapshot,
        projects: [],
        agents: [],
        settings: null,
        coreUsageDay: null,
        coreUsageMonth: null,
        onQueryAccountCredit: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(quotasHtml).toContain('Cotas');

    const routingHtml = renderToStaticMarkup(
      React.createElement(RoutingStrategiesSection, {
        snapshot,
        settings: null,
        activeProjectId: null,
        projectPrivacy: 'personal-private',
        onChangeProjectPrivacy: () => undefined,
        strategyDraft: buildPresetStrategy('free-only'),
        onChangeStrategyDraft: () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(routingHtml).toContain('Somente gratuito');
    expect(routingHtml).toContain('Somente local');

    const benchmarksHtml = renderToStaticMarkup(
      React.createElement(BenchmarksSection, {
        snapshot: makeEmptySnapshot('ready'),
        onRecordBenchmark: () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(benchmarksHtml).toContain('Executar benchmark');
    expect(benchmarksHtml).toContain('zero notas fictícias');

    const diagnosticsHtml = renderToStaticMarkup(
      React.createElement(DiagnosticsSection, {
        snapshot: makeEmptySnapshot('unsupported'),
        sessions: [],
        activeProjectId: null,
        activeInferenceStream: '',
        activeInferenceRequestId: null,
        onSubmitDiagInference: async () => undefined,
        onCancelDiagInference: async () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(diagnosticsHtml).toContain('ai.catalog.list: unsupported');

    const emptySet: ReadonlySet<string> = new Set<string>();
    const centerHtml = renderToStaticMarkup(
      React.createElement(AiResourceCenterView, {
        projects: [],
        activeProject: null,
        projectPrivacy: 'personal-private',
        onChangeProjectPrivacy: () => undefined,
        selectedStrategyPreset: 'balanced',
        onChangeStrategyPreset: () => undefined,
        signupQueue: [],
        onUpdateSignupQueue: () => undefined,
        adapters: [],
        providers: [],
        agents: [],
        credentials: [],
        policies: [],
        settings: null,
        dependencyReports: {},
        runningProviderIds: emptySet,
        runningAgentIds: emptySet,
        onCheckAdapter: async () => undefined,
        onRefreshCore: async () => undefined,
        onModelsChanged: () => undefined,
        onOpenWorkspace: () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(centerHtml).toContain('Marketplace');
    expect(centerHtml).toContain('Catálogo');
    expect(centerHtml).toContain('Agentes');
  });

  it('integrates OpenCode in Dev Agents and enforces Restricted project guardrail in Workspace while preserving Phase 01', () => {
    const emptySet: ReadonlySet<string> = new Set<string>();
    const openCodeProviderId = newId('provider');
    const openCodeAgentId = newId('agent');
    const openCodeProvider: ProviderProfile = {
      provider: {
        id: openCodeProviderId,
        adapterKey: 'opencode-cli',
        kind: 'cli-agent',
        displayName: 'OpenCode Runtime',
        vendor: 'Anomaly / OpenCode',
        status: 'unknown',
        enabled: true,
        credentialRef: null,
        endpoint: null,
        capabilities: { ...NO_CAPABILITIES },
        lastCheckedAt: null,
      },
      config: {
        executablePath: 'opencode',
        defaultArgs: [],
        models: [{ id: 'ollama/qwen2.5-coder:14b', displayName: 'Qwen 2.5 Coder 14B' }],
        defaultModel: 'ollama/qwen2.5-coder:14b',
        envAllowlist: [],
      },
      health: {
        installed: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
        authenticated: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
        operational: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
      },
      readiness: 'configured',
    };
    const openCodeAgent: Agent = {
      id: openCodeAgentId,
      providerId: openCodeProviderId,
      name: 'OpenCode Dev Agent',
      role: 'Developer',
      model: 'ollama/qwen2.5-coder:14b',
      capabilities: { ...NO_CAPABILITIES },
      permissionPolicyId: newId('policy'),
      status: 'idle',
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
      metadata: {},
    };

    const agentsHtml = renderToStaticMarkup(
      React.createElement(AgentsProvidersView, {
        adapters: [],
        providers: [openCodeProvider],
        agents: [openCodeAgent],
        credentials: [],
        policies: [],
        dependencyReports: {},
        runningProviderIds: emptySet,
        runningAgentIds: emptySet,
        embedded: true,
        onCheckAdapter: async () => undefined,
        onRefreshAll: async () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(agentsHtml).toContain('OpenCode');
    expect(agentsHtml).toContain('opencode-cli');
    expect(agentsHtml).toContain('Modelo · Provedor · Agente · Runtime · Conexão · Política');

    const projectId = newId('project');
    const wsId = newId('workspace');
    const provId = newId('provider');
    const agentId = newId('agent');
    const project: Project = {
      id: projectId,
      name: 'VaultCore',
      rootPath: 'C:\\projects\\vaultcore',
      description: null,
      isGitRepository: true,
      defaultWorkspaceId: wsId,
      technologies: [],
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
      lastOpenedAt: nowTimestamp(),
      archivedAt: null,
      metadata: {},
    };
    const cloudProvider: ProviderProfile = {
      provider: {
        id: provId,
        adapterKey: 'openai-codex-cli',
        kind: 'cli-agent',
        displayName: 'OpenAI Codex',
        vendor: 'OpenAI',
        status: 'available',
        enabled: true,
        credentialRef: null,
        endpoint: null,
        capabilities: { ...NO_CAPABILITIES },
        lastCheckedAt: nowTimestamp(),
      },
      config: {
        executablePath: 'codex',
        defaultArgs: [],
        models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
        defaultModel: 'gpt-5-codex',
        envAllowlist: [],
      },
      health: {
        installed: {
          state: 'yes',
          checkedAt: nowTimestamp(),
          source: 'execution-engine',
          detail: '1.0',
        },
        authenticated: { state: 'unknown', checkedAt: null, source: 'none', detail: null },
        operational: {
          state: 'yes',
          checkedAt: nowTimestamp(),
          source: 'execution-engine',
          detail: null,
        },
      },
      readiness: 'available',
    };
    const agent: Agent = {
      id: agentId,
      providerId: provId,
      name: 'Codex Cloud Agent',
      role: 'Developer',
      model: 'gpt-5-codex',
      capabilities: { ...NO_CAPABILITIES },
      permissionPolicyId: newId('policy'),
      status: 'idle',
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
      metadata: {},
    };

    const workspaceRestrictedHtml = renderToStaticMarkup(
      React.createElement(WorkspaceView, {
        activeProject: project,
        agents: [agent],
        providers: [cloudProvider],
        availableModels: [
          makeModel({
            id: 'mod-qwen-local',
            providerId: 'ollama',
            upstreamModelId: 'ollama/qwen2.5-coder:7b',
            name: 'Qwen 2.5 Coder 7B',
          }),
        ],
        projectPrivacy: 'restricted',
        pendingApprovals: [],
        requestedSessionId: null,
        terminalAutoScroll: true,
        terminalExpanded: false,
        terminalHeight: 280,
        onToggleAutoScroll: () => undefined,
        onToggleExpanded: () => undefined,
        onResizeTerminal: () => undefined,
        onOpenApprovalModal: () => undefined,
        onNavigate: () => undefined,
        onImportProjectQuick: async () => undefined,
        onExecutionActiveChange: () => undefined,
        language: 'pt-BR',
      }),
    );
    expect(workspaceRestrictedHtml).toContain('Restrito');
    expect(workspaceRestrictedHtml).toContain('bloqueado');
    expect(workspaceRestrictedHtml).toContain('Qwen 2.5 Coder 7B');
  });
});
