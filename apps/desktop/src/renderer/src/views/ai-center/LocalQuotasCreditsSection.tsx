import { useEffect, useMemo, useState } from 'react';
import type {
  Agent,
  ApplicationSettings,
  BudgetStatus,
  Project,
  QuotaForecast,
  UsageSummary,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  Input,
  Select,
  tokens,
} from '@devbrain/ui';
import {
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  LOCAL_MODEL_REFERENCE_CATALOG,
  callAiChannel,
  computeQuotaBreakdown,
  estimateLocalFeasibility,
  formatBytesGiB,
  summarizeUsageRecords,
  type AiResourceSnapshot,
  type QuotaWindowLabel,
} from '../../lib/ai-center';
import { formatTimestamp, type AppLanguage } from '../../lib/i18n';

export interface ActivePullState {
  operationId: string;
  runtimeId: string;
  modelId: string;
  completed: number;
  total: number | null;
}

export interface LocalModelsSectionProps {
  snapshot: AiResourceSnapshot;
  activePulls: Readonly<Record<string, ActivePullState>>;
  onStartPull: (pull: ActivePullState) => void;
  onRemovePull: (operationId: string) => void;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

export const LocalModelsSection = ({
  snapshot,
  activePulls,
  onStartPull,
  onRemovePull,
  onRefreshAll,
  language,
}: LocalModelsSectionProps) => {
  const pt = language === 'pt-BR';
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>(
    snapshot.localRuntimes[0]?.id ?? 'ollama',
  );
  const [customPullTag, setCustomPullTag] = useState('');
  const [consentTarget, setConsentTarget] = useState<{
    runtimeId: string;
    modelTag: string;
    approxBytes: number | null;
  } | null>(null);
  const [confirmDownload, setConfirmDownload] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<{ runtimeId: string; modelId: string } | null>(
    null,
  );
  const [confirmRemove, setConfirmRemove] = useState(false);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'info' | 'success' | 'danger';
    text: string;
  } | null>(null);

  // Latest measured hardware profile from real benchmarks (never invented!)
  const latestHardware = snapshot.benchmarks[0]?.hardware ?? null;
  const browserCores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : null;

