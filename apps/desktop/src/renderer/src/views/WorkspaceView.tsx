import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TERMINAL_EXECUTION_STATUSES,
  isLiveSession,
  type Agent,
  type AgentSession,
  type ApprovalRequest,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionStatus,
  type GitDiff,
  type GitStatus,
  type ModelDefinition,
  type Project,
  type ProviderProfile,
  type SessionHistory,
  type Workspace,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  KeyHint,
  Select,
  SplitPane,
  Tabs,
  Textarea,
  UntrustedBlock,
  tokens,
} from '@devbrain/ui';
import {
  AlertTriangle,
  Bot,
  Cpu,
  FolderOpen,
  GitBranch,
  History,
  Lock,
  Play,
  Plus,
  RotateCcw,
  Square,
  StopCircle,
} from 'lucide-react';
import { DiffViewer } from '../components/DiffViewer';
import { TerminalPane } from '../components/TerminalPane';
import { GatewayAgentPanel } from './GatewayAgentPanel';
import { PRIVACY_CLASSIFICATIONS, type ProjectPrivacyClass } from '../lib/ai-center';
import { describeError, invoke, subscribe, type DescribedError } from '../lib/bridge';
import {
  describeEnforcement,
  describeProviderStates,
  formatExecutionStatus,
  formatSessionStatus,
  formatTimestamp,
  formatUsageHonest,
  type AppLanguage,
  type NavSection,
} from '../lib/i18n';
import {
  createStreamSnapshot,
  mergeExecutionEvents,
  tokenizeCommandArgs,
  type StreamSnapshot,
} from '../lib/stream';

export interface WorkspaceViewProps {
  activeProject: Project | null;
  agents: readonly Agent[];
  providers: readonly ProviderProfile[];
  availableModels?: readonly ModelDefinition[] | undefined;
  projectPrivacy?: ProjectPrivacyClass | undefined;
  onAgentModelUpdated?: (() => Promise<void>) | undefined;
  pendingApprovals: readonly ApprovalRequest[];
  requestedSessionId: string | null;
  terminalAutoScroll: boolean;
  terminalExpanded: boolean;
  terminalHeight: number;
  onToggleAutoScroll: () => void;
  onToggleExpanded: () => void;
  onResizeTerminal: (height: number) => void;
  onOpenApprovalModal: () => void;
  onNavigate: (section: NavSection) => void;
  onImportProjectQuick: () => Promise<void>;
  onExecutionActiveChange: (info: {
    executionId: string | null;
    agentId: string | null;
    providerId: string | null;
    status: ExecutionStatus | null;
  }) => void;
  language: AppLanguage;
}

