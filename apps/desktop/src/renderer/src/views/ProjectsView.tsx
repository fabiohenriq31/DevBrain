import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Agent,
  AgentSession,
  GitStatus,
  PermissionPolicy,
  Project,
  ProjectSettings,
  Workspace,
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
  Tabs,
  Textarea,
  tokens,
} from '@devbrain/ui';
import {
  Archive,
  Download,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { describeError, invoke } from '../lib/bridge';
import { formatSessionStatus, formatTimestamp, type AppLanguage } from '../lib/i18n';

export interface ProjectsViewProps {
  projects: readonly Project[];
  recentProjects: readonly Project[];
  activeProjectId: string | null;
  agents: readonly Agent[];
  policies: readonly PermissionPolicy[];
  onSelectProject: (projectId: string | null) => void;
  onOpenWorkspaceSession: (projectId: string, sessionId?: string) => void;
  onRefreshProjects: () => Promise<void>;
  language: AppLanguage;
}

export const ProjectsView = ({
  projects,
  recentProjects,
  activeProjectId,
  agents,
  policies,
  onSelectProject,
  onOpenWorkspaceSession,
  onRefreshProjects,
  language,
}: ProjectsViewProps) => {
  const pt = language === 'pt-BR';
  const [filterTab, setFilterTab] = useState<'active' | 'recent' | 'archived'>('active');
  const [detailTab, setDetailTab] = useState<'overview' | 'settings' | 'access' | 'sessions'>(
    'overview',
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    activeProjectId ?? projects.find((p) => !p.archivedAt)?.id ?? null,
  );
  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  useEffect(() => {
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) {
      setSelectedId(activeProjectId);
    } else if (!selectedId && projects[0]) {
      setSelectedId(projects[0].id);
    }
  }, [activeProjectId, projects, selectedId]);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [projSettings, setProjSettings] = useState<ProjectSettings | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'danger' | 'success'; text: string } | null>(
    null,
  );

  // Editable project metadata
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Editable project settings
  const [prefAgentId, setPrefAgentId] = useState<string>('');
  const [overridePolicyId, setOverridePolicyId] = useState<string>('');
  const [excludedText, setExcludedText] = useState('');
  const [notesText, setNotesText] = useState('');

  // Editable workspace access
  const [allowedRootsText, setAllowedRootsText] = useState('');
  const [readOnlyRootsText, setReadOnlyRootsText] = useState('');
  const [allowNetwork, setAllowNetwork] = useState(false);

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const loadSelectedDetails = useCallback(
    async (project: Project) => {
      setLoadingDetails(true);
      try {
        const [wsList, settings, sessionList] = await Promise.all([
          invoke('workspaces.list', { projectId: project.id }),
          invoke('projects.getSettings', { id: project.id }),
          invoke('sessions.listByProject', { projectId: project.id }),
        ]);
        setWorkspaces(wsList);
        setProjSettings(settings);
        setSessions(sessionList);

        setEditName(project.name);
        setEditDesc(project.description ?? '');

        setPrefAgentId(settings.preferredAgentId ?? '');
        setOverridePolicyId(settings.permissionPolicyId ?? '');
        setExcludedText(settings.excludedPaths.join('\n'));
        setNotesText(settings.notes ?? '');

        const primary = wsList[0];
        if (primary) {
          setAllowedRootsText(primary.access.allowedRoots.join('\n'));
          setReadOnlyRootsText(primary.access.readOnlyRoots.join('\n'));
          setAllowNetwork(primary.access.allowNetwork);
          const status = await invoke('git.status', { workspaceId: primary.id }).catch(() => null);
          setGitStatus(status);
        } else {
          setGitStatus(null);
        }
      } catch (e) {
        setFeedback({ tone: 'danger', text: describeError(e, language).message });
      } finally {
        setLoadingDetails(false);
      }
    },
    [language],
  );

  useEffect(() => {
    if (selected) {
      void loadSelectedDetails(selected);
    } else {
      setWorkspaces([]);
      setGitStatus(null);
      setProjSettings(null);
      setSessions([]);
    }
  }, [selected, loadSelectedDetails]);

  const visibleProjects = useMemo(() => {
    if (filterTab === 'archived') return projects.filter((p) => p.archivedAt !== null);
    if (filterTab === 'recent') return recentProjects.filter((p) => p.archivedAt === null);
    return projects.filter((p) => p.archivedAt === null);
  }, [projects, recentProjects, filterTab]);

  const handleImport = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const dir = await invoke('projects.pickDirectory', {});
      if (!dir) return;
      const created = await invoke('projects.register', { rootPath: dir });
      await onRefreshProjects();
      setSelectedId(created.id);
      onSelectProject(created.id);
      setFeedback({
        tone: 'success',
        text: pt ? `Projeto "${created.name}" importado.` : `Imported "${created.name}".`,
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const created = await invoke('projects.create', {
        parentPath: parentPath.trim(),
        folderName: folderName.trim(),
        ...(newName.trim() ? { name: newName.trim() } : {}),
        ...(newDesc.trim() ? { description: newDesc.trim() } : {}),
      });
      await onRefreshProjects();
      setSelectedId(created.id);
      onSelectProject(created.id);
      setCreateOpen(false);
      setFolderName('');
      setNewName('');
      setNewDesc('');
      setFeedback({
        tone: 'success',
        text: pt ? `Projeto "${created.name}" criado em disco e registrado.` : 'Project created.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMetadata = async () => {
    if (!selected) return;
    setFeedback(null);
    setBusy(true);
    try {
      await invoke('projects.update', {
        id: selected.id,
        name: editName.trim(),
        description: editDesc.trim() ? editDesc.trim() : null,
      });
      await onRefreshProjects();
      setFeedback({ tone: 'success', text: pt ? 'Cadastro atualizado.' : 'Project updated.' });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleRescanTech = async () => {
    if (!selected) return;
    setFeedback(null);
    setBusy(true);
    try {
      const updated = await invoke('projects.detectTechnologies', { id: selected.id });
      await onRefreshProjects();
      await loadSelectedDetails(updated);
      setFeedback({
        tone: 'success',
        text: pt
          ? `${updated.technologies.length} tecnologia(s) identificada(s).`
          : `Detected ${updated.technologies.length} technologies.`,
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveProjectSettings = async () => {
    if (!selected) return;
    setFeedback(null);
    setBusy(true);
    try {
      const excluded = excludedText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const saved = await invoke('projects.updateSettings', {
        projectId: selected.id,
        preferredAgentId: prefAgentId || null,
        permissionPolicyId: overridePolicyId || null,
        excludedPaths: excluded,
        notes: notesText.trim() ? notesText.trim() : null,
      });
      setProjSettings(saved);
      setFeedback({
        tone: 'success',
        text: pt ? 'Configurações do projeto salvas.' : 'Project settings saved.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveWorkspaceAccess = async () => {
    const primary = workspaces[0];
    if (!primary) return;
    setFeedback(null);
    setBusy(true);
    try {
      const allowedRoots = allowedRootsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const readOnlyRoots = readOnlyRootsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const updatedWs = await invoke('workspaces.updateAccess', {
        workspaceId: primary.id,
        allowedRoots,
        readOnlyRoots,
        allowNetwork,
      });
      setWorkspaces((prev) => prev.map((w) => (w.id === updatedWs.id ? updatedWs : w)));
      setFeedback({
        tone: 'success',
        text: pt ? 'Escopo de acesso do workspace atualizado.' : 'Workspace access updated.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (!selected) return;
    setFeedback(null);
    setBusy(true);
    try {
      if (selected.archivedAt) {
        await invoke('projects.restore', { id: selected.id });
      } else {
        await invoke('projects.archive', { id: selected.id });
        if (activeProjectId === selected.id) onSelectProject(null);
      }
      await onRefreshProjects();
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (!selected) return;
    setFeedback(null);
    try {
      const res = await invoke('projects.export', { id: selected.id });
      if (res) {
        setFeedback({
          tone: 'success',
          text: pt ? `Exportado para ${res.path}` : `Exported to ${res.path}`,
        });
      }
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    }
  };

  const handleRemoveConfirmed = async () => {
    if (!selected || !confirmRemove) return;
    setFeedback(null);
    setBusy(true);
    try {
      const removedName = selected.name;
      const removedId = selected.id;
      await invoke('projects.remove', { id: removedId, confirm: true });
      if (activeProjectId === removedId) onSelectProject(null);
      setSelectedId(null);
      setRemoveOpen(false);
      setConfirmRemove(false);
      await onRefreshProjects();
      setFeedback({
        tone: 'success',
        text: pt
          ? `Cadastro de "${removedName}" removido do DevBrain. Os arquivos originais em disco foram preservados.`
          : `Removed "${removedName}" from DevBrain. Disk files were preserved.`,
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Left list */}
      <div
        style={{
          borderRight: `1px solid ${tokens.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: tokens.color.surface,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: `1px solid ${tokens.color.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
          }}
        >
          <strong style={{ fontSize: 13 }}>{pt ? 'Projetos' : 'Projects'}</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="xs"
              variant="primary"
              icon={<FolderOpen size={12} />}
              loading={busy}
              onClick={() => void handleImport()}
            >
              {pt ? 'Importar' : 'Import'}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              icon={<FolderPlus size={12} />}
              onClick={() => setCreateOpen(true)}
            >
              {pt ? 'Criar' : 'New'}
            </Button>
          </div>
        </div>

        <Tabs
          tabs={[
            {
              id: 'active',
              label: pt ? 'Ativos' : 'Active',
              badge: projects.filter((p) => !p.archivedAt).length,
            },
            {
              id: 'recent',
              label: pt ? 'Recentes' : 'Recent',
              badge: recentProjects.filter((p) => !p.archivedAt).length,
            },
            {
              id: 'archived',
              label: pt ? 'Arquivados' : 'Archived',
              badge: projects.filter((p) => p.archivedAt !== null).length,
            },
          ]}
          active={filterTab}
          onChange={setFilterTab}
        />

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {visibleProjects.length === 0 ? (
            <div
              style={{
                padding: 18,
                textAlign: 'center',
                color: tokens.color.textMuted,
                fontSize: 12,
              }}
            >
              {pt ? 'Nenhum projeto nesta visão.' : 'No projects in this view.'}
            </div>
          ) : (
            visibleProjects.map((proj) => {
              const isSelected = proj.id === selectedId;
              const isActive = proj.id === activeProjectId;
              return (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => setSelectedId(proj.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '8px 10px',
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${isSelected ? tokens.color.accent : tokens.color.border}`,
                    background: isSelected
                      ? tokens.color.accentSubtle
                      : tokens.color.surfaceElevated,
                    color: tokens.color.text,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{proj.name}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {isActive ? <Badge tone="success">{pt ? 'Ativo' : 'Active'}</Badge> : null}
                      {proj.isGitRepository ? <Badge tone="info">Git</Badge> : null}
                      {proj.archivedAt ? (
                        <Badge tone="warning">{pt ? 'Arquivado' : 'Archived'}</Badge>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="db-mono db-faint"
                    style={{
                      fontSize: 11,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {proj.rootPath}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right detail */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {feedback ? (
          <div style={{ padding: '10px 16px 0 16px' }}>
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
          </div>
        ) : null}

        {!selected ? (
          <div style={{ padding: 24 }}>
            <EmptyState
              icon={<FolderGit2 size={26} />}
              title={pt ? 'Selecione ou cadastre um projeto' : 'Select or register a project'}
              description={
                pt
                  ? 'Importe um diretório local existente ou crie uma nova pasta para gerenciar sessões, políticas, tecnologias e estado Git.'
                  : 'Import an existing local directory or create a new project folder.'
              }
              actions={
                <>
                  <Button
                    variant="primary"
                    icon={<FolderOpen size={14} />}
                    onClick={() => void handleImport()}
                  >
                    {pt ? 'Importar diretório' : 'Import directory'}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<FolderPlus size={14} />}
                    onClick={() => setCreateOpen(true)}
                  >
                    {pt ? 'Criar projeto' : 'Create project'}
                  </Button>
                </>
              }
            />
          </div>
        ) : (
          <>
            <div
              style={{
                padding: '12px 16px',
                borderBottom: `1px solid ${tokens.color.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h2 style={{ margin: 0, fontSize: 16 }}>{selected.name}</h2>
                  {gitStatus ? (
                    <Badge tone="info" mono>
                      <GitBranch size={11} /> {gitStatus.branch ?? 'detached'}
                    </Badge>
                  ) : null}
                  {selected.archivedAt ? (
                    <Badge tone="warning">{pt ? 'Arquivado' : 'Archived'}</Badge>
                  ) : null}
                </div>
                <div className="db-mono db-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {selected.rootPath}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {!selected.archivedAt ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Play size={13} />}
                    onClick={() => {
                      onSelectProject(selected.id);
                      onOpenWorkspaceSession(selected.id);
                    }}
                  >
                    {pt ? 'Abrir no Workspace' : 'Open in Workspace'}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Download size={13} />}
                  onClick={() => void handleExport()}
                >
                  {pt ? 'Exportar JSON' : 'Export JSON'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={selected.archivedAt ? <RotateCcw size={13} /> : <Archive size={13} />}
                  loading={busy}
                  onClick={() => void handleArchiveToggle()}
                >
                  {selected.archivedAt
                    ? pt
                      ? 'Restaurar'
                      : 'Restore'
                    : pt
                      ? 'Arquivar'
                      : 'Archive'}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 size={13} />}
                  onClick={() => {
                    setConfirmRemove(false);
                    setRemoveOpen(true);
                  }}
                >
                  {pt ? 'Remover cadastro' : 'Remove registration'}
                </Button>
              </div>
            </div>

            <Tabs
              tabs={[
                { id: 'overview', label: pt ? 'Visão geral, Tecnologias e Git' : 'Overview & Git' },
                { id: 'settings', label: pt ? 'Configurações do projeto' : 'Project settings' },
                { id: 'access', label: pt ? 'Diretórios autorizados' : 'Workspace access' },
                {
                  id: 'sessions',
                  label: pt ? 'Histórico de sessões' : 'Session history',
                  badge: sessions.length,
                },
              ]}
              active={detailTab}
              onChange={setDetailTab}
            />

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              {loadingDetails ? (
                <div className="db-muted">{pt ? 'Carregando informações…' : 'Loading…'}</div>
              ) : null}

              {detailTab === 'overview' ? (
                <>
                  <div
                    className="db-card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <div className="db-card-header" style={{ marginBottom: 0 }}>
                      <h3 className="db-section-title">
                        {pt ? 'Identificação do projeto' : 'Project metadata'}
                      </h3>
                      <Button
                        size="xs"
                        variant="primary"
                        loading={busy}
                        onClick={() => void handleSaveMetadata()}
                      >
                        {pt ? 'Salvar alterações' : 'Save changes'}
                      </Button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                      <Field label={pt ? 'Nome' : 'Name'} required>
                        {(props) => (
                          <Input
                            {...props}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        )}
                      </Field>
                      <Field label={pt ? 'Descrição' : 'Description'}>
                        {(props) => (
                          <Input
                            {...props}
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                          />
                        )}
                      </Field>
                    </div>
                    <div className="db-faint" style={{ fontSize: 11.5 }}>
                      {pt ? 'Cadastrado em: ' : 'Created: '}
                      {formatTimestamp(selected.createdAt, language)} ·{' '}
                      {pt ? 'Último acesso: ' : 'Last opened: '}
                      {formatTimestamp(selected.lastOpenedAt, language)}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div className="db-card">
                      <div className="db-card-header">
                        <h3 className="db-section-title">
                          {pt ? 'Tecnologias identificadas' : 'Detected technologies'}
                        </h3>
                        <Button
                          size="xs"
                          variant="secondary"
                          icon={<RefreshCw size={12} />}
                          loading={busy}
                          onClick={() => void handleRescanTech()}
                        >
                          {pt ? 'Reescanear' : 'Rescan'}
                        </Button>
                      </div>
                      {selected.technologies.length === 0 ? (
                        <div className="db-muted" style={{ fontSize: 12 }}>
                          {pt
                            ? 'Nenhum manifesto reconhecido na raiz do projeto.'
                            : 'No recognized manifests in project root.'}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {selected.technologies.map((tech) => (
                            <Badge
                              key={tech.id}
                              tone="info"
                              title={`${tech.category} — ${tech.evidence}`}
                            >
                              {tech.name} ({tech.evidence})
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="db-card">
                      <div className="db-card-header">
                        <h3 className="db-section-title">{pt ? 'Estado Git' : 'Git status'}</h3>
                        {workspaces[0] ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            icon={<RefreshCw size={12} />}
                            onClick={() => void loadSelectedDetails(selected)}
                          >
                            {pt ? 'Atualizar' : 'Refresh'}
                          </Button>
                        ) : null}
                      </div>
                      {!gitStatus ? (
                        <div className="db-muted" style={{ fontSize: 12 }}>
                          {pt
                            ? 'Diretório não inicializado como repositório Git.'
                            : 'Not a Git repository.'}
                        </div>
                      ) : (
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}
                        >
                          <div>
                            <span className="db-muted">
                              {pt ? 'Branch atual: ' : 'Current branch: '}
                            </span>
                            <strong className="db-mono">
                              {gitStatus.branch ?? (pt ? 'HEAD destacado' : 'detached HEAD')}
                            </strong>
                          </div>
                          <div>
                            <span className="db-muted">{pt ? 'Upstream: ' : 'Upstream: '}</span>
                            <span className="db-mono">{gitStatus.upstream ?? '—'}</span>
                            {gitStatus.upstream ? (
                              <span>
                                {' '}
                                (+{gitStatus.ahead} / -{gitStatus.behind})
                              </span>
                            ) : null}
                          </div>
                          <div>
                            <span className="db-muted">
                              {pt ? 'Árvore de trabalho: ' : 'Working tree: '}
                            </span>
                            <Badge tone={gitStatus.clean ? 'success' : 'warning'}>
                              {gitStatus.clean
                                ? pt
                                  ? 'Limpa'
                                  : 'Clean'
                                : `${gitStatus.files.length} ${pt ? 'alteração(ões)' : 'change(s)'}`}
                            </Badge>
                          </div>
                          {gitStatus.files.length > 0 ? (
                            <div
                              className="db-mono"
                              style={{
                                maxHeight: 110,
                                overflowY: 'auto',
                                fontSize: 11,
                                padding: 6,
                                background: tokens.color.surfaceElevated,
                                borderRadius: tokens.radius.sm,
                              }}
                            >
                              {gitStatus.files.slice(0, 30).map((f) => (
                                <div key={f.path}>
                                  [{f.workTree}] {f.path}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : null}

              {detailTab === 'settings' && projSettings ? (
                <div
                  className="db-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  <div className="db-card-header" style={{ marginBottom: 0 }}>
                    <h3 className="db-section-title">
                      {pt ? 'Preferências e restrições do projeto' : 'Project settings'}
                    </h3>
                    <Button
                      size="xs"
                      variant="primary"
                      loading={busy}
                      onClick={() => void handleSaveProjectSettings()}
                    >
                      {pt ? 'Salvar configurações' : 'Save settings'}
                    </Button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label={pt ? 'Agente preferencial neste projeto' : 'Preferred agent'}>
                      {(props) => (
                        <Select
                          {...props}
                          value={prefAgentId}
                          onChange={(e) => setPrefAgentId(e.target.value)}
                        >
                          <option value="">{pt ? 'Nenhum padrão fixado' : 'None'}</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field
                      label={pt ? 'Política adicional do projeto' : 'Project override policy'}
                      hint={
                        pt
                          ? 'A decisão mais restritiva entre agente e projeto prevalece.'
                          : 'Most restrictive wins.'
                      }
                    >
                      {(props) => (
                        <Select
                          {...props}
                          value={overridePolicyId}
                          onChange={(e) => setOverridePolicyId(e.target.value)}
                        >
                          <option value="">
                            {pt ? 'Usar apenas política do agente' : 'Agent policy only'}
                          </option>
                          {policies.map((pol) => (
                            <option key={pol.id} value={pol.id}>
                              {pol.name} (v{pol.version})
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                  <Field
                    label={
                      pt
                        ? 'Caminhos excluídos (1 glob relativo por linha)'
                        : 'Excluded paths (1 glob per line)'
                    }
                    hint={
                      pt
                        ? 'Além das proteções padrão (.env, chaves privadas).'
                        : 'In addition to default secret exclusions.'
                    }
                  >
                    {(props) => (
                      <Textarea
                        {...props}
                        mono
                        value={excludedText}
                        placeholder={'secrets/**\n*.pem'}
                        onChange={(e) => setExcludedText(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Notas operacionais do projeto' : 'Operational notes'}>
                    {(props) => (
                      <Textarea
                        {...props}
                        value={notesText}
                        onChange={(e) => setNotesText(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              ) : null}

              {detailTab === 'access' ? (
                <div
                  className="db-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  <div className="db-card-header" style={{ marginBottom: 0 }}>
                    <h3 className="db-section-title">
                      {pt
                        ? 'Confinamento real-path do workspace primário'
                        : 'Primary workspace real-path scope'}
                    </h3>
                    <Button
                      size="xs"
                      variant="primary"
                      loading={busy}
                      onClick={() => void handleSaveWorkspaceAccess()}
                    >
                      {pt ? 'Atualizar escopo' : 'Update scope'}
                    </Button>
                  </div>
                  <Field
                    label={
                      pt
                        ? 'Raízes autorizadas para leitura/escrita (1 caminho absoluto por linha)'
                        : 'Allowed roots'
                    }
                    hint={
                      pt ? 'Deve incluir a raiz do workspace.' : 'Must contain the workspace root.'
                    }
                  >
                    {(props) => (
                      <Textarea
                        {...props}
                        mono
                        value={allowedRootsText}
                        onChange={(e) => setAllowedRootsText(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label={
                      pt
                        ? 'Raízes somente leitura adicionais (opcional)'
                        : 'Read-only roots (optional)'
                    }
                  >
                    {(props) => (
                      <Textarea
                        {...props}
                        mono
                        value={readOnlyRootsText}
                        onChange={(e) => setReadOnlyRootsText(e.target.value)}
                      />
                    )}
                  </Field>
                  <Checkbox
                    checked={allowNetwork}
                    onChange={(e) => setAllowNetwork(e.target.checked)}
                    label={pt ? 'Permitir acesso à rede pelo workspace' : 'Allow network access'}
                    description={
                      pt
                        ? 'Ainda sujeito à política do agente e às capacidades reais do adaptador.'
                        : 'Still subject to agent policy and adapter capabilities.'
                    }
                  />
                </div>
              ) : null}

              {detailTab === 'sessions' ? (
                <DataTable
                  columns={[
                    {
                      key: 'title',
                      header: pt ? 'Sessão' : 'Session',
                      render: (s) => (
                        <div>
                          <div style={{ fontWeight: 600 }}>{s.title ?? s.id}</div>
                          <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                            {s.id}
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'agent',
                      header: pt ? 'Agente' : 'Agent',
                      render: (s) => agents.find((a) => a.id === s.agentId)?.name ?? s.agentId,
                    },
                    {
                      key: 'status',
                      header: pt ? 'Estado' : 'Status',
                      render: (s) => {
                        const st = formatSessionStatus(s.status, language);
                        return (
                          <Badge tone={st.tone} dot>
                            {st.label}
                          </Badge>
                        );
                      },
                    },
                    {
                      key: 'startedAt',
                      header: pt ? 'Iniciada em' : 'Started',
                      render: (s) => formatTimestamp(s.startedAt, language),
                    },
                    {
                      key: 'action',
                      header: '',
                      render: (s) => (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            onSelectProject(selected.id);
                            onOpenWorkspaceSession(selected.id, s.id);
                          }}
                        >
                          {pt ? 'Inspecionar' : 'Inspect'}
                        </Button>
                      ),
                    },
                  ]}
                  rows={sessions}
                  rowKey={(s) => s.id}
                  emptyMessage={
                    pt ? 'Nenhuma sessão registrada para este projeto.' : 'No sessions yet.'
                  }
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Create project dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={pt ? 'Criar novo projeto' : 'Create new project'}
        subtitle={
          pt
            ? 'Cria uma nova pasta dentro do diretório pai selecionado e a registra no DevBrain.'
            : 'Creates a new directory inside the chosen parent folder and registers it.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!parentPath.trim() || !folderName.trim()}
              onClick={() => void handleCreate()}
            >
              {pt ? 'Criar projeto' : 'Create project'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label={pt ? 'Diretório pai' : 'Parent directory'} required>
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
                  {pt ? 'Selecionar…' : 'Browse…'}
                </Button>
              </div>
            )}
          </Field>
          <Field label={pt ? 'Nome da pasta' : 'Folder name'} required>
            {(props) => (
              <Input
                {...props}
                mono
                value={folderName}
                placeholder="novo-projeto"
                onChange={(e) => setFolderName(e.target.value)}
              />
            )}
          </Field>
          <Field label={pt ? 'Nome de exibição (opcional)' : 'Display name (optional)'}>
            {(props) => (
              <Input {...props} value={newName} onChange={(e) => setNewName(e.target.value)} />
            )}
          </Field>
          <Field label={pt ? 'Descrição (opcional)' : 'Description (optional)'}>
            {(props) => (
              <Input {...props} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            )}
          </Field>
        </div>
      </Dialog>

      {/* Safe removal confirmation dialog */}
      <Dialog
        open={removeOpen && selected !== null}
        onClose={() => setRemoveOpen(false)}
        title={pt ? 'Remover cadastro do projeto' : 'Remove project registration'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!confirmRemove}
              onClick={() => void handleRemoveConfirmed()}
            >
              {pt ? 'Remover do DevBrain' : 'Remove from DevBrain'}
            </Button>
          </>
        }
      >
        {selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner
              tone="info"
              title={pt ? 'Seus arquivos originais estão seguros' : 'Your files are safe'}
            >
              {pt
                ? `Nenhum arquivo em "${selected.rootPath}" será apagado do disco. Apenas o cadastro local, histórico de sessões, eventos e checkpoints deste projeto no DevBrain serão removidos.`
                : `Files in "${selected.rootPath}" will NOT be deleted from disk.`}
            </Banner>
            <Checkbox
              checked={confirmRemove}
              onChange={(e) => setConfirmRemove(e.target.checked)}
              label={
                pt
                  ? `Confirmo a remoção do cadastro e histórico local de "${selected.name}"`
                  : `Confirm removing registration and local history of "${selected.name}"`
              }
            />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
};
