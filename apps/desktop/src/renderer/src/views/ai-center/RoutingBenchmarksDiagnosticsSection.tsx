import { useEffect, useMemo, useState } from 'react';
import type {
  AgentSession,
  ApplicationSettings,
  BenchmarkResult,
  BenchmarkRun,
  CostRecord,
  ExplainedRoutingDecision,
  FallbackAttempt,
  HandoffPacket,
  ModelEvidence,
  ProviderPrivacyProfile,
  RoutingDecision,
  TaskCheckpoint,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Field,
  Input,
  Select,
  Textarea,
  UntrustedBlock,
  tokens,
} from '@devbrain/ui';
import {
  Activity,
  CheckCircle2,
  FlaskConical,
  GitBranch,
  Play,
  Plus,
  ShieldAlert,
  Square,
  Upload,
} from 'lucide-react';
import {
  AI_CHANNEL_KEYS,
  PRIVACY_CLASSIFICATIONS,
  buildPresetStrategy,
  callAiChannel,
  evaluateProviderEligibility,
  formatBytesGiB,
  toContractPolicies,
  validateStrategyGuardrails,
  type AiResourceSnapshot,
  type ProjectPrivacyClass,
  type StrategyDraft,
  type StrategyPresetId,
} from '../../lib/ai-center';
import { formatTimestamp, type AppLanguage } from '../../lib/i18n';

export interface RoutingStrategiesSectionProps {
  snapshot: AiResourceSnapshot;
  settings: ApplicationSettings | null;
  activeProjectId: string | null;
  projectPrivacy: ProjectPrivacyClass;
  onChangeProjectPrivacy: (next: ProjectPrivacyClass) => void;
  strategyDraft: StrategyDraft;
  onChangeStrategyDraft: (next: StrategyDraft) => void;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

const PRESET_LABELS: readonly { id: StrategyPresetId; pt: string; en: string }[] = [
  { id: 'free-only', pt: 'Somente gratuito', en: 'Free only' },
  { id: 'local-only', pt: 'Somente local', en: 'Local only' },
  { id: 'max-savings', pt: 'Economia máxima', en: 'Max savings' },
  { id: 'balanced', pt: 'Equilibrado', en: 'Balanced' },
  { id: 'max-quality', pt: 'Qualidade máxima', en: 'Max quality' },
  { id: 'custom', pt: 'Personalizado', en: 'Custom' },
];

export const RoutingStrategiesSection = ({
  snapshot,
  settings,
  activeProjectId,
  projectPrivacy,
  onChangeProjectPrivacy,
  strategyDraft,
  onChangeStrategyDraft,
  onRefreshAll,
  language,
}: RoutingStrategiesSectionProps) => {
  const pt = language === 'pt-BR';
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'info' | 'success' | 'danger';
    text: string;
  } | null>(null);

  // Route creation inputs
  const [newRouteModelId, setNewRouteModelId] = useState<string>(snapshot.models[0]?.id ?? '');
  const [newRouteConnId, setNewRouteConnId] = useState<string>(snapshot.connections[0]?.id ?? '');
  const [newRoutePriority, setNewRoutePriority] = useState<string>('10');
  const [newRouteLocalOnly, setNewRouteLocalOnly] = useState<boolean>(false);

  // Router dry-run explanation
  const [routerDecision, setRouterDecision] = useState<RoutingDecision | null>(null);
  const [routerExplanation, setRouterExplanation] = useState<ExplainedRoutingDecision | null>(null);
  const [privacyProfiles, setPrivacyProfiles] = useState<ProviderPrivacyProfile[]>([]);
  const [profileProviderId, setProfileProviderId] = useState('');
  const [profileTraining, setProfileTraining] = useState<'unknown' | 'no' | 'opt-out' | 'yes'>(
    'unknown',
  );
  const [profileRetention, setProfileRetention] = useState<
    'unknown' | 'none' | 'limited' | 'indefinite'
  >('unknown');
  const [profileCommercial, setProfileCommercial] = useState<'unknown' | 'allowed' | 'restricted'>(
    'unknown',
  );
  const [profileSourceUrl, setProfileSourceUrl] = useState('');
  const [profileConfirmed, setProfileConfirmed] = useState(false);