export const WorkspaceView = ({
  activeProject,
  agents,
  providers,
  availableModels = [],
  projectPrivacy = 'personal-private',
  onAgentModelUpdated,
  pendingApprovals,
  requestedSessionId,
  terminalAutoScroll,
  terminalExpanded,
  terminalHeight,
  onToggleAutoScroll,
  onToggleExpanded,
  onResizeTerminal,
  onOpenApprovalModal,
  onNavigate,
  onImportProjectQuick,
  onExecutionActiveChange,
  language,
}: WorkspaceViewProps) => {
  const pt = language === 'pt-BR';

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  // Composer state
  const [mode, setMode] = useState<'prompt' | 'command'>('prompt');
  const [promptText, setPromptText] = useState('');
  const [contextFilesText, setContextFilesText] = useState('');
  const [cmdExecutable, setCmdExecutable] = useState('node');
  const [cmdArgsText, setCmdArgsText] = useState('-v');

  // Execution & stream state
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [stream, setStream] = useState<StreamSnapshot>(() => createStreamSnapshot(''));
  const streamRef = useRef<StreamSnapshot>(stream);
  streamRef.current = stream;

  const [sessionHistory, setSessionHistory] = useState<SessionHistory | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiff | null>(null);
  const [loadingGit, setLoadingGit] = useState(false);

  const [bottomTab, setBottomTab] = useState<
    'terminal' | 'events' | 'files' | 'diff' | 'result' | 'history'
  >('terminal');
  const [submitting, setSubmitting] = useState(false);
  // DevBrain gateway agent options (only used when the selected agent is `devbrain-agent`).
  const [gwPolicies, setGwPolicies] = useState<
    { id: string; allowPaid: boolean; allowUnknownCost: boolean; privacy: string }[]
  >([]);
  const [gwPolicyId, setGwPolicyId] = useState('');
  const [gwModelId, setGwModelId] = useState('');
  const [gwCommandsText, setGwCommandsText] = useState('test: node --test');
  const [gwMaxTurns, setGwMaxTurns] = useState('24');
  const [opError, setOpError] = useState<DescribedError | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null,
    [agents, selectedAgentId],
  );
  const selectedProvider = useMemo(
    () =>
      selectedAgent
        ? (providers.find((p) => p.provider.id === selectedAgent.providerId) ?? null)
        : null,
    [providers, selectedAgent],
  );
  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const privacyMeta = PRIVACY_CLASSIFICATIONS[projectPrivacy];
  const isAgentTargetLocal = useMemo(() => {
    if (!selectedAgent) return false;
    if (selectedProvider?.provider.kind === 'local-model') return true;
    if (
      selectedProvider?.provider.adapterKey === 'opencode-cli' &&
      selectedAgent.model &&
      /^(ollama|lmstudio|local)\//i.test(selectedAgent.model)
    ) {
      return true;
    }
    return false;
  }, [selectedAgent, selectedProvider]);

  const isGatewayAgent = selectedProvider?.provider.adapterKey === 'devbrain-agent';
  // The gateway agent is not blocked here: the gateway itself keeps restricted projects on
  // local routes only (enforced per model call in the main process, not in this view).
  const isRestrictedExternalPromptBlocked =
    projectPrivacy === 'restricted' &&
    mode === 'prompt' &&
    Boolean(selectedAgent) &&
    !isAgentTargetLocal &&
    !isGatewayAgent;
  const gatewayToolModels = useMemo(
    () => availableModels.filter((m) => m.capabilities.tools && m.lifecycle !== 'deprecated'),
    [availableModels],
  );
  useEffect(() => {
    if (!isGatewayAgent) return;
    let cancelled = false;
    void invoke('ai.policies.list', {})
      .then((list) => {
        if (cancelled) return;
        const mapped = list.map((entry) => ({
          id: entry.policy.id,
          allowPaid: entry.billing.allowPaid,
          allowUnknownCost: entry.billing.allowUnknownCost,
          privacy: entry.privacy.mode,
        }));
        setGwPolicies(mapped);
        setGwPolicyId((current) =>
          current && mapped.some((m) => m.id === current)
            ? current
            : (mapped.find((m) => !m.allowPaid && !m.allowUnknownCost)?.id ?? mapped[0]?.id ?? ''),
        );
      })
      .catch(() => {
        if (!cancelled) setGwPolicies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isGatewayAgent]);
  /** `id: executable arg arg` per line; no shell, no quoting (each token is one argument). */
  const parseGatewayCommands = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^([a-z0-9][a-z0-9_-]{0,39})\s*:\s*(\S+)(.*)$/.exec(line);
        if (!match) throw new Error(line);
        return {
          id: match[1]!,
          executable: match[2]!,
          args: match[3]!.trim() ? match[3]!.trim().split(/\s+/) : [],
          timeoutMs: 120_000,
        };
      });

  const selectableModelOptions = useMemo(() => {
    const map = new Map<string, string>();
    if (selectedAgent?.model) {
      map.set(selectedAgent.model, selectedAgent.model);
    }
    for (const mod of selectedProvider?.config.models ?? []) {
      if (!map.has(mod.id)) map.set(mod.id, mod.displayName ?? mod.id);
    }
    for (const m of availableModels) {
      const value = m.upstreamModelId;
      const label = `${m.name} [${m.providerId}]`;
      if (!map.has(value)) map.set(value, label);
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [availableModels, selectedAgent?.model, selectedProvider?.config.models]);

  const [updatingModel, setUpdatingModel] = useState(false);
  const handleChangeAgentModel = async (nextModelValue: string) => {
    if (!selectedAgent) return;
    setUpdatingModel(true);
    setOpError(null);
    try {
      await invoke('agents.update', {
        id: selectedAgent.id,
        model: nextModelValue.trim() ? nextModelValue.trim() : null,
      });
      await onAgentModelUpdated?.();
    } catch (e) {
      setOpError(describeError(e, language));
    } finally {
      setUpdatingModel(false);
    }
  };

  useEffect(() => {
    if (!selectedAgentId && agents[0]) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const refreshGit = useCallback(async (wsId: string) => {
    if (!wsId) return;
    setLoadingGit(true);
    try {
      const [st, df] = await Promise.all([
        invoke('git.status', { workspaceId: wsId }),
        invoke('git.diff', { workspaceId: wsId }),
      ]);
      setGitStatus(st);
      setGitDiff(df);
    } catch {
      setGitStatus(null);
      setGitDiff(null);
    } finally {
      setLoadingGit(false);
    }
  }, []);

  const loadProjectContext = useCallback(
    async (project: Project) => {
      try {
        const [wsList, sessList, projSettings] = await Promise.all([
          invoke('workspaces.list', { projectId: project.id }),
          invoke('sessions.listByProject', { projectId: project.id }),
          invoke('projects.getSettings', { id: project.id }),
        ]);
        setWorkspaces(wsList);
        const ws0 = wsList.find((w) => w.id === project.defaultWorkspaceId) ?? wsList[0];
        if (ws0) {
          setSelectedWorkspaceId(ws0.id);
          void refreshGit(ws0.id);
        }
        setSessions(sessList);
        if (
          projSettings.preferredAgentId &&
          agents.some((a) => a.id === projSettings.preferredAgentId)
        ) {
          setSelectedAgentId(projSettings.preferredAgentId);
        }
        const preferredSession =
          (requestedSessionId ? sessList.find((s) => s.id === requestedSessionId) : undefined) ??
          sessList.find((s) => isLiveSession(s.status)) ??
          sessList[0];
        setSelectedSessionId(preferredSession?.id ?? '');
      } catch (e) {
        setOpError(describeError(e, language));
      }
    },
    [agents, language, refreshGit, requestedSessionId],
  );

  useEffect(() => {
    if (!activeProject) {
      setWorkspaces([]);
      setSelectedWorkspaceId('');
      setSessions([]);
      setSelectedSessionId('');
      setSessionHistory(null);
      setGitStatus(null);
      setGitDiff(null);
      return;
    }
    void loadProjectContext(activeProject);
  }, [activeProject, loadProjectContext]);

  const loadExecutionReplay = useCallback(async (executionId: string, afterSeq = -1) => {
    const persisted = await invoke('executions.listEvents', {
      executionId,
      afterSeq,
      limit: 5000,
    });
    setStream((prev) => {
      const base = prev.executionId === executionId ? prev : createStreamSnapshot(executionId);
      return mergeExecutionEvents(base, persisted).snapshot;
    });
    const res = await invoke('executions.getResult', { executionId });
    if (res) {
      setExecutionResult(res);
      setExecutionStatus(res.status);
    }
  }, []);

  const loadSessionDetails = useCallback(
    async (sessionId: string) => {
      if (!sessionId) {
        setSessionHistory(null);
        return;
      }
      try {
        const hist = await invoke('sessions.history', { sessionId });
        setSessionHistory(hist);
        const latestExec = hist.executions[hist.executions.length - 1];
        if (latestExec && !activeExecutionId) {
          setActiveExecutionId(latestExec.request.id);
          setExecutionStatus(latestExec.status);
          setExecutionResult(latestExec.result);
          await loadExecutionReplay(latestExec.request.id, -1);
        }
      } catch (e) {
        setOpError(describeError(e, language));
      }
    },
    [activeExecutionId, language, loadExecutionReplay],
  );

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionDetails(selectedSessionId);
    } else {
      setSessionHistory(null);
    }
  }, [selectedSessionId, loadSessionDetails]);

  // Subscribe to real-time `execution.event` and `sessions.changed`
  useEffect(() => {
    const unsubExec = subscribe('execution.event', (ev: ExecutionEvent) => {
      if (ev.executionId !== streamRef.current.executionId) return;
      const merged = mergeExecutionEvents(streamRef.current, [ev]);
      setStream(merged.snapshot);
      if (ev.type === 'status') {
        setExecutionStatus(ev.status);
      }
      if (ev.type === 'approval-required') {
        setExecutionStatus('awaiting-approval');
      }
      if (merged.snapshot.hasGap) {
        void loadExecutionReplay(ev.executionId, -1);
      }
      if (ev.type === 'status' && TERMINAL_EXECUTION_STATUSES.has(ev.status)) {
        void invoke('executions.getResult', { executionId: ev.executionId }).then((res) => {
          if (res) setExecutionResult(res);
        });
        if (selectedSessionId) {
          void invoke('sessions.history', { sessionId: selectedSessionId }).then(setSessionHistory);
        }
        if (selectedWorkspaceId) {
          void refreshGit(selectedWorkspaceId);
        }
      }
    });

    const unsubSess = subscribe('sessions.changed', (updated: AgentSession) => {
      if (activeProject && updated.projectId === activeProject.id) {
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === updated.id);
          return exists ? prev.map((s) => (s.id === updated.id ? updated : s)) : [updated, ...prev];
        });
      }
    });

    return () => {
      unsubExec();
      unsubSess();
    };
  }, [activeProject, loadExecutionReplay, refreshGit, selectedSessionId, selectedWorkspaceId]);

  const isRunning = Boolean(executionStatus && !TERMINAL_EXECUTION_STATUSES.has(executionStatus));

  // Poll result while execution is active (covers fast commands & pending session approval transitions)
  useEffect(() => {
    if (!activeExecutionId || !isRunning) return;
    const hasPendingForSession = pendingApprovals.some(
      (a) => a.sessionId === selectedSessionId || a.executionId === activeExecutionId,
    );
    if (hasPendingForSession && executionStatus === 'queued') {
      setExecutionStatus('awaiting-approval');
    }
    const timer = setInterval(() => {
      void (async () => {
        const events = await invoke('executions.listEvents', {
          executionId: activeExecutionId,
          afterSeq: streamRef.current.highestSeq,
          limit: 1000,
        }).catch(() => []);
        if (events.length > 0) {
          setStream((prev) => mergeExecutionEvents(prev, events).snapshot);
        }
        const res = await invoke('executions.getResult', {
          executionId: activeExecutionId,
        }).catch(() => null);
        if (res) {
          setExecutionResult(res);
          setExecutionStatus(res.status);
          if (selectedSessionId) {
            const hist = await invoke('sessions.history', { sessionId: selectedSessionId }).catch(
              () => null,
            );
            if (hist) setSessionHistory(hist);
          }
          if (selectedWorkspaceId) void refreshGit(selectedWorkspaceId);
        }
      })();
    }, 450);
    return () => clearInterval(timer);
  }, [
    activeExecutionId,
    executionStatus,
    isRunning,
    pendingApprovals,
    refreshGit,
    selectedSessionId,
    selectedWorkspaceId,
  ]);

  // Notify parent shell of running execution status
  useEffect(() => {
    onExecutionActiveChange({
      executionId: isRunning ? activeExecutionId : null,
      agentId: isRunning ? (selectedAgent?.id ?? null) : null,
      providerId: isRunning ? (selectedAgent?.providerId ?? null) : null,
      status: executionStatus,
    });
  }, [activeExecutionId, executionStatus, isRunning, onExecutionActiveChange, selectedAgent]);

  const handleStartNewSession = async (resumeFrom?: AgentSession) => {
    if (!activeProject || !selectedAgent || !selectedWorkspaceId) return null;
    setOpError(null);
    try {
      const created = await invoke('sessions.start', {
        agentId: selectedAgent.id,
        projectId: activeProject.id,
        workspaceId: selectedWorkspaceId,
        title: resumeFrom
          ? `${pt ? 'Continuação' : 'Resumed'} — ${selectedAgent.name}`
          : `${selectedAgent.name} — ${new Date().toLocaleTimeString(language, { hour12: false })}`,
        ...(resumeFrom ? { resumeFromSessionId: resumeFrom.id } : {}),
        ...(resumeFrom?.lastCheckpointId
          ? { resumeFromCheckpointId: resumeFrom.lastCheckpointId }
          : {}),
      });
      if (resumeFrom?.lastCheckpointId) {
        const ckpt = await invoke('checkpoints.get', { id: resumeFrom.lastCheckpointId }).catch(
          () => null,
        );
        if (ckpt && typeof ckpt.state.task === 'string' && !promptText.trim()) {
          setPromptText(ckpt.state.task);
        }
      }
      setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
      setSelectedSessionId(created.id);
      setActiveExecutionId(null);
      setExecutionStatus(null);
      setExecutionResult(null);
      setStream(createStreamSnapshot(''));
      return created;
    } catch (e) {
      setOpError(describeError(e, language));
      return null;
    }
  };

  const handleStopSession = async () => {
    if (!selectedSession) return;
    setOpError(null);
    try {
      const stopped = await invoke('sessions.stop', { sessionId: selectedSession.id });
      setSessions((prev) => prev.map((s) => (s.id === stopped.id ? stopped : s)));
    } catch (e) {
      setOpError(describeError(e, language));
    }
  };

  const handleSubmitExecution = async () => {
    if (!activeProject || !selectedAgent || !selectedWorkspaceId) return;
    if (mode === 'prompt' && !promptText.trim()) return;
    if (mode === 'command' && !cmdExecutable.trim()) return;
    if (isRestrictedExternalPromptBlocked) {
      setOpError({
        code: 'PERMISSION_DENIED',
        title: pt
          ? 'Projeto Restrito bloqueia envio de prompts para nuvem externa'
          : 'Restricted project blocks external cloud prompts',
        message: pt
          ? 'Este projeto está classificado como Restrito (somente execução local). Prompts ao agente selecionado enviariam contexto para endpoint externo.'
          : 'This project is classified as Restricted (local-only).',
        remediation: pt
          ? 'Selecione um runtime/modelo local (ex.: OpenCode com ollama/<modelo>), utilize Processo autorizado (sem shell) ou ajuste a classificação em Projetos.'
          : 'Select a local runtime/model or adjust the project privacy classification.',
        retryable: false,
      });
      return;
    }

    setOpError(null);
    setSubmitting(true);
    try {
      let targetSession =
        selectedSession &&
        isLiveSession(selectedSession.status) &&
        selectedSession.agentId === selectedAgent.id &&
        selectedSession.workspaceId === selectedWorkspaceId
          ? selectedSession
          : null;

      if (!targetSession) {
        targetSession = await handleStartNewSession();
        if (!targetSession) return;
      }

      let gateway = undefined;
      if (mode === 'prompt' && isGatewayAgent) {
        if (!gwPolicyId) {
          setOpError({
            code: 'VALIDATION_FAILED',
            title: pt ? 'Escolha uma estratégia de roteamento' : 'Choose a routing strategy',
            message: pt
              ? 'O agente DevBrain usa o AI Gateway; configure uma estratégia (ex.: somente gratuito ou somente local) na Central de IA.'
              : 'The DevBrain agent uses the AI gateway; configure a strategy in the AI Center.',
            remediation: pt ? 'Abra a Central de IA → Roteamento.' : 'Open AI Center → Routing.',
            retryable: false,
          });
          return;
        }
        let allowedCommands;
        try {
          allowedCommands = parseGatewayCommands(gwCommandsText);
        } catch (e) {
          setOpError({
            code: 'VALIDATION_FAILED',
            title: pt ? 'Comando pré-autorizado inválido' : 'Invalid pre-authorized command',
            message: `${pt ? 'Use o formato' : 'Use the format'} "id: executável arg1 arg2" — ${e instanceof Error ? e.message : ''}`,
            remediation: pt
              ? 'Ids em minúsculas (a-z, 0-9, -, _); o executável não pode ser um shell.'
              : 'Lowercase ids (a-z, 0-9, -, _); the executable cannot be a shell.',
            retryable: false,
          });
          return;
        }
        gateway = {
          routingPolicyId: gwPolicyId,
          modelId: gwModelId || null,
          allowedCommands,
          maxTurns: Math.min(100, Math.max(1, Number.parseInt(gwMaxTurns, 10) || 24)),
          maxToolCalls: 80,
          maxTotalTokens: 400_000,
          maxDurationMs: 20 * 60 * 1000,
          maxOutputTokensPerTurn: 4096,
        };
      }
      const payload =
        mode === 'prompt'
          ? {
              kind: 'prompt' as const,
              prompt: promptText.trim(),
              contextFiles: contextFilesText
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              ...(gateway ? { gateway } : {}),
            }
          : {
              kind: 'command' as const,
              executable: cmdExecutable.trim(),
              args: tokenizeCommandArgs(cmdArgsText),
            };

      const handle = await invoke('executions.submit', {
        sessionId: targetSession.id,
        payload,
      });

      setActiveExecutionId(handle.executionId);
      setExecutionStatus(handle.status);
      setExecutionResult(null);
      setStream(createStreamSnapshot(handle.executionId));
      setBottomTab('terminal');

      await loadExecutionReplay(handle.executionId, -1);
    } catch (e) {
      setOpError(describeError(e, language));
    } finally {
      setSubmitting(false);
    }
  };

  const handleInterrupt = async (interruptMode: 'graceful' | 'force') => {
    if (!activeExecutionId) return;
    setOpError(null);
    try {
      const res = await invoke('executions.interrupt', {
        executionId: activeExecutionId,
        mode: interruptMode,
      });
      setExecutionStatus(res.status);
    } catch (e) {
      setOpError(describeError(e, language));
    }
  };

  if (!activeProject) {
    return (
      <div style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: 28 }}>
        <EmptyState
          icon={<FolderOpen size={28} />}
          title={pt ? 'Nenhum projeto selecionado no Workspace' : 'No active project selected'}
          description={
            pt
              ? 'Importe um diretório local existente ou selecione um projeto na barra superior para iniciar sessões de desenvolvimento com agentes.'
              : 'Import a directory or select a project from the top bar.'
          }
          actions={
            <>
              <Button
                variant="primary"
                icon={<FolderOpen size={14} />}
                onClick={() => void onImportProjectQuick()}
              >
                {pt ? 'Importar diretório agora' : 'Import folder now'}
              </Button>
              <Button variant="secondary" onClick={() => onNavigate('projects')}>
                {pt ? 'Gerenciar projetos' : 'Manage projects'}
              </Button>
            </>
          }
        />
      </div>
    );
  }

  const interruptedSession = sessions.find((s) => s.status === 'interrupted');
  const enforcement = selectedAgent
    ? describeEnforcement(selectedAgent.capabilities, language)
    : null;
  const providerBadges = selectedProvider
    ? describeProviderStates(selectedProvider, isRunning, language)
    : null;
  const usageFormatted = formatUsageHonest(
    executionResult?.usage,
    selectedAgent?.capabilities.costModel ?? 'unknown',
    language,
  );

  const modifiedFilesCount =
    (sessionHistory?.files.length ?? 0) + (gitStatus ? gitStatus.files.length : 0);

  const topComposerPane = (
    <div
      data-testid="workspace-composer-scroll"
      data-scroll-region="workspace-composer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'auto',
        padding: '10px 14px',
        gap: 10,
      }}
    >
      {/* Session & Workspace Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          flexShrink: 0,
          paddingBottom: 8,
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Select
            aria-label={pt ? 'Workspace' : 'Workspace'}
            value={selectedWorkspaceId}
            onChange={(e) => {
              setSelectedWorkspaceId(e.target.value);
              void refreshGit(e.target.value);
            }}
            style={{ width: 190, height: 28 }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name} ({ws.kind})
              </option>
            ))}
          </Select>

          {gitStatus ? (
            <Badge tone="info" mono>
              <GitBranch size={11} /> {gitStatus.branch ?? 'detached'}{' '}
              {gitStatus.clean ? '· limpo' : `· ${gitStatus.files.length} alt.`}
            </Badge>
          ) : null}

          <Select
            aria-label={pt ? 'Sessão ativa' : 'Session'}
            value={selectedSessionId}
            onChange={(e) => {
              const sid = e.target.value;
              setSelectedSessionId(sid);
              setActiveExecutionId(null);
              setExecutionStatus(null);
              setExecutionResult(null);
              setStream(createStreamSnapshot(''));
            }}
            style={{ width: 250, height: 28 }}
          >
            <option value="">
              {pt ? 'Nova sessão automática ao executar' : 'Auto-start session'}
            </option>
            {sessions.map((s) => {
              const st = formatSessionStatus(s.status, language);
              return (
                <option key={s.id} value={s.id}>
                  [{st.label}] {s.title ?? s.id.slice(0, 14)}
                </option>
              );
            })}
          </Select>

          <Button
            size="xs"
            variant="secondary"
            icon={<Plus size={12} />}
            disabled={!selectedAgent}
            onClick={() => void handleStartNewSession()}
          >
            {pt ? 'Nova sessão' : 'New session'}
          </Button>
          {selectedSession && isLiveSession(selectedSession.status) ? (
            <Button
              size="xs"
              variant="ghost"
              icon={<StopCircle size={12} />}
              onClick={() => void handleStopSession()}
            >
              {pt ? 'Encerrar sessão' : 'End session'}
            </Button>
          ) : null}
        </div>

        {/* Execution status & cancel controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Badge
            tone={
              projectPrivacy === 'restricted'
                ? 'danger'
                : projectPrivacy === 'commercial-confidential'
                  ? 'warning'
                  : 'outline'
            }
            title={privacyMeta.summaryPt}
          >
            <Lock size={10} /> {pt ? privacyMeta.labelPt : privacyMeta.labelEn}
          </Badge>
          {executionStatus ? (
            <Badge tone={formatExecutionStatus(executionStatus, language).tone} dot>
              {formatExecutionStatus(executionStatus, language).label}
            </Badge>
          ) : null}
          {isRunning ? (
            <>
              <Button
                size="xs"
                variant="warning"
                icon={<Square size={11} />}
                onClick={() => void handleInterrupt('graceful')}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </Button>
              <Button size="xs" variant="danger" onClick={() => void handleInterrupt('force')}>
                {pt ? 'Forçar parada' : 'Force kill'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Banners: Interrupted Session Recovery / Pending Approvals / Errors */}
      {interruptedSession && selectedSession?.id === interruptedSession.id ? (
        <Banner
          tone="warning"
          icon={<RotateCcw size={15} />}
          title={
            pt
              ? 'Sessão interrompida detectada (processos órfãos não são retomados silenciosamente)'
              : 'Interrupted session detected'
          }
          actions={
            <Button
              size="xs"
              variant="primary"
              icon={<RotateCcw size={12} />}
              onClick={() => void handleStartNewSession(interruptedSession)}
            >
              {pt
                ? 'Iniciar nova sessão a partir do checkpoint'
                : 'Start new session from checkpoint'}
            </Button>
          }
        >
          {pt
            ? `Motivo registrado: ${interruptedSession.endReason ?? 'encerramento abrupto da instância anterior'}.`
            : (interruptedSession.endReason ?? 'Unclean shutdown.')}
        </Banner>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <Banner
          tone="warning"
          icon={<AlertTriangle size={15} />}
          title={
            pt
              ? `${pendingApprovals.length} solicitação(ões) aguardando aprovação humana`
              : `${pendingApprovals.length} approval request(s) pending`
          }
          actions={
            <Button size="xs" variant="primary" onClick={onOpenApprovalModal}>
              {pt ? 'Revisar e decidir agora' : 'Review & decide'}
            </Button>
          }
        >
          {pendingApprovals[0]?.summary}
        </Banner>
      ) : null}

      {opError ? (
        <Banner
          tone="danger"
          title={`${opError.title} (${opError.code})`}
          actions={
            <Button size="xs" variant="ghost" onClick={() => setOpError(null)}>
              ×
            </Button>
          }
        >
          <div>{opError.message}</div>
          <div className="db-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            {opError.remediation}
          </div>
        </Banner>
      ) : null}

      {/* Agent Selection & Composer */}
      {activeProject ? (
        <GatewayAgentPanel projectId={activeProject.id} language={language} />
      ) : null}
      {agents.length === 0 ? (
        <Banner
          tone="info"
          title={pt ? 'Configure um agente para iniciar execuções' : 'Configure an agent first'}
          actions={
            <Button
              size="xs"
              variant="primary"
              icon={<Bot size={12} />}
              onClick={() => onNavigate('agents')}
            >
              {pt ? 'Abrir Central de IA' : 'Open AI Resource Center'}
            </Button>
          }
        >
          {pt
            ? 'Cadastre Claude Code, OpenAI Codex, Google Antigravity ou OpenCode na Central de IA.'
            : 'Register an agent in the AI Resource Center.'}
        </Banner>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Select
                aria-label={pt ? 'Agente selecionado' : 'Selected agent'}
                value={selectedAgent?.id ?? ''}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                style={{ width: 220, height: 28 }}
              >
                {agents.map((a) => {
                  const prov = providers.find((p) => p.provider.id === a.providerId);
                  return (
                    <option key={a.id} value={a.id}>
                      {a.name} {prov ? `[${prov.provider.adapterKey}]` : ''}
                    </option>
                  );
                })}
              </Select>
              {isGatewayAgent ? (
                <>
                  <Select
                    aria-label={pt ? 'Estratégia de roteamento' : 'Routing strategy'}
                    value={gwPolicyId}
                    disabled={isRunning}
                    onChange={(e) => setGwPolicyId(e.target.value)}
                    style={{ width: 220, height: 28 }}
                  >
                    {gwPolicies.length === 0 ? (
                      <option value="">
                        {pt ? 'Nenhuma estratégia configurada' : 'No strategy configured'}
                      </option>
                    ) : null}
                    {gwPolicies.map((policy) => (
                      <option key={policy.id} value={policy.id}>
                        {policy.id} ·{' '}
                        {!policy.allowPaid && !policy.allowUnknownCost
                          ? pt
                            ? 'somente gratuito/local'
                            : 'free/local only'
                          : pt
                            ? 'pode ter custo'
                            : 'may incur cost'}{' '}
                        · {policy.privacy}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={pt ? 'Modelo do gateway' : 'Gateway model'}
                    value={gwModelId}
                    disabled={isRunning}
                    onChange={(e) => setGwModelId(e.target.value)}
                    style={{ width: 220, height: 28 }}
                  >
                    <option value="">{pt ? 'Roteamento automático' : 'Automatic routing'}</option>
                    {gatewayToolModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} [{m.providerId}]
                      </option>
                    ))}
                  </Select>
                </>
              ) : (
                <Select
                  aria-label={pt ? 'Modelo do agente' : 'Agent model'}
                  value={selectedAgent?.model ?? ''}
                  disabled={!selectedAgent || updatingModel || isRunning}
                  onChange={(e) => void handleChangeAgentModel(e.target.value)}
                  style={{ width: 220, height: 28 }}
                >
                  <option value="">
                    {pt ? 'Modelo padrão do runtime' : 'Runtime default model'}
                  </option>
                  {selectableModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              )}
              {selectedAgent?.model ? (
                <Badge tone="info" mono>
                  <Cpu size={10} /> {selectedAgent.model}
                </Badge>
              ) : null}
              {providerBadges ? (
                <Badge tone={providerBadges.primary.tone} dot>
                  {providerBadges.primary.label}
                </Badge>
              ) : null}
              {enforcement ? (
                <Badge tone={enforcement.tone} title={enforcement.warnings.join(' ')}>
                  {enforcement.badge}
                </Badge>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Button
                size="xs"
                variant={mode === 'prompt' ? 'primary' : 'secondary'}
                onClick={() => setMode('prompt')}
              >
                {pt ? 'Instrução ao agente' : 'Agent prompt'}
              </Button>
              <Button
                size="xs"
                variant={mode === 'command' ? 'primary' : 'secondary'}
                onClick={() => setMode('command')}
              >
                {pt ? 'Processo autorizado (sem shell)' : 'Authorized command'}
              </Button>
            </div>
          </div>

          {isRestrictedExternalPromptBlocked ? (
            <Banner
              tone="danger"
              icon={<Lock size={14} />}
              title={
                pt
                  ? 'Projeto classificado como Restrito: envio a provedores externos bloqueado'
                  : 'Restricted project: external cloud prompts blocked'
              }
              actions={
                <Button size="xs" variant="secondary" onClick={() => onNavigate('agents')}>
                  {pt ? 'Configurar modelo local' : 'Configure local model'}
                </Button>
              }
            >
              {pt
                ? 'Somente runtimes locais (ex.: OpenCode com ollama/<modelo> ou provedor local-model) ou Processos autorizados locais podem ser executados neste projeto.'
                : 'Only local runtimes or authorized local processes are allowed in Restricted projects.'}
            </Banner>
          ) : null}

          {enforcement && enforcement.level !== 'per-action' && mode === 'prompt' ? (
            <div
              style={{
                fontSize: 11.5,
                color: tokens.color.warning,
                background: tokens.color.warningSubtle,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                padding: '5px 9px',
              }}
            >
              {enforcement.warnings[0]}
            </div>
          ) : null}

          {mode === 'prompt' && isGatewayAgent ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px',
                gap: 8,
                alignItems: 'start',
                fontSize: 11.5,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="db-faint">
                  {pt
                    ? 'Comandos pré-autorizados (um por linha, "id: executável args"; sem shell). O modelo só pode escolher pelo id; cada execução ainda passa pela política e pode pedir aprovação.'
                    : 'Pre-authorized commands (one per line, "id: executable args"; no shell). The model can only pick them by id; each run is still policy-checked and may ask for approval.'}
                </span>
                <Textarea
                  value={gwCommandsText}
                  disabled={isRunning}
                  onChange={(e) => setGwCommandsText(e.target.value)}
                  style={{ minHeight: 44, fontFamily: 'monospace', fontSize: 11.5 }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="db-faint">{pt ? 'Máx. turnos' : 'Max turns'}</span>
                <Input
                  mono
                  value={gwMaxTurns}
                  disabled={isRunning}
                  onChange={(e) => setGwMaxTurns(e.target.value.replace(/[^0-9]/g, ''))}
                  style={{ height: 28 }}
                />
              </div>
            </div>
          ) : null}

          {mode === 'prompt' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Textarea
                value={promptText}
                placeholder={
                  pt
                    ? 'Descreva a tarefa de engenharia para o agente selecionado… (Ctrl+Enter para iniciar execução)'
                    : 'Describe the engineering instruction… (Ctrl+Enter to run)'
                }
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void handleSubmitExecution();
                  }
                }}
                style={{ minHeight: 74 }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <Input
                  mono
                  value={contextFilesText}
                  placeholder={
                    pt
                      ? 'Arquivos de contexto opcionais relativos ao workspace (ex.: src/index.ts, package.json)'
                      : 'Optional workspace-relative context files'
                  }
                  onChange={(e) => setContextFilesText(e.target.value)}
                  style={{ height: 28, fontSize: 11.5 }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Play size={13} />}
                  loading={submitting}
                  disabled={!promptText.trim() || isRunning || isRestrictedExternalPromptBlocked}
                  onClick={() => void handleSubmitExecution()}
                >
                  <span>{pt ? 'Executar' : 'Run'}</span>
                  <KeyHint keys="Ctrl+Enter" />
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '200px 1fr auto',
                  gap: 8,
                  alignItems: 'end',
                }}
              >
                <Field label={pt ? 'Executável (sem shell)' : 'Executable (no shell)'}>
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      value={cmdExecutable}
                      placeholder="node"
                      onChange={(e) => setCmdExecutable(e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label={
                    pt
                      ? 'Argumentos (separados por espaço ou 1 por linha)'
                      : 'Arguments (space or newline separated)'
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      value={cmdArgsText}
                      placeholder="-e process.stdout.write('ok')"
                      onChange={(e) => setCmdArgsText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault();
                          void handleSubmitExecution();
                        }
                      }}
                    />
                  )}
                </Field>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Play size={13} />}
                  loading={submitting}
                  disabled={!cmdExecutable.trim() || isRunning}
                  onClick={() => void handleSubmitExecution()}
                >
                  {pt ? 'Executar processo' : 'Run command'}
                </Button>
              </div>
              <div className="db-faint" style={{ fontSize: 11 }}>
                {pt
                  ? 'Invocado via child_process.spawn com shell: false e validado por Core.authorizeCommand (sujeito à política do agente e aprovação humana).'
                  : 'Spawned with shell: false and validated by Core.authorizeCommand.'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const bottomOperationalPane = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <Tabs
        tabs={[
          {
            id: 'terminal',
            label: pt ? 'Terminal integrado' : 'Terminal',
            badge: stream.events.length,
          },
          {
            id: 'events',
            label: pt ? 'Eventos (seq)' : 'Events',
            badge: stream.events.filter((e) => e.type !== 'output').length,
          },
          {
            id: 'files',
            label: pt ? 'Arquivos modificados' : 'Modified files',
            badge: modifiedFilesCount,
          },
          {
            id: 'diff',
            label: pt ? 'Diff Git' : 'Git Diff',
            badge: gitStatus && !gitStatus.clean ? gitStatus.files.length : undefined,
          },
          {
            id: 'result',
            label: pt ? 'Resultado e Uso' : 'Result & Usage',
          },
          {
            id: 'history',
            label: pt ? 'Histórico e Checkpoints' : 'History & Checkpoints',
            badge: sessionHistory?.executions.length ?? 0,
          },
        ]}
        active={bottomTab}
        onChange={setBottomTab}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 0%',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {bottomTab === 'terminal' ? (
          <TerminalPane
            executionId={activeExecutionId}
            executionStatus={executionStatus}
            session={selectedSession}
            events={stream.events}
            highestSeq={stream.highestSeq}
            hasGap={stream.hasGap}
            autoScroll={terminalAutoScroll}
            expanded={terminalExpanded}
            onToggleAutoScroll={onToggleAutoScroll}
            onToggleExpanded={onToggleExpanded}
            onReplay={async () => {
              if (activeExecutionId) {
                await loadExecutionReplay(activeExecutionId, -1);
              }
            }}
            language={language}
          />
        ) : null}

        {bottomTab === 'events' ? (
          <div
            data-scroll-region="workspace-events"
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'auto',
              padding: 12,
            }}
          >
            <DataTable
              columns={[
                {
                  key: 'seq',
                  header: 'seq',
                  width: 60,
                  render: (ev) => <span className="db-mono">#{ev.seq}</span>,
                },
                {
                  key: 'type',
                  header: pt ? 'Tipo' : 'Type',
                  width: 140,
                  render: (ev) => (
                    <Badge
                      tone={
                        ev.type === 'error' ||
                        (ev.type === 'tool-call' &&
                          (ev.state === 'denied' ||
                            ev.state === 'failed' ||
                            ev.state === 'invalid'))
                          ? 'danger'
                          : ev.type === 'approval-required' ||
                              (ev.type === 'tool-call' && ev.state === 'unknown')
                            ? 'warning'
                            : ev.type === 'file-change'
                              ? 'success'
                              : 'info'
                      }
                      mono
                    >
                      {ev.type}
                    </Badge>
                  ),
                },
                {
                  key: 'detail',
                  header: pt ? 'Conteúdo (texto escapado)' : 'Payload (escaped)',
                  render: (ev) => {
                    switch (ev.type) {
                      case 'status':
                        return ev.status;
                      case 'output':
                        return (
                          <span className="db-mono" style={{ fontSize: 11 }}>
                            [{ev.stream}] {ev.chunk.slice(0, 240)}
                          </span>
                        );
                      case 'message':
                        return `[${ev.role}] ${ev.text.slice(0, 240)}`;
                      case 'tool-call':
                        return `${ev.tool}${ev.state ? ` [${ev.state}]` : ''}: ${JSON.stringify(ev.input).slice(0, 200)}${ev.result ? ` → ${ev.result.slice(0, 200)}` : ''}`;
                      case 'approval-required':
                        return `${ev.action} (${ev.approvalId})`;
                      case 'file-change':
                        return `${ev.change}: ${ev.path}`;
                      case 'usage':
                        return `in=${ev.usage.inputTokens ?? '—'} out=${ev.usage.outputTokens ?? '—'}`;
                      case 'error':
                        return `${ev.error.code}: ${ev.error.message}`;
                      case 'heartbeat':
                        return 'heartbeat';
                    }
                  },
                },
                {
                  key: 'time',
                  header: pt ? 'Horário' : 'Time',
                  width: 170,
                  render: (ev) => (
                    <span className="db-mono db-faint" style={{ fontSize: 11 }}>
                      {formatTimestamp(ev.timestamp, language)}
                    </span>
                  ),
                },
              ]}
              rows={stream.events}
              rowKey={(ev) => `${ev.executionId}:${ev.seq}`}
              emptyMessage={
                pt ? 'Nenhum evento registrado para a execução atual.' : 'No events recorded.'
              }
            />
          </div>
        ) : null}

        {bottomTab === 'files' ? (
          <div
            data-scroll-region="workspace-files"
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'auto',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <DataTable
              columns={[
                {
                  key: 'change',
                  header: pt ? 'Operação' : 'Change',
                  width: 130,
                  render: (f) => (
                    <Badge
                      tone={
                        f.change === 'created'
                          ? 'success'
                          : f.change === 'deleted'
                            ? 'danger'
                            : 'info'
                      }
                      mono
                    >
                      {f.change}
                    </Badge>
                  ),
                },
                {
                  key: 'path',
                  header: pt ? 'Caminho relativo ao workspace' : 'Workspace path',
                  render: (f) => <span className="db-mono">{f.path}</span>,
                },
                {
                  key: 'recordedAt',
                  header: pt ? 'Registrado em' : 'Recorded at',
                  width: 180,
                  render: (f) => formatTimestamp(f.recordedAt, language),
                },
              ]}
              rows={sessionHistory?.files ?? []}
              rowKey={(f) => `${f.executionId ?? 'ses'}:${f.path}:${f.recordedAt}`}
              emptyMessage={
                pt
                  ? 'Nenhum arquivo indexado em eventos da sessão até o momento.'
                  : 'No session file events recorded yet.'
              }
            />
          </div>
        ) : null}

        {bottomTab === 'diff' ? (
          <DiffViewer
            gitStatus={gitStatus}
            gitDiff={gitDiff}
            loading={loadingGit}
            onRefresh={() => void refreshGit(selectedWorkspaceId)}
            language={language}
          />
        ) : null}

        {bottomTab === 'result' ? (
          <div
            data-scroll-region="workspace-result"
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'auto',
              padding: 14,
            }}
          >
            {!executionResult ? (
              <EmptyState
                title={pt ? 'Sem resultado final disponível' : 'No terminal result yet'}
                description={
                  isRunning
                    ? pt
                      ? 'A execução ainda está em andamento. O resultado consolidado aparecerá ao término.'
                      : 'Execution is still running.'
                    : pt
                      ? 'Inicie ou selecione uma execução concluída no histórico para inspecionar o resultado.'
                      : 'Run an instruction or select a completed execution.'
                }
              />
            ) : (
              <div
                className="db-card"
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge tone={formatExecutionStatus(executionResult.status, language).tone} dot>
                      {formatExecutionStatus(executionResult.status, language).label}
                    </Badge>
                    <Badge tone="outline" mono>
                      exitCode: {executionResult.exitCode ?? '—'}
                    </Badge>
                    {executionResult.outputTruncated ? (
                      <Badge tone="warning">
                        {pt ? 'Saída truncada pelo limite' : 'Output truncated'}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="db-mono db-faint" style={{ fontSize: 11 }}>
                    {executionResult.executionId}
                  </span>
                </div>

                <div
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}
                >
                  <div>
                    <span className="db-muted">{pt ? 'Início: ' : 'Started: '}</span>
                    <span>{formatTimestamp(executionResult.startedAt, language)}</span>
                  </div>
                  <div>
                    <span className="db-muted">{pt ? 'Término: ' : 'Finished: '}</span>
                    <span>{formatTimestamp(executionResult.finishedAt, language)}</span>
                  </div>
                  <div>
                    <span className="db-muted">{pt ? 'Tokens: ' : 'Tokens: '}</span>
                    <strong>{usageFormatted.tokensLabel}</strong>
                  </div>
                  <div>
                    <span className="db-muted">{pt ? 'Custo: ' : 'Cost: '}</span>
                    <strong>{usageFormatted.costLabel}</strong>
                  </div>
                </div>

                {executionResult.error ? (
                  <Banner tone="danger" title={executionResult.error.code}>
                    {executionResult.error.message}
                  </Banner>
                ) : null}

                {executionResult.summary ? (
                  <UntrustedBlock
                    label={pt ? 'Resumo redigido' : 'Redacted summary'}
                    text={executionResult.summary}
                    maxHeight={180}
                  />
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {bottomTab === 'history' ? (
          <div
            data-scroll-region="workspace-history"
            style={{
              flex: '1 1 0%',
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'auto',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <History size={13} />
                <span>{pt ? 'Execuções desta sessão' : 'Session executions'}</span>
              </div>
              <DataTable
                columns={[
                  {
                    key: 'id',
                    header: pt ? 'Instrução / Comando' : 'Payload',
                    render: (rec) => (
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {rec.request.payload.kind === 'prompt'
                            ? rec.request.payload.prompt.slice(0, 90)
                            : `${rec.request.payload.executable} ${rec.request.payload.args.join(' ')}`}
                        </div>
                        <div className="db-mono db-faint" style={{ fontSize: 10.5 }}>
                          {rec.request.id}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'status',
                    header: pt ? 'Estado' : 'Status',
                    width: 150,
                    render: (rec) => {
                      const st = formatExecutionStatus(rec.status, language);
                      return (
                        <Badge tone={st.tone} dot>
                          {st.label}
                        </Badge>
                      );
                    },
                  },
                  {
                    key: 'events',
                    header: pt ? 'Eventos' : 'Events',
                    width: 90,
                    render: (rec) => <span className="db-mono">{rec.eventCount}</span>,
                  },
                  {
                    key: 'replay',
                    header: '',
                    width: 110,
                    render: (rec) => (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          setActiveExecutionId(rec.request.id);
                          setExecutionStatus(rec.status);
                          setExecutionResult(rec.result);
                          setBottomTab('terminal');
                          void loadExecutionReplay(rec.request.id, -1);
                        }}
                      >
                        {pt ? 'Abrir stream' : 'Replay'}
                      </Button>
                    ),
                  },
                ]}
                rows={sessionHistory?.executions ?? []}
                rowKey={(rec) => rec.request.id}
                selectedKey={activeExecutionId}
                emptyMessage={
                  pt ? 'Nenhuma execução registrada nesta sessão.' : 'No executions yet.'
                }
              />
            </div>

            {(sessionHistory?.checkpoints.length ?? 0) > 0 ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {pt ? 'Checkpoints persistidos' : 'Saved checkpoints'}
                </div>
                <DataTable
                  columns={[
                    { key: 'label', header: pt ? 'Rótulo' : 'Label', render: (c) => c.label },
                    {
                      key: 'commit',
                      header: 'Git HEAD',
                      render: (c) => (
                        <span className="db-mono">
                          {c.gitCommit ? c.gitCommit.slice(0, 10) : '—'}
                        </span>
                      ),
                    },
                    {
                      key: 'createdAt',
                      header: pt ? 'Criado em' : 'Created',
                      render: (c) => formatTimestamp(c.createdAt, language),
                    },
                  ]}
                  rows={sessionHistory?.checkpoints ?? []}
                  rowKey={(c) => c.id}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (terminalExpanded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {bottomOperationalPane}
      </div>
    );
  }

  return (
    <SplitPane
      direction="vertical"
      controlledPane="second"
      initialSize={terminalHeight}
      minSize={200}
      maxSize={620}
      onResizeEnd={onResizeTerminal}
      first={topComposerPane}
      second={bottomOperationalPane}
    />
  );
};
