import { useCallback, useEffect, useState } from 'react';
import type {
  AdapterDescriptor,
  Agent,
  AgentSession,
  ApplicationSettings,
  BenchmarkResult,
  CredentialReference,
  DependencyReport,
  ModelAvailability,
  ModelDefinition,
  PermissionPolicy,
  Project,
  ProviderProfile,
  UsageSummary,
} from '@devbrain/contracts';
import { Tabs, tokens } from '@devbrain/ui';
import {
  AI_CHANNEL_KEYS,
  buildPresetStrategy,
  callAiChannel,
  type AiChannelKey,
  type AiResourceSnapshot,
  type ChannelSupportState,
  type ProjectPrivacyClass,
  type StrategyDraft,
  type StrategyPresetId,
} from '../../lib/ai-center';
import { invoke, subscribe } from '../../lib/bridge';
import type { AppLanguage } from '../../lib/i18n';
import type { AssistedSignupQueueItem } from '../../lib/preferences';
import { AgentsProvidersView } from '../AgentsProvidersView';
import { ConnectionsSection, ModelsCatalogSection } from './ConnectionsModelsSection';
import {
  LocalModelsSection,
  QuotasAndCreditsSection,
  type ActivePullState,
} from './LocalQuotasCreditsSection';
import { MarketplaceWizardSection } from './MarketplaceWizardSection';
import { OverviewSection, type AiCenterTab } from './OverviewSection';
import {
  BenchmarksSection,
  DiagnosticsSection,
  RoutingStrategiesSection,
} from './RoutingBenchmarksDiagnosticsSection';

export interface AiResourceCenterViewProps {
  initialTab?: AiCenterTab | undefined;
  projects: readonly Project[];
  activeProject: Project | null;
  projectPrivacy: ProjectPrivacyClass;
  onChangeProjectPrivacy: (next: ProjectPrivacyClass) => void;
  selectedStrategyPreset: StrategyPresetId;
  onChangeStrategyPreset: (preset: StrategyPresetId) => void;
  signupQueue: readonly AssistedSignupQueueItem[];
  onUpdateSignupQueue: (next: AssistedSignupQueueItem[]) => void;
  adapters: readonly AdapterDescriptor[];
  providers: readonly ProviderProfile[];
  agents: readonly Agent[];
  credentials: readonly CredentialReference[];
  policies: readonly PermissionPolicy[];
  settings: ApplicationSettings | null;
  dependencyReports: Readonly<Record<string, DependencyReport>>;
  runningProviderIds: ReadonlySet<string>;
  runningAgentIds: ReadonlySet<string>;
  onCheckAdapter: (adapterKey: string) => Promise<void>;
  onRefreshCore: () => Promise<void>;
  onModelsChanged: (models: ModelDefinition[]) => void;
  onOpenWorkspace: () => void;
  language: AppLanguage;
}

const createInitialChannelStates = (): Record<AiChannelKey, ChannelSupportState> => {
  const rec = {} as Record<AiChannelKey, ChannelSupportState>;
  for (const key of AI_CHANNEL_KEYS) rec[key] = 'unprobed';
  return rec;
};