  const installedList = useMemo(
    () => snapshot.localModels[selectedRuntimeId] ?? [],
    [selectedRuntimeId, snapshot.localModels],
  );
  const totalDiskBytes = useMemo(
    () => installedList.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0),
    [installedList],
  );

  const handleConfirmPull = async () => {
    if (!consentTarget || !confirmDownload) return;
    setFeedback(null);
    setBusy(true);
    try {
      const res = await callAiChannel('ai.local.pull', {
        runtimeId: consentTarget.runtimeId,
        modelId: consentTarget.modelTag,
        confirm: true,
      });
      if (res.status === 'ok') {
        onStartPull({
          operationId: res.data.operationId,
          runtimeId: consentTarget.runtimeId,
          modelId: consentTarget.modelTag,
          completed: 0,
          total: consentTarget.approxBytes,
        });
        setFeedback({
          tone: 'info',
          text: pt
            ? `Download iniciado (${res.data.operationId}) para ${consentTarget.modelTag}.`
            : `Started pull ${res.data.operationId}.`,
        });
      } else {
        setFeedback({
          tone: 'danger',
          text: res.status === 'unsupported' ? res.message : res.error.message,
        });
      }
      setConsentTarget(null);
      setConfirmDownload(false);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelPull = async (operationId: string) => {
    const res = await callAiChannel('ai.local.cancelPull', { operationId });
    onRemovePull(operationId);
    if (res.status === 'ok') {
      setFeedback({
        tone: 'info',
        text: pt ? 'Download cancelado pelo usuário.' : 'Download cancelled.',
      });
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget || !confirmRemove) return;
    setFeedback(null);
    setBusy(true);
    try {
      const res = await callAiChannel('ai.local.remove', {
        runtimeId: removeTarget.runtimeId,
        modelId: removeTarget.modelId,
        confirm: true,
      });
      if (res.status === 'ok') {
        await onRefreshAll();
        setFeedback({
          tone: 'success',
          text: pt ? `Modelo local "${removeTarget.modelId}" removido.` : 'Local model removed.',
        });
      } else {
        setFeedback({
          tone: 'danger',
          text: res.status === 'unsupported' ? res.message : res.error.message,
        });
      }
      setRemoveTarget(null);
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };

  const handleBenchmarkTest = async (runtimeId: string, modelId: string) => {
    setFeedback(null);
    setBusy(true);
    try {
      const res = await callAiChannel('ai.local.benchmark', { runtimeId, modelId });
      if (res.status === 'ok') {
        await onRefreshAll();
        setFeedback({
          tone: 'success',
          text: pt
            ? `Teste local concluído: ${res.data.tokensPerSecond?.toFixed(1) ?? '—'} tok/s · TTFT ${res.data.timeToFirstTokenMs ?? '—'} ms.`
            : 'Local benchmark succeeded.',
        });
      } else {
        setFeedback({
          tone: 'info',
          text:
            res.status === 'unsupported'
              ? pt
                ? 'Execução de benchmark local (ai.local.benchmark) respondeu UNSUPPORTED — aguardando integração do laboratório de benchmarks (bloco Claude).'
                : res.message
              : res.error.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {feedback ? (
        <Banner
          tone={feedback.tone}
          actions={
            <Button size="xs" variant="ghost" onClick={() => setFeedback(null)}>
              ×
            </Button>
          }
        >
          {feedback.text}
        </Banner>
      ) : null}

      {/* Runtimes + Hardware Profile */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="db-card-header" style={{ marginBottom: 0 }}>
            <h3 className="db-section-title">
              <Cpu size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {pt ? 'Runtimes locais detectados e instalação oficial' : 'Detected local runtimes'}
            </h3>
            <Button
              size="xs"
              variant="secondary"
              icon={<RefreshCw size={12} />}
              onClick={() => void onRefreshAll()}
            >
              {pt ? 'Detectar runtimes' : 'Detect'}
            </Button>
          </div>

          {snapshot.localRuntimes.length === 0 ? (
            <div className="db-muted" style={{ fontSize: 12 }}>
              {pt
                ? 'Nenhum runtime local reportado ainda. Instale Ollama ou LM Studio pelos links oficiais abaixo para inferência 100% offline/loopback.'
                : 'No local runtime detected yet.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {snapshot.localRuntimes.map((rt) => (
                <div
                  key={rt.id}
                  onClick={() => setSelectedRuntimeId(rt.id)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '7px 10px',
                    borderRadius: tokens.radius.sm,
                    border: `1px solid ${selectedRuntimeId === rt.id ? tokens.color.accent : tokens.color.border}`,
                    background: tokens.color.surfaceElevated,
                    cursor: 'pointer',
                  }}
                >
                  <div>
                    <strong>{rt.id}</strong> ({rt.kind}) —{' '}
                    <span className="db-mono" style={{ fontSize: 11.5 }}>
                      {rt.endpoint}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {rt.version ? (
                      <Badge tone="outline" mono>
                        v{rt.version}
                      </Badge>
                    ) : null}
                    <Badge
                      tone={
                        rt.status === 'available'
                          ? 'success'
                          : rt.status === 'unavailable'
                            ? 'danger'
                            : 'outline'
                      }
                      dot
                    >
                      {rt.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 4 }}>
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
              style={{
                color: tokens.color.accent,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>{pt ? 'Instalar Ollama (oficial)' : 'Install Ollama'}</span>
              <ExternalLink size={11} />
            </a>
            <a
              href="https://lmstudio.ai"
              target="_blank"
              rel="noreferrer"
              style={{
                color: tokens.color.accent,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>{pt ? 'Instalar LM Studio (oficial)' : 'Install LM Studio'}</span>
              <ExternalLink size={11} />
            </a>
          </div>
        </div>

        <div
          className="db-card"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}
        >
          <h3 className="db-section-title">
            <HardDrive size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {pt ? 'Hardware observado e uso de disco' : 'Observed hardware & disk'}
          </h3>
          <div>
            <span className="db-muted">CPU: </span>
            <strong>{latestHardware?.cpuCores ?? browserCores ?? 'Desconhecido'} threads</strong>
          </div>
          <div>
            <span className="db-muted">RAM: </span>
            <strong>
              {latestHardware
                ? formatBytesGiB(latestHardware.memoryBytes)
                : pt
                  ? 'Não medida'
                  : 'Unmeasured'}
            </strong>
          </div>
          <div>
            <span className="db-muted">GPU / VRAM: </span>
            <strong>
              {latestHardware?.gpuName
                ? `${latestHardware.gpuName} (${formatBytesGiB(latestHardware.gpuMemoryBytes)})`
                : pt
                  ? 'Não reportada pelo runtime'
                  : 'Unreported'}
            </strong>
          </div>
          <div>
            <span className="db-muted">
              {pt ? 'Uso de disco pelos modelos locais: ' : 'Local models disk: '}
            </span>
            <strong className="db-mono">{formatBytesGiB(totalDiskBytes)}</strong>
          </div>
          <div className="db-faint" style={{ fontSize: 11 }}>
            {pt
              ? 'Importante: recomendações de viabilidade abaixo são ESTIMATIVAS baseadas em quantização, nunca garantias de execução.'
              : 'Feasibility notes are ESTIMATES, never execution guarantees.'}
          </div>
        </div>
      </div>

      {/* Active Downloads with Progress & Cancel */}
      {Object.values(activePulls).length > 0 ? (
        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 className="db-section-title">
            {pt ? 'Downloads de modelos em andamento' : 'Active model downloads'}
          </h4>
          {Object.values(activePulls).map((pull) => {
            const pct =
              pull.total && pull.total > 0
                ? Math.min(100, Math.round((pull.completed / pull.total) * 100))
                : null;
            return (
              <div
                key={pull.operationId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 10px',
                  background: tokens.color.surfaceElevated,
                  borderRadius: tokens.radius.sm,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <strong className="db-mono">{pull.modelId}</strong>
                    <span className="db-mono">
                      {formatBytesGiB(pull.completed)} / {formatBytesGiB(pull.total)}
                      {pct !== null ? ` (${pct}%)` : ''}
                    </span>
                  </div>
                  {pct !== null ? (
                    <div
                      style={{
                        height: 5,
                        marginTop: 5,
                        background: tokens.color.border,
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: tokens.color.accent,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  variant="danger"
                  icon={<Square size={11} />}
                  onClick={() => void handleCancelPull(pull.operationId)}
                >
                  {pt ? 'Cancelar' : 'Cancel'}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Installed Local Models */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 className="db-section-title">
          {pt
            ? `Modelos instalados (${installedList.length})`
            : `Installed local models (${installedList.length})`}
        </h3>
        <DataTable
          columns={[
            {
              key: 'model',
              header: pt ? 'Modelo' : 'Model',
              render: (m) => <strong className="db-mono">{m.modelId}</strong>,
            },
            {
              key: 'size',
              header: pt ? 'Tamanho em disco' : 'Disk size',
              render: (m) => <span className="db-mono">{formatBytesGiB(m.sizeBytes)}</span>,
            },
            {
              key: 'digest',
              header: 'Digest',
              render: (m) => (
                <span className="db-mono db-faint">{m.digest ? m.digest.slice(0, 16) : '—'}</span>
              ),
            },
            {
              key: 'installedAt',
              header: pt ? 'Instalado em' : 'Installed',
              render: (m) => formatTimestamp(m.installedAt, language),
            },
            {
              key: 'actions',
              header: '',
              render: (m) => (
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={<Play size={11} />}
                    loading={busy}
                    onClick={() => void handleBenchmarkTest(m.runtimeId, m.modelId)}
                  >
                    {pt ? 'Executar teste' : 'Test'}
                  </Button>
                  <Button
                    size="xs"
                    variant="danger"
                    icon={<Trash2 size={11} />}
                    onClick={() => {
                      setConfirmRemove(false);
                      setRemoveTarget({ runtimeId: m.runtimeId, modelId: m.modelId });
                    }}
                  >
                    {pt ? 'Remover' : 'Remove'}
                  </Button>
                </div>
              ),
            },
          ]}
          rows={installedList}
          rowKey={(m) => m.id}
          emptyMessage={
            pt
              ? 'Nenhum modelo local instalado neste runtime.'
              : 'No local models installed in this runtime.'
          }
        />
      </div>

      {/* Reference Local Models for Explicit User-Approved Pull */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <h3 className="db-section-title">
            {pt
              ? 'Modelos locais disponíveis para download (exige consentimento explícito)'
              : 'Available local models (explicit consent required)'}
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input
              mono
              value={customPullTag}
              placeholder="ex.: codestral:22b"
              onChange={(e) => setCustomPullTag(e.target.value)}
              style={{ width: 200, height: 28 }}
            />
            <Button
              size="xs"
              variant="primary"
              icon={<Download size={12} />}
              disabled={!customPullTag.trim()}
              onClick={() => {
                setConfirmDownload(false);
                setConsentTarget({
                  runtimeId: selectedRuntimeId,
                  modelTag: customPullTag.trim(),
                  approxBytes: null,
                });
              }}
            >
              {pt ? 'Baixar tag…' : 'Pull tag…'}
            </Button>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: 'name',
              header: pt ? 'Modelo / Tag' : 'Model / Tag',
              render: (spec) => (
                <div>
                  <strong>{spec.displayName}</strong>{' '}
                  {spec.codingFocused ? <Badge tone="info">Código</Badge> : null}
                  <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                    {spec.modelTag}
                  </div>
                </div>
              ),
            },
            {
              key: 'quant',
              header: pt ? 'Quantização / Contexto' : 'Quant / Context',
              render: (spec) => (
                <span className="db-mono">
                  {spec.quantization} · {spec.contextTokens.toLocaleString(language)} tok
                </span>
              ),
            },
            {
              key: 'size',
              header: pt ? 'Tamanho estimado' : 'Est. download',
              render: (spec) => (
                <span className="db-mono">~{formatBytesGiB(spec.approxBytes)}</span>
              ),
            },
            {
              key: 'feasibility',
              header: pt ? 'Viabilidade estimada (RAM / VRAM)' : 'Estimated feasibility',
              render: (spec) => {
                const est = estimateLocalFeasibility({
                  modelSizeBytes: spec.approxBytes,
                  systemMemoryBytes: latestHardware?.memoryBytes ?? null,
                  gpuMemoryBytes: latestHardware?.gpuMemoryBytes ?? null,
                });
                return (
                  <div style={{ fontSize: 11 }}>
                    <Badge
                      tone={
                        est.tier === 'gpu-estimated'
                          ? 'success'
                          : est.tier === 'insufficient-estimated'
                            ? 'danger'
                            : 'outline'
                      }
                    >
                      {est.labelPt}
                    </Badge>
                    <div className="db-mono db-faint" style={{ marginTop: 2 }}>
                      est. VRAM ~{formatBytesGiB(est.requiredVramBytesEstimate)} · RAM ~
                      {formatBytesGiB(est.requiredRamBytesEstimate)}
                    </div>
                  </div>
                );
              },
            },
            {
              key: 'pull',
              header: '',
              render: (spec) => (
                <Button
                  size="xs"
                  variant="secondary"
                  icon={<Download size={12} />}
                  onClick={() => {
                    setConfirmDownload(false);
                    setConsentTarget({
                      runtimeId: selectedRuntimeId,
                      modelTag: spec.modelTag,
                      approxBytes: spec.approxBytes,
                    });
                  }}
                >
                  {pt ? 'Baixar…' : 'Download…'}
                </Button>
              ),
            },
          ]}
          rows={LOCAL_MODEL_REFERENCE_CATALOG}
          rowKey={(s) => s.modelTag}
        />
      </div>

      {/* Explicit Download Consent Dialog */}
      <Dialog
        open={consentTarget !== null}
        onClose={() => setConsentTarget(null)}
        title={pt ? 'Confirmar download de modelo local' : 'Confirm local model download'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConsentTarget(null)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              disabled={!confirmDownload}
              loading={busy}
              onClick={() => void handleConfirmPull()}
            >
              {pt ? 'Autorizar e iniciar download' : 'Confirm download'}
            </Button>
          </>
        }
      >
        {consentTarget ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Banner tone="warning">
              {pt
                ? `Modelo: ${consentTarget.modelTag} · Tamanho aproximado: ${consentTarget.approxBytes ? `~${formatBytesGiB(consentTarget.approxBytes)}` : 'desconhecido'}. Nenhum download volumoso é iniciado sem sua confirmação.`
                : `Model: ${consentTarget.modelTag}.`}
            </Banner>
            <Checkbox
              checked={confirmDownload}
              onChange={(e) => setConfirmDownload(e.target.checked)}
              label={
                pt
                  ? `Confirmo o download de "${consentTarget.modelTag}" para o runtime local "${consentTarget.runtimeId}".`
                  : `Confirm pulling "${consentTarget.modelTag}".`
              }
            />
          </div>
        ) : null}
      </Dialog>

      {/* Remove Local Model Confirmation Dialog */}
      <Dialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={pt ? 'Remover modelo local do disco' : 'Remove local model'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              disabled={!confirmRemove}
              loading={busy}
              onClick={() => void handleConfirmRemove()}
            >
              {pt ? 'Remover modelo' : 'Remove model'}
            </Button>
          </>
        }
      >
        {removeTarget ? (
          <Checkbox
            checked={confirmRemove}
            onChange={(e) => setConfirmRemove(e.target.checked)}
            label={
              pt
                ? `Confirmo a remoção dos pesos locais do modelo "${removeTarget.modelId}".`
                : `Confirm removing local model "${removeTarget.modelId}".`
            }
          />
        ) : null}
      </Dialog>
    </div>
  );
};

// ---------------------------------------------------------------------------
// §9 & §4 — Central de Cotas + Créditos e Orçamento
// ---------------------------------------------------------------------------

export interface QuotasAndCreditsSectionProps {
  mode: 'quotas' | 'credits';
  snapshot: AiResourceSnapshot;
  projects: readonly Project[];
  agents: readonly Agent[];
  settings: ApplicationSettings | null;
  activeProjectId: string | null;
  coreUsageDay: UsageSummary | null;
  coreUsageMonth: UsageSummary | null;
  onQueryAccountCredit: (accountId: string) => Promise<void>;
  language: AppLanguage;
}

export const QuotasAndCreditsSection = ({
  mode,
  snapshot,
  projects,
  agents,
  settings,
  activeProjectId,
  coreUsageDay,
  coreUsageMonth,
  onQueryAccountCredit,
  language,
}: QuotasAndCreditsSectionProps) => {
  const pt = language === 'pt-BR';
  const [filterWindow, setFilterWindow] = useState<'all' | QuotaWindowLabel>('all');
  const [filterProjectId, setFilterProjectId] = useState<string>('all');
  const [filterConnectionId, setFilterConnectionId] = useState<string>('all');
  const [filterAgentId, setFilterAgentId] = useState<string>('all');
  const [filterModelId, setFilterModelId] = useState<string>('all');
  const [accountLookup, setAccountLookup] = useState('');
  const [budgetStatuses, setBudgetStatuses] = useState<BudgetStatus[]>([]);
  const [forecasts, setForecasts] = useState<Record<string, QuotaForecast>>({});

  useEffect(() => {
    let cancelled = false;
    if (mode === 'credits') {
      void callAiChannel('ai.budget.status', {
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      }).then((out) => {
        if (!cancelled) setBudgetStatuses(out.status === 'ok' ? out.data : []);
      });
    } else {
      void Promise.all(
        snapshot.quotas.slice(0, 30).map(async (quota) => {
          const out = await callAiChannel('ai.quota.forecast', { quotaId: quota.id });
          return [quota.id, out.status === 'ok' ? out.data : null] as const;
        }),
      ).then((entries) => {
        if (!cancelled)
          setForecasts(
            Object.fromEntries(entries.filter((entry) => entry[1] !== null)) as Record<
              string,
              QuotaForecast
            >,
          );
      });
    }
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, mode, snapshot.quotas]);

  const allBreakdowns = useMemo(
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

  const filteredQuotas = useMemo(() => {
    return allBreakdowns.filter((q) => {
      if (filterWindow !== 'all' && q.windowLabel !== filterWindow) return false;
      if (filterProjectId !== 'all' && q.scope === 'project' && q.scopeId !== filterProjectId) {
        return false;
      }
      if (filterConnectionId !== 'all') {
        const conn = snapshot.connections.find((c) => c.id === filterConnectionId);
        if (
          conn &&
          q.scopeId !== conn.id &&
          q.scopeId !== conn.providerId &&
          q.scopeId !== conn.endpointId
        ) {
          return false;
        }
      }
      if (filterModelId !== 'all' && q.scope === 'model' && q.scopeId !== filterModelId) {
        return false;
      }
      return true;
    });
  }, [
    allBreakdowns,
    filterConnectionId,
    filterModelId,
    filterProjectId,
    filterWindow,
    snapshot.connections,
  ]);

  const gatewayUsage = useMemo(
    () => summarizeUsageRecords(snapshot.recentUsage),
    [snapshot.recentUsage],
  );

  if (mode === 'credits') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          className="db-card"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <Field
              label={
                pt ? 'Consultar saldo observado de conta (accountId)' : 'Lookup account credit'
              }
              hint={
                pt
                  ? 'Exibe apenas saldos reportados pelo provedor ou declarados pelo usuário; nunca estima saldos.'
                  : 'Shows only provider-reported or user-entered credit balances.'
              }
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={accountLookup}
                  placeholder="acc-openrouter-main"
                  onChange={(e) => setAccountLookup(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!accountLookup.trim()}
            onClick={() => void onQueryAccountCredit(accountLookup.trim())}
          >
            {pt ? 'Consultar saldo' : 'Query balance'}
          </Button>
        </div>

        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 className="db-section-title">
            {pt ? 'Saldos de créditos observados' : 'Observed credit balances'}
          </h3>
          <DataTable
            columns={[
              {
                key: 'acc',
                header: pt ? 'Conta' : 'Account',
                render: (c) => <strong className="db-mono">{c.accountId}</strong>,
              },
              {
                key: 'amount',
                header: pt ? 'Saldo disponível' : 'Balance',
                render: (c) =>
                  c.amount !== null ? (
                    <Badge tone="success" mono>
                      {c.currency} {c.amount.toFixed(4)}
                    </Badge>
                  ) : (
                    <Badge tone="outline">{pt ? 'Desconhecido' : 'Unknown'}</Badge>
                  ),
              },
              {
                key: 'source',
                header: pt ? 'Origem' : 'Source',
                render: (c) => <Badge tone="neutral">{c.source}</Badge>,
              },
              {
                key: 'expires',
                header: pt ? 'Expiração' : 'Expires',
                render: (c) => formatTimestamp(c.expiresAt, language),
              },
              {
                key: 'observed',
                header: pt ? 'Última atualização' : 'Observed at',
                render: (c) => formatTimestamp(c.observedAt, language),
              },
            ]}
            rows={snapshot.credits}
            rowKey={(c) => c.accountId}
            emptyMessage={
              pt ? 'Nenhum saldo de crédito registrado.' : 'No credit balances recorded.'
            }
          />
        </div>

        <div
          className="db-card"
          style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}
        >
          <h3 className="db-section-title">
            {pt ? 'Orçamento global e consumo real por moeda' : 'Global budget & measured spend'}
          </h3>
          <div>
            <span className="db-muted">{pt ? 'Teto configurado: ' : 'Ceiling: '}</span>
            <strong className="db-mono">
              {settings?.budget.currency ?? 'USD'} {pt ? 'dia=' : 'day='}
              {settings?.budget.maxPerDay ?? (pt ? 'sem teto' : 'unlimited')} ·{' '}
              {pt ? 'mês=' : 'month='}
              {settings?.budget.maxPerMonth ?? (pt ? 'sem teto' : 'unlimited')}
            </strong>
          </div>
          <div>
            <span className="db-muted">{pt ? 'Consumo Core (dia / mês): ' : 'Core spend: '}</span>
            <span>
              {coreUsageDay?.executions ?? 0} exec. hoje ({coreUsageDay?.unknownCostExecutions ?? 0}{' '}
              sem custo informado) · {coreUsageMonth?.executions ?? 0} exec. no mês
            </span>
          </div>
          <div>
            <span className="db-muted">
              {pt ? 'Consumo Gateway por moeda: ' : 'Gateway spend: '}
            </span>
            <span>
              {Object.keys(gatewayUsage.byCurrency).length > 0
                ? Object.entries(gatewayUsage.byCurrency)
                    .map(([cur, v]) => `${cur} ${v.totalCost.toFixed(4)} (${v.requests} req)`)
                    .join(' · ')
                : pt
                  ? 'Nenhum custo monetário registrado'
                  : 'No monetary charges recorded'}
            </span>
          </div>
          {budgetStatuses.map((status) => (
            <div key={`${status.scope}:${status.scopeId}`}>
              <span className="db-muted">
                {status.scope} ({status.scopeId}):{' '}
              </span>
              <span className="db-mono">
                {status.currency} {(status.committedMicros / 1_000_000).toFixed(4)} +{' '}
                {(status.reservedMicros / 1_000_000).toFixed(4)} {pt ? 'reservado' : 'reserved'} /{' '}
                {status.limitMicros === null
                  ? pt
                    ? 'teto não definido'
                    : 'no ceiling'
                  : (status.limitMicros / 1_000_000).toFixed(4)}
              </span>
              {status.unknownCostRequests > 0 ? (
                <Badge tone="warning">
                  {status.unknownCostRequests} {pt ? 'custos desconhecidos' : 'unknown costs'}
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Filters by Window (RPM/RPD/TPM/TPD/Weekly/Monthly/Credits/Provider-Unit) + Project + Connection + Agent + Model */}
      <div
        className="db-card"
        style={{
          padding: 10,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8,
        }}
      >
        <Select
          value={filterWindow}
          onChange={(e) => setFilterWindow(e.target.value as 'all' | QuotaWindowLabel)}
        >
          <option value="all">{pt ? 'Período/Tipo: Todos' : 'Window: All'}</option>
          <option value="RPM">RPM (req/min)</option>
          <option value="RPD">RPD (req/dia)</option>
          <option value="TPM">TPM (tok/min)</option>
          <option value="TPD">TPD (tok/dia)</option>
          <option value="Semanal">{pt ? 'Limites semanais' : 'Weekly'}</option>
          <option value="Mensal">{pt ? 'Limites mensais' : 'Monthly'}</option>
          <option value="Créditos">{pt ? 'Créditos monetários' : 'Credits'}</option>
          <option value="Unidade do provedor">
            {pt ? 'Unidades do provedor' : 'Provider units'}
          </option>
        </Select>

        <Select value={filterProjectId} onChange={(e) => setFilterProjectId(e.target.value)}>
          <option value="all">{pt ? 'Projeto: Todos' : 'Project: All'}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>

        <Select value={filterConnectionId} onChange={(e) => setFilterConnectionId(e.target.value)}>
          <option value="all">{pt ? 'Conexão: Todas' : 'Connection: All'}</option>
          {snapshot.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
            </option>
          ))}
        </Select>

        <Select value={filterAgentId} onChange={(e) => setFilterAgentId(e.target.value)}>
          <option value="all">{pt ? 'Agente: Todos' : 'Agent: All'}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>

        <Select value={filterModelId} onChange={(e) => setFilterModelId(e.target.value)}>
          <option value="all">{pt ? 'Modelo: Todos' : 'Model: All'}</option>
          {snapshot.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>

      {/* Concurrency & Subscription Quotas Card */}
      <div
        className="db-card"
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}
      >
        <Badge tone="info" mono>
          {pt ? 'Concorrência global' : 'Global concurrency'}:{' '}
          {settings?.execution.maxConcurrentExecutions ?? 4}
        </Badge>
        <Badge tone="info" mono>
          {pt ? 'Concorrência por agente' : 'Per-agent concurrency'}:{' '}
          {settings?.execution.maxConcurrentPerAgent ?? 2}
        </Badge>
        <Badge tone="neutral">
          {pt
            ? 'Cotas de assinatura CLI (Codex / Claude / Antigravity): denominador não exposto pelos provedores — exibido como Desconhecido'
            : 'CLI subscription quotas: denominator unexposed — shown as Unknown'}
        </Badge>
      </div>

      <DataTable
        columns={[
          {
            key: 'window',
            header: pt ? 'Janela / Escopo compartilhado' : 'Window / Shared scope',
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
            key: 'used',
            header: pt ? 'Utilizado / Nominal' : 'Used / Nominal',
            render: (q) => (
              <span className="db-mono">
                {q.consumed !== null ? q.consumed.toLocaleString(language) : '—'} /{' '}
                {q.nominal !== null
                  ? q.nominal.toLocaleString(language)
                  : pt
                    ? 'Limite desconhecido'
                    : 'Unknown limit'}
              </span>
            ),
          },
          {
            key: 'reserved',
            header: pt ? 'Reservado / Incerto' : 'Reserved / Uncertain',
            render: (q) => (
              <span className="db-mono">
                {q.reserved} / {q.estimatedUncertain}
              </span>
            ),
          },
          {
            key: 'avail',
            header: pt ? 'Disponível' : 'Available',
            render: (q) =>
              q.available !== null ? (
                <Badge tone={q.available > 0 ? 'success' : 'danger'} mono>
                  {q.available.toLocaleString(language)}
                  {q.utilizationPercent !== null ? ` (${q.utilizationPercent}% usado)` : ''}
                </Badge>
              ) : (
                <Badge tone="outline">{pt ? 'Desconhecido (sem denominador)' : 'Unknown'}</Badge>
              ),
          },
          {
            key: 'meta',
            header: pt ? 'Origem · Renovação · Atualizado' : 'Origin · Reset · Updated',
            render: (q) => (
              <div style={{ fontSize: 11 }} className="db-muted">
                <div>
                  {pt ? 'Origem' : 'Source'}: {q.source}
                </div>
                <div>
                  {pt ? 'Renova' : 'Reset'}: {formatTimestamp(q.resetAt, language)}
                </div>
                <div>
                  {pt ? 'Observado' : 'Observed'}: {formatTimestamp(q.observedAt, language)}
                </div>
                {forecasts[q.quotaId] ? (
                  <div>
                    {pt ? 'Previsão' : 'Forecast'}:{' '}
                    {forecasts[q.quotaId]?.remaining ?? (pt ? 'desconhecida' : 'unknown')};{' '}
                    {pt ? 'renovação' : 'reset'}{' '}
                    {formatTimestamp(forecasts[q.quotaId]?.resetAt ?? null, language)} (
                    {forecasts[q.quotaId]?.resetBasis})
                  </div>
                ) : null}
              </div>
            ),
          },
        ]}
        rows={filteredQuotas}
        rowKey={(q) => q.quotaId}
        emptyMessage={
          pt
            ? 'Nenhuma definição de cota corresponde aos filtros selecionados. Limites desconhecidos nunca geram percentuais artificiais.'
            : 'No matching quota definitions.'
        }
      />
    </div>
  );
};
