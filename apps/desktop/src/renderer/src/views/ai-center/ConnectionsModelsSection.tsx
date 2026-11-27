import { useMemo, useState } from 'react';
import type {
  Agent,
  CredentialReference,
  ModelAvailability,
  ModelDefinition,
  ProviderConnection,
  ProviderEndpoint,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  tokens,
} from '@devbrain/ui';
import {
  CheckCircle2,
  GitCompare,
  KeyRound,
  Layers,
  Play,
  Plus,
  Power,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react';
import {
  PRIVACY_CLASSIFICATIONS,
  callAiChannel,
  evaluateProviderEligibility,
  extractModelFamily,
  formatPricePerMillion,
  groupModelsAcrossProviders,
  type AiResourceSnapshot,
  type ProjectPrivacyClass,
} from '../../lib/ai-center';
import { describeError, invoke } from '../../lib/bridge';
import { formatTimestamp, type AppLanguage } from '../../lib/i18n';

export interface ConnectionsSectionProps {
  snapshot: AiResourceSnapshot;
  credentials: readonly CredentialReference[];
  projectPrivacy: ProjectPrivacyClass;
  approvedProviderIds: readonly string[];
  onRecordAvailability: (key: string, avail: ModelAvailability) => void;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

export const ConnectionsSection = ({
  snapshot,
  credentials,
  projectPrivacy,
  approvedProviderIds,
  onRecordAvailability,
  onRefreshAll,
  language,
}: ConnectionsSectionProps) => {
  const pt = language === 'pt-BR';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: 'danger' | 'success' | 'info';
    text: string;
  } | null>(null);

  // Edit / New connection modal
  const [editOpen, setEditOpen] = useState(false);
  const [connId, setConnId] = useState('');
  const [providerId, setProviderId] = useState('openrouter');
  const [endpointId, setEndpointId] = useState('ep-openrouter');
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [protocol, setProtocol] = useState<ProviderEndpoint['protocol']>('openai-chat');
  const [credId, setCredId] = useState('');
  const [newSecretLabel, setNewSecretLabel] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');

  // Authorized inference test dialog
  const [testTarget, setTestTarget] = useState<ProviderConnection | null>(null);
  const [confirmPaidTest, setConfirmPaidTest] = useState(false);

  const openNewOrEdit = (conn?: ProviderConnection) => {
    if (conn) {
      const ep = snapshot.endpoints.find((e) => e.id === conn.endpointId);
      setConnId(conn.id);
      setProviderId(conn.providerId);
      setEndpointId(conn.endpointId);
      setBaseUrl(ep?.baseUrl ?? 'https://');
      setProtocol(ep?.protocol ?? 'openai-chat');
      setCredId(conn.credentialId ?? '');
    } else {
      setConnId(`conn-${Date.now().toString(36)}`);
      setProviderId('openrouter');
      setEndpointId(`ep-${Date.now().toString(36)}`);
      setBaseUrl('https://openrouter.ai/api/v1');
      setProtocol('openai-chat');
      setCredId(credentials[0]?.id ?? '');
    }
    setNewSecretLabel('');
    setNewSecretValue('');
    setEditOpen(true);
  };

  const handleSaveConnection = async () => {
    setFeedback(null);
    setBusyId('save');
    try {
      let effectiveCredId = credId;
      if (newSecretValue.trim()) {
        const stored = await invoke('credentials.store', {
          storage: 'os-encrypted',
          label: newSecretLabel.trim() || `${providerId} Key`,
          secret: newSecretValue,
        });
        setNewSecretValue('');
        effectiveCredId = stored.id;
      }

      const epRes = await callAiChannel('ai.endpoints.save', {
        id: endpointId.trim(),
        providerId: providerId.trim(),
        baseUrl: baseUrl.trim(),
        protocol,
        documentationUrl: null,
      });
      if (epRes.status !== 'ok') {
        setFeedback({
          tone: epRes.status === 'unsupported' ? 'info' : 'danger',
          text:
            epRes.status === 'unsupported'
              ? pt
                ? 'Canal ai.endpoints.save respondeu UNSUPPORTED nesta branch (credencial DPAPI salva com sucesso no Core).'
                : epRes.message
              : `${epRes.error.code}: ${epRes.error.message}`,
        });
        await onRefreshAll();
        return;
      }

      const saveRes = await callAiChannel('ai.connections.save', {
        id: connId.trim(),
        providerId: providerId.trim(),
        endpointId: endpointId.trim(),
        credentialId: effectiveCredId || null,
        enabled: true,
        status: 'unknown',
        lastVerifiedAt: null,
      });
      if (saveRes.status !== 'ok') {
        throw new Error(saveRes.status === 'unsupported' ? saveRes.message : saveRes.error.message);
      }
      await onRefreshAll();
      setEditOpen(false);
      setFeedback({
        tone: 'success',
        text: pt
          ? 'Conexão salva (status inicial: unknown até validação explícita).'
          : 'Connection saved.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleEnabled = async (conn: ProviderConnection) => {
    setFeedback(null);
    setBusyId(conn.id);
    try {
      const res = await callAiChannel('ai.connections.save', {
        ...conn,
        enabled: !conn.enabled,
      });
      if (res.status !== 'ok') {
        setFeedback({
          tone: 'danger',
          text: res.status === 'unsupported' ? res.message : res.error.message,
        });
        return;
      }
      await onRefreshAll();
    } finally {
      setBusyId(null);
    }
  };

  const handleValidateAuth = async (conn: ProviderConnection) => {
    setFeedback(null);
    setBusyId(conn.id);
    try {
      const res = await callAiChannel('ai.connections.validate', { id: conn.id });
      if (res.status === 'ok') {
        onRecordAvailability(`${res.data.modelId}:${res.data.connectionId}`, res.data);
        await onRefreshAll();
        setFeedback({
          tone: res.data.state === 'available' ? 'success' : 'info',
          text: pt
            ? `Validação concluída: estado=${res.data.state}, evidência=${res.data.evidence} (nota: listagem de modelos valida a chave, mas difere de inferência completa).`
            : `Validation result: ${res.data.state} (${res.data.evidence}).`,
        });
      } else {
        setFeedback({
          tone: 'danger',
          text:
            res.status === 'unsupported'
              ? res.message
              : `${res.error.code}: ${res.error.message} — verifique a chave no cofre DPAPI e o protocolo do endpoint.`,
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRunInferenceTest = async () => {
    if (!testTarget || !confirmPaidTest) return;
    setFeedback(null);
    setBusyId(testTarget.id);
    try {
      const route = snapshot.routes.find((r) => r.connectionId === testTarget.id);
      const reqId = `probe-${testTarget.id}-${Date.now()}`;
      const sub = await callAiChannel('ai.inference.submit', {
        id: reqId,
        sessionId: null,
        modelId: route?.modelId ?? null,
        messages: [{ role: 'user', content: 'Ping.' }],
        maxOutputTokens: 12,
        temperature: 0,
        stream: false,
        routingPolicyId: 'policy-balanced',
        idempotencyKey: reqId,
      });
      if (sub.status !== 'ok') {
        setFeedback({
          tone: 'danger',
          text:
            sub.status === 'unsupported' ? sub.message : `${sub.error.code}: ${sub.error.message}`,
        });
      } else {
        const res = await callAiChannel('ai.inference.result', { requestId: sub.data.requestId });
        setFeedback({
          tone: 'success',
          text:
            res.status === 'ok' && res.data
              ? pt
                ? `Inferência real executada com sucesso na rota ${res.data.routeId} (finishReason=${res.data.finishReason}).`
                : `Inference succeeded via ${res.data.routeId}.`
              : pt
                ? `Teste submetido (${sub.data.requestId}).`
                : 'Test submitted.',
        });
      }
      setTestTarget(null);
      setConfirmPaidTest(false);
      await onRefreshAll();
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveConnection = async (connIdToRemove: string) => {
    setFeedback(null);
    setBusyId(connIdToRemove);
    try {
      const res = await callAiChannel('ai.connections.remove', { id: connIdToRemove });
      if (res.status !== 'ok') {
        setFeedback({
          tone: 'danger',
          text: res.status === 'unsupported' ? res.message : res.error.message,
        });
        return;
      }
      await onRefreshAll();
      setFeedback({
        tone: 'success',
        text: pt
          ? 'Conexão revogada e removida. A credencial no cofre DPAPI pode ser revogada separadamente caso não seja usada por outra conexão.'
          : 'Connection removed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div className="db-muted" style={{ fontSize: 12 }}>
          {pt
            ? 'Diferenciação estrita: "Chave autenticada (provider-api)" confirma aceitação da credencial na listagem; "Inferência comprovada (successful-inference)" confirma geração real.'
            : 'Distinguishes API key authentication from verified inference completion.'}
        </div>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={13} />}
          onClick={() => openNewOrEdit()}
        >
          {pt ? 'Nova conexão' : 'New connection'}
        </Button>
      </div>

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

      {snapshot.connections.length === 0 ? (
        <EmptyState
          title={pt ? 'Nenhuma conexão de inferência configurada' : 'No inference connections'}
          description={
            pt
              ? 'Adicione uma conexão HTTP/HTTPS ou loopback (OpenRouter, OpenAI, Anthropic, Gemini, Ollama) vinculada a uma referência segura de credencial.'
              : 'Add an HTTPS or loopback inference connection.'
          }
          actions={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => openNewOrEdit()}>
              {pt ? 'Configurar conexão' : 'Add connection'}
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {snapshot.connections.map((conn) => {
            const ep = snapshot.endpoints.find((e) => e.id === conn.endpointId);
            const prov = snapshot.catalog.find((p) => p.id === conn.providerId);
            const cred = credentials.find((c) => c.id === conn.credentialId);
            const connModels = snapshot.models.filter((m) =>
              snapshot.routes.some((r) => r.connectionId === conn.id && r.modelId === m.id),
            );
            const observedAvail = Object.values(snapshot.availabilities).filter(
              (a) => a.connectionId === conn.id,
            );
            const hasSuccessfulInference = observedAvail.some(
              (a) => a.evidence === 'successful-inference' && a.state === 'available',
            );
            const hasApiValidation =
              conn.status === 'ready' ||
              observedAvail.some((a) => a.evidence === 'provider-api' && a.state === 'available');
            const eligibility = evaluateProviderEligibility({
              privacyClass: projectPrivacy,
              provider: prov,
              endpoint: ep,
              connection: conn,
              approvedProviderIds,
            });
            const connQuotas = snapshot.quotas.filter(
              (q) =>
                (q.scope === 'provider' && q.scopeId === conn.providerId) ||
                (q.scope === 'endpoint' && q.scopeId === conn.endpointId) ||
                (q.scope === 'credential' && q.scopeId === conn.credentialId),
            );

            return (
              <div
                key={conn.id}
                className="db-card"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13.5 }}>{prov?.name ?? conn.providerId}</strong>
                    <span className="db-mono db-faint" style={{ fontSize: 11.5 }}>
                      ({conn.id})
                    </span>
                    <Badge
                      tone={
                        !conn.enabled || conn.status === 'disabled'
                          ? 'neutral'
                          : conn.status === 'ready'
                            ? 'success'
                            : conn.status === 'invalid-credential' || conn.status === 'unavailable'
                              ? 'danger'
                              : 'outline'
                      }
                      dot
                    >
                      {!conn.enabled
                        ? pt
                          ? 'Desativada'
                          : 'Disabled'
                        : conn.status === 'ready'
                          ? pt
                            ? 'Pronta (ready)'
                            : 'Ready'
                          : conn.status === 'invalid-credential'
                            ? pt
                              ? 'Credencial inválida'
                              : 'Invalid credential'
                            : conn.status === 'unavailable'
                              ? pt
                                ? 'Indisponível'
                                : 'Unavailable'
                              : pt
                                ? 'Não verificada'
                                : 'Unverified'}
                    </Badge>

                    {/* Key Auth vs Inference Completion distinction (§7) */}
                    {hasSuccessfulInference ? (
                      <Badge tone="success">
                        {pt ? 'Inferência comprovada' : 'Verified inference'}
                      </Badge>
                    ) : hasApiValidation ? (
                      <Badge tone="info">
                        {pt
                          ? 'Chave válida (inferência ainda não testada)'
                          : 'Key valid (inference untested)'}
                      </Badge>
                    ) : (
                      <Badge tone="outline">
                        {pt ? 'Autenticação desconhecida' : 'Auth unverified'}
                      </Badge>
                    )}

                    {!eligibility.eligible ? (
                      <Badge tone="danger">
                        {pt
                          ? `Bloqueada (${PRIVACY_CLASSIFICATIONS[projectPrivacy].labelPt})`
                          : 'Privacy blocked'}
                      </Badge>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={<CheckCircle2 size={12} />}
                      loading={busyId === conn.id}
                      onClick={() => void handleValidateAuth(conn)}
                    >
                      {pt ? 'Validar chave' : 'Validate key'}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={<Play size={12} />}
                      onClick={() => {
                        setConfirmPaidTest(false);
                        setTestTarget(conn);
                      }}
                    >
                      {pt ? 'Testar inferência' : 'Test inference'}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={<Settings2 size={12} />}
                      onClick={() => openNewOrEdit(conn)}
                    >
                      {pt ? 'Editar / Trocar chave' : 'Edit / Rotate key'}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={<Power size={12} />}
                      onClick={() => void handleToggleEnabled(conn)}
                    >
                      {conn.enabled ? (pt ? 'Desativar' : 'Disable') : pt ? 'Ativar' : 'Enable'}
                    </Button>
                    <Button
                      size="xs"
                      variant="danger"
                      icon={<Trash2 size={12} />}
                      onClick={() => void handleRemoveConnection(conn.id)}
                    >
                      {pt ? 'Revogar' : 'Revoke'}
                    </Button>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                    gap: 8,
                    fontSize: 11.5,
                    color: tokens.color.textMuted,
                  }}
                >
                  <div>
                    <span>Endpoint: </span>
                    <span className="db-mono" style={{ color: tokens.color.text }}>
                      {ep ? `${ep.baseUrl} (${ep.protocol})` : conn.endpointId}
                    </span>
                  </div>
                  <div>
                    <span>{pt ? 'Credencial: ' : 'Credential: '}</span>
                    <strong style={{ color: tokens.color.text }}>
                      {cred
                        ? `${cred.label} (••••${cred.hint ?? ''})`
                        : pt
                          ? 'Sem credencial'
                          : 'None'}
                    </strong>
                  </div>
                  <div>
                    <span>{pt ? 'Modelos / Cotas: ' : 'Models / Quotas: '}</span>
                    <strong style={{ color: tokens.color.text }}>
                      {connModels.length} mod. · {connQuotas.length} cota(s)
                    </strong>
                  </div>
                  <div>
                    <span>{pt ? 'Última verificação: ' : 'Last verified: '}</span>
                    <span>{formatTimestamp(conn.lastVerifiedAt, language)}</span>
                  </div>
                </div>

                {conn.status === 'invalid-credential' ? (
                  <Banner tone="danger">
                    {pt
                      ? 'Orientação: o provedor recusou a credencial (HTTP 401/403). Clique em "Editar / Trocar chave" para gravar uma nova chave no cofre DPAPI e revalidar.'
                      : 'Provider rejected the credential (HTTP 401/403). Rotate the key via Edit.'}
                  </Banner>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Rotate Key Dialog */}
      <Dialog
        open={editOpen}
        onClose={() => {
          setNewSecretValue('');
          setEditOpen(false);
        }}
        title={pt ? 'Configurar conexão e credencial autorizada' : 'Configure connection'}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setNewSecretValue('');
                setEditOpen(false);
              }}
            >
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              loading={busyId === 'save'}
              disabled={!connId.trim() || !providerId.trim() || !baseUrl.trim()}
              onClick={() => void handleSaveConnection()}
            >
              {pt ? 'Salvar conexão' : 'Save connection'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={pt ? 'ID da conexão' : 'Connection ID'} required>
              {(props) => (
                <Input {...props} mono value={connId} onChange={(e) => setConnId(e.target.value)} />
              )}
            </Field>
            <Field label={pt ? 'ID do provedor' : 'Provider ID'} required>
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <Field
              label={pt ? 'Endpoint autorizado (HTTPS ou 127.0.0.1)' : 'Authorized endpoint'}
              required
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              )}
            </Field>
            <Field label={pt ? 'Protocolo' : 'Protocol'}>
              {(props) => (
                <Select
                  {...props}
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value as ProviderEndpoint['protocol'])}
                >
                  <option value="openai-chat">openai-chat</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-gemini">google-gemini</option>
                  <option value="ollama">ollama</option>
                  <option value="custom">custom</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label={pt ? 'Credencial vinculada existente' : 'Existing credential'}>
            {(props) => (
              <Select {...props} value={credId} onChange={(e) => setCredId(e.target.value)}>
                <option value="">
                  {pt ? 'Sem credencial / substituir abaixo' : 'None / replace below'}
                </option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.storage})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <KeyRound size={13} />
              <span>
                {pt
                  ? 'Substituir por nova chave cifrada pelo SO (opcional — nunca reexibida)'
                  : 'Rotate with a new OS-encrypted secret (optional)'}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8 }}>
              <Input
                value={newSecretLabel}
                placeholder={pt ? 'Rótulo da nova chave' : 'New key label'}
                onChange={(e) => setNewSecretLabel(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="off"
                value={newSecretValue}
                placeholder={pt ? 'Cole o novo segredo aqui' : 'Paste secret key'}
                onChange={(e) => setNewSecretValue(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Dialog>

      {/* Inference Test Consent Dialog */}
      <Dialog
        open={testTarget !== null}
        onClose={() => setTestTarget(null)}
        title={pt ? 'Autorizar teste real de inferência' : 'Authorize live inference test'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTestTarget(null)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              disabled={!confirmPaidTest}
              loading={busyId !== null}
              onClick={() => void handleRunInferenceTest()}
            >
              {pt ? 'Executar inferência' : 'Run inference'}
            </Button>
          </>
        }
      >
        <Checkbox
          checked={confirmPaidTest}
          onChange={(e) => setConfirmPaidTest(e.target.checked)}
          label={
            pt
              ? 'Confirmo o envio de um prompt curto ("Ping", máx. 12 tokens) para comprovar inferência ponta a ponta nesta conexão.'
              : 'Confirm sending a minimal 12-token test prompt.'
          }
        />
      </Dialog>
    </div>
  );
};

// ---------------------------------------------------------------------------
// §8 — Catálogo de Modelos (Descoberta, Agrupamento Multi-Provedor e Comparação)
// ---------------------------------------------------------------------------

export interface ModelsCatalogSectionProps {
  snapshot: AiResourceSnapshot;
  agents: readonly Agent[];
  projectPrivacy: ProjectPrivacyClass;
  approvedProviderIds: readonly string[];
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

export const ModelsCatalogSection = ({
  snapshot,
  agents,
  projectPrivacy,
  approvedProviderIds,
  onRefreshAll,
  language,
}: ModelsCatalogSectionProps) => {
  const pt = language === 'pt-BR';
  const [search, setSearch] = useState('');
  const [groupSameModel, setGroupSameModel] = useState(true);
  const [filterTools, setFilterTools] = useState(false);
  const [filterStructured, setFilterStructured] = useState(false);
  const [filterReasoning, setFilterReasoning] = useState(false);
  const [filterFamily, setFilterFamily] = useState('all');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState<string>(agents[0]?.id ?? '');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  // Add model modal
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [mProviderId, setMProviderId] = useState('openrouter');
  const [mUpstreamId, setMUpstreamId] = useState('');
  const [mName, setMName] = useState('');
  const [mCtx, setMCtx] = useState('128000');
  const [mTools, setMTools] = useState(true);
  const [mStructured, setMStructured] = useState(true);
  const [mReasoning, setMReasoning] = useState(false);

  const families = useMemo(() => {
    const s = new Set(snapshot.models.map((m) => extractModelFamily(m.upstreamModelId)));
    return [...s].sort();
  }, [snapshot.models]);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return snapshot.models.filter((m) => {
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !m.upstreamModelId.toLowerCase().includes(q) &&
        !m.providerId.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (filterTools && !m.capabilities.tools) return false;
      if (filterStructured && !m.capabilities.structuredOutput) return false;
      if (filterReasoning && !m.capabilities.reasoning) return false;
      if (filterFamily !== 'all' && extractModelFamily(m.upstreamModelId) !== filterFamily) {
        return false;
      }
      return true;
    });
  }, [filterFamily, filterReasoning, filterStructured, filterTools, search, snapshot.models]);

  const grouped = useMemo(
    () =>
      groupModelsAcrossProviders({
        models: filteredModels,
        catalog: snapshot.catalog,
        endpoints: snapshot.endpoints,
        connections: snapshot.connections,
        routes: snapshot.routes,
        availabilities: snapshot.availabilities,
        benchmarks: snapshot.benchmarks,
      }),
    [
      filteredModels,
      snapshot.availabilities,
      snapshot.benchmarks,
      snapshot.catalog,
      snapshot.connections,
      snapshot.endpoints,
      snapshot.routes,
    ],
  );

  const toggleCompare = (modelId: string) => {
    setCompareIds((prev) =>
      prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : prev.length < 4
          ? [...prev, modelId]
          : prev,
    );
  };

  const handleAssignToAgent = async (model: ModelDefinition) => {
    const targetAgent = assignAgentId || agents[0]?.id;
    if (!targetAgent) return;
    try {
      await invoke('agents.update', {
        id: targetAgent,
        model: model.upstreamModelId,
      });
      await onRefreshAll();
      setFeedback({
        tone: 'success',
        text: pt
          ? `Modelo "${model.upstreamModelId}" vinculado ao agente para uso no Workspace.`
          : `Assigned "${model.upstreamModelId}" to agent.`,
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    }
  };

  const handleAddModel = async () => {
    const id = `${mProviderId.trim()}-${mUpstreamId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:-]/g, '-')}`.slice(0, 120);
    const res = await callAiChannel('ai.models.save', {
      id,
      providerId: mProviderId.trim(),
      upstreamModelId: mUpstreamId.trim(),
      name: mName.trim() || mUpstreamId.trim(),
      capabilities: {
        input: ['text'],
        output: ['text'],
        tools: mTools,
        streaming: true,
        structuredOutput: mStructured,
        reasoning: mReasoning,
        contextTokens: Number.parseInt(mCtx, 10) || null,
        outputTokens: null,
      },
      pricing: null,
      lifecycle: 'active',
      sourceId: 'user-configured',
      verifiedAt: null,
    });
    if (res.status === 'ok') {
      await onRefreshAll();
      setAddModelOpen(false);
      setMUpstreamId('');
      setMName('');
    } else {
      setFeedback({
        tone: 'danger',
        text: res.status === 'unsupported' ? res.message : res.error.message,
      });
    }
  };

  const comparedModels = useMemo(
    () => snapshot.models.filter((m) => compareIds.includes(m.id)),
    [compareIds, snapshot.models],
  );

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

      {/* Dense filter & grouping toolbar */}
      <div
        className="db-card"
        style={{
          padding: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', width: 250 }}>
            <Input
              value={search}
              placeholder={pt ? 'Buscar família, modelo ou provedor…' : 'Search models…'}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 28, height: 28 }}
            />
            <Search
              size={13}
              style={{ position: 'absolute', left: 8, top: 7, color: tokens.color.textFaint }}
            />
          </div>

          <Select
            value={filterFamily}
            onChange={(e) => setFilterFamily(e.target.value)}
            style={{ width: 155, height: 28 }}
          >
            <option value="all">{pt ? 'Todas as famílias' : 'All families'}</option>
            {families.map((fam) => (
              <option key={fam} value={fam}>
                {fam}
              </option>
            ))}
          </Select>

          <Checkbox
            checked={filterTools}
            onChange={(e) => setFilterTools(e.target.checked)}
            label="Tools"
          />
          <Checkbox
            checked={filterStructured}
            onChange={(e) => setFilterStructured(e.target.checked)}
            label="JSON / Structured"
          />
          <Checkbox
            checked={filterReasoning}
            onChange={(e) => setFilterReasoning(e.target.checked)}
            label={pt ? 'Raciocínio' : 'Reasoning'}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {agents.length > 0 ? (
            <Select
              aria-label={pt ? 'Agente destino' : 'Target agent'}
              value={assignAgentId}
              onChange={(e) => setAssignAgentId(e.target.value)}
              style={{ width: 170, height: 28 }}
            >
              {agents.map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {pt ? 'Usar em: ' : 'Use in: '}
                  {ag.name}
                </option>
              ))}
            </Select>
          ) : null}

          <Button
            size="xs"
            variant={groupSameModel ? 'primary' : 'secondary'}
            icon={<Layers size={12} />}
            onClick={() => setGroupSameModel((v) => !v)}
          >
            {pt ? 'Agrupar por modelo' : 'Group same model'}
          </Button>

          {compareIds.length >= 2 ? (
            <Button
              size="xs"
              variant="primary"
              icon={<GitCompare size={12} />}
              onClick={() => setCompareOpen(true)}
            >
              {pt ? `Comparar (${compareIds.length})` : `Compare (${compareIds.length})`}
            </Button>
          ) : null}

          <Button
            size="xs"
            variant="secondary"
            icon={<Plus size={12} />}
            onClick={() => setAddModelOpen(true)}
          >
            {pt ? 'Declarar modelo' : 'Register model'}
          </Button>
        </div>
      </div>

      <div className="db-faint" style={{ fontSize: 11.5 }}>
        {pt
          ? 'Aviso de arquitetura: o mesmo modelo oferecido por provedores/endpoints distintos possui latência, limites de cota, preços e políticas de retenção/privacidade independentes.'
          : 'Note: identical models across distinct endpoints carry independent quotas, latency, pricing and privacy policies.'}
      </div>

      {filteredModels.length === 0 ? (
        <EmptyState
          title={pt ? 'Nenhum modelo catalogado corresponde à busca' : 'No matching models'}
          description={
            pt
              ? 'Conecte provedores na aba Marketplace / Minhas Conexões ou declare um modelo manualmente.'
              : 'Connect providers or register a model manually.'
          }
          actions={
            <Button
              variant="primary"
              icon={<Plus size={13} />}
              onClick={() => setAddModelOpen(true)}
            >
              {pt ? 'Declarar modelo' : 'Register model'}
            </Button>
          }
        />
      ) : groupSameModel ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {grouped.slice(0, 120).map((grp) => (
            <div
              key={grp.canonicalKey}
              className="db-card"
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>{grp.displayName}</strong>
                  <Badge tone="info">{grp.family}</Badge>
                  <Badge tone="outline" mono>
                    {grp.offerings.length} {pt ? 'endpoint(s) / provedor(es)' : 'endpoint(s)'}
                  </Badge>
                </div>
              </div>

              <DataTable
                columns={[
                  {
                    key: 'provider',
                    header: pt ? 'Provedor / Endpoint' : 'Provider / Endpoint',
                    render: (off) => (
                      <div>
                        <strong>{off.providerName}</strong>
                        <div className="db-mono db-faint" style={{ fontSize: 10.5 }}>
                          {off.model.upstreamModelId}{' '}
                          {off.endpoint ? `· ${off.endpoint.protocol}` : ''}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'caps',
                    header: pt ? 'Contexto · Saída · Capacidades' : 'Context & Capabilities',
                    render: (off) => {
                      const c = off.model.capabilities;
                      return (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <Badge tone="outline" mono>
                            ctx {c.contextTokens?.toLocaleString(language) ?? '?'} / out{' '}
                            {c.outputTokens?.toLocaleString(language) ?? '?'}
                          </Badge>
                          <Badge tone="outline">
                            {c.input.join('+')}→{c.output.join('+')}
                          </Badge>
                          {c.tools ? <Badge tone="info">tools</Badge> : null}
                          {c.structuredOutput ? <Badge tone="info">json</Badge> : null}
                          {c.streaming ? <Badge tone="neutral">stream</Badge> : null}
                          {c.reasoning ? <Badge tone="warning">reasoning</Badge> : null}
                        </div>
                      );
                    },
                  },
                  {
                    key: 'pricing',
                    header: pt ? 'Entrada / Saída / Cache (1M)' : 'In / Out / Cache (1M)',
                    render: (off) => {
                      const pr = off.model.pricing;
                      return (
                        <div className="db-mono" style={{ fontSize: 11 }}>
                          <div>in: {formatPricePerMillion(pr?.inputPerMillion, pr?.currency)}</div>
                          <div>
                            out: {formatPricePerMillion(pr?.outputPerMillion, pr?.currency)}
                          </div>
                          <div className="db-faint">
                            cache: {formatPricePerMillion(pr?.cachedInputPerMillion, pr?.currency)}
                          </div>
                        </div>
                      );
                    },
                  },
                  {
                    key: 'perf',
                    header: pt ? 'Latência / Benchmark / Estado' : 'Latency / Benchmark / State',
                    render: (off) => {
                      const provEntry = snapshot.catalog.find((p) => p.id === off.model.providerId);
                      const elig = evaluateProviderEligibility({
                        privacyClass: projectPrivacy,
                        provider: provEntry,
                        endpoint: off.endpoint,
                        connection: off.connection,
                        approvedProviderIds,
                      });
                      return (
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}
                        >
                          <div>
                            <Badge
                              tone={
                                off.availability?.state === 'available'
                                  ? 'success'
                                  : off.availability?.state === 'rate-limited'
                                    ? 'warning'
                                    : off.availability?.state === 'unavailable'
                                      ? 'danger'
                                      : 'outline'
                              }
                            >
                              {off.availability?.state ?? 'unknown'}
                            </Badge>{' '}
                            <Badge tone={elig.eligible ? 'success' : 'danger'}>
                              {elig.eligible
                                ? PRIVACY_CLASSIFICATIONS[projectPrivacy].labelPt
                                : pt
                                  ? 'Privacidade bloqueada'
                                  : 'Blocked'}
                            </Badge>
                          </div>
                          <span className="db-mono db-faint">
                            TTFT:{' '}
                            {off.benchmark?.timeToFirstTokenMs !== null &&
                            off.benchmark?.timeToFirstTokenMs !== undefined
                              ? `${Math.round(off.benchmark.timeToFirstTokenMs)} ms`
                              : '—'}{' '}
                            · tok/s:{' '}
                            {off.benchmark?.tokensPerSecond !== null &&
                            off.benchmark?.tokensPerSecond !== undefined
                              ? off.benchmark.tokensPerSecond.toFixed(1)
                              : '—'}
                          </span>
                        </div>
                      );
                    },
                  },
                  {
                    key: 'actions',
                    header: '',
                    render: (off) => (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button
                          size="xs"
                          variant={compareIds.includes(off.model.id) ? 'primary' : 'ghost'}
                          onClick={() => toggleCompare(off.model.id)}
                        >
                          {compareIds.includes(off.model.id) ? '✓ Comp.' : '+ Comp.'}
                        </Button>
                        {agents.length > 0 ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => void handleAssignToAgent(off.model)}
                          >
                            {pt ? 'Usar no Agente' : 'Use'}
                          </Button>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
                rows={grp.offerings}
                rowKey={(o) => o.model.id}
              />
            </div>
          ))}
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: 'name',
              header: pt ? 'Modelo / Família' : 'Model / Family',
              render: (m) => (
                <div>
                  <strong>{m.name}</strong>{' '}
                  <Badge tone="outline">{extractModelFamily(m.upstreamModelId)}</Badge>
                  <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                    {m.providerId} · {m.upstreamModelId}
                  </div>
                </div>
              ),
            },
            {
              key: 'ctx',
              header: pt ? 'Contexto / Saída' : 'Context / Output',
              render: (m) => (
                <span className="db-mono">
                  {m.capabilities.contextTokens?.toLocaleString(language) ?? '—'} /{' '}
                  {m.capabilities.outputTokens?.toLocaleString(language) ?? '—'}
                </span>
              ),
            },
            {
              key: 'price',
              header: pt ? 'Preço Entrada / Saída' : 'Price In / Out',
              render: (m) => (
                <span className="db-mono" style={{ fontSize: 11 }}>
                  {formatPricePerMillion(m.pricing?.inputPerMillion, m.pricing?.currency)} ·{' '}
                  {formatPricePerMillion(m.pricing?.outputPerMillion, m.pricing?.currency)}
                </span>
              ),
            },
            {
              key: 'lifecycle',
              header: pt ? 'Ciclo' : 'Lifecycle',
              render: (m) => <Badge tone="outline">{m.lifecycle}</Badge>,
            },
          ]}
          rows={filteredModels.slice(0, 200)}
          rowKey={(m) => m.id}
        />
      )}

      {/* Side-by-side comparison modal */}
      <Dialog
        open={compareOpen}
        width={780}
        onClose={() => setCompareOpen(false)}
        title={
          pt ? 'Comparação lado a lado de endpoints de modelo' : 'Side-by-side model comparison'
        }
      >
        <DataTable
          columns={[
            {
              key: 'model',
              header: pt ? 'Modelo' : 'Model',
              render: (m) => <strong>{m.name}</strong>,
            },
            { key: 'prov', header: pt ? 'Provedor' : 'Provider', render: (m) => m.providerId },
            {
              key: 'ctx',
              header: pt ? 'Contexto' : 'Context',
              render: (m) => m.capabilities.contextTokens?.toLocaleString(language) ?? '—',
            },
            {
              key: 'tools',
              header: 'Tools / JSON / Reasoning',
              render: (m) =>
                [
                  m.capabilities.tools ? 'tools' : '',
                  m.capabilities.structuredOutput ? 'json' : '',
                  m.capabilities.reasoning ? 'reasoning' : '',
                ]
                  .filter(Boolean)
                  .join(', ') || '—',
            },
            {
              key: 'price',
              header: pt ? 'Entrada / Saída' : 'In / Out',
              render: (m) =>
                `${formatPricePerMillion(m.pricing?.inputPerMillion, m.pricing?.currency)} / ${formatPricePerMillion(m.pricing?.outputPerMillion, m.pricing?.currency)}`,
            },
          ]}
          rows={comparedModels}
          rowKey={(m) => m.id}
        />
      </Dialog>

      {/* Register Model Dialog */}
      <Dialog
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        title={pt ? 'Declarar modelo explicitamente' : 'Register model definition'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddModelOpen(false)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              disabled={!mProviderId.trim() || !mUpstreamId.trim()}
              onClick={() => void handleAddModel()}
            >
              {pt ? 'Salvar modelo' : 'Save model'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 10 }}>
            <Field label={pt ? 'Provedor (ID)' : 'Provider ID'} required>
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={mProviderId}
                  onChange={(e) => setMProviderId(e.target.value)}
                />
              )}
            </Field>
            <Field label={pt ? 'Upstream Model ID' : 'Upstream Model ID'} required>
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={mUpstreamId}
                  placeholder="qwen/qwen3-coder:free"
                  onChange={(e) => setMUpstreamId(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 10 }}>
            <Field label={pt ? 'Nome de exibição' : 'Display name'}>
              {(props) => (
                <Input {...props} value={mName} onChange={(e) => setMName(e.target.value)} />
              )}
            </Field>
            <Field label={pt ? 'Contexto conhecido (tokens)' : 'Context window'}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  value={mCtx}
                  onChange={(e) => setMCtx(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Checkbox
              checked={mTools}
              onChange={(e) => setMTools(e.target.checked)}
              label="Tool calling"
            />
            <Checkbox
              checked={mStructured}
              onChange={(e) => setMStructured(e.target.checked)}
              label="Structured output"
            />
            <Checkbox
              checked={mReasoning}
              onChange={(e) => setMReasoning(e.target.checked)}
              label={pt ? 'Raciocínio' : 'Reasoning'}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
};