export const AiResourceCenterView = ({
  initialTab = 'overview',
  projects,
  activeProject,
  projectPrivacy,
  onChangeProjectPrivacy,
  selectedStrategyPreset,
  onChangeStrategyPreset,
  signupQueue,
  onUpdateSignupQueue,
  adapters,
  providers,
  agents,
  credentials,
  policies,
  settings,
  dependencyReports,
  runningProviderIds,
  runningAgentIds,
  onCheckAdapter,
  onRefreshCore,
  onModelsChanged,
  onOpenWorkspace,
  language,
}: AiResourceCenterViewProps) => {
  const pt = language === 'pt-BR';
  const [activeTab, setActiveTab] = useState<AiCenterTab>(initialTab);
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<AiResourceSnapshot>(() => ({
    channelStates: createInitialChannelStates(),
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
  }));

  const [coreUsageDay, setCoreUsageDay] = useState<UsageSummary | null>(null);
  const [coreUsageMonth, setCoreUsageMonth] = useState<UsageSummary | null>(null);
  const [projectSessions, setProjectSessions] = useState<AgentSession[]>([]);
  const [activePulls, setActivePulls] = useState<Record<string, ActivePullState>>({});

  const [strategyDraft, setStrategyDraft] = useState<StrategyDraft>(() =>
    buildPresetStrategy(selectedStrategyPreset, {
      privacyMode: projectPrivacy === 'restricted' ? 'local-only' : 'approved-providers',
    }),
  );

  // Diagnostic inference streaming state
  const [activeInferenceRequestId, setActiveInferenceRequestId] = useState<string | null>(null);
  const [activeInferenceStream, setActiveInferenceStream] = useState<string>('');

  const refreshGatewayAndCore = useCallback(async () => {
    setLoading(true);
    try {
      const nextStates: Record<AiChannelKey, ChannelSupportState> = {
        ...snapshot.channelStates,
      };
      const recordOutcome = <K extends AiChannelKey>(
        key: K,
        outcome: Awaited<ReturnType<typeof callAiChannel<K>>>,
      ) => {
        nextStates[key] =
          outcome.status === 'ok'
            ? 'ready'
            : outcome.status === 'unsupported'
              ? 'unsupported'
              : 'error';
      };

      const [catOut, epOut, connOut, modOut, rtOut, quotaOut, locOut, daySum, monthSum, sessList] =
        await Promise.all([
          callAiChannel('ai.catalog.list', {}),
          callAiChannel('ai.endpoints.list', {}),
          callAiChannel('ai.connections.list', {}),
          callAiChannel('ai.models.list', {}),
          callAiChannel('ai.routes.list', {}),
          callAiChannel('ai.quota.definitions', {}),
          callAiChannel('ai.local.list', {}),
          invoke('usage.summary', { period: 'day' }).catch(() => null),
          invoke('usage.summary', { period: 'month' }).catch(() => null),
          activeProject
            ? invoke('sessions.listByProject', { projectId: activeProject.id }).catch(() => [])
            : Promise.resolve([]),
        ]);

      recordOutcome('ai.catalog.list', catOut);
      recordOutcome('ai.endpoints.list', epOut);
      recordOutcome('ai.connections.list', connOut);
      recordOutcome('ai.models.list', modOut);
      recordOutcome('ai.routes.list', rtOut);
      recordOutcome('ai.quota.definitions', quotaOut);
      recordOutcome('ai.local.list', locOut);

      const quotas = quotaOut.status === 'ok' ? quotaOut.data : [];
      const observations: AiResourceSnapshot['observations'] = {};
      const reservations: AiResourceSnapshot['reservations'] = {};
      for (const q of quotas.slice(0, 30)) {
        const [obsOut, resOut] = await Promise.all([
          callAiChannel('ai.quota.observations', { quotaId: q.id }),
          callAiChannel('ai.quota.reservations', { quotaId: q.id }),
        ]);
        recordOutcome('ai.quota.observations', obsOut);
        recordOutcome('ai.quota.reservations', resOut);
        if (obsOut.status === 'ok') observations[q.id] = obsOut.data;
        if (resOut.status === 'ok') reservations[q.id] = resOut.data;
      }

      const localRuntimes = locOut.status === 'ok' ? locOut.data : [];
      const localModels: AiResourceSnapshot['localModels'] = {};
      for (const rt of localRuntimes) {
        const lmOut = await callAiChannel('ai.local.models', { runtimeId: rt.id });
        recordOutcome('ai.local.models', lmOut);
        if (lmOut.status === 'ok') localModels[rt.id] = lmOut.data;
      }

      const models = modOut.status === 'ok' ? modOut.data : [];
      onModelsChanged(models);

      setCoreUsageDay(daySum);
      setCoreUsageMonth(monthSum);
      setProjectSessions(sessList);

      setSnapshot((prev) => ({
        ...prev,
        channelStates: nextStates,
        catalog: catOut.status === 'ok' ? catOut.data : [],
        endpoints: epOut.status === 'ok' ? epOut.data : [],
        connections: connOut.status === 'ok' ? connOut.data : [],
        models,
        routes: rtOut.status === 'ok' ? rtOut.data : [],
        quotas,
        observations,
        reservations,
        localRuntimes,
        localModels,
      }));
    } finally {
      setLoading(false);
    }
  }, [activeProject, onModelsChanged, snapshot.channelStates]);

  useEffect(() => {
    void refreshGatewayAndCore();
  }, [activeProject?.id]);

  // Subscribe to `ai.local.pullProgress` and `ai.inference.event`
  useEffect(() => {
    const unsubPull = subscribe('ai.local.pullProgress', (ev) => {
      setActivePulls((prev) => {
        const cur = prev[ev.operationId];
        if (!cur) return prev;
        if (ev.total !== null && ev.completed >= ev.total && ev.total > 0) {
          const copy = { ...prev };
          delete copy[ev.operationId];
          void refreshGatewayAndCore();
          return copy;
        }
        return {
          ...prev,
          [ev.operationId]: { ...cur, completed: ev.completed, total: ev.total },
        };
      });
    });

    const unsubInf = subscribe('ai.inference.event', (ev) => {
      if (ev.type === 'started') {
        setActiveInferenceStream((prev) => `${prev}[#${ev.seq} started route=${ev.routeId}]\n`);
      } else if (ev.type === 'delta') {
        setActiveInferenceStream((prev) => prev + ev.text);
      } else if (ev.type === 'completed') {
        setActiveInferenceStream(
          (prev) => `${prev}\n[#${ev.seq} completed finish=${ev.result.finishReason}]\n`,
        );
        setActiveInferenceRequestId(null);
        if (ev.result.usage) {
          const usageItem = ev.result.usage;
          setSnapshot((s) => ({
            ...s,
            recentUsage: [usageItem, ...s.recentUsage.slice(0, 99)],
            recentAttempts: { ...s.recentAttempts, [ev.requestId]: ev.result.attempts },
          }));
        }
      } else if (ev.type === 'failed') {
        setActiveInferenceStream(
          (prev) => `${prev}\n[#${ev.seq} FAILED ${ev.error.code}: ${ev.error.message}]\n`,
        );
        setActiveInferenceRequestId(null);
      }
    });

    return () => {
      unsubPull();
      unsubInf();
    };
  }, [refreshGatewayAndCore]);

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([onRefreshCore(), refreshGatewayAndCore()]);
  }, [onRefreshCore, refreshGatewayAndCore]);

  const handleQueryAccountCredit = async (accountId: string) => {
    const out = await callAiChannel('ai.credits.get', { accountId });
    if (out.status === 'ok' && out.data) {
      const bal = out.data;
      setSnapshot((prev) => ({
        ...prev,
        credits: [bal, ...prev.credits.filter((c) => c.accountId !== bal.accountId)],
      }));
    }
  };

  const handleSubmitDiagInference = async (prompt: string, policyId: string) => {
    const id = `diag-${Date.now()}`;
    setActiveInferenceRequestId(id);
    setActiveInferenceStream('');
    const out = await callAiChannel('ai.inference.submit', {
      id,
      sessionId: null,
      modelId: null,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 128,
      temperature: 0.2,
      stream: true,
      routingPolicyId: policyId || 'policy-balanced',
      idempotencyKey: id,
    });
    if (out.status !== 'ok') {
      setActiveInferenceRequestId(null);
      setActiveInferenceStream(
        out.status === 'unsupported'
          ? `[UNSUPPORTED] ${out.message}`
          : `[${out.error.code}] ${out.error.message}`,
      );
    }
  };

  const handleCancelDiagInference = async () => {
    if (!activeInferenceRequestId) return;
    await callAiChannel('ai.inference.cancel', { requestId: activeInferenceRequestId });
    setActiveInferenceRequestId(null);
  };

  const tabs: { id: AiCenterTab; label: string; badge?: number }[] = [
    { id: 'overview', label: pt ? 'Visão geral' : 'Overview' },
    {
      id: 'marketplace',
      label: pt ? 'Marketplace' : 'Marketplace',
      ...(snapshot.catalog.length > 0 ? { badge: snapshot.catalog.length } : {}),
    },
    {
      id: 'connections',
      label: pt ? 'Minhas conexões' : 'Connections',
      ...(snapshot.connections.length > 0 ? { badge: snapshot.connections.length } : {}),
    },
    {
      id: 'models',
      label: pt ? 'Catálogo de modelos' : 'Models',
      ...(snapshot.models.length > 0 ? { badge: snapshot.models.length } : {}),
    },
    {
      id: 'agents',
      label: pt ? 'Agentes de dev' : 'Dev Agents',
      badge: agents.length,
    },
    {
      id: 'local',
      label: pt ? 'Modelos locais' : 'Local Models',
      ...(snapshot.localRuntimes.length > 0 ? { badge: snapshot.localRuntimes.length } : {}),
    },
    {
      id: 'quotas',
      label: pt ? 'Cotas' : 'Quotas',
      ...(snapshot.quotas.length > 0 ? { badge: snapshot.quotas.length } : {}),
    },
    { id: 'credits', label: pt ? 'Créditos e orçamento' : 'Credits & Budget' },
    { id: 'routing', label: pt ? 'Roteamento e privacidade' : 'Routing & Privacy' },
    {
      id: 'benchmarks',
      label: 'Benchmarks',
      ...(snapshot.benchmarks.length > 0 ? { badge: snapshot.benchmarks.length } : {}),
    },
    { id: 'diagnostics', label: pt ? 'Diagnóstico' : 'Diagnostics' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          padding: '10px 16px',
          borderBottom: `1px solid ${tokens.color.border}`,
          background: tokens.color.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            {pt ? 'AI Resource Center — Central de Recursos de IA' : 'AI Resource Center'}
          </h2>
          <div className="db-muted" style={{ fontSize: 11.5 }}>
            {pt
              ? 'Descoberta de provedores, conexões seguras, catálogo multi-endpoint, agentes CLI, modelos locais, cotas, roteamento e privacidade.'
              : 'Provider discovery, secure connections, multi-endpoint model catalog, CLI agents, local models, quotas and routing.'}
          </div>
        </div>
      </div>

      <Tabs
        tabs={tabs}
        active={activeTab}
        onChange={setActiveTab}
        ariaLabel={pt ? 'Áreas da Central de IA' : 'AI Resource Center sections'}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: activeTab === 'marketplace' || activeTab === 'agents' ? 'hidden' : 'auto',
          padding: activeTab === 'marketplace' || activeTab === 'agents' ? 0 : 14,
        }}
      >
        {activeTab === 'overview' ? (
          <OverviewSection
            snapshot={snapshot}
            adapters={adapters}
            cliProviders={providers}
            coreUsageDay={coreUsageDay}
            projectPrivacy={projectPrivacy}
            activeProjectName={activeProject?.name ?? null}
            onNavigateTab={setActiveTab}
            onRefresh={() => void handleRefreshAll()}
            loading={loading}
            language={language}
          />
        ) : null}

        {activeTab === 'marketplace' ? (
          <MarketplaceWizardSection
            snapshot={snapshot}
            credentials={credentials}
            projectPrivacy={projectPrivacy}
            approvedProviderIds={strategyDraft.allowedProviderIds}
            signupQueue={signupQueue}
            onUpdateSignupQueue={onUpdateSignupQueue}
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'connections' ? (
          <ConnectionsSection
            snapshot={snapshot}
            credentials={credentials}
            projectPrivacy={projectPrivacy}
            approvedProviderIds={strategyDraft.allowedProviderIds}
            onRecordAvailability={(key: string, avail: ModelAvailability) =>
              setSnapshot((prev) => ({
                ...prev,
                availabilities: { ...prev.availabilities, [key]: avail },
              }))
            }
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'models' ? (
          <ModelsCatalogSection
            snapshot={snapshot}
            agents={agents}
            projectPrivacy={projectPrivacy}
            approvedProviderIds={strategyDraft.allowedProviderIds}
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'agents' ? (
          <AgentsProvidersView
            embedded
            adapters={adapters}
            providers={providers}
            agents={agents}
            credentials={credentials}
            policies={policies}
            dependencyReports={dependencyReports}
            runningProviderIds={runningProviderIds}
            runningAgentIds={runningAgentIds}
            availableModels={snapshot.models}
            gatewayConnections={snapshot.connections}
            onOpenInWorkspace={onOpenWorkspace}
            onCheckAdapter={onCheckAdapter}
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'local' ? (
          <LocalModelsSection
            snapshot={snapshot}
            activePulls={activePulls}
            onStartPull={(pull) =>
              setActivePulls((prev) => ({ ...prev, [pull.operationId]: pull }))
            }
            onRemovePull={(opId) =>
              setActivePulls((prev) => {
                const copy = { ...prev };
                delete copy[opId];
                return copy;
              })
            }
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'quotas' ? (
          <QuotasAndCreditsSection
            mode="quotas"
            snapshot={snapshot}
            projects={projects}
            agents={agents}
            settings={settings}
            coreUsageDay={coreUsageDay}
            coreUsageMonth={coreUsageMonth}
            onQueryAccountCredit={handleQueryAccountCredit}
            language={language}
          />
        ) : null}

        {activeTab === 'credits' ? (
          <QuotasAndCreditsSection
            mode="credits"
            snapshot={snapshot}
            projects={projects}
            agents={agents}
            settings={settings}
            coreUsageDay={coreUsageDay}
            coreUsageMonth={coreUsageMonth}
            onQueryAccountCredit={handleQueryAccountCredit}
            language={language}
          />
        ) : null}

        {activeTab === 'routing' ? (
          <RoutingStrategiesSection
            snapshot={snapshot}
            settings={settings}
            projectPrivacy={projectPrivacy}
            onChangeProjectPrivacy={onChangeProjectPrivacy}
            strategyDraft={strategyDraft}
            onChangeStrategyDraft={(next) => {
              setStrategyDraft(next);
              onChangeStrategyPreset(next.preset);
            }}
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}

        {activeTab === 'benchmarks' ? (
          <BenchmarksSection
            snapshot={snapshot}
            onRecordBenchmark={(res: BenchmarkResult) =>
              setSnapshot((prev) => ({
                ...prev,
                benchmarks: [res, ...prev.benchmarks.filter((b) => b.id !== res.id)],
              }))
            }
            language={language}
          />
        ) : null}

        {activeTab === 'diagnostics' ? (
          <DiagnosticsSection
            snapshot={snapshot}
            sessions={projectSessions}
            activeInferenceStream={activeInferenceStream}
            activeInferenceRequestId={activeInferenceRequestId}
            onSubmitDiagInference={handleSubmitDiagInference}
            onCancelDiagInference={handleCancelDiagInference}
            onRefreshAll={handleRefreshAll}
            language={language}
          />
        ) : null}
      </div>
    </div>
  );
};
