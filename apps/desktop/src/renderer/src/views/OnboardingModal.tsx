import { useState } from 'react';
import {
  ALWAYS_ASK_ACTIONS,
  type AdapterDescriptor,
  type Agent,
  type ApplicationSettings,
  type DependencyReport,
  type Project,
  type ProviderProfile,
} from '@devbrain/contracts';
import { Badge, Banner, Button, Dialog, Field, Input, tokens } from '@devbrain/ui';
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { describeError, invoke } from '../lib/bridge';
import {
  describeEnforcement,
  formatDependencyStatus,
  formatPermissionAction,
  type AppLanguage,
} from '../lib/i18n';

export interface OnboardingModalProps {
  open: boolean;
  projects: readonly Project[];
  adapters: readonly AdapterDescriptor[];
  providers: readonly ProviderProfile[];
  agents: readonly Agent[];
  dependencyReports: Readonly<Record<string, DependencyReport>>;
  settings: ApplicationSettings | null;
  onRefreshAll: () => Promise<void>;
  onSelectProject: (projectId: string) => void;
  onCheckAdapter: (adapterKey: string) => Promise<void>;
  onComplete: () => void;
  onSkip: () => void;
  language: AppLanguage;
}

export const OnboardingModal = ({
  open,
  projects,
  adapters,
  providers,
  agents,
  dependencyReports,
  settings,
  onRefreshAll,
  onSelectProject,
  onCheckAdapter,
  onComplete,
  onSkip,
  language,
}: OnboardingModalProps) => {
  const pt = language === 'pt-BR';
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Project creation inline form
  const [createMode, setCreateMode] = useState(false);
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [projectName, setProjectName] = useState('');

  // Security basic config
  const [approvalMinutes, setApprovalMinutes] = useState<string>(() =>
    String(Math.round((settings?.security.approvalTimeoutMs ?? 900_000) / 60_000)),
  );
  const [grantHours, setGrantHours] = useState<string>(() =>
    String(Math.round((settings?.security.defaultGrantTtlMs ?? 28_800_000) / 3_600_000)),
  );

  if (!open) return null;

  const steps = pt
    ? ['1. Boas-vindas', '2. Projeto', '3. Agentes', '4. Permissões e Segurança', '5. Conclusão']
    : ['1. Welcome', '2. Project', '3. Agents', '4. Permissions & Security', '5. Finish'];

  const handleImportProject = async () => {
    setErrorMsg(null);
    setBusy(true);
    try {
      const picked = await invoke('projects.pickDirectory', {});
      if (!picked) return;
      const created = await invoke('projects.register', { rootPath: picked });
      await onRefreshAll();
      onSelectProject(created.id);
    } catch (e) {
      setErrorMsg(describeError(e, language).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateProject = async () => {
    setErrorMsg(null);
    setBusy(true);
    try {
      const created = await invoke('projects.create', {
        parentPath,
        folderName: folderName.trim(),
        ...(projectName.trim() ? { name: projectName.trim() } : {}),
      });
      await onRefreshAll();
      onSelectProject(created.id);
      setCreateMode(false);
      setFolderName('');
      setProjectName('');
    } catch (e) {
      setErrorMsg(describeError(e, language).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDetectAll = async () => {
    setErrorMsg(null);
    setBusy(true);
    try {
      for (const adapter of adapters) {
        await onCheckAdapter(adapter.adapterKey);
      }
      await onRefreshAll();
    } catch (e) {
      setErrorMsg(describeError(e, language).message);
    } finally {
      setBusy(false);
    }
  };

  const handleQuickConfigureAdapter = async (adapter: AdapterDescriptor) => {
    setErrorMsg(null);
    setBusy(true);
    try {
      let existing = providers.find((p) => p.provider.adapterKey === adapter.adapterKey);
      if (!existing) {
        existing = await invoke('providers.register', {
          adapterKey: adapter.adapterKey,
          kind: adapter.kind,
          displayName: adapter.displayName,
          vendor: adapter.vendor,
        });
      }
      const hasAgent = agents.some((a) => a.providerId === existing.provider.id);
      if (!hasAgent) {
        await invoke('agents.register', {
          providerId: existing.provider.id,
          name: adapter.displayName,
          role: pt ? 'Engenharia de software' : 'Software engineering',
        });
      }
      await onCheckAdapter(adapter.adapterKey);
      await onRefreshAll();
    } catch (e) {
      setErrorMsg(describeError(e, language).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSecurity = async () => {
    setErrorMsg(null);
    setBusy(true);
    try {
      const mins = Math.max(1, Math.min(1440, Number.parseInt(approvalMinutes, 10) || 15));
      const hrs = Math.max(1, Math.min(720, Number.parseInt(grantHours, 10) || 8));
      await invoke('settings.update', {
        security: {
          approvalTimeoutMs: mins * 60_000,
          defaultGrantTtlMs: hrs * 3_600_000,
        },
      });
      await onRefreshAll();
      setStep(4);
    } catch (e) {
      setErrorMsg(describeError(e, language).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      width={720}
      onClose={onSkip}
      title={pt ? 'Configuração inicial — DevBrain AI' : 'Initial Setup — DevBrain AI'}
      subtitle={
        pt
          ? 'Você pode pular etapas opcionais a qualquer momento e retomá-las pelo cabeçalho ou pelas Configurações.'
          : 'You can skip optional steps anytime and resume setup later from Settings.'
      }
      footer={
        <div
          style={{
            display: 'flex',
            width: '100%',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {pt ? 'Pular e retomar depois' : 'Skip for now'}
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2 | 3 | 4)}
              >
                {pt ? 'Voltar' : 'Back'}
              </Button>
            ) : null}
            {step < 3 ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setStep((s) => (s + 1) as 0 | 1 | 2 | 3 | 4)}
              >
                {pt ? 'Próxima etapa' : 'Next step'}
              </Button>
            ) : step === 3 ? (
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() => void handleSaveSecurity()}
              >
                {pt ? 'Salvar segurança e avançar' : 'Save security & continue'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<CheckCircle2 size={14} />}
                onClick={onComplete}
              >
                {pt ? 'Acessar o Workspace' : 'Enter Workspace'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {steps.map((label, idx) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(idx as 0 | 1 | 2 | 3 | 4)}
              style={{
                padding: '4px 9px',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${step === idx ? tokens.color.accent : tokens.color.border}`,
                background: step === idx ? tokens.color.accentSubtle : tokens.color.surfaceElevated,
                color: step === idx ? tokens.color.accent : tokens.color.textMuted,
                fontSize: 11.5,
                fontWeight: step === idx ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {errorMsg ? <Banner tone="danger">{errorMsg}</Banner> : null}

        {step === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              {pt
                ? 'Centro de comando local-first para engenharia com agentes'
                : 'Local-first command center for agent-assisted engineering'}
            </h3>
            <p className="db-muted" style={{ margin: 0, lineHeight: 1.55 }}>
              {pt
                ? 'O DevBrain AI conecta seus repositórios locais, políticas de segurança auditáveis e ferramentas reais de agentes CLI em um único ambiente desktop, sem servidores intermediários na nuvem e sem telemetria.'
                : 'DevBrain AI connects your local repositories, auditable security policies and real CLI agents in a single desktop command center with zero telemetry.'}
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
              }}
            >
              <div className="db-card">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {pt ? 'Persistência local' : 'Local persistence'}
                </div>
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt
                    ? 'Projetos, sessões, eventos, checkpoints e auditoria gravados em SQLite local com backup automático.'
                    : 'Projects, sessions, checkpoints and audit stored in local SQLite.'}
                </div>
              </div>
              <div className="db-card">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {pt ? 'Execução auditável' : 'Auditable execution'}
                </div>
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt
                    ? 'Processos iniciados sem shell irrestrito, com streaming em tempo real, cancelamento e inspeção de diffs Git.'
                    : 'Processes spawned without unrestricted shells, with real-time streaming and Git diffs.'}
                </div>
              </div>
              <div className="db-card">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {pt ? 'Segredos protegidos' : 'Protected secrets'}
                </div>
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt
                    ? 'Credenciais cifradas pelo Windows DPAPI (safeStorage); valores nunca retornam para a interface.'
                    : 'Credentials encrypted via Windows DPAPI; raw values never reach the renderer.'}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 14.5 }}>
                  {pt ? 'Importar ou criar um projeto' : 'Import or create a project'}
                </h3>
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt
                    ? 'Opcional agora — selecione um diretório existente ou crie uma nova pasta.'
                    : 'Optional now — pick an existing directory or create a new folder.'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<FolderOpen size={14} />}
                  loading={busy && !createMode}
                  onClick={() => void handleImportProject()}
                >
                  {pt ? 'Importar diretório…' : 'Import folder…'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderPlus size={14} />}
                  onClick={() => setCreateMode((v) => !v)}
                >
                  {pt ? 'Criar projeto' : 'Create project'}
                </Button>
              </div>
            </div>

            {createMode ? (
              <div
                className="db-card"
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <Field label={pt ? 'Pasta pai existente' : 'Existing parent directory'} required>
                  {(props) => (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Input
                        {...props}
                        mono
                        value={parentPath}
                        placeholder="C:\\projetos"
                        onChange={(e) => setParentPath(e.target.value)}
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          void invoke('projects.pickDirectory', {}).then((p) => {
                            if (p) setParentPath(p);
                          });
                        }}
                      >
                        {pt ? 'Procurar…' : 'Browse…'}
                      </Button>
                    </div>
                  )}
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label={pt ? 'Nome da nova pasta' : 'New folder name'} required>
                    {(props) => (
                      <Input
                        {...props}
                        mono
                        value={folderName}
                        placeholder="meu-servico"
                        onChange={(e) => setFolderName(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Nome de exibição (opcional)' : 'Display name (optional)'}>
                    {(props) => (
                      <Input
                        {...props}
                        value={projectName}
                        placeholder="Meu Serviço"
                        onChange={(e) => setProjectName(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    disabled={!parentPath.trim() || !folderName.trim()}
                    onClick={() => void handleCreateProject()}
                  >
                    {pt ? 'Criar e registrar' : 'Create & register'}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="db-card">
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {pt
                  ? `Projetos registrados (${projects.length})`
                  : `Registered projects (${projects.length})`}
              </div>
              {projects.length === 0 ? (
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt ? 'Nenhum projeto cadastrado ainda.' : 'No projects registered yet.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderRadius: tokens.radius.sm,
                        background: tokens.color.surfaceElevated,
                      }}
                    >
                      <div>
                        <strong>{p.name}</strong>{' '}
                        {p.isGitRepository ? <Badge tone="info">Git</Badge> : null}
                        <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                          {p.rootPath}
                        </div>
                      </div>
                      <Badge tone="success">{pt ? 'Pronto' : 'Ready'}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 14.5 }}>
                  {pt ? 'Detectar e configurar agentes CLI' : 'Detect & configure CLI agents'}
                </h3>
                <div className="db-muted" style={{ fontSize: 12 }}>
                  {pt
                    ? 'Verifique quais CLIs oficiais estão instaladas no PATH do Windows e habilite os agentes desejados.'
                    : 'Check which official CLIs are installed on Windows PATH and enable agents.'}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={13} />}
                loading={busy}
                onClick={() => void handleDetectAll()}
              >
                {pt ? 'Detectar ferramentas instaladas' : 'Detect installed CLIs'}
              </Button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {adapters.map((adapter) => {
                const report = dependencyReports[adapter.adapterKey];
                const configured = providers.find(
                  (p) => p.provider.adapterKey === adapter.adapterKey,
                );
                const depBadge = report
                  ? formatDependencyStatus(report.status, language)
                  : { label: pt ? 'Não verificado' : 'Unchecked', tone: 'outline' as const };
                const enf = describeEnforcement(adapter.capabilities, language);
                return (
                  <div
                    key={adapter.adapterKey}
                    className="db-card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
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
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        <Terminal size={14} />
                        <strong>{adapter.displayName}</strong>
                        {adapter.vendor ? <Badge tone="outline">{adapter.vendor}</Badge> : null}
                        <Badge tone={depBadge.tone} dot>
                          {depBadge.label}
                        </Badge>
                        <Badge tone={enf.tone}>{enf.badge}</Badge>
                        {configured ? (
                          <Badge tone="info">{pt ? 'Cadastrado' : 'Configured'}</Badge>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {adapter.documentationUrl ? (
                          <a
                            href={adapter.documentationUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11.5,
                              color: tokens.color.accent,
                              textDecoration: 'none',
                            }}
                          >
                            <span>{pt ? 'Documentação oficial' : 'Official docs'}</span>
                            <ExternalLink size={11} />
                          </a>
                        ) : null}
                        <Button
                          size="xs"
                          variant={configured ? 'secondary' : 'primary'}
                          loading={busy}
                          onClick={() => void handleQuickConfigureAdapter(adapter)}
                        >
                          {configured
                            ? pt
                              ? 'Revalidar'
                              : 'Re-check'
                            : pt
                              ? 'Cadastrar agente'
                              : 'Register agent'}
                        </Button>
                      </div>
                    </div>
                    {report?.checks[0] ? (
                      <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                        {report.checks[0].found
                          ? `${report.checks[0].resolvedPath} (${report.checks[0].version ?? ''})`
                          : `${report.checks[0].name}: ${report.checks[0].message ?? 'não encontrado no PATH'}`}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={17} />
              <h3 style={{ margin: 0, fontSize: 14.5 }}>
                {pt
                  ? 'Permissões e configuração básica de segurança'
                  : 'Permissions & security setup'}
              </h3>
            </div>

            <Banner
              tone="warning"
              title={
                pt
                  ? 'Transparência sobre agentes CLI externos'
                  : 'Transparency on external CLI agents'
              }
            >
              {pt
                ? 'Agentes CLI sem proxy por ação (enforcement: none) exigem aprovação humana explícita por sessão antes de iniciar. Operações destrutivas ou externas abaixo nunca são aprovadas automaticamente.'
                : 'CLI agents without per-action interception require explicit human session approval.'}
            </Banner>

            <div className="db-card">
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {pt
                  ? 'Piso inegociável — ações que sempre exigem aprovação pontual (ALWAYS_ASK):'
                  : 'Mandatory floor — actions that always require one-time human approval:'}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {ALWAYS_ASK_ACTIONS.map((act) => (
                  <Badge key={act} tone="warning" mono>
                    {formatPermissionAction(act, language)}
                  </Badge>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field
                label={
                  pt
                    ? 'Expiração de solicitações pendentes (minutos)'
                    : 'Approval timeout (minutes)'
                }
                hint={
                  pt
                    ? 'Solicitações expiradas são negadas automaticamente.'
                    : 'Expired requests are denied.'
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={1440}
                    value={approvalMinutes}
                    onChange={(e) => setApprovalMinutes(e.target.value)}
                  />
                )}
              </Field>
              <Field
                label={pt ? 'Validade padrão de concessões (horas)' : 'Default grant TTL (hours)'}
                hint={
                  pt
                    ? 'Aplica-se a aprovações com escopo de sessão ou projeto.'
                    : 'Applies to session/project grants.'
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={720}
                    value={grantHours}
                    onChange={(e) => setGrantHours(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner
              tone="success"
              title={pt ? 'Ambiente pronto para utilização' : 'Workspace ready'}
            >
              {pt
                ? `Projetos registrados: ${projects.length} · Provedores configurados: ${providers.length} · Agentes disponíveis: ${agents.length}.`
                : `Projects: ${projects.length} · Providers: ${providers.length} · Agents: ${agents.length}.`}
            </Banner>
            <div className="db-muted" style={{ fontSize: 12.5 }}>
              {pt
                ? 'No Workspace você pode selecionar um projeto e um agente, iniciar sessões auditáveis, aprovar ações sensíveis, acompanhar stdout/stderr no terminal integrado e inspecionar diffs Git.'
                : 'In the Workspace you can select a project and agent, start auditable sessions, approve sensitive actions, stream stdout/stderr and inspect Git diffs.'}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
