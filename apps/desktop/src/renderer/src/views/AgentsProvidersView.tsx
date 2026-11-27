import { useState } from 'react';
import type {
  AdapterDescriptor,
  Agent,
  AgentCapabilities,
  CredentialReference,
  DependencyReport,
  PermissionPolicy,
  ProviderKind,
  ProviderProfile,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Tabs,
  tokens,
} from '@devbrain/ui';
import {
  Bot,
  ExternalLink,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { describeError, invoke } from '../lib/bridge';
import {
  describeEnforcement,
  describeProviderStates,
  formatAgentStatus,
  formatCostModel,
  formatDependencyStatus,
  formatProviderKind,
  formatTimestamp,
  type AppLanguage,
} from '../lib/i18n';

export interface AgentsProvidersViewProps {
  adapters: readonly AdapterDescriptor[];
  providers: readonly ProviderProfile[];
  agents: readonly Agent[];
  credentials: readonly CredentialReference[];
  policies: readonly PermissionPolicy[];
  dependencyReports: Readonly<Record<string, DependencyReport>>;
  runningProviderIds: ReadonlySet<string>;
  runningAgentIds: ReadonlySet<string>;
  onCheckAdapter: (adapterKey: string) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

const CAPABILITY_ITEMS: readonly {
  key: keyof Pick<
    AgentCapabilities,
    | 'streaming'
    | 'interrupt'
    | 'resumeSession'
    | 'toolUse'
    | 'fileEdits'
    | 'shellCommands'
    | 'mcp'
    | 'structuredOutput'
  >;
  pt: string;
  en: string;
}[] = [
  { key: 'streaming', pt: 'Streaming de saída', en: 'Streaming output' },
  { key: 'interrupt', pt: 'Cancelamento / Interrupção', en: 'Interrupt / Cancel' },
  { key: 'resumeSession', pt: 'Retomada nativa de sessão', en: 'Native session resume' },
  { key: 'toolUse', pt: 'Uso de ferramentas', en: 'Tool use' },
  { key: 'fileEdits', pt: 'Edição de arquivos', en: 'File edits' },
  { key: 'shellCommands', pt: 'Comandos locais', en: 'Shell commands' },
  { key: 'mcp', pt: 'Protocolo MCP', en: 'MCP' },
  { key: 'structuredOutput', pt: 'Saída estruturada JSON', en: 'Structured JSON output' },
];

export const AgentsProvidersView = ({
  adapters,
  providers,
  agents,
  credentials,
  policies,
  dependencyReports,
  runningProviderIds,
  runningAgentIds,
  onCheckAdapter,
  onRefreshAll,
  language,
}: AgentsProvidersViewProps) => {
  const pt = language === 'pt-BR';
  const [tab, setTab] = useState<'catalog' | 'providers' | 'agents' | 'credentials'>('catalog');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'danger' | 'success'; text: string } | null>(
    null,
  );

  // Provider registration / edit dialog
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [provAdapterKey, setProvAdapterKey] = useState('openai-codex-cli');
  const [provKind, setProvKind] = useState<ProviderKind>('cli-agent');
  const [provDisplayName, setProvDisplayName] = useState('OpenAI Codex');
  const [provVendor, setProvVendor] = useState('OpenAI');
  const [provEndpoint, setProvEndpoint] = useState('');
  const [provCredentialId, setProvCredentialId] = useState('');
  const [provExecutablePath, setProvExecutablePath] = useState('');
  const [provDefaultArgs, setProvDefaultArgs] = useState('');
  const [provDefaultModel, setProvDefaultModel] = useState('');
  const [provEnvAllowlist, setProvEnvAllowlist] = useState('');

  // Agent dialog
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agProviderId, setAgProviderId] = useState('');
  const [agName, setAgName] = useState('');
  const [agRole, setAgRole] = useState('');
  const [agModel, setAgModel] = useState('');
  const [agPolicyId, setAgPolicyId] = useState('');
  const [agStatus, setAgStatus] = useState<'idle' | 'paused' | 'disabled'>('idle');

  // Credential dialog
  const [credModalOpen, setCredModalOpen] = useState(false);
  const [credStorage, setCredStorage] = useState<'os-encrypted' | 'environment'>('os-encrypted');
  const [credLabel, setCredLabel] = useState('');
  const [credProviderId, setCredProviderId] = useState('');
  const [credSecret, setCredSecret] = useState('');
  const [credEnvVar, setCredEnvVar] = useState('');

  const openNewProvider = (adapter?: AdapterDescriptor) => {
    setEditingProviderId(null);
    setProvAdapterKey(adapter?.adapterKey ?? 'openai-codex-cli');
    setProvKind(adapter?.kind ?? 'cli-agent');
    setProvDisplayName(adapter?.displayName ?? 'OpenAI Codex');
    setProvVendor(adapter?.vendor ?? '');
    setProvEndpoint('');
    setProvCredentialId('');
    setProvExecutablePath('');
    setProvDefaultArgs('');
    setProvDefaultModel('');
    setProvEnvAllowlist('');
    setProviderModalOpen(true);
  };

  const openEditProvider = (p: ProviderProfile) => {
    setEditingProviderId(p.provider.id);
    setProvAdapterKey(p.provider.adapterKey);
    setProvKind(p.provider.kind);
    setProvDisplayName(p.provider.displayName);
    setProvVendor(p.provider.vendor ?? '');
    setProvEndpoint(p.provider.endpoint ?? '');
    setProvCredentialId(p.provider.credentialRef ?? '');
    setProvExecutablePath(p.config.executablePath ?? '');
    setProvDefaultArgs(p.config.defaultArgs.join(' '));
    setProvDefaultModel(p.config.defaultModel ?? '');
    setProvEnvAllowlist(p.config.envAllowlist.join(', '));
    setProviderModalOpen(true);
  };

  const handleSaveProvider = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const config = {
        executablePath: provExecutablePath.trim() ? provExecutablePath.trim() : null,
        defaultArgs: provDefaultArgs
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        defaultModel: provDefaultModel.trim() ? provDefaultModel.trim() : null,
        envAllowlist: provEnvAllowlist
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (editingProviderId) {
        await invoke('providers.update', {
          id: editingProviderId,
          displayName: provDisplayName.trim(),
          vendor: provVendor.trim() ? provVendor.trim() : null,
          endpoint: provEndpoint.trim() ? provEndpoint.trim() : null,
          credentialRef: provCredentialId || null,
          config,
        });
      } else {
        const created = await invoke('providers.register', {
          adapterKey: provAdapterKey.trim(),
          kind: provKind,
          displayName: provDisplayName.trim(),
          vendor: provVendor.trim() ? provVendor.trim() : null,
          endpoint: provEndpoint.trim() ? provEndpoint.trim() : null,
          credentialRef: provCredentialId || null,
          config,
        });
        if (adapters.some((a) => a.adapterKey === created.provider.adapterKey)) {
          await onCheckAdapter(created.provider.adapterKey).catch(() => undefined);
        }
      }
      await onRefreshAll();
      setProviderModalOpen(false);
      setFeedback({
        tone: 'success',
        text: pt ? 'Configuração do provedor salva.' : 'Provider configuration saved.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleDetectAll = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      for (const adapter of adapters) {
        await onCheckAdapter(adapter.adapterKey);
      }
      await onRefreshAll();
      setFeedback({
        tone: 'success',
        text: pt
          ? 'Verificação de instalação concluída para todos os adaptadores conhecidos.'
          : 'Dependency check completed for all known adapters.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const openNewAgent = (defaultProviderId?: string) => {
    setEditingAgentId(null);
    const chosen = defaultProviderId ?? providers[0]?.provider.id ?? '';
    const prov = providers.find((p) => p.provider.id === chosen);
    setAgProviderId(chosen);
    setAgName(prov?.provider.displayName ?? '');
    setAgRole(pt ? 'Engenharia de software' : 'Software engineering');
    setAgModel(prov?.config.defaultModel ?? '');
    setAgPolicyId('');
    setAgStatus('idle');
    setAgentModalOpen(true);
  };

  const openEditAgent = (agent: Agent) => {
    setEditingAgentId(agent.id);
    setAgProviderId(agent.providerId);
    setAgName(agent.name);
    setAgRole(agent.role ?? '');
    setAgModel(agent.model ?? '');
    setAgPolicyId(agent.permissionPolicyId);
    setAgStatus(
      agent.status === 'disabled' ? 'disabled' : agent.status === 'paused' ? 'paused' : 'idle',
    );
    setAgentModalOpen(true);
  };

  const handleSaveAgent = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      if (editingAgentId) {
        await invoke('agents.update', {
          id: editingAgentId,
          name: agName.trim(),
          role: agRole.trim() ? agRole.trim() : null,
          model: agModel.trim() ? agModel.trim() : null,
          ...(agPolicyId ? { permissionPolicyId: agPolicyId } : {}),
          status: agStatus,
        });
      } else {
        await invoke('agents.register', {
          providerId: agProviderId,
          name: agName.trim(),
          role: agRole.trim() ? agRole.trim() : null,
          model: agModel.trim() ? agModel.trim() : null,
          ...(agPolicyId ? { permissionPolicyId: agPolicyId } : {}),
        });
      }
      await onRefreshAll();
      setAgentModalOpen(false);
      setFeedback({ tone: 'success', text: pt ? 'Agente salvo.' : 'Agent saved.' });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleStoreCredential = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      if (credStorage === 'os-encrypted') {
        await invoke('credentials.store', {
          storage: 'os-encrypted',
          label: credLabel.trim(),
          providerId: credProviderId || null,
          secret: credSecret,
        });
      } else {
        await invoke('credentials.store', {
          storage: 'environment',
          label: credLabel.trim(),
          providerId: credProviderId || null,
          variable: credEnvVar.trim(),
        });
      }
      // Wipe in-memory secret input immediately
      setCredSecret('');
      setCredEnvVar('');
      setCredLabel('');
      setCredModalOpen(false);
      await onRefreshAll();
      setFeedback({
        tone: 'success',
        text: pt
          ? 'Referência segura de credencial registrada (o segredo nunca é reexibido).'
          : 'Credential reference stored securely.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${tokens.color.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          background: tokens.color.surface,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            {pt ? 'Central de Agentes e Provedores' : 'Agents & Providers Hub'}
          </h2>
          <div className="db-muted" style={{ fontSize: 12 }}>
            {pt
              ? 'Disponibilidade derivada exclusivamente de evidências reais do motor — sem cotas ou tokens fictícios.'
              : 'Readiness derived strictly from verified engine evidence — zero fictional quotas.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={13} />}
            loading={busy}
            onClick={() => void handleDetectAll()}
          >
            {pt ? 'Detectar ferramentas instaladas' : 'Detect installed CLIs'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => openNewProvider()}
          >
            {pt ? 'Novo provedor' : 'New provider'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Bot size={13} />}
            disabled={providers.length === 0}
            onClick={() => openNewAgent()}
          >
            {pt ? 'Novo agente' : 'New agent'}
          </Button>
        </div>
      </div>

      <Tabs
        tabs={[
          {
            id: 'catalog',
            label: pt ? 'Integrações conhecidas' : 'Known integrations',
            badge: adapters.length,
          },
          {
            id: 'providers',
            label: pt ? 'Provedores configurados' : 'Configured providers',
            badge: providers.length,
          },
          {
            id: 'agents',
            label: pt ? 'Agentes registrados' : 'Registered agents',
            badge: agents.length,
          },
          {
            id: 'credentials',
            label: pt ? 'Cofre de credenciais' : 'Credentials vault',
            badge: credentials.length,
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
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

        {tab === 'catalog' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {adapters.map((adapter) => {
              const report = dependencyReports[adapter.adapterKey];
              const depBadge = report
                ? formatDependencyStatus(report.status, language)
                : { label: pt ? 'Não verificado' : 'Unchecked', tone: 'outline' as const };
              const enf = describeEnforcement(adapter.capabilities, language);
              const configured = providers.find(
                (p) => p.provider.adapterKey === adapter.adapterKey,
              );

              return (
                <div
                  key={adapter.adapterKey}
                  className="db-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        <strong style={{ fontSize: 14 }}>{adapter.displayName}</strong>
                        {adapter.vendor ? <Badge tone="outline">{adapter.vendor}</Badge> : null}
                        <Badge tone="outline">{formatProviderKind(adapter.kind, language)}</Badge>
                        <Badge tone={depBadge.tone} dot>
                          {depBadge.label}
                        </Badge>
                        <Badge tone={enf.tone}>{enf.badge}</Badge>
                      </div>
                      <div className="db-mono db-faint" style={{ fontSize: 11, marginTop: 3 }}>
                        adapterKey: {adapter.adapterKey} ·{' '}
                        {pt ? 'Modelo de custo: ' : 'Cost model: '}
                        {formatCostModel(adapter.capabilities.costModel, language)}
                      </div>
                    </div>

                    <div
                      style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                    >
                      {adapter.documentationUrl ? (
                        <a
                          href={adapter.documentationUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 12,
                            color: tokens.color.accent,
                            textDecoration: 'none',
                            padding: '4px 8px',
                          }}
                        >
                          <span>{pt ? 'Documentação oficial de instalação' : 'Official docs'}</span>
                          <ExternalLink size={12} />
                        </a>
                      ) : null}
                      <Button
                        size="xs"
                        variant="secondary"
                        icon={<RefreshCw size={12} />}
                        loading={busy}
                        onClick={() => void onCheckAdapter(adapter.adapterKey)}
                      >
                        {pt ? 'Verificar CLI' : 'Check CLI'}
                      </Button>
                      <Button
                        size="xs"
                        variant={configured ? 'secondary' : 'primary'}
                        onClick={() =>
                          configured ? openEditProvider(configured) : openNewProvider(adapter)
                        }
                      >
                        {configured
                          ? pt
                            ? 'Editar provedor'
                            : 'Edit provider'
                          : pt
                            ? 'Configurar provedor'
                            : 'Configure provider'}
                      </Button>
                    </div>
                  </div>

                  {report?.checks.map((chk) => (
                    <div
                      key={chk.name}
                      style={{
                        padding: '6px 10px',
                        borderRadius: tokens.radius.sm,
                        background: tokens.color.surfaceElevated,
                        fontSize: 11.5,
                        display: 'flex',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      <span className="db-mono">
                        {pt ? 'Executável' : 'Executable'}: <strong>{chk.name}</strong> —{' '}
                        {chk.found
                          ? `${chk.resolvedPath} (${chk.version ?? ''})`
                          : (chk.message ?? (pt ? 'Não instalado no PATH' : 'Not found in PATH'))}
                      </span>
                      <span className="db-faint">
                        {formatTimestamp(report.checkedAt, language)}
                      </span>
                    </div>
                  ))}

                  {enf.warnings.length > 0 ? (
                    <Banner tone="warning" icon={<ShieldAlert size={15} />}>
                      {enf.warnings[0]}
                    </Banner>
                  ) : null}

                  <div>
                    <div
                      className="db-muted"
                      style={{ fontSize: 11, fontWeight: 600, marginBottom: 5 }}
                    >
                      {pt
                        ? 'Capacidades verificadas vs. não suportadas:'
                        : 'Verified vs. unsupported capabilities:'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {CAPABILITY_ITEMS.map((cap) => {
                        const supported = adapter.capabilities[cap.key];
                        return (
                          <Badge key={cap.key} tone={supported ? 'success' : 'neutral'}>
                            {pt ? cap.pt : cap.en}:{' '}
                            {supported
                              ? pt
                                ? 'Suportado'
                                : 'Supported'
                              : pt
                                ? 'Capacidade não suportada'
                                : 'Unsupported'}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {tab === 'providers' ? (
          providers.length === 0 ? (
            <EmptyState
              title={pt ? 'Nenhum provedor configurado' : 'No configured providers'}
              description={
                pt
                  ? 'Configure Claude Code, OpenAI Codex ou Google Antigravity CLI a partir da aba Integrações conhecidas.'
                  : 'Configure a provider from Known integrations.'
              }
              actions={
                <Button variant="primary" onClick={() => openNewProvider()}>
                  {pt ? 'Configurar provedor' : 'Configure provider'}
                </Button>
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {providers.map((p) => {
                const isRunning = runningProviderIds.has(p.provider.id);
                const stateBadges = describeProviderStates(p, isRunning, language);
                const enf = describeEnforcement(p.provider.capabilities, language);
                const linkedCred = credentials.find((c) => c.id === p.provider.credentialRef);

                return (
                  <div
                    key={p.provider.id}
                    className="db-card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                      >
                        <strong style={{ fontSize: 13.5 }}>{p.provider.displayName}</strong>
                        <Badge tone={stateBadges.primary.tone} dot>
                          {stateBadges.primary.label}
                        </Badge>
                        {stateBadges.secondary.map((b, i) => (
                          <Badge key={i} tone={b.tone}>
                            {b.label}
                          </Badge>
                        ))}
                        <Badge tone={enf.tone}>{enf.badge}</Badge>
                      </div>

                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button
                          size="xs"
                          variant="secondary"
                          icon={<Bot size={12} />}
                          onClick={() => openNewAgent(p.provider.id)}
                        >
                          {pt ? 'Criar agente' : 'Create agent'}
                        </Button>
                        <Button
                          size="xs"
                          variant="secondary"
                          icon={<Settings2 size={12} />}
                          onClick={() => openEditProvider(p)}
                        >
                          {pt ? 'Configurar' : 'Configure'}
                        </Button>
                        <Button
                          size="xs"
                          variant="secondary"
                          icon={<Power size={12} />}
                          onClick={() => {
                            void invoke('providers.setEnabled', {
                              id: p.provider.id,
                              enabled: !p.provider.enabled,
                            })
                              .then(() => onRefreshAll())
                              .catch((e) =>
                                setFeedback({
                                  tone: 'danger',
                                  text: describeError(e, language).message,
                                }),
                              );
                          }}
                        >
                          {p.provider.enabled
                            ? pt
                              ? 'Desativar'
                              : 'Disable'
                            : pt
                              ? 'Ativar'
                              : 'Enable'}
                        </Button>
                        <Button
                          size="xs"
                          variant="danger"
                          icon={<Trash2 size={12} />}
                          onClick={() => {
                            void invoke('providers.remove', { id: p.provider.id })
                              .then(() => onRefreshAll())
                              .catch((e) =>
                                setFeedback({
                                  tone: 'danger',
                                  text: describeError(e, language).message,
                                }),
                              );
                          }}
                        />
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                        gap: 8,
                        fontSize: 12,
                        color: tokens.color.textMuted,
                      }}
                    >
                      <div>
                        <span>{pt ? 'Adaptador: ' : 'Adapter: '}</span>
                        <span className="db-mono" style={{ color: tokens.color.text }}>
                          {p.provider.adapterKey}
                        </span>
                      </div>
                      <div>
                        <span>{pt ? 'Executável configurado: ' : 'Executable: '}</span>
                        <span className="db-mono" style={{ color: tokens.color.text }}>
                          {p.config.executablePath ?? (pt ? 'Automático via PATH' : 'PATH')}
                        </span>
                      </div>
                      <div>
                        <span>{pt ? 'Autenticação conhecida: ' : 'Known auth: '}</span>
                        <strong style={{ color: tokens.color.text }}>
                          {p.health.authenticated.state === 'yes'
                            ? pt
                              ? 'Validada em execução'
                              : 'Verified'
                            : p.health.authenticated.state === 'no'
                              ? pt
                                ? 'Não autenticado'
                                : 'Unauthenticated'
                              : pt
                                ? 'Não verificada (gerenciada pela CLI)'
                                : 'Unverified (managed by CLI)'}
                        </strong>
                      </div>
                      <div>
                        <span>{pt ? 'Credencial vinculada: ' : 'Credential ref: '}</span>
                        <span style={{ color: tokens.color.text }}>
                          {linkedCred
                            ? `${linkedCred.label} (${linkedCred.storage})`
                            : pt
                              ? 'Sessão local da CLI / nenhuma'
                              : 'CLI login / none'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'agents' ? (
          agents.length === 0 ? (
            <EmptyState
              icon={<Bot size={24} />}
              title={pt ? 'Nenhum agente registrado' : 'No registered agents'}
              description={
                pt
                  ? 'Registre um agente vinculado a um provedor configurado para iniciar sessões no Workspace.'
                  : 'Register an agent linked to a configured provider.'
              }
              actions={
                <Button
                  variant="primary"
                  disabled={providers.length === 0}
                  onClick={() => openNewAgent()}
                >
                  {pt ? 'Registrar agente' : 'Register agent'}
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={[
                {
                  key: 'name',
                  header: pt ? 'Agente' : 'Agent',
                  render: (a) => (
                    <div>
                      <strong>{a.name}</strong>
                      {a.role ? (
                        <div className="db-muted" style={{ fontSize: 11 }}>
                          {a.role}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'provider',
                  header: pt ? 'Provedor' : 'Provider',
                  render: (a) =>
                    providers.find((p) => p.provider.id === a.providerId)?.provider.displayName ??
                    a.providerId,
                },
                {
                  key: 'status',
                  header: pt ? 'Estado' : 'Status',
                  render: (a) => {
                    const st = formatAgentStatus(a, runningAgentIds.has(a.id), language);
                    return (
                      <Badge tone={st.tone} dot>
                        {st.label}
                      </Badge>
                    );
                  },
                },
                {
                  key: 'enforcement',
                  header: pt ? 'Interceptação' : 'Enforcement',
                  render: (a) => {
                    const enf = describeEnforcement(a.capabilities, language);
                    return <Badge tone={enf.tone}>{enf.badge}</Badge>;
                  },
                },
                {
                  key: 'policy',
                  header: pt ? 'Política' : 'Policy',
                  render: (a) =>
                    policies.find((pol) => pol.id === a.permissionPolicyId)?.name ??
                    a.permissionPolicyId,
                },
                {
                  key: 'actions',
                  header: '',
                  render: (a) => (
                    <Button size="xs" variant="secondary" onClick={() => openEditAgent(a)}>
                      {pt ? 'Editar' : 'Edit'}
                    </Button>
                  ),
                },
              ]}
              rows={agents}
              rowKey={(a) => a.id}
            />
          )
        ) : null}

        {tab === 'credentials' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Segredos são cifrados no processo principal via Windows DPAPI (safeStorage) ou lidos de variáveis de ambiente no momento do spawn. Valores nunca retornam ao renderer.'
                  : 'Secrets stay encrypted in main process via OS DPAPI or env vars; values never return to the renderer.'}
              </div>
              <Button
                size="sm"
                variant="primary"
                icon={<KeyRound size={13} />}
                onClick={() => setCredModalOpen(true)}
              >
                {pt ? 'Nova credencial' : 'Store credential'}
              </Button>
            </div>

            <DataTable
              columns={[
                {
                  key: 'label',
                  header: pt ? 'Rótulo' : 'Label',
                  render: (c) => <strong>{c.label}</strong>,
                },
                {
                  key: 'storage',
                  header: pt ? 'Armazenamento' : 'Storage',
                  render: (c) => (
                    <Badge tone={c.storage === 'os-encrypted' ? 'success' : 'info'}>
                      {c.storage === 'os-encrypted'
                        ? pt
                          ? 'Cifrado pelo SO (DPAPI)'
                          : 'OS-encrypted (DPAPI)'
                        : pt
                          ? 'Variável de ambiente'
                          : 'Environment variable'}
                    </Badge>
                  ),
                },
                {
                  key: 'locator',
                  header: pt ? 'Referência / Sufixo' : 'Locator / Hint',
                  render: (c) => (
                    <span className="db-mono" style={{ fontSize: 11.5 }}>
                      {c.storage === 'environment' ? c.locator : `••••${c.hint ?? ''}`}
                    </span>
                  ),
                },
                {
                  key: 'lastUsed',
                  header: pt ? 'Último uso' : 'Last used',
                  render: (c) => formatTimestamp(c.lastUsedAt, language),
                },
                {
                  key: 'remove',
                  header: '',
                  render: (c) => (
                    <Button
                      size="xs"
                      variant="danger"
                      icon={<Trash2 size={12} />}
                      onClick={() => {
                        void invoke('credentials.remove', { id: c.id })
                          .then(() => onRefreshAll())
                          .catch((e) =>
                            setFeedback({
                              tone: 'danger',
                              text: describeError(e, language).message,
                            }),
                          );
                      }}
                    >
                      {pt ? 'Remover' : 'Remove'}
                    </Button>
                  ),
                },
              ]}
              rows={credentials}
              rowKey={(c) => c.id}
              emptyMessage={pt ? 'Nenhuma credencial cadastrada.' : 'No stored credentials.'}
            />
          </div>
        ) : null}
      </div>

      {/* Provider Dialog */}
      <Dialog
        open={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        title={
          editingProviderId
            ? pt
              ? 'Editar provedor'
              : 'Edit provider'
            : pt
              ? 'Configurar provedor'
              : 'Configure provider'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setProviderModalOpen(false)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!provDisplayName.trim() || !provAdapterKey.trim()}
              onClick={() => void handleSaveProvider()}
            >
              {pt ? 'Salvar provedor' : 'Save provider'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={pt ? 'Adaptador (adapterKey)' : 'Adapter key'} required>
              {(props) => (
                <Select
                  {...props}
                  disabled={Boolean(editingProviderId)}
                  value={provAdapterKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setProvAdapterKey(key);
                    const found = adapters.find((a) => a.adapterKey === key);
                    if (found) {
                      setProvDisplayName(found.displayName);
                      setProvVendor(found.vendor ?? '');
                      setProvKind(found.kind);
                    }
                  }}
                >
                  {adapters.map((a) => (
                    <option key={a.adapterKey} value={a.adapterKey}>
                      {a.displayName} ({a.adapterKey})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={pt ? 'Nome de exibição' : 'Display name'} required>
              {(props) => (
                <Input
                  {...props}
                  value={provDisplayName}
                  onChange={(e) => setProvDisplayName(e.target.value)}
                />
              )}
            </Field>
          </div>

          <Field
            label={pt ? 'Caminho absoluto do executável (opcional)' : 'Executable path (optional)'}
            hint={
              pt
                ? 'Deixe em branco para resolver automaticamente pelo PATH do Windows.'
                : 'Leave empty to resolve via system PATH.'
            }
          >
            {(props) => (
              <Input
                {...props}
                mono
                value={provExecutablePath}
                placeholder="C:\\caminho\\para\\executavel.exe"
                onChange={(e) => setProvExecutablePath(e.target.value)}
              />
            )}
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={pt ? 'Modelo padrão (opcional)' : 'Default model (optional)'}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={provDefaultModel}
                  onChange={(e) => setProvDefaultModel(e.target.value)}
                />
              )}
            </Field>
            <Field
              label={pt ? 'Credencial vinculada (opcional)' : 'Credential reference (optional)'}
            >
              {(props) => (
                <Select
                  {...props}
                  value={provCredentialId}
                  onChange={(e) => setProvCredentialId(e.target.value)}
                >
                  <option value="">
                    {pt ? 'Nenhuma / Login próprio da CLI' : 'None / CLI login'}
                  </option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({c.storage})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <Field
            label={pt ? 'Argumentos extras fixos (separados por espaço)' : 'Extra default args'}
          >
            {(props) => (
              <Input
                {...props}
                mono
                value={provDefaultArgs}
                onChange={(e) => setProvDefaultArgs(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={
              pt
                ? 'Variáveis de ambiente repassadas (nomes separados por vírgula)'
                : 'Allowed env var names'
            }
          >
            {(props) => (
              <Input
                {...props}
                mono
                value={provEnvAllowlist}
                placeholder="OPENAI_API_KEY, ANTHROPIC_API_KEY"
                onChange={(e) => setProvEnvAllowlist(e.target.value)}
              />
            )}
          </Field>
        </div>
      </Dialog>

      {/* Agent Dialog */}
      <Dialog
        open={agentModalOpen}
        onClose={() => setAgentModalOpen(false)}
        title={
          editingAgentId
            ? pt
              ? 'Editar agente'
              : 'Edit agent'
            : pt
              ? 'Registrar agente'
              : 'Register agent'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAgentModalOpen(false)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!agName.trim() || !agProviderId}
              onClick={() => void handleSaveAgent()}
            >
              {pt ? 'Salvar agente' : 'Save agent'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label={pt ? 'Provedor' : 'Provider'} required>
            {(props) => (
              <Select
                {...props}
                disabled={Boolean(editingAgentId)}
                value={agProviderId}
                onChange={(e) => setAgProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.provider.id} value={p.provider.id}>
                    {p.provider.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={pt ? 'Nome do agente' : 'Agent name'} required>
              {(props) => (
                <Input {...props} value={agName} onChange={(e) => setAgName(e.target.value)} />
              )}
            </Field>
            <Field label={pt ? 'Função / Papel' : 'Role'}>
              {(props) => (
                <Input {...props} value={agRole} onChange={(e) => setAgRole(e.target.value)} />
              )}
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={pt ? 'Modelo (opcional)' : 'Model (optional)'}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={agModel}
                  onChange={(e) => setAgModel(e.target.value)}
                />
              )}
            </Field>
            <Field label={pt ? 'Política de permissão' : 'Permission policy'}>
              {(props) => (
                <Select
                  {...props}
                  value={agPolicyId}
                  onChange={(e) => setAgPolicyId(e.target.value)}
                >
                  {!editingAgentId ? (
                    <option value="">
                      {pt
                        ? 'Criar política restritiva padrão'
                        : 'Create default restrictive policy'}
                    </option>
                  ) : null}
                  {policies.map((pol) => (
                    <option key={pol.id} value={pol.id}>
                      {pol.name} (v{pol.version})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {editingAgentId ? (
            <Field label={pt ? 'Estado operacional' : 'Operational status'}>
              {(props) => (
                <Select
                  {...props}
                  value={agStatus}
                  onChange={(e) => setAgStatus(e.target.value as 'idle' | 'paused' | 'disabled')}
                >
                  <option value="idle">{pt ? 'Disponível (idle)' : 'Available'}</option>
                  <option value="paused">{pt ? 'Pausado' : 'Paused'}</option>
                  <option value="disabled">{pt ? 'Desativado' : 'Disabled'}</option>
                </Select>
              )}
            </Field>
          ) : null}
        </div>
      </Dialog>

      {/* Credential Dialog */}
      <Dialog
        open={credModalOpen}
        onClose={() => {
          setCredSecret('');
          setCredModalOpen(false);
        }}
        title={pt ? 'Cadastrar referência segura de credencial' : 'Store credential reference'}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setCredSecret('');
                setCredModalOpen(false);
              }}
            >
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={
                !credLabel.trim() ||
                (credStorage === 'os-encrypted' ? !credSecret : !credEnvVar.trim())
              }
              onClick={() => void handleStoreCredential()}
            >
              {pt ? 'Salvar com segurança' : 'Store securely'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label={pt ? 'Tipo de armazenamento' : 'Storage backend'}>
            {(props) => (
              <Select
                {...props}
                value={credStorage}
                onChange={(e) => setCredStorage(e.target.value as 'os-encrypted' | 'environment')}
              >
                <option value="os-encrypted">
                  {pt ? 'Cifrado pelo Windows DPAPI (safeStorage)' : 'OS-encrypted (DPAPI)'}
                </option>
                <option value="environment">
                  {pt ? 'Variável de ambiente do sistema' : 'Environment variable'}
                </option>
              </Select>
            )}
          </Field>
          <Field label={pt ? 'Rótulo de identificação' : 'Label'} required>
            {(props) => (
              <Input
                {...props}
                value={credLabel}
                placeholder={pt ? 'Ex.: Chave API corporativa' : 'e.g. Corporate API Key'}
                onChange={(e) => setCredLabel(e.target.value)}
              />
            )}
          </Field>
          <Field label={pt ? 'Provedor associado (opcional)' : 'Associated provider (optional)'}>
            {(props) => (
              <Select
                {...props}
                value={credProviderId}
                onChange={(e) => setCredProviderId(e.target.value)}
              >
                <option value="">{pt ? 'Qualquer provedor autorizado' : 'Any'}</option>
                {providers.map((p) => (
                  <option key={p.provider.id} value={p.provider.id}>
                    {p.provider.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {credStorage === 'os-encrypted' ? (
            <Field
              label={pt ? 'Valor do segredo' : 'Secret value'}
              required
              hint={
                pt
                  ? 'Enviado uma única vez ao processo principal e cifrado em disco; jamais armazenado em localStorage.'
                  : 'Encrypted in main process; never stored in localStorage.'
              }
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="off"
                  value={credSecret}
                  onChange={(e) => setCredSecret(e.target.value)}
                />
              )}
            </Field>
          ) : (
            <Field
              label={pt ? 'Nome da variável de ambiente' : 'Environment variable name'}
              required
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={credEnvVar}
                  placeholder="OPENAI_API_KEY"
                  onChange={(e) => setCredEnvVar(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      </Dialog>
    </div>
  );
};