  useEffect(() => {
    let active = true;
    void callAiChannel('ai.privacyProfiles.list', {}).then((out) => {
      if (active && out.status === 'ok') setPrivacyProfiles(out.data);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleSavePrivacyProfile = async () => {
    if (!profileProviderId || !profileConfirmed || !/^https:\/\//i.test(profileSourceUrl)) return;
    const existing = privacyProfiles.find((profile) => profile.providerId === profileProviderId);
    const out = await callAiChannel('ai.privacyProfiles.save', {
      ...(existing?.sourceUrl === profileSourceUrl ? existing : {}),
      providerId: profileProviderId,
      trainingOnInputs: profileTraining,
      retention: profileRetention,
      commercialUse: profileCommercial,
      sourceUrl: profileSourceUrl,
      verifiedBy: 'user',
    });
    if (out.status === 'ok') {
      setPrivacyProfiles((prev) => [
        out.data,
        ...prev.filter((profile) => profile.providerId !== out.data.providerId),
      ]);
      setProfileConfirmed(false);
      setFeedback({
        tone: 'success',
        text: pt ? 'Perfil de privacidade salvo.' : 'Privacy profile saved.',
      });
    } else {
      setFeedback({
        tone: 'danger',
        text: out.status === 'unsupported' ? out.message : out.error.message,
      });
    }
  };
  const selectProfileProvider = (providerId: string) => {
    setProfileProviderId(providerId);
    const existing = privacyProfiles.find((profile) => profile.providerId === providerId);
    setProfileTraining((existing?.trainingOnInputs ?? 'unknown') as typeof profileTraining);
    setProfileRetention((existing?.retention ?? 'unknown') as typeof profileRetention);
    setProfileCommercial((existing?.commercialUse ?? 'unknown') as typeof profileCommercial);
    setProfileSourceUrl(existing?.sourceUrl ?? '');
    setProfileConfirmed(false);
  };

  const guardrails = useMemo(
    () =>
      validateStrategyGuardrails({
        draft: strategyDraft,
        projectPrivacy,
        globalMaxPerDay: settings?.budget.maxPerDay ?? null,
        globalAllowWithoutCostGuarantee: settings?.budget.allowWithoutCostGuarantee ?? false,
        routes: snapshot.routes,
        models: snapshot.models,
      }),
    [
      projectPrivacy,
      settings?.budget.allowWithoutCostGuarantee,
      settings?.budget.maxPerDay,
      snapshot.models,
      snapshot.routes,
      strategyDraft,
    ],
  );

  const handleApplyPolicies = async () => {
    if (!guardrails.valid) return;
    setFeedback(null);
    setBusy(true);
    try {
      const payload = toContractPolicies(strategyDraft);
      const res = await callAiChannel('ai.policies.configure', payload);
      if (res.status === 'ok') {
        await onRefreshAll();
        setFeedback({
          tone: 'success',
          text: pt
            ? `Estratégia "${strategyDraft.policyId}" aplicada no roteador com sucesso.`
            : 'Routing policy configured.',
        });
      } else {
        setFeedback({
          tone: res.status === 'unsupported' ? 'info' : 'danger',
          text:
            res.status === 'unsupported'
              ? pt
                ? 'Canal ai.policies.configure respondeu UNSUPPORTED nesta branch; as restrições superiores já estão validadas e preservadas localmente.'
                : res.message
              : res.error.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAddRoute = async () => {
    if (!newRouteModelId || !newRouteConnId) return;
    setFeedback(null);
    setBusy(true);
    try {
      const id = `rt-${newRouteModelId}-${newRouteConnId}`.slice(0, 120);
      const res = await callAiChannel('ai.routes.save', {
        id,
        modelId: newRouteModelId,
        connectionId: newRouteConnId,
        priority: Math.max(0, Number.parseInt(newRoutePriority, 10) || 10),
        enabled: true,
        localOnly: newRouteLocalOnly || strategyDraft.preset === 'local-only',
      });
      if (res.status === 'ok') {
        await onRefreshAll();
        setFeedback({ tone: 'success', text: pt ? 'Rota salva.' : 'Route saved.' });
      } else {
        setFeedback({
          tone: 'danger',
          text: res.status === 'unsupported' ? res.message : res.error.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateRouter = async () => {
    if (!activeProjectId) return;
    setFeedback(null);
    setRouterDecision(null);
    setRouterExplanation(null);
    setBusy(true);
    try {
      const reqId = `dryrun-${Date.now()}`;
      const request = {
        id: reqId,
        sessionId: null,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
        modelId: null,
        messages: [{ role: 'user' as const, content: 'Inspecionar decisão do roteador.' }],
        maxOutputTokens: 256,
        temperature: 0,
        stream: false,
        routingPolicyId: strategyDraft.policyId,
        idempotencyKey: null,
      };
      const [res, explanation] = await Promise.all([
        callAiChannel('ai.routes.select', request),
        callAiChannel('ai.routes.explain', request),
      ]);
      setRouterExplanation(explanation.status === 'ok' ? explanation.data : null);
      if (res.status === 'ok') {
        setRouterDecision(res.data);
      } else {
        setFeedback({
          tone: 'info',
          text:
            res.status === 'unsupported'
              ? pt
                ? 'A inspeção de rotas não está disponível nesta instalação.'
                : res.message
              : res.error.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const privacySpec = PRIVACY_CLASSIFICATIONS[projectPrivacy];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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

      {/* Project Privacy Classification & Mandatory Disclosures (§14) */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div>
            <h3 className="db-section-title">
              {pt
                ? 'Classificação de privacidade do projeto ativo e elegibilidade de provedores'
                : 'Project privacy classification & provider eligibility'}
            </h3>
            <div className="db-muted" style={{ fontSize: 12 }}>
              {pt ? privacySpec.summaryPt : privacySpec.summaryEn}
            </div>
          </div>

          <Select
            aria-label={pt ? 'Classificação de privacidade' : 'Privacy classification'}
            value={projectPrivacy}
            onChange={(e) => {
              const nextPriv = e.target.value as ProjectPrivacyClass;
              onChangeProjectPrivacy(nextPriv);
              if (nextPriv === 'restricted') {
                onChangeStrategyDraft(buildPresetStrategy('local-only', strategyDraft));
              }
            }}
            style={{ width: 250 }}
          >
            {Object.values(PRIVACY_CLASSIFICATIONS).map((spec) => (
              <option key={spec.id} value={spec.id}>
                {pt ? spec.labelPt : spec.labelEn}
              </option>
            ))}
          </Select>
        </div>

        <Banner tone="warning" icon={<ShieldAlert size={15} />}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {privacySpec.warningsPt.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      </div>

      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 className="db-section-title">
          {pt ? 'Fatos de privacidade verificados por provedor' : 'Verified provider privacy facts'}
        </h3>
        <DataTable
          columns={[
            { key: 'provider', header: pt ? 'Provedor' : 'Provider', render: (p) => p.providerId },
            {
              key: 'training',
              header: pt ? 'Treinamento' : 'Training',
              render: (p) => p.trainingOnInputs,
            },
            { key: 'retention', header: pt ? 'Retenção' : 'Retention', render: (p) => p.retention },
            { key: 'source', header: pt ? 'Fonte' : 'Source', render: (p) => p.sourceUrl ?? '—' },
          ]}
          rows={privacyProfiles}
          rowKey={(profile) => profile.providerId}
          emptyMessage={pt ? 'Nenhum fato verificado.' : 'No verified facts.'}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 8,
          }}
        >
          <Field label={pt ? 'Provedor' : 'Provider'}>
            {(props) => (
              <Select
                {...props}
                value={profileProviderId}
                onChange={(e) => selectProfileProvider(e.target.value)}
              >
                <option value="">{pt ? 'Selecione' : 'Select'}</option>
                {snapshot.catalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={pt ? 'Uso para treinamento' : 'Training on inputs'}>
            {(props) => (
              <Select
                {...props}
                value={profileTraining}
                onChange={(e) => setProfileTraining(e.target.value as typeof profileTraining)}
              >
                <option value="unknown">{pt ? 'Desconhecido' : 'Unknown'}</option>
                <option value="no">{pt ? 'Não' : 'No'}</option>
                <option value="opt-out">Opt-out</option>
                <option value="yes">{pt ? 'Sim' : 'Yes'}</option>
              </Select>
            )}
          </Field>
          <Field label={pt ? 'Retenção' : 'Retention'}>
            {(props) => (
              <Select
                {...props}
                value={profileRetention}
                onChange={(e) => setProfileRetention(e.target.value as typeof profileRetention)}
              >
                <option value="unknown">{pt ? 'Desconhecida' : 'Unknown'}</option>
                <option value="none">{pt ? 'Nenhuma' : 'None'}</option>
                <option value="limited">{pt ? 'Limitada' : 'Limited'}</option>
                <option value="indefinite">{pt ? 'Indefinida' : 'Indefinite'}</option>
              </Select>
            )}
          </Field>
          <Field label={pt ? 'Uso comercial' : 'Commercial use'}>
            {(props) => (
              <Select
                {...props}
                value={profileCommercial}
                onChange={(e) => setProfileCommercial(e.target.value as typeof profileCommercial)}
              >
                <option value="unknown">{pt ? 'Desconhecido' : 'Unknown'}</option>
                <option value="allowed">{pt ? 'Permitido' : 'Allowed'}</option>
                <option value="restricted">{pt ? 'Restrito' : 'Restricted'}</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label={pt ? 'URL oficial que comprova os fatos' : 'Official supporting URL'}>
          {(props) => (
            <Input
              {...props}
              value={profileSourceUrl}
              onChange={(e) => setProfileSourceUrl(e.target.value)}
              placeholder="https://..."
            />
          )}
        </Field>
        <Checkbox
          checked={profileConfirmed}
          onChange={(e) => setProfileConfirmed(e.target.checked)}
          label={
            pt
              ? 'Li a fonte e confirmei os fatos informados.'
              : 'I read the source and verified these facts.'
          }
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={
            !profileProviderId || !profileConfirmed || !/^https:\/\//i.test(profileSourceUrl)
          }
          onClick={() => void handleSavePrivacyProfile()}
        >
          {pt ? 'Salvar fatos verificados' : 'Save verified facts'}
        </Button>
      </div>

      {/* Execution Strategy Presets (§11) */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="db-card-header" style={{ marginBottom: 0 }}>
          <h3 className="db-section-title">
            {pt ? 'Modo de estratégia de execução' : 'Execution strategy preset'}
          </h3>
          <Button
            size="sm"
            variant="primary"
            disabled={!guardrails.valid}
            loading={busy}
            onClick={() => void handleApplyPolicies()}
          >
            {pt ? 'Aplicar estratégia no roteador' : 'Apply routing policy'}
          </Button>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESET_LABELS.map((pr) => (
            <Button
              key={pr.id}
              size="sm"
              variant={strategyDraft.preset === pr.id ? 'primary' : 'secondary'}
              onClick={() =>
                onChangeStrategyDraft(
                  buildPresetStrategy(pr.id, {
                    ...strategyDraft,
                    privacyMode:
                      projectPrivacy === 'restricted' ? 'local-only' : strategyDraft.privacyMode,
                  }),
                )
              }
            >
              {pt ? pr.pt : pr.en}
            </Button>
          ))}
        </div>

        {!guardrails.valid ? (
          <Banner
            tone="danger"
            title={
              pt
                ? 'Combinação bloqueada por política superior de segurança / privacidade / orçamento'
                : 'Blocked by upper security/privacy/budget policy'
            }
          >
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {guardrails.violationsPt.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 10,
          }}
        >
          <Field label={pt ? 'Algoritmo do roteador' : 'Router strategy'}>
            {(props) => (
              <Select
                {...props}
                value={strategyDraft.strategy}
                onChange={(e) =>
                  onChangeStrategyDraft({
                    ...strategyDraft,
                    preset: 'custom',
                    strategy: e.target.value as StrategyDraft['strategy'],
                  })
                }
              >
                <option value="priority">priority</option>
                <option value="lowest-known-cost">lowest-known-cost</option>
                <option value="lowest-latency">lowest-latency</option>
                <option value="local-first">local-first</option>
              </Select>
            )}
          </Field>

          <Field label={pt ? 'Modo de privacidade' : 'Privacy mode'}>
            {(props) => (
              <Select
                {...props}
                disabled={strategyDraft.preset === 'local-only' || projectPrivacy === 'restricted'}
                value={strategyDraft.privacyMode}
                onChange={(e) =>
                  onChangeStrategyDraft({
                    ...strategyDraft,
                    preset: 'custom',
                    privacyMode: e.target.value as StrategyDraft['privacyMode'],
                  })
                }
              >
                <option value="local-only">local-only</option>
                <option value="approved-providers">approved-providers</option>
                <option value="any-configured">any-configured</option>
              </Select>
            )}
          </Field>

          <Field label={pt ? 'Tentativas máx. (fallback)' : 'Max attempts'}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={10}
                value={String(strategyDraft.maxAttempts)}
                onChange={(e) =>
                  onChangeStrategyDraft({
                    ...strategyDraft,
                    maxAttempts: Math.max(
                      1,
                      Math.min(10, Number.parseInt(e.target.value, 10) || 1),
                    ),
                  })
                }
              />
            )}
          </Field>

          <Field label={pt ? 'Teto por requisição' : 'Max cost / req'}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                step="0.01"
                disabled={
                  strategyDraft.preset === 'free-only' || strategyDraft.preset === 'local-only'
                }
                value={
                  strategyDraft.maxCostPerRequest !== null
                    ? String(strategyDraft.maxCostPerRequest)
                    : ''
                }
                onChange={(e) =>
                  onChangeStrategyDraft({
                    ...strategyDraft,
                    maxCostPerRequest: e.target.value.trim() ? Number(e.target.value) : null,
                  })
                }
              />
            )}
          </Field>

          <Field label={pt ? 'Teto diário da estratégia' : 'Max cost / day'}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                step="0.01"
                disabled={
                  strategyDraft.preset === 'free-only' || strategyDraft.preset === 'local-only'
                }
                value={
                  strategyDraft.maxCostPerDay !== null ? String(strategyDraft.maxCostPerDay) : ''
                }
                onChange={(e) =>
                  onChangeStrategyDraft({
                    ...strategyDraft,
                    maxCostPerDay: e.target.value.trim() ? Number(e.target.value) : null,
                  })
                }
              />
            )}
          </Field>
        </div>

        <Field
          label={
            pt
              ? 'Provedores autorizados (IDs separados por vírgula para approved-providers)'
              : 'Approved provider IDs (comma separated)'
          }
        >
          {(props) => (
            <Input
              {...props}
              mono
              disabled={strategyDraft.privacyMode === 'local-only'}
              value={strategyDraft.allowedProviderIds.join(', ')}
              placeholder="ollama, openrouter, openai"
              onChange={(e) =>
                onChangeStrategyDraft({
                  ...strategyDraft,
                  allowedProviderIds: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          )}
        </Field>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 8,
          }}
        >
          <Checkbox
            checked={strategyDraft.allowPaid}
            disabled={strategyDraft.preset === 'free-only' || strategyDraft.preset === 'local-only'}
            onChange={(e) =>
              onChangeStrategyDraft({
                ...strategyDraft,
                preset: 'custom',
                allowPaid: e.target.checked,
              })
            }
            label={pt ? 'Permitir rotas pagas tarifadas' : 'Allow metered paid routes'}
          />
          <Checkbox
            checked={strategyDraft.requireTools}
            onChange={(e) =>
              onChangeStrategyDraft({ ...strategyDraft, requireTools: e.target.checked })
            }
            label={pt ? 'Exigir suporte a Tool Calling' : 'Require tool calling'}
          />
          <Checkbox
            checked={strategyDraft.prioritizeSubscriptions}
            disabled={strategyDraft.preset === 'local-only'}
            onChange={(e) =>
              onChangeStrategyDraft({
                ...strategyDraft,
                prioritizeSubscriptions: e.target.checked,
              })
            }
            label={pt ? 'Priorizar assinaturas ativas' : 'Prioritize subscriptions'}
          />
          <Checkbox
            checked={strategyDraft.allowPromotionalCredits}
            disabled={strategyDraft.preset === 'free-only' || strategyDraft.preset === 'local-only'}
            onChange={(e) =>
              onChangeStrategyDraft({
                ...strategyDraft,
                allowPromotionalCredits: e.target.checked,
              })
            }
            label={pt ? 'Permitir uso de créditos promocionais' : 'Allow promotional credits'}
          />
          <Checkbox
            checked={strategyDraft.preferLocalInference}
            onChange={(e) =>
              onChangeStrategyDraft({ ...strategyDraft, preferLocalInference: e.target.checked })
            }
            label={pt ? 'Preferir inferência local quando viável' : 'Prefer local inference'}
          />
        </div>
      </div>

      {/* Ordered Routes & Route-Blocking Explanation Table */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="db-card-header" style={{ marginBottom: 0 }}>
          <h3 className="db-section-title">
            <GitBranch size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {pt
              ? ' Cadeia de rotas, fallback e motivos de elegibilidade / bloqueio'
              : 'Routes, fallbacks & block reasons'}
          </h3>
          <Button
            size="xs"
            variant="secondary"
            icon={<Play size={12} />}
            loading={busy}
            disabled={!activeProjectId}
            onClick={() => void handleSimulateRouter()}
          >
            {pt ? 'Inspecionar decisão do roteador' : 'Explain router decision'}
          </Button>
        </div>

        {routerDecision ? (
          <Banner
            tone="info"
            title={`${pt ? 'Rota selecionada' : 'Selected route'}: ${routerDecision.routeId}`}
          >
            <div>{routerDecision.reason}</div>
            <div className="db-mono db-faint" style={{ fontSize: 11 }}>
              candidatas={routerDecision.candidateRouteIds.join(', ')}
            </div>
          </Banner>
        ) : null}
        {routerExplanation ? (
          <div className="db-card" style={{ fontSize: 11 }}>
            <div className="db-mono">
              {pt ? 'Rotas classificadas' : 'Ranked routes'}:{' '}
              {routerExplanation.ranked
                .map((route) => `${route.routeId} (${route.score})`)
                .join(', ') || (pt ? 'nenhuma' : 'none')}
            </div>
            {routerExplanation.excluded.map((route) => (
              <div key={route.routeId}>
                {route.routeId}: {route.reasons.map((reason) => reason.message).join('; ')}
              </div>
            ))}
          </div>
        ) : null}

        <DataTable
          columns={[
            {
              key: 'prio',
              header: pt ? 'Prioridade' : 'Priority',
              width: 85,
              render: (r) => (
                <Badge tone="info" mono>
                  #{r.priority}
                </Badge>
              ),
            },
            {
              key: 'route',
              header: pt ? 'Rota / Modelo / Conexão' : 'Route / Model / Connection',
              render: (r) => (
                <div>
                  <strong className="db-mono">{r.id}</strong>
                  <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                    model={r.modelId} · conn={r.connectionId} {r.localOnly ? '· [localOnly]' : ''}
                  </div>
                </div>
              ),
            },
            {
              key: 'verdict',
              header: pt
                ? 'Explicação de elegibilidade na política atual'
                : 'Eligibility explanation',
              render: (r) => {
                const conn = snapshot.connections.find((c) => c.id === r.connectionId);
                const ep = conn
                  ? snapshot.endpoints.find((e) => e.id === conn.endpointId)
                  : undefined;
                const prov = conn
                  ? snapshot.catalog.find((p) => p.id === conn.providerId)
                  : undefined;
                const elig = evaluateProviderEligibility({
                  privacyClass: projectPrivacy,
                  provider: prov,
                  endpoint: ep,
                  connection: conn,
                  approvedProviderIds: strategyDraft.allowedProviderIds,
                });
                const model = snapshot.models.find((m) => m.id === r.modelId);
                const blockedByFreeOnly =
                  strategyDraft.preset === 'free-only' &&
                  !r.localOnly &&
                  (!model?.pricing ||
                    (model.pricing.inputPerMillion ?? 1) > 0 ||
                    (model.pricing.outputPerMillion ?? 1) > 0);
                const blockedByLocalOnly = strategyDraft.preset === 'local-only' && !r.localOnly;

                if (!r.enabled)
                  return <Badge tone="neutral">{pt ? 'Desativada' : 'Disabled'}</Badge>;
                if (!elig.eligible || blockedByFreeOnly || blockedByLocalOnly) {
                  return (
                    <div style={{ fontSize: 11, color: tokens.color.danger }}>
                      <strong>{pt ? 'Bloqueada: ' : 'Blocked: '}</strong>
                      {[
                        ...elig.reasonsPt,
                        blockedByFreeOnly
                          ? 'preço pago ou desconhecido não permitido em Somente gratuito'
                          : '',
                        blockedByLocalOnly ? 'rota externa bloqueada em Somente local' : '',
                      ]
                        .filter(Boolean)
                        .join('; ')}
                    </div>
                  );
                }
                return (
                  <Badge tone="success">
                    <CheckCircle2 size={11} /> {pt ? 'Elegível para roteamento' : 'Eligible'}
                  </Badge>
                );
              },
            },
          ]}
          rows={[...snapshot.routes].sort((a, b) => a.priority - b.priority)}
          rowKey={(r) => r.id}
          emptyMessage={pt ? 'Nenhuma rota cadastrada ainda.' : 'No routes configured yet.'}
        />

        {snapshot.models.length > 0 && snapshot.connections.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1.2fr 0.7fr auto auto',
              gap: 8,
              alignItems: 'end',
            }}
          >
            <Field label={pt ? 'Modelo' : 'Model'}>
              {(props) => (
                <Select
                  {...props}
                  value={newRouteModelId}
                  onChange={(e) => setNewRouteModelId(e.target.value)}
                >
                  {snapshot.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={pt ? 'Conexão' : 'Connection'}>
              {(props) => (
                <Select
                  {...props}
                  value={newRouteConnId}
                  onChange={(e) => setNewRouteConnId(e.target.value)}
                >
                  {snapshot.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={pt ? 'Prioridade' : 'Priority'}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  value={newRoutePriority}
                  onChange={(e) => setNewRoutePriority(e.target.value)}
                />
              )}
            </Field>
            <div style={{ paddingBottom: 6 }}>
              <Checkbox
                checked={newRouteLocalOnly}
                onChange={(e) => setNewRouteLocalOnly(e.target.checked)}
                label="localOnly"
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={12} />}
              onClick={() => void handleAddRoute()}
            >
              {pt ? 'Adicionar rota' : 'Add route'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// §13 — Laboratório de Modelos (Benchmarks)
// ---------------------------------------------------------------------------

export interface BenchmarksSectionProps {
  snapshot: AiResourceSnapshot;
  activeProjectId: string | null;
  routingPolicyId: string;
  onRecordBenchmark: (result: BenchmarkResult) => void;
  language: AppLanguage;
}

export const BenchmarksSection = ({
  snapshot,
  activeProjectId,
  routingPolicyId,
  onRecordBenchmark,
  language,
}: BenchmarksSectionProps) => {
  const pt = language === 'pt-BR';
  const [runtimeId, setRuntimeId] = useState<string>(snapshot.localRuntimes[0]?.id ?? 'ollama');
  const [modelId, setModelId] = useState<string>('');
  const [authorizePaidOrExternal, setAuthorizePaidOrExternal] = useState(false);
  const [suites, setSuites] = useState<
    { id: string; version: string; cases: number; categories: string[] }[]
  >([]);
  const [quality, setQuality] = useState<ModelEvidence[]>([]);
  const [suiteId, setSuiteId] = useState('');
  const [suiteRouteId, setSuiteRouteId] = useState('');
  const [confirmSuite, setConfirmSuite] = useState(false);
  const [latestSuiteRun, setLatestSuiteRun] = useState<BenchmarkRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'info' | 'success' | 'danger';
    text: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      callAiChannel('ai.benchmark.suites', {}),
      callAiChannel('ai.benchmark.quality', {}),
    ]).then(([suiteOut, qualityOut]) => {
      if (!active) return;
      if (suiteOut.status === 'ok') setSuites(suiteOut.data);
      if (qualityOut.status === 'ok') setQuality(qualityOut.data);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleRunSuite = async () => {
    if (!activeProjectId || !suiteId || !suiteRouteId || !confirmSuite) return;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await callAiChannel('ai.benchmark.run', {
        suiteId,
        routeId: suiteRouteId,
        routingPolicyId,
        projectId: activeProjectId,
        confirm: true,
      });
      if (out.status === 'ok') {
        setLatestSuiteRun(out.data);
        setConfirmSuite(false);
        setFeedback({
          tone: 'success',
          text: pt
            ? `Suíte concluída: ${out.data.results.filter((result) => result.passed).length}/${out.data.results.length} casos aprovados.`
            : 'Benchmark suite completed.',
        });
      } else {
        setFeedback({
          tone: 'danger',
          text: out.status === 'unsupported' ? out.message : out.error.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRunBenchmark = async () => {
    if (!runtimeId.trim() || !modelId.trim()) return;
    setFeedback(null);
    setBusy(true);
    try {
      const res = await callAiChannel('ai.local.benchmark', {
        runtimeId: runtimeId.trim(),
        modelId: modelId.trim(),
      });
      if (res.status === 'ok') {
        onRecordBenchmark(res.data);
        setFeedback({
          tone: 'success',
          text: pt
            ? `Benchmark concluído: ${res.data.tokensPerSecond?.toFixed(1) ?? '—'} tok/s · TTFT ${res.data.timeToFirstTokenMs ?? '—'} ms.`
            : 'Benchmark completed.',
        });
      } else {
        setFeedback({
          tone: 'info',
          text:
            res.status === 'unsupported'
              ? pt
                ? 'Medição local indisponível neste runtime. As suítes estruturadas abaixo usam a rota configurada no gateway.'
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
      <Banner
        tone="info"
        icon={<FlaskConical size={15} />}
        title={
          pt
            ? 'Política do Laboratório: zero notas fictícias e nenhuma execução automática em APIs pagas'
            : 'Benchmark Lab policy: zero fictional scores and no automatic paid API runs'
        }
      >
        {pt
          ? 'Os resultados exibidos refletem exclusivamente medições reais executadas neste hardware. Suítes em endpoints pagos jamais iniciam sem clique e autorização explícita.'
          : 'Shows strictly measured runs on this machine; paid endpoints never run automatically.'}
      </Banner>

      {feedback ? <Banner tone={feedback.tone}>{feedback.text}</Banner> : null}

      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 className="db-section-title">
          {pt ? 'Executar medição manual de desempenho' : 'Run manual benchmark'}
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.5fr auto',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <Field label={pt ? 'Runtime / Alvo' : 'Runtime ID'}>
            {(props) => (
              <Input
                {...props}
                mono
                value={runtimeId}
                onChange={(e) => setRuntimeId(e.target.value)}
              />
            )}
          </Field>
          <Field label={pt ? 'Modelo (ID instalado ou configurado)' : 'Model ID'}>
            {(props) => (
              <Input
                {...props}
                mono
                value={modelId}
                placeholder="qwen2.5-coder:7b"
                onChange={(e) => setModelId(e.target.value)}
              />
            )}
          </Field>
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={13} />}
            loading={busy}
            disabled={!modelId.trim() || (runtimeId !== 'ollama' && !authorizePaidOrExternal)}
            onClick={() => void handleRunBenchmark()}
          >
            {pt ? 'Executar benchmark' : 'Run benchmark'}
          </Button>
        </div>
        {runtimeId !== 'ollama' ? (
          <Checkbox
            checked={authorizePaidOrExternal}
            onChange={(e) => setAuthorizePaidOrExternal(e.target.checked)}
            label={
              pt
                ? 'Autorizo explicitamente a execução manual deste benchmark em endpoint externo/tarifado.'
                : 'Explicitly authorize manual benchmark on external/paid endpoint.'
            }
          />
        ) : null}

        {/* Dimensions defined for Claude benchmark suite */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {[
            pt ? 'Programação' : 'Coding',
            'Structured Output',
            'Tool Calling',
            pt ? 'Latência (TTFT)' : 'Latency (TTFT)',
            pt ? 'Vazão (tok/s)' : 'Throughput (tok/s)',
            pt ? 'Confiabilidade' : 'Reliability',
            pt ? 'Consumo e Custo por tarefa' : 'Task consumption & cost',
          ].map((dim) => (
            <Badge key={dim} tone="outline">
              {dim}
            </Badge>
          ))}
        </div>
      </div>

      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 className="db-section-title">
          {pt ? 'Suítes de avaliação estruturada' : 'Structured evaluation suites'}
        </h3>
        <div style={{ fontSize: 12 }} className="db-muted">
          {pt
            ? 'Cada caso faz inferência real pela rota e pode consumir cota ou gerar custo. A política do projeto é aplicada no gateway.'
            : 'Each case calls the selected route and may consume quota or incur cost. Project policy applies.'}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 8,
          }}
        >
          <Field label={pt ? 'Suíte' : 'Suite'}>
            {(props) => (
              <Select {...props} value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                <option value="">{pt ? 'Selecione' : 'Select'}</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.id}@{suite.version} ({suite.cases} {pt ? 'casos' : 'cases'})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={pt ? 'Rota' : 'Route'}>
            {(props) => (
              <Select
                {...props}
                value={suiteRouteId}
                onChange={(e) => setSuiteRouteId(e.target.value)}
              >
                <option value="">{pt ? 'Selecione' : 'Select'}</option>
                {snapshot.routes
                  .filter((route) => route.enabled)
                  .map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.id}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox
          checked={confirmSuite}
          onChange={(e) => setConfirmSuite(e.target.checked)}
          label={
            pt
              ? 'Autorizo esta execução e o consumo da rota selecionada.'
              : 'I authorize this run and its route usage.'
          }
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!activeProjectId || !suiteId || !suiteRouteId || !confirmSuite}
          onClick={() => void handleRunSuite()}
        >
          {pt ? 'Executar suíte' : 'Run suite'}
        </Button>
        {latestSuiteRun ? (
          <div className="db-mono" style={{ fontSize: 11 }}>
            {latestSuiteRun.suiteId}@{latestSuiteRun.suiteVersion}:{' '}
            {latestSuiteRun.results.filter((result) => result.passed).length}/
            {latestSuiteRun.results.length} {pt ? 'casos aprovados' : 'cases passed'}
          </div>
        ) : null}
        <DataTable
          columns={[
            { key: 'model', header: pt ? 'Modelo' : 'Model', render: (entry) => entry.modelId },
            {
              key: 'samples',
              header: pt ? 'Amostras' : 'Samples',
              render: (entry) => entry.samples,
            },
            {
              key: 'confidence',
              header: pt ? 'Confiança' : 'Confidence',
              render: (entry) => entry.confidence,
            },
            { key: 'source', header: pt ? 'Origem' : 'Source', render: (entry) => entry.source },
          ]}
          rows={quality}
          rowKey={(entry) => entry.modelId}
          emptyMessage={pt ? 'Sem medições de qualidade.' : 'No quality measurements.'}
        />
      </div>

      <DataTable
        columns={[
          {
            key: 'model',
            header: pt ? 'Modelo / Runtime' : 'Model / Runtime',
            render: (b) => (
              <div>
                <strong className="db-mono">{b.modelId}</strong>
                <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                  runtime={b.runtimeId}
                </div>
              </div>
            ),
          },
          {
            key: 'tps',
            header: 'Tokens/s',
            render: (b) => (
              <span className="db-mono">
                {b.tokensPerSecond !== null ? b.tokensPerSecond.toFixed(2) : '—'}
              </span>
            ),
          },
          {
            key: 'ttft',
            header: 'TTFT (ms)',
            render: (b) => (
              <span className="db-mono">
                {b.timeToFirstTokenMs !== null ? Math.round(b.timeToFirstTokenMs) : '—'}
              </span>
            ),
          },
          {
            key: 'status',
            header: pt ? 'Confiabilidade' : 'Result',
            render: (b) => (
              <Badge tone={b.success ? 'success' : 'danger'}>
                {b.success ? (pt ? 'Sucesso' : 'Pass') : pt ? 'Falha' : 'Fail'}
              </Badge>
            ),
          },
          {
            key: 'hw',
            header: 'Hardware',
            render: (b) => (
              <span className="db-mono" style={{ fontSize: 11 }}>
                {b.hardware.cpuCores}c · {formatBytesGiB(b.hardware.memoryBytes)}
                {b.hardware.gpuName ? ` · ${b.hardware.gpuName}` : ''}
              </span>
            ),
          },
          {
            key: 'at',
            header: pt ? 'Medido em' : 'Measured',
            render: (b) => formatTimestamp(b.measuredAt, language),
          },
        ]}
        rows={snapshot.benchmarks}
        rowKey={(b) => b.id}
        emptyMessage={
          pt
            ? 'Nenhuma medição executada ainda. Execute um benchmark manual em um modelo local para registrar resultados reais.'
            : 'No benchmark measurements recorded yet.'
        }
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// §3, §4, §16 — Diagnóstico, Matriz IPC, Inferência Controlada e Catálogo
// ---------------------------------------------------------------------------

export interface DiagnosticsSectionProps {
  snapshot: AiResourceSnapshot;
  sessions: readonly AgentSession[];
  activeProjectId: string | null;
  activeInferenceStream: string;
  activeInferenceRequestId: string | null;
  lastInferenceCost: CostRecord | null;
  onSubmitDiagInference: (prompt: string, policyId: string) => Promise<void>;
  onCancelDiagInference: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

export const DiagnosticsSection = ({
  snapshot,
  sessions,
  activeProjectId,
  activeInferenceStream,
  activeInferenceRequestId,
  lastInferenceCost,
  onSubmitDiagInference,
  onCancelDiagInference,
  onRefreshAll,
  language,
}: DiagnosticsSectionProps) => {
  const pt = language === 'pt-BR';
  const [diagPrompt, setDiagPrompt] = useState('Explique brevemente o estado desta rota.');
  const [diagPolicyId, setDiagPolicyId] = useState('policy-balanced');
  const [lookupRequestId, setLookupRequestId] = useState('');
  const [inspectedAttempts, setInspectedAttempts] = useState<FallbackAttempt[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(sessions[0]?.id ?? '');
  const [latestTaskCheckpoint, setLatestTaskCheckpoint] = useState<TaskCheckpoint | null>(null);
  const [handoffPacket, setHandoffPacket] = useState<HandoffPacket | null>(null);

  const [importSourceId, setImportSourceId] = useState('models-dev');
  const [importJson, setImportJson] = useState('');
  const [feedback, setFeedback] = useState<{
    tone: 'info' | 'success' | 'danger';
    text: string;
  } | null>(null);

  const handleInspectAttempts = async () => {
    if (!lookupRequestId.trim()) return;
    const res = await callAiChannel('ai.inference.attempts', {
      requestId: lookupRequestId.trim(),
    });
    if (res.status === 'ok') {
      setInspectedAttempts(res.data);
    } else {
      setFeedback({
        tone: 'info',
        text: res.status === 'unsupported' ? res.message : res.error.message,
      });
    }
  };

  const handleInspectCheckpoint = async () => {
    if (!selectedSessionId) return;
    const res = await callAiChannel('ai.checkpoints.latest', { sessionId: selectedSessionId });
    if (res.status === 'ok') {
      setLatestTaskCheckpoint(res.data);
    } else {
      setFeedback({
        tone: 'info',
        text:
          res.status === 'unsupported'
            ? pt
              ? 'Canal ai.checkpoints.latest respondeu UNSUPPORTED (checkpoints de tarefa avançados pertencem ao bloco Claude; os checkpoints de sessão da Fase 01 continuam ativos no Workspace).'
              : res.message
            : res.error.message,
      });
    }
  };

  const handleBuildHandoff = async () => {
    if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) return;
    const out = await callAiChannel('ai.handoff.build', {
      sessionId: selectedSessionId,
      kind: 'session-continuation',
    });
    if (out.status === 'ok') setHandoffPacket(out.data);
    else
      setFeedback({
        tone: 'info',
        text: out.status === 'unsupported' ? out.message : out.error.message,
      });
  };

  const handleImportCatalog = async () => {
    if (!importJson.trim()) return;
    const res = await callAiChannel('ai.catalog.import', {
      sourceId: importSourceId.trim(),
      data: importJson,
    });
    if (res.status === 'ok') {
      setImportJson('');
      await onRefreshAll();
      setFeedback({
        tone: 'success',
        text: pt
          ? `Catálogo importado (${res.data.providerCount} provedores, SHA256=${res.data.sha256.slice(0, 12)}…). Nenhuma conexão foi criada automaticamente.`
          : `Catalog imported (${res.data.providerCount} providers).`,
      });
    } else {
      setFeedback({
        tone: 'danger',
        text: res.status === 'unsupported' ? res.message : res.error.message,
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {feedback ? <Banner tone={feedback.tone}>{feedback.text}</Banner> : null}

      {/* IPC Contract 0.6.0 Readiness Matrix */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 className="db-section-title">
          <Activity size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {pt
            ? 'Matriz de prontidão dos canais IPC de IA (@devbrain/contracts 0.6.0)'
            : 'AI IPC channel readiness matrix (contracts 0.6.0)'}
        </h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {AI_CHANNEL_KEYS.map((ch) => {
            const st = snapshot.channelStates[ch];
            return (
              <Badge
                key={ch}
                mono
                tone={
                  st === 'ready'
                    ? 'success'
                    : st === 'unsupported'
                      ? 'warning'
                      : st === 'error'
                        ? 'danger'
                        : 'outline'
                }
              >
                {ch}: {st}
              </Badge>
            );
          })}
        </div>
      </div>

      {/* Controlled Gateway Inference & Streaming Console */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 className="db-section-title">
          {pt
            ? 'Console de diagnóstico de inferência e streaming (ai.inference.*)'
            : 'Gateway inference & streaming diagnostic console'}
        </h3>
        {!activeProjectId ? (
          <Banner tone="info">
            {pt
              ? 'Selecione um projeto para aplicar sua política de privacidade à inferência.'
              : 'Select a project to apply its privacy policy to inference.'}
          </Banner>
        ) : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 220px auto auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <Field label={pt ? 'Mensagem de teste' : 'Diagnostic prompt'}>
            {(props) => (
              <Input
                {...props}
                value={diagPrompt}
                onChange={(e) => setDiagPrompt(e.target.value)}
              />
            )}
          </Field>
          <Field label={pt ? 'Política de roteamento' : 'Routing policy ID'}>
            {(props) => (
              <Input
                {...props}
                mono
                value={diagPolicyId}
                onChange={(e) => setDiagPolicyId(e.target.value)}
              />
            )}
          </Field>
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={12} />}
            disabled={Boolean(activeInferenceRequestId) || !activeProjectId || !diagPrompt.trim()}
            onClick={() => void onSubmitDiagInference(diagPrompt.trim(), diagPolicyId.trim())}
          >
            {pt ? 'Testar rota' : 'Test route'}
          </Button>
          {activeInferenceRequestId ? (
            <Button
              size="sm"
              variant="danger"
              icon={<Square size={12} />}
              onClick={() => void onCancelDiagInference()}
            >
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
          ) : null}
        </div>
        {activeInferenceStream ? (
          <UntrustedBlock
            label={`ai.inference.event (${activeInferenceRequestId ?? 'concluído'})`}
            text={activeInferenceStream}
            maxHeight={160}
          />
        ) : null}
        {lastInferenceCost ? (
          <div className="db-mono" style={{ fontSize: 11 }}>
            {pt ? 'Custo da última inferência' : 'Last inference cost'}: {lastInferenceCost.state}{' '}
            {lastInferenceCost.reconciledMicros === null
              ? pt
                ? '(valor desconhecido)'
                : '(amount unknown)'
              : `${lastInferenceCost.currency} ${(lastInferenceCost.reconciledMicros / 1_000_000).toFixed(6)}`}
          </div>
        ) : null}
      </div>

      {/* Fallback Attempt Inspector + Task Checkpoint Inspector */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 className="db-section-title">
            {pt ? 'Inspecionar tentativas de fallback (requestId)' : 'Inspect fallback attempts'}
          </h4>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input
              mono
              value={lookupRequestId}
              placeholder="req-..."
              onChange={(e) => setLookupRequestId(e.target.value)}
            />
            <Button size="xs" variant="secondary" onClick={() => void handleInspectAttempts()}>
              {pt ? 'Consultar' : 'Lookup'}
            </Button>
          </div>
          {inspectedAttempts.map((att, idx) => (
            <div key={idx} className="db-mono" style={{ fontSize: 11 }}>
              [{att.error?.code ?? 'OK'}] {att.routeId} ({att.endedAt})
            </div>
          ))}
        </div>

        <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 className="db-section-title">
            {pt
              ? 'Checkpoint de tarefa mais recente (ai.checkpoints.latest)'
              : 'Latest task checkpoint'}
          </h4>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
            >
              <option value="">{pt ? 'Selecionar sessão…' : 'Select session…'}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title ?? s.id}
                </option>
              ))}
            </Select>
            <Button
              size="xs"
              variant="secondary"
              disabled={!selectedSessionId}
              onClick={() => void handleInspectCheckpoint()}
            >
              {pt ? 'Inspecionar' : 'Inspect'}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={!selectedSessionId}
              onClick={() => void handleBuildHandoff()}
            >
              {pt ? 'Preparar handoff' : 'Build handoff'}
            </Button>
          </div>
          {latestTaskCheckpoint ? (
            <UntrustedBlock
              label={`${latestTaskCheckpoint.id} (${latestTaskCheckpoint.state})`}
              text={latestTaskCheckpoint.summary}
              maxHeight={120}
            />
          ) : null}
          {handoffPacket ? (
            <UntrustedBlock
              label={`${pt ? 'Handoff de' : 'Handoff from'} ${handoffPacket.sessionId ?? ''}`}
              text={JSON.stringify(
                {
                  branch: handoffPacket.branch,
                  baseCommit: handoffPacket.baseCommit,
                  filesTouched: handoffPacket.filesTouched,
                  tests: handoffPacket.tests,
                  pending: handoffPacket.pending,
                  reconciliationRequired: handoffPacket.reconciliationRequired,
                },
                null,
                2,
              )}
              maxHeight={200}
            />
          ) : null}
        </div>
      </div>

      {/* Audited Snapshot Import */}
      <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h4 className="db-section-title">
          {pt
            ? 'Importar snapshot versionado de catálogo (dado não confiável — nunca cria conexões)'
            : 'Import versioned catalog snapshot'}
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            mono
            value={importSourceId}
            onChange={(e) => setImportSourceId(e.target.value)}
            style={{ width: 200 }}
          />
          <Button
            size="xs"
            variant="secondary"
            icon={<Upload size={12} />}
            disabled={!importJson.trim()}
            onClick={() => void handleImportCatalog()}
          >
            {pt ? 'Importar JSON' : 'Import JSON'}
          </Button>
        </div>
        <Textarea
          mono
          value={importJson}
          placeholder='{"formatVersion":1,"sourceId":"models-dev","revision":"...","license":"MIT","entries":[...]}'
          onChange={(e) => setImportJson(e.target.value)}
          style={{ minHeight: 70 }}
        />
      </div>
    </div>
  );
};
