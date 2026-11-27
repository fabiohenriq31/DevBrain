import { useMemo } from 'react';
import type { AdapterDescriptor, ProviderProfile, UsageSummary } from '@devbrain/contracts';
import { Badge, Banner, Button, DataTable, EmptyState, tokens } from '@devbrain/ui';
import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  Layers,
  RefreshCw,
  Server,
  ShieldAlert,
} from 'lucide-react';
import {
  PRIVACY_CLASSIFICATIONS,
  computeQuotaBreakdown,
  summarizeUsageRecords,
  type AiResourceSnapshot,
  type ProjectPrivacyClass,
} from '../../lib/ai-center';
import { formatTimestamp, type AppLanguage } from '../../lib/i18n';

export type AiCenterTab =
  | 'overview'
  | 'marketplace'
  | 'connections'
  | 'models'
  | 'agents'
  | 'local'
  | 'quotas'
  | 'credits'
  | 'routing'
  | 'benchmarks'
  | 'diagnostics';

export interface OverviewSectionProps {
  snapshot: AiResourceSnapshot;
  adapters: readonly AdapterDescriptor[];
  cliProviders: readonly ProviderProfile[];
  coreUsageDay: UsageSummary | null;
  projectPrivacy: ProjectPrivacyClass;
  activeProjectName: string | null;
  onNavigateTab: (tab: AiCenterTab) => void;
  onRefresh: () => void;
  loading: boolean;
  language: AppLanguage;
}

