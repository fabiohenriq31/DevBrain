import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdapterDescriptor,
  Agent,
  ApplicationSettings,
  ApprovalRequest,
  CredentialReference,
  DependencyReport,
  ExecutionStatus,
  ModelDefinition,
  PermissionPolicy,
  Project,
  ProviderProfile,
  StorageHealth,
  SystemInfo,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  KeyHint,
  Select,
  SplitPane,
  THEME_CSS,
  resolveEffectiveTheme,
  tokens,
} from '@devbrain/ui';
import {
  Bell,
  Bot,
  Command,
  Database,
  FolderGit2,
  HelpCircle,
  LayoutPanelLeft,
  Lock,
  PanelRight,
  Settings,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { ApprovalModal, type ApprovalDecisionHandler } from './components/ApprovalModal';
import {
  CommandPalette,
  NotificationsDialog,
  ShortcutsDialog,
  type AppNotification,
  type PaletteCommand,
} from './components/Overlays';
import { PRIVACY_CLASSIFICATIONS, callAiChannel, type ProjectPrivacyClass } from './lib/ai-center';
import { describeError, invoke, subscribe, type DescribedError } from './lib/bridge';
import {
  describeEnforcement,
  formatExecutionStatus,
  getStrings,
  type AppLanguage,
  type NavSection,
} from './lib/i18n';
import { loadUiPreferences, saveUiPreferences, type UiPreferences } from './lib/preferences';
import './styles.css';
import { AiResourceCenterView } from './views/ai-center/AiResourceCenterView';
import type { AiCenterTab } from './views/ai-center/OverviewSection';
import { ApprovalsSecurityView } from './views/ApprovalsSecurityView';
import { OnboardingModal } from './views/OnboardingModal';
import { ProjectsView } from './views/ProjectsView';
import { SettingsView } from './views/SettingsView';
import { WorkspaceView } from './views/WorkspaceView';

export const App = () => {
  const [prefs, setPrefs] = useState<UiPreferences>(() => loadUiPreferences());
  const updatePrefs = useCallback((patch: Partial<UiPreferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveUiPreferences(next);
      return next;
    });
  }, []);

  const [section, setSection] = useState<NavSection>('workspace');
  const [aiCenterTab, setAiCenterTab] = useState<AiCenterTab>('overview');
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);

  // Core state
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<DescribedError | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [settings, setSettings] = useState<ApplicationSettings | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPolicies, setProjectPolicies] = useState<Record<string, ProjectPrivacyClass>>({});
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [adapters, setAdapters] = useState<AdapterDescriptor[]>([]);
  const [dependencyReports, setDependencyReports] = useState<Record<string, DependencyReport>>({});
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [discoveredAiModels, setDiscoveredAiModels] = useState<ModelDefinition[]>([]);
  const [credentials, setCredentials] = useState<CredentialReference[]>([]);
  const [policies, setPolicies] = useState<PermissionPolicy[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);

  // Active execution summary for shell & status bar
  const [runningExec, setRunningExec] = useState<{
    executionId: string | null;
    agentId: string | null;
    providerId: string | null;
    status: ExecutionStatus | null;
  }>({ executionId: null, agentId: null, providerId: null, status: null });

  // Modals & Overlays
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [dismissedRecoveryBanner, setDismissedRecoveryBanner] = useState(false);

  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,
  );

  const language: AppLanguage = settings?.language ?? 'pt-BR';
  const pt = language === 'pt-BR';
  const t = getStrings(language);

  const pushNotification = useCallback(
    (item: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => {
      setNotifications((prev) => [
        {
          ...item,
          id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          read: false,
        },
        ...prev.slice(0, 79),
      ]);
    },
    [],
  );

  // Inject CSS variables & sync theme attribute
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-devbrain-theme', 'true');
    styleEl.textContent = THEME_CSS;
    document.head.appendChild(styleEl);

    if (typeof window.matchMedia !== 'function') {
      return () => styleEl.remove();
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (ev: MediaQueryListEvent) => setSystemDark(ev.matches);
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
      styleEl.remove();
    };
  }, []);

  const effectiveTheme = resolveEffectiveTheme(settings?.theme ?? 'system', systemDark);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.setAttribute('lang', language);
  }, [effectiveTheme, language]);

  const refreshProjects = useCallback(async () => {
    const [all, rec] = await Promise.all([
      invoke('projects.list', { includeArchived: true }),
      invoke('projects.listRecent', { limit: 15 }),
    ]);
    setProjects(all);
    setRecentProjects(rec);
    return all;
  }, []);

  const refreshSystemAndSettings = useCallback(async () => {
    const info = await invoke('system.getInfo', {});
    setSystemInfo(info);
    if (!info.dataDirectoryConfigured) {
      setStorageHealth(null);
      return;
    }
    const [health, cfg] = await Promise.all([
      invoke('system.storageHealth', {}),
      invoke('settings.get', {}),
    ]);
    setStorageHealth(health);
    setSettings(cfg);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const info = await invoke('system.getInfo', {});
      setSystemInfo(info);
      if (!info.dataDirectoryConfigured) {
        setBootError({
          code: 'STORAGE_ERROR',
          title: 'Falha de persistência local',
          message: 'O banco de dados local não pôde ser inicializado.',
          remediation:
            'Verifique espaço livre e permissões de escrita em %APPDATA%\\DevBrain AI e reinicie o aplicativo.',
          retryable: true,
        });
        return;
      }

      const [
        health,
        cfg,
        allProjects,
        recProjects,
        adapterList,
        provList,
        agList,
        credList,
        polList,
        pending,
      ] = await Promise.all([
        invoke('system.storageHealth', {}),
        invoke('settings.get', {}),
        invoke('projects.list', { includeArchived: true }),
        invoke('projects.listRecent', { limit: 15 }),
        invoke('providers.listAdapters', {}),
        invoke('providers.listConfigured', {}),
        invoke('agents.list', {}),
        invoke('credentials.list', {}),
        invoke('permissions.listPolicies', {}),
        invoke('approvals.listPending', {}),
      ]);

      const aiModelsOutcome = await callAiChannel('ai.models.list', {});
      if (aiModelsOutcome.status === 'ok') {
        setDiscoveredAiModels([...aiModelsOutcome.data]);
      }
      const projectPolicyResults = await Promise.all(
        allProjects.map(async (project) => ({
          id: project.id,
          outcome: await window.devbrain.invoke('ai.projectPolicy.get', { projectId: project.id }),
        })),
      );
      setProjectPolicies(
        Object.fromEntries(
          projectPolicyResults
            .filter((item) => item.outcome.ok)
            .map((item) => [
              item.id,
              item.outcome.ok ? item.outcome.data.privacyClass : 'personal-private',
            ]),
        ),
      );

      setStorageHealth(health);
      setSettings(cfg);
      setProjects(allProjects);
      setRecentProjects(recProjects);
      setAdapters(adapterList);
      setProviders(provList);
      setAgents(agList);
      setCredentials(credList);
      setPolicies(polList);
      setPendingApprovals(pending);
      setBootError(null);
    } catch (e) {
      setBootError(describeError(e, 'pt-BR'));
    }
  }, []);

  // Initial bootstrap
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void (async () => {
      setBooting(true);
      await refreshAll();
      setBooting(false);
    })();
  }, [refreshAll]);

  // Auto-open onboarding on first fresh run if pending and no projects/agents configured yet
  const evaluatedOnboardingRef = useRef(false);
  useEffect(() => {
    if (booting || evaluatedOnboardingRef.current || bootError) return;
    evaluatedOnboardingRef.current = true;
    if (prefs.onboardingState === 'pending' && projects.length === 0 && agents.length === 0) {
      setOnboardingOpen(true);
    }
    if (storageHealth?.uncleanShutdownDetected) {
      pushNotification({
        tone: 'warning',
        title: pt ? 'Recuperação de sessão executada' : 'Crash recovery executed',
        body: pt
          ? `${storageHealth.recoveredSessions} sessão(ões) órfã(s) marcada(s) como interrompida(s).`
          : `${storageHealth.recoveredSessions} orphaned session(s) marked interrupted.`,
        targetSection: 'workspace',
      });
    }
  }, [
    agents.length,
    bootError,
    booting,
    prefs.onboardingState,
    projects.length,
    pt,
    pushNotification,
    storageHealth,
  ]);

  // Select active project automatically if none selected
  const activeProject = useMemo(() => {
    const activeList = projects.filter((p) => !p.archivedAt);
    return activeList.find((p) => p.id === prefs.activeProjectId) ?? activeList[0] ?? null;
  }, [prefs.activeProjectId, projects]);

  const activeProjectPrivacy: ProjectPrivacyClass = activeProject
    ? (projectPolicies[activeProject.id] ?? 'personal-private')
    : 'personal-private';

  const handleChangeProjectPrivacy = useCallback(
    (projectId: string, next: ProjectPrivacyClass) => {
      void (async () => {
        const current = await invoke('ai.projectPolicy.get', { projectId });
        const saved = await invoke('ai.projectPolicy.save', {
          projectId,
          privacyClass: next,
          approvedProviderIds: current.approvedProviderIds,
          budget: current.budget,
        });
        setProjectPolicies((previous) => ({ ...previous, [projectId]: saved.privacyClass }));
      })().catch((error: unknown) => {
        pushNotification({
          tone: 'danger',
          title: 'Não foi possível salvar a privacidade do projeto',
          body: describeError(error, 'pt-BR').message,
          targetSection: 'projects',
        });
      });
    },
    [pushNotification],
  );

  const openAiCenterTab = useCallback((tab: AiCenterTab) => {
    setAiCenterTab(tab);
    setSection('agents');
  }, []);

  const handleSelectProject = useCallback(
    (projectId: string | null) => {
      updatePrefs({ activeProjectId: projectId });
      if (projectId) {
        void invoke('projects.markOpened', { id: projectId })
          .then(() => refreshProjects())
          .catch(() => undefined);
      }
    },
    [refreshProjects, updatePrefs],
  );

  const handleCheckAdapter = useCallback(async (adapterKey: string) => {
    const report = await invoke('providers.checkDependencies', { adapterKey });
    setDependencyReports((prev) => ({ ...prev, [adapterKey]: report }));
    const [provList, agList] = await Promise.all([
      invoke('providers.listConfigured', {}),
      invoke('agents.list', {}),
    ]);
    setProviders(provList);
    setAgents(agList);
  }, []);

  const handleDecideApproval: ApprovalDecisionHandler = useCallback(
    async ({ approvalId, decision, scope, note }) => {
      await invoke('approvals.decide', {
        approvalId,
        decision,
        scope,
        ...(note ? { note } : {}),
      });
      const next = await invoke('approvals.listPending', {});
      setPendingApprovals(next);
      if (next.length === 0) setApprovalModalOpen(false);
    },
    [],
  );

  // Subscribe to IPC push events
  useEffect(() => {
    const unsubs = [
      subscribe('approval.requested', (req) => {
        setPendingApprovals((prev) => (prev.some((x) => x.id === req.id) ? prev : [...prev, req]));
        setApprovalModalOpen(true);
        pushNotification({
          tone: 'warning',
          title: pt ? 'Aprovação solicitada' : 'Approval requested',
          body: req.summary,
          targetSection: 'security',
        });
      }),
      subscribe('approval.decided', (decided) => {
        setPendingApprovals((prev) => prev.filter((x) => x.id !== decided.id));
        pushNotification({
          tone: decided.status === 'approved' ? 'success' : 'danger',
          title:
            decided.status === 'approved'
              ? pt
                ? 'Ação aprovada'
                : 'Action approved'
              : pt
                ? 'Ação recusada'
                : 'Action denied',
          body: decided.summary,
          targetSection: 'security',
        });
      }),
      subscribe('projects.changed', () => {
        void refreshProjects();
      }),
      subscribe('providers.changed', () => {
        void Promise.all([
          invoke('providers.listConfigured', {}),
          invoke('agents.list', {}),
          invoke('permissions.listPolicies', {}),
        ]).then(([p, a, pol]) => {
          setProviders(p);
          setAgents(a);
          setPolicies(pol);
        });
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }, [pt, pushNotification, refreshProjects]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'F1') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (!mod) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === '1') {
        e.preventDefault();
        setSection('workspace');
      } else if (e.key === '2') {
        e.preventDefault();
        setSection('projects');
      } else if (e.key === '3') {
        e.preventDefault();
        setSection('agents');
      } else if (e.key === '4') {
        e.preventDefault();
        setSection('security');
      } else if (e.key === '5' || e.key === ',') {
        e.preventDefault();
        setSection('settings');
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed });
      } else if (e.key.toLowerCase() === 'i') {
        e.preventDefault();
        updatePrefs({ inspectorOpen: !prefs.inspectorOpen });
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        updatePrefs({ terminalExpanded: !prefs.terminalExpanded });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.inspectorOpen, prefs.sidebarCollapsed, prefs.terminalExpanded, updatePrefs]);

  const handleImportProjectQuick = useCallback(async () => {
    const dir = await invoke('projects.pickDirectory', {});
    if (!dir) return;
    const created = await invoke('projects.register', { rootPath: dir });
    await refreshProjects();
    handleSelectProject(created.id);
    setSection('workspace');
  }, [handleSelectProject, refreshProjects]);

  const paletteCommands: PaletteCommand[] = useMemo(
    () => [
      {
        id: 'go-workspace',
        label: pt ? 'Ir para Workspace de Desenvolvimento' : 'Go to Workspace',
        shortcut: 'Ctrl+1',
        run: () => setSection('workspace'),
      },
      {
        id: 'go-projects',
        label: pt ? 'Ir para Gerenciamento de Projetos' : 'Go to Projects',
        shortcut: 'Ctrl+2',
        run: () => setSection('projects'),
      },
      {
        id: 'go-agents',
        label: pt ? 'Ir para Central de IA (Visão Geral)' : 'Go to AI Resource Center',
        shortcut: 'Ctrl+3',
        run: () => openAiCenterTab('overview'),
      },
      {
        id: 'go-ai-marketplace',
        label: pt
          ? 'Central de IA: Marketplace de Provedores e Cadastro Assistido'
          : 'AI Center: Provider Marketplace & Guided Signup',
        run: () => openAiCenterTab('marketplace'),
      },
      {
        id: 'go-ai-connections',
        label: pt ? 'Central de IA: Minhas Conexões' : 'AI Center: My Connections',
        run: () => openAiCenterTab('connections'),
      },
      {
        id: 'go-ai-models',
        label: pt ? 'Central de IA: Catálogo de Modelos' : 'AI Center: Model Catalog',
        run: () => openAiCenterTab('models'),
      },
      {
        id: 'go-ai-dev-agents',
        label: pt
          ? 'Central de IA: Agentes de Desenvolvimento (Claude, Codex, Antigravity, OpenCode)'
          : 'AI Center: Development Agents',
        run: () => openAiCenterTab('agents'),
      },
      {
        id: 'go-ai-local',
        label: pt
          ? 'Central de IA: Modelos Locais (Ollama / LM Studio)'
          : 'AI Center: Local Models',
        run: () => openAiCenterTab('local'),
      },
      {
        id: 'go-ai-quotas',
        label: pt ? 'Central de IA: Cotas e Disponibilidade' : 'AI Center: Quotas & Availability',
        run: () => openAiCenterTab('quotas'),
      },
      {
        id: 'go-ai-credits',
        label: pt ? 'Central de IA: Créditos e Orçamento' : 'AI Center: Credits & Budget',
        run: () => openAiCenterTab('credits'),
      },
      {
        id: 'go-ai-routing',
        label: pt
          ? 'Central de IA: Estratégias de Roteamento e Privacidade'
          : 'AI Center: Routing Strategies & Privacy',
        run: () => openAiCenterTab('routing'),
      },
      {
        id: 'go-ai-benchmarks',
        label: pt ? 'Central de IA: Benchmarks' : 'AI Center: Benchmarks',
        run: () => openAiCenterTab('benchmarks'),
      },
      {
        id: 'go-ai-diagnostics',
        label: pt ? 'Central de IA: Diagnóstico e Histórico' : 'AI Center: Diagnostics & History',
        run: () => openAiCenterTab('diagnostics'),
      },
      {
        id: 'go-security',
        label: pt ? 'Ir para Segurança e Aprovações' : 'Go to Security & Approvals',
        shortcut: 'Ctrl+4',
        run: () => setSection('security'),
      },
      {
        id: 'go-settings',
        label: pt ? 'Ir para Configurações' : 'Go to Settings',
        shortcut: 'Ctrl+5',
        run: () => setSection('settings'),
      },
      {
        id: 'import-project',
        label: pt ? 'Importar diretório de projeto…' : 'Import project directory…',
        run: () => void handleImportProjectQuick(),
      },
      {
        id: 'open-onboarding',
        label: pt ? 'Abrir assistente de configuração inicial' : 'Open setup wizard',
        run: () => setOnboardingOpen(true),
      },
      {
        id: 'toggle-sidebar',
        label: t.shell.toggleSidebar,
        shortcut: 'Ctrl+B',
        run: () => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed }),
      },
      {
        id: 'toggle-inspector',
        label: t.shell.toggleInspector,
        shortcut: 'Ctrl+I',
        run: () => updatePrefs({ inspectorOpen: !prefs.inspectorOpen }),
      },
    ],
    [
      handleImportProjectQuick,
      openAiCenterTab,
      prefs.inspectorOpen,
      prefs.sidebarCollapsed,
      pt,
      t.shell.toggleInspector,
      t.shell.toggleSidebar,
      updatePrefs,
    ],
  );

  const unreadNotifications = notifications.filter((n) => !n.read).length;
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const runningAgentIds = useMemo(
    () => new Set(runningExec.agentId ? [runningExec.agentId] : []),
    [runningExec.agentId],
  );
  const runningProviderIds = useMemo(
    () => new Set(runningExec.providerId ? [runningExec.providerId] : []),
    [runningExec.providerId],
  );

  const isWin32 = (systemInfo?.platform ?? 'win32') === 'win32';

  if (booting) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 10,
          background: tokens.color.background,
          color: tokens.color.textMuted,
        }}
      >
        <strong style={{ color: tokens.color.text, fontSize: 15 }}>DevBrain AI</strong>
        <span>Inicializando serviços locais e validando banco SQLite…</span>
      </div>
    );
  }

  const sidebarContent = (
    <nav
      aria-label={pt ? 'Navegação principal' : 'Primary navigation'}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 8,
        background: 'var(--db-sidebar)',
        borderRight: `1px solid ${tokens.color.border}`,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <button
          type="button"
          className="db-nav-item"
          data-active={section === 'workspace'}
          onClick={() => setSection('workspace')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <TerminalSquare size={15} />
            <span>{t.nav.workspace}</span>
          </span>
          {runningExec.executionId ? (
            <Badge tone="info" dot>
              {pt ? 'Ativo' : 'Live'}
            </Badge>
          ) : null}
        </button>

        <button
          type="button"
          className="db-nav-item"
          data-active={section === 'projects'}
          onClick={() => setSection('projects')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FolderGit2 size={15} />
            <span>{t.nav.projects}</span>
          </span>
          <Badge tone="neutral" mono>
            {activeProjects.length}
          </Badge>
        </button>

        <button
          type="button"
          className="db-nav-item"
          data-active={section === 'agents'}
          onClick={() => setSection('agents')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Bot size={15} />
            <span>{t.nav.agents}</span>
          </span>
          <Badge tone="neutral" mono>
            {agents.length}
          </Badge>
        </button>

        <button
          type="button"
          className="db-nav-item"
          data-active={section === 'security'}
          onClick={() => setSection('security')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <ShieldAlert size={15} />
            <span>{t.nav.security}</span>
          </span>
          {pendingApprovals.length > 0 ? (
            <Badge tone="warning" dot mono>
              {pendingApprovals.length}
            </Badge>
          ) : null}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          className="db-nav-item"
          data-active={section === 'settings'}
          onClick={() => setSection('settings')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Settings size={15} />
            <span>{t.nav.settings}</span>
          </span>
        </button>
      </div>
    </nav>
  );

  const contextInspectorContent = (
    <aside
      aria-label={pt ? 'Painel contextual' : 'Context panel'}
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 12,
        background: tokens.color.surface,
        borderLeft: `1px solid ${tokens.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: tokens.color.textFaint,
        }}
      >
        {pt ? 'Contexto operacional' : 'Operational context'}
      </div>

      <div className="db-card" style={{ padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
          {pt ? 'Projeto ativo' : 'Active project'}
        </div>
        {activeProject ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5 }}>
            <strong>{activeProject.name}</strong>
            <div className="db-mono db-faint" style={{ wordBreak: 'break-all', fontSize: 10.5 }}>
              {activeProject.rootPath}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <Badge
                tone={
                  activeProjectPrivacy === 'restricted'
                    ? 'danger'
                    : activeProjectPrivacy === 'commercial-confidential'
                      ? 'warning'
                      : 'outline'
                }
              >
                <Lock size={10} />{' '}
                {pt
                  ? PRIVACY_CLASSIFICATIONS[activeProjectPrivacy].labelPt
                  : PRIVACY_CLASSIFICATIONS[activeProjectPrivacy].labelEn}
              </Badge>
              {activeProject.isGitRepository ? <Badge tone="info">Git</Badge> : null}
              {activeProject.technologies.slice(0, 6).map((tech) => (
                <Badge key={tech.id} tone="outline">
                  {tech.name}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <div className="db-muted" style={{ fontSize: 11.5 }}>
            {pt ? 'Nenhum projeto selecionado.' : 'No project selected.'}
          </div>
        )}
      </div>

      <div className="db-card" style={{ padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          {pt ? 'Agentes configurados' : 'Configured agents'}
        </div>
        {agents.length === 0 ? (
          <div className="db-muted" style={{ fontSize: 11.5 }}>
            {pt ? 'Nenhum agente registrado.' : 'No agents registered.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {agents.map((ag) => {
              const enf = describeEnforcement(ag.capabilities, language);
              return (
                <div
                  key={ag.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    paddingBottom: 6,
                    borderBottom: `1px solid ${tokens.color.border}`,
                    fontSize: 11.5,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <strong>{ag.name}</strong>
                    <Badge tone={runningAgentIds.has(ag.id) ? 'info' : 'outline'}>
                      {runningAgentIds.has(ag.id) ? (pt ? 'Executando' : 'Running') : ag.status}
                    </Badge>
                  </div>
                  <span className="db-faint" style={{ fontSize: 10.5 }}>
                    {enf.badge}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="db-card"
        style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 5 }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          {pt ? 'Atalhos rápidos' : 'Quick shortcuts'}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
          <span className="db-muted">{pt ? 'Paleta' : 'Palette'}</span>
          <KeyHint keys="Ctrl+K" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
          <span className="db-muted">{pt ? 'Executar' : 'Run'}</span>
          <KeyHint keys="Ctrl+Enter" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
          <span className="db-muted">{pt ? 'Expandir terminal' : 'Expand terminal'}</span>
          <KeyHint keys="Ctrl+J" />
        </div>
      </div>
    </aside>
  );

  const mainViewContent = (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        background: tokens.color.background,
      }}
    >
      {bootError ? (
        <div style={{ padding: 12 }}>
          <Banner
            tone="danger"
            title={`${bootError.title} (${bootError.code})`}
            actions={
              <Button size="xs" variant="secondary" onClick={() => void refreshAll()}>
                {pt ? 'Tentar novamente' : 'Retry'}
              </Button>
            }
          >
            <div>{bootError.message}</div>
            <div className="db-muted" style={{ fontSize: 11.5 }}>
              {bootError.remediation}
            </div>
          </Banner>
        </div>
      ) : null}

      {storageHealth?.uncleanShutdownDetected && !dismissedRecoveryBanner ? (
        <div style={{ padding: '8px 12px 0 12px' }}>
          <Banner
            tone="warning"
            title={
              pt
                ? 'Encerramento abrupto detectado na execução anterior'
                : 'Unclean shutdown detected'
            }
            actions={
              <Button size="xs" variant="ghost" onClick={() => setDismissedRecoveryBanner(true)}>
                {pt ? 'Ocultar' : 'Dismiss'}
              </Button>
            }
          >
            {pt
              ? `Integridade do banco: ${storageHealth.integrity}. Sessões recuperadas para o estado interrompido: ${storageHealth.recoveredSessions}.`
              : `Database integrity: ${storageHealth.integrity}. Recovered sessions: ${storageHealth.recoveredSessions}.`}
          </Banner>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {section === 'workspace' ? (
          <WorkspaceView
            activeProject={activeProject}
            agents={agents}
            providers={providers}
            availableModels={discoveredAiModels}
            projectPrivacy={activeProjectPrivacy}
            onAgentModelUpdated={async () => {
              setAgents(await invoke('agents.list', {}));
            }}
            pendingApprovals={pendingApprovals}
            requestedSessionId={requestedSessionId}
            terminalAutoScroll={prefs.terminalAutoScroll}
            terminalExpanded={prefs.terminalExpanded}
            terminalHeight={prefs.terminalHeight}
            onToggleAutoScroll={() =>
              updatePrefs({ terminalAutoScroll: !prefs.terminalAutoScroll })
            }
            onToggleExpanded={() => updatePrefs({ terminalExpanded: !prefs.terminalExpanded })}
            onResizeTerminal={(h) => updatePrefs({ terminalHeight: h })}
            onOpenApprovalModal={() => setApprovalModalOpen(true)}
            onNavigate={setSection}
            onImportProjectQuick={handleImportProjectQuick}
            onExecutionActiveChange={setRunningExec}
            language={language}
          />
        ) : null}

        {section === 'projects' ? (
          <ProjectsView
            projects={projects}
            recentProjects={recentProjects}
            activeProjectId={activeProject?.id ?? null}
            agents={agents}
            policies={policies}
            projectPrivacyMap={projectPolicies}
            onChangeProjectPrivacy={handleChangeProjectPrivacy}
            onSelectProject={handleSelectProject}
            onOpenWorkspaceSession={(projectId, sessionId) => {
              handleSelectProject(projectId);
              setRequestedSessionId(sessionId ?? null);
              setSection('workspace');
            }}
            onRefreshProjects={async () => {
              await refreshProjects();
            }}
            language={language}
          />
        ) : null}

        {section === 'agents' ? (
          <AiResourceCenterView
            initialTab={aiCenterTab}
            projects={projects}
            activeProject={activeProject}
            projectPrivacy={activeProjectPrivacy}
            onChangeProjectPrivacy={(next) => {
              if (activeProject) handleChangeProjectPrivacy(activeProject.id, next);
            }}
            selectedStrategyPreset={prefs.selectedStrategyPreset}
            onChangeStrategyPreset={(preset) => updatePrefs({ selectedStrategyPreset: preset })}
            signupQueue={prefs.signupQueue}
            onUpdateSignupQueue={(next) => updatePrefs({ signupQueue: next })}
            adapters={adapters}
            providers={providers}
            agents={agents}
            credentials={credentials}
            policies={policies}
            settings={settings}
            dependencyReports={dependencyReports}
            runningProviderIds={runningProviderIds}
            runningAgentIds={runningAgentIds}
            onCheckAdapter={handleCheckAdapter}
            onRefreshCore={refreshAll}
            onModelsChanged={(models) => setDiscoveredAiModels(models)}
            onOpenWorkspace={() => setSection('workspace')}
            language={language}
          />
        ) : null}

        {section === 'security' ? (
          <ApprovalsSecurityView
            pendingApprovals={pendingApprovals}
            agents={agents}
            projects={projects}
            policies={policies}
            activeProjectId={activeProject?.id ?? null}
            onDecideApproval={handleDecideApproval}
            onRefreshPolicies={async () => {
              setPolicies(await invoke('permissions.listPolicies', {}));
            }}
            language={language}
          />
        ) : null}

        {section === 'settings' ? (
          <SettingsView
            settings={settings}
            systemInfo={systemInfo}
            storageHealth={storageHealth}
            onRefreshSystem={refreshSystemAndSettings}
            onReopenOnboarding={() => setOnboardingOpen(true)}
            language={language}
          />
        ) : null}
      </div>
    </main>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {/* Top Integrated Titlebar & Window Controls */}
      <header className="db-titlebar" style={{ paddingRight: isWin32 ? 148 : 12 }}>
        <div className="db-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            size="xs"
            variant="ghost"
            icon={<LayoutPanelLeft size={14} />}
            title={`${t.shell.toggleSidebar} (Ctrl+B)`}
            onClick={() => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })}
          />
          <span
            style={{
              fontWeight: 700,
              fontSize: 12.5,
              letterSpacing: 0.2,
              color: tokens.color.text,
              marginRight: 4,
            }}
          >
            DevBrain AI
          </span>

          <Select
            aria-label={pt ? 'Seletor de projeto ativo' : 'Active project selector'}
            value={activeProject?.id ?? ''}
            onChange={(e) => handleSelectProject(e.target.value || null)}
            style={{ width: 220, height: 26, fontSize: 12 }}
          >
            {activeProjects.length === 0 ? (
              <option value="">{t.shell.noActiveProject}</option>
            ) : null}
            {activeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="db-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Button
            size="xs"
            variant="secondary"
            icon={<Command size={12} />}
            onClick={() => setPaletteOpen(true)}
          >
            <span>{t.shell.commandPalette}</span>
            <KeyHint keys="Ctrl+K" />
          </Button>

          {pendingApprovals.length > 0 ? (
            <Button
              size="xs"
              variant="warning"
              icon={<ShieldAlert size={12} />}
              onClick={() => setApprovalModalOpen(true)}
            >
              {pendingApprovals.length} {t.shell.pendingApprovals}
            </Button>
          ) : null}

          <Button
            size="xs"
            variant="ghost"
            icon={<Sparkles size={13} />}
            title={t.shell.onboarding}
            onClick={() => setOnboardingOpen(true)}
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<HelpCircle size={13} />}
            title={`${t.shell.shortcuts} (F1)`}
            onClick={() => setShortcutsOpen(true)}
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<Bell size={13} />}
            title={t.shell.notifications}
            onClick={() => {
              setNotificationsOpen(true);
              setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
            }}
          >
            {unreadNotifications > 0 ? (
              <Badge tone="info" mono>
                {unreadNotifications}
              </Badge>
            ) : null}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            active={prefs.inspectorOpen}
            icon={<PanelRight size={14} />}
            title={`${t.shell.toggleInspector} (Ctrl+I)`}
            onClick={() => updatePrefs({ inspectorOpen: !prefs.inspectorOpen })}
          />
        </div>
      </header>

      {/* Resizable 3-Pane Desktop Shell */}
      <SplitPane
        direction="horizontal"
        controlledPane="first"
        initialSize={prefs.sidebarWidth}
        minSize={180}
        maxSize={340}
        collapsed={prefs.sidebarCollapsed}
        onResizeEnd={(w) => updatePrefs({ sidebarWidth: w })}
        first={sidebarContent}
        second={
          <SplitPane
            direction="horizontal"
            controlledPane="second"
            initialSize={prefs.inspectorWidth}
            minSize={240}
            maxSize={460}
            collapsed={!prefs.inspectorOpen}
            onResizeEnd={(w) => updatePrefs({ inspectorWidth: w })}
            first={mainViewContent}
            second={contextInspectorContent}
          />
        }
      />

      {/* Status Bar */}
      <footer
        style={{
          height: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          background: 'var(--db-titlebar)',
          borderTop: `1px solid ${tokens.color.border}`,
          fontSize: 11,
          color: tokens.color.textMuted,
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={() => setSection('settings')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: 'transparent',
              border: 'none',
              color: storageHealth
                ? storageHealth.integrity === 'ok'
                  ? tokens.color.success
                  : tokens.color.warning
                : tokens.color.danger,
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Database size={11} />
            <span>
              {storageHealth
                ? storageHealth.integrity === 'ok'
                  ? t.shell.dbOk
                  : t.shell.dbRecovered
                : t.shell.dbUnavailable}
            </span>
          </button>

          {activeProject ? <span className="db-mono">{activeProject.name}</span> : null}

          {runningExec.status ? (
            <span>{formatExecutionStatus(runningExec.status, language).label}</span>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{t.shell.unsignedBuildNote}</span>
          {systemInfo ? (
            <span className="db-mono">
              v{systemInfo.appVersion} · contracts {systemInfo.contractsVersion}
            </span>
          ) : null}
        </div>
      </footer>

      {/* Modals & Overlays */}
      <OnboardingModal
        open={onboardingOpen}
        projects={activeProjects}
        adapters={adapters}
        providers={providers}
        agents={agents}
        dependencyReports={dependencyReports}
        settings={settings}
        onRefreshAll={refreshAll}
        onSelectProject={handleSelectProject}
        onCheckAdapter={handleCheckAdapter}
        onComplete={() => {
          updatePrefs({ onboardingState: 'completed' });
          setOnboardingOpen(false);
          setSection('workspace');
        }}
        onSkip={() => {
          updatePrefs({ onboardingState: 'skipped' });
          setOnboardingOpen(false);
        }}
        language={language}
      />

      <ApprovalModal
        open={approvalModalOpen}
        approvals={pendingApprovals}
        agents={agents}
        projects={projects}
        onClose={() => setApprovalModalOpen(false)}
        onDecide={handleDecideApproval}
        language={language}
      />

      <NotificationsDialog
        open={notificationsOpen}
        notifications={notifications}
        onClose={() => setNotificationsOpen(false)}
        onMarkAllRead={() => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))}
        onNavigate={setSection}
        language={language}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        language={language}
      />

      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        language={language}
      />
    </div>
  );
};