export const OverviewSection = ({
  snapshot,
  adapters,
  cliProviders,
  coreUsageDay,
  projectPrivacy,
  activeProjectName,
  onNavigateTab,
  onRefresh,
  loading,
  language,
}: OverviewSectionProps) => {
  const pt = language === 'pt-BR';

  const operationalConnections = useMemo(
    () => snapshot.connections.filter((c) => c.enabled && c.status === 'ready'),
    [snapshot.connections],
  );
  const operationalCliProviders = useMemo(
    () =>
      cliProviders.filter(
        (p) =>
          p.provider.enabled &&
          (p.readiness === 'available' ||
            p.readiness === 'authenticated' ||
            p.readiness === 'operational'),
      ),
    [cliProviders],
  );

  const unavailableConnections = useMemo(
    () =>
      snapshot.connections.filter(
        (c) => c.enabled && (c.status === 'unavailable' || c.status === 'invalid-credential'),
      ),
    [snapshot.connections],
  );

  const installedLocalCount = useMemo(
    () => Object.values(snapshot.localModels).reduce((sum, list) => sum + list.length, 0),
    [snapshot.localModels],
  );
  const availableLocalRuntimes = useMemo(
    () => snapshot.localRuntimes.filter((r) => r.status === 'available').length,
    [snapshot.localRuntimes],
  );

  // Resource modality breakdown (never mixing incompatible units or inventing free badges)
  const modalityBreakdown = useMemo(() => {
    let verifiedFreeModels = 0;
    let meteredPaidModels = 0;
    let unknownPriceModels = 0;
    let localCatalogEntries = 0;
    let subscriptionEntries = 0;

    for (const m of snapshot.models) {
      if (
        !m.pricing ||
        (m.pricing.inputPerMillion === null && m.pricing.outputPerMillion === null)
      ) {
        unknownPriceModels += 1;
      } else if (
        (m.pricing.inputPerMillion ?? 0) === 0 &&
        (m.pricing.outputPerMillion ?? 0) === 0
      ) {
        verifiedFreeModels += 1;
      } else {
        meteredPaidModels += 1;
      }
    }
    for (const entry of snapshot.catalog) {
      if (entry.kind === 'local') localCatalogEntries += 1;
      if (entry.kind === 'subscription') subscriptionEntries += 1;
    }
    const promoCredits = snapshot.credits.filter((c) => c.expiresAt !== null).length;

    return {
      verifiedFreeModels,
      meteredPaidModels,
      unknownPriceModels,
      localCatalogEntries: localCatalogEntries + installedLocalCount,
      subscriptionEntries:
        subscriptionEntries +
        cliProviders.filter((p) => p.provider.capabilities.costModel === 'subscription').length,
      promoCredits,
    };
  }, [cliProviders, installedLocalCount, snapshot.catalog, snapshot.credits, snapshot.models]);

  // Quota breakdowns with strict separation of nominal / available / reserved / uncertain / consumed / unknown
  const quotaBreakdowns = useMemo(
    () =>
      snapshot.quotas.map((q) =>
        computeQuotaBreakdown(
          q,
          snapshot.observations[q.id] ?? [],
          snapshot.reservations[q.id] ?? [],
        ),
      ),
    [snapshot.observations, snapshot.quotas, snapshot.reservations],
  );

  const upcomingRenewals = useMemo(
    () =>
      quotaBreakdowns
        .filter((b) => b.resetAt !== null)
        .sort((a, b) => (a.resetAt ?? '').localeCompare(b.resetAt ?? ''))
        .slice(0, 6),
    [quotaBreakdowns],
  );

  const expiringCredits = useMemo(() => {
    const horizonMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
    return snapshot.credits
      .filter((c) => c.expiresAt !== null && new Date(c.expiresAt).getTime() <= horizonMs)
      .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''));
  }, [snapshot.credits]);

  const gatewayUsage = useMemo(
    () => summarizeUsageRecords(snapshot.recentUsage),
    [snapshot.recentUsage],
  );

  const recentFallbacks = useMemo(() => {
    const rows: {
      requestId: string;
      routeId: string;
      endedAt: string;
      code: string;
      message: string;
    }[] = [];
    for (const [requestId, attempts] of Object.entries(snapshot.recentAttempts)) {
      for (const att of attempts) {
        rows.push({
          requestId,
          routeId: att.routeId,
          endedAt: att.endedAt,
          code: att.error?.code ?? 'OK',
          message: att.error?.message ?? (pt ? 'Rota concluída com sucesso' : 'Route succeeded'),
        });
      }
    }
    return rows.sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, 12);
  }, [pt, snapshot.recentAttempts]);

  const catalogUnsupported = snapshot.channelStates['ai.catalog.list'] === 'unsupported';
  const privacySpec = PRIVACY_CLASSIFICATIONS[projectPrivacy];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {catalogUnsupported ? (
        <Banner
          tone="info"
          title={
            pt
              ? 'Motor AI Gateway da Fase 02 aguardando integração de branch no processo principal'
              : 'Phase 02 AI Gateway awaiting main-process branch integration'
          }
          actions={
            <Button size="xs" variant="secondary" onClick={() => onNavigateTab('diagnostics')}>
              {pt ? 'Ver matriz IPC' : 'View IPC matrix'}
            </Button>
          }
        >
          {pt
            ? 'Esta branch parte diretamente de phase-02/contracts: canais ainda sem handler no main respondem honestamente UNSUPPORTED (nenhum dado simulado é exibido). Provedores CLI, credenciais DPAPI, sessões e políticas do Core operam normalmente.'
            : 'Channels without main-process handlers honestly respond UNSUPPORTED with zero simulated data.'}
        </Banner>
      ) : null}

      {/* Privacy classification context banner */}
      <div
        className="db-card"
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge
            tone={
              projectPrivacy === 'restricted'
                ? 'danger'
                : projectPrivacy === 'commercial-confidential'
                  ? 'warning'
                  : 'info'
            }
            dot
          >
            {pt ? privacySpec.labelPt : privacySpec.labelEn}
          </Badge>
          <span style={{ fontSize: 12, color: tokens.color.text }}>
            {activeProjectName
              ? `${pt ? 'Projeto ativo' : 'Active project'}: ${activeProjectName} — `
              : ''}
            <span className="db-muted">{pt ? privacySpec.summaryPt : privacySpec.summaryEn}</span>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="xs" variant="secondary" onClick={() => onNavigateTab('routing')}>
            {pt ? 'Estratégias e Privacidade' : 'Routing & Privacy'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<RefreshCw size={12} />}
            loading={loading}
            onClick={onRefresh}
          >
            {pt ? 'Atualizar painel' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Executive KPI grid — dense, operational */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
          gap: 10,
        }}
      >
        <div className="db-card" style={{ padding: '10px 12px' }}>
          <div
            className="db-muted"
            style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{pt ? 'Provedores descobertos' : 'Discovered providers'}</span>
            <Layers size={13} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
            {snapshot.catalog.length}{' '}
            <span className="db-muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
              + {adapters.length} CLI
            </span>
          </div>
          <div className="db-faint" style={{ fontSize: 11, marginTop: 2 }}>
            {pt ? 'Catálogo auditado + adaptadores locais' : 'Audited catalog + CLI adapters'}
          </div>
        </div>

        <div className="db-card" style={{ padding: '10px 12px' }}>
          <div
            className="db-muted"
            style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{pt ? 'Conexões configuradas' : 'Configured connections'}</span>
            <Server size={13} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
            {snapshot.connections.length}{' '}
            <span className="db-muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
              + {cliProviders.length} CLI
            </span>
          </div>
          <div className="db-faint" style={{ fontSize: 11, marginTop: 2 }}>
            {pt
              ? `${operationalConnections.length} gateway prontas · ${operationalCliProviders.length} CLI disponíveis`
              : `${operationalConnections.length} ready · ${operationalCliProviders.length} CLI available`}
          </div>
        </div>

        <div className="db-card" style={{ padding: '10px 12px' }}>
          <div
            className="db-muted"
            style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{pt ? 'Modelos catalogados' : 'Cataloged models'}</span>
            <Database size={13} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
            {snapshot.models.length}
          </div>
          <div className="db-faint" style={{ fontSize: 11, marginTop: 2 }}>
            {pt
              ? `${snapshot.routes.filter((r) => r.enabled).length} rota(s) habilitada(s)`
              : `${snapshot.routes.filter((r) => r.enabled).length} active route(s)`}
          </div>
        </div>

        <div className="db-card" style={{ padding: '10px 12px' }}>
          <div
            className="db-muted"
            style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{pt ? 'Recursos locais' : 'Local resources'}</span>
            <Cpu size={13} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
            {availableLocalRuntimes} / {snapshot.localRuntimes.length}
          </div>
          <div className="db-faint" style={{ fontSize: 11, marginTop: 2 }}>
            {pt
              ? `${installedLocalCount} modelo(s) instalado(s) em disco`
              : `${installedLocalCount} local model(s) installed`}
          </div>
        </div>

        <div className="db-card" style={{ padding: '10px 12px' }}>
          <div
            className="db-muted"
            style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{pt ? 'Indisponibilidades / Falhas' : 'Outages / Failures'}</span>
            <AlertTriangle size={13} />
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              marginTop: 4,
              color: unavailableConnections.length > 0 ? tokens.color.danger : tokens.color.text,
            }}
          >
            {unavailableConnections.length}
          </div>
          <div className="db-faint" style={{ fontSize: 11, marginTop: 2 }}>
            {pt
              ? `${recentFallbacks.filter((f) => f.code !== 'OK').length} falha(s) de rota recente(s)`
              : `${recentFallbacks.filter((f) => f.code !== 'OK').length} recent route error(s)`}
          </div>
        </div>
      </div>

      {/* Resource Categories & Real Consumption (never summing incompatible units) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 12 }}>
        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="db-card-header" style={{ marginBottom: 0 }}>
            <h3 className="db-section-title">
              {pt
                ? 'Classificação econômica de recursos (sem misturar unidades)'
                : 'Economic resource breakdown'}
            </h3>
            <Button size="xs" variant="ghost" onClick={() => onNavigateTab('marketplace')}>
              {pt ? 'Abrir Marketplace →' : 'Marketplace →'}
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge tone="success">
              {pt ? 'Gratuitos verificados' : 'Verified free'}:{' '}
              {modalityBreakdown.verifiedFreeModels}
            </Badge>
            <Badge tone="warning">
              {pt ? 'Créditos promocionais' : 'Promo credits'}: {modalityBreakdown.promoCredits}
            </Badge>
            <Badge tone="info">
              {pt ? 'Assinaturas' : 'Subscriptions'}: {modalityBreakdown.subscriptionEntries}
            </Badge>
            <Badge tone="neutral">
              {pt ? 'Pagos tarifados' : 'Metered paid'}: {modalityBreakdown.meteredPaidModels}
            </Badge>
            <Badge tone="info">
              {pt ? 'Locais (loopback)' : 'Local'}: {modalityBreakdown.localCatalogEntries}
            </Badge>
            <Badge tone="outline">
              {pt ? 'Preço/oferta desconhecida' : 'Unknown offer'}:{' '}
              {modalityBreakdown.unknownPriceModels}
            </Badge>
          </div>
          <div className="db-faint" style={{ fontSize: 11.5 }}>
            {pt
              ? 'Nota de integridade: o DevBrain não calcula "saldo global de tokens", pois limites RPM/TPM, créditos em moeda e assinaturas possuem denominadores e janelas incompatíveis.'
              : 'Integrity note: DevBrain never computes a misleading global token balance across incompatible units.'}
          </div>
        </div>

        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="db-card-header" style={{ marginBottom: 0 }}>
            <h3 className="db-section-title">
              {pt ? 'Consumo real medido (hoje)' : 'Measured consumption (today)'}
            </h3>
            <Button size="xs" variant="ghost" onClick={() => onNavigateTab('credits')}>
              {pt ? 'Créditos e Orçamento →' : 'Credits & Budget →'}
            </Button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            <div>
              <div className="db-muted">{pt ? 'Agentes CLI (Core)' : 'CLI Agents (Core)'}</div>
              <div>
                <strong>{coreUsageDay?.executions ?? 0}</strong>{' '}
                {pt ? 'execução(ões)' : 'execution(s)'} ·{' '}
                {coreUsageDay && Object.keys(coreUsageDay.cost).length > 0
                  ? Object.entries(coreUsageDay.cost)
                      .map(([cur, val]) => `${cur} ${val.toFixed(4)}`)
                      .join(' · ')
                  : pt
                    ? 'nenhum custo monetário informado'
                    : 'no reported currency cost'}
              </div>
              <div className="db-faint" style={{ fontSize: 11 }}>
                {pt
                  ? `${coreUsageDay?.unknownCostExecutions ?? 0} execução(ões) com custo desconhecido`
                  : `${coreUsageDay?.unknownCostExecutions ?? 0} unknown-cost run(s)`}
              </div>
            </div>
            <div>
              <div className="db-muted">{pt ? 'Inferência Gateway' : 'Gateway Inference'}</div>
              <div>
                {Object.keys(gatewayUsage.byCurrency).length > 0
                  ? Object.entries(gatewayUsage.byCurrency)
                      .map(([cur, v]) => `${cur} ${v.totalCost.toFixed(4)} (${v.requests} req)`)
                      .join(' · ')
                  : pt
                    ? '0 custos tarifados registrados'
                    : '0 metered charges'}
              </div>
              <div className="db-faint" style={{ fontSize: 11 }}>
                in={gatewayUsage.totalInputTokens.toLocaleString(language)} tok · out=
                {gatewayUsage.totalOutputTokens.toLocaleString(language)} tok
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Quota Capacity States: Nominal | Available | Reserved | Uncertain | Consumed | Unknown */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="db-card-header" style={{ marginBottom: 0 }}>
          <h3 className="db-section-title">
            {pt
              ? 'Cotas conhecidas — Capacidade Nominal · Disponível · Reservada · Estimada/Incerta · Consumida · Desconhecida'
              : 'Known Quotas — Nominal · Available · Reserved · Uncertain · Consumed · Unknown'}
          </h3>
          <Button size="xs" variant="secondary" onClick={() => onNavigateTab('quotas')}>
            {pt ? 'Central de Cotas' : 'Quotas Center'}
          </Button>
        </div>

        {quotaBreakdowns.length === 0 ? (
          <div className="db-muted" style={{ fontSize: 12 }}>
            {pt
              ? 'Nenhuma definição de cota publicada ou observada até o momento. Limites não verificados permanecem explícitos como desconhecidos.'
              : 'No published or observed quota definitions yet.'}
          </div>
        ) : (
          <DataTable
            columns={[
              {
                key: 'scope',
                header: pt ? 'Escopo / Janela' : 'Scope / Window',
                render: (q) => (
                  <div>
                    <Badge tone="info" mono>
                      {q.windowLabel}
                    </Badge>{' '}
                    <span className="db-mono" style={{ fontSize: 11.5 }}>
                      {q.scope}:{q.scopeId}
                    </span>
                  </div>
                ),
              },
              {
                key: 'unit',
                header: pt ? 'Unidade' : 'Unit',
                render: (q) => <span className="db-mono">{q.unit}</span>,
              },
              {
                key: 'nominal',
                header: pt ? 'Nominal' : 'Nominal',
                render: (q) =>
                  q.nominal !== null ? (
                    <strong className="db-mono">{q.nominal.toLocaleString(language)}</strong>
                  ) : (
                    <Badge tone="outline">{pt ? 'Desconhecida' : 'Unknown'}</Badge>
                  ),
              },
              {
                key: 'consumed',
                header: pt ? 'Consumida' : 'Consumed',
                render: (q) =>
                  q.consumed !== null ? (
                    <span className="db-mono">{q.consumed.toLocaleString(language)}</span>
                  ) : (
                    <span className="db-faint">—</span>
                  ),
              },
              {
                key: 'reserved',
                header: pt ? 'Reservada / Incerta' : 'Reserved / Uncertain',
                render: (q) => (
                  <span className="db-mono">
                    {q.reserved} /{' '}
                    <span
                      style={{ color: q.estimatedUncertain > 0 ? tokens.color.warning : undefined }}
                    >
                      {q.estimatedUncertain}
                    </span>
                  </span>
                ),
              },
              {
                key: 'available',
                header: pt ? 'Disponível' : 'Available',
                render: (q) =>
                  q.available !== null ? (
                    <Badge tone={q.available > 0 ? 'success' : 'danger'} mono>
                      {q.available.toLocaleString(language)}
                      {q.utilizationPercent !== null
                        ? ` (${100 - q.utilizationPercent}% livre)`
                        : ''}
                    </Badge>
                  ) : (
                    <Badge tone="outline">{pt ? 'Desconhecida' : 'Unknown'}</Badge>
                  ),
              },
              {
                key: 'reset',
                header: pt ? 'Próxima renovação' : 'Next reset',
                render: (q) => formatTimestamp(q.resetAt, language),
              },
            ]}
            rows={quotaBreakdowns.slice(0, 8)}
            rowKey={(q) => q.quotaId}
          />
        )}
      </div>

      {/* Expiring Credits, Upcoming Renewals & Fallback History */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 className="db-section-title">
            {pt
              ? 'Créditos próximos de expirar e próximas renovações'
              : 'Expiring credits & upcoming renewals'}
          </h3>
          {expiringCredits.length === 0 && upcomingRenewals.length === 0 ? (
            <div className="db-muted" style={{ fontSize: 12 }}>
              {pt
                ? 'Nenhum crédito próximo do vencimento nem janela de renovação pendente registrada.'
                : 'No expiring credits or pending quota resets.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              {expiringCredits.map((cr) => (
                <div
                  key={cr.accountId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '5px 8px',
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.warningSubtle,
                  }}
                >
                  <span>
                    <ShieldAlert size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    <strong>{cr.accountId}</strong>:{' '}
                    {cr.amount !== null ? `${cr.currency} ${cr.amount.toFixed(2)}` : 'Desconhecido'}
                  </span>
                  <span className="db-mono">
                    {pt ? 'Expira: ' : 'Expires: '}
                    {formatTimestamp(cr.expiresAt, language)}
                  </span>
                </div>
              ))}
              {upcomingRenewals.map((rn) => (
                <div
                  key={rn.quotaId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '5px 8px',
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.surfaceElevated,
                  }}
                >
                  <span className="db-mono">
                    {rn.windowLabel} ({rn.scopeId})
                  </span>
                  <span className="db-mono db-muted">{formatTimestamp(rn.resetAt, language)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="db-card-header" style={{ marginBottom: 0 }}>
            <h3 className="db-section-title">
              <Activity size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />
              {pt ? 'Histórico recente de fallback e falhas' : 'Recent fallback & failure history'}
            </h3>
            <Button size="xs" variant="ghost" onClick={() => onNavigateTab('diagnostics')}>
              {pt ? 'Diagnóstico →' : 'Diagnostics →'}
            </Button>
          </div>
          {recentFallbacks.length === 0 ? (
            <EmptyState
              title={pt ? 'Sem eventos de fallback registrados' : 'No fallback attempts recorded'}
              description={
                pt
                  ? 'Tentativas de inferência com troca automática de rota ou erro de provedor aparecem aqui.'
                  : 'Route failover events appear here.'
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5 }}>
              {recentFallbacks.map((fb, idx) => (
                <div
                  key={`${fb.requestId}:${idx}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '5px 8px',
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.surfaceElevated,
                  }}
                >
                  <div>
                    <Badge tone={fb.code === 'OK' ? 'success' : 'danger'} mono>
                      {fb.code}
                    </Badge>{' '}
                    <span className="db-mono">{fb.routeId}</span> —{' '}
                    <span className="db-muted">{fb.message.slice(0, 80)}</span>
                  </div>
                  <span className="db-mono db-faint">{formatTimestamp(fb.endedAt, language)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
