import type {
  Agent,
  AgentCapabilities,
  ApprovalStatus,
  CostModel,
  ExecutionStatus,
  PermissionAction,
  ProviderKind,
  ProviderProfile,
  ProviderStatus,
  RiskLevel,
  SessionStatus,
  Usage,
} from '@devbrain/contracts';
import type { BadgeTone } from '@devbrain/ui';

export type AppLanguage = 'pt-BR' | 'en';

export type NavSection = 'workspace' | 'projects' | 'agents' | 'security' | 'settings';

const STRINGS = {
  'pt-BR': {
    nav: {
      workspace: 'Workspace',
      projects: 'Projetos',
      agents: 'Agentes e Provedores',
      security: 'Segurança e Aprovações',
      settings: 'Configurações',
    },
    shell: {
      noActiveProject: 'Selecionar projeto…',
      notifications: 'Central de notificações',
      shortcuts: 'Atalhos de teclado',
      onboarding: 'Configuração inicial',
      commandPalette: 'Comandos rápidos',
      toggleSidebar: 'Alternar barra lateral',
      toggleInspector: 'Alternar painel contextual',
      dbOk: 'SQLite íntegro',
      dbRecovered: 'Banco recuperado',
      dbUnavailable: 'Armazenamento indisponível',
      pendingApprovals: 'aprovações pendentes',
      noNotifications: 'Nenhuma notificação recente.',
      clearNotifications: 'Limpar lidas',
      unsignedBuildNote: 'Build de desenvolvimento Windows x64 (não assinado)',
    },
  },
  en: {
    nav: {
      workspace: 'Workspace',
      projects: 'Projects',
      agents: 'Agents & Providers',
      security: 'Security & Approvals',
      settings: 'Settings',
    },
    shell: {
      noActiveProject: 'Select project…',
      notifications: 'Notification center',
      shortcuts: 'Keyboard shortcuts',
      onboarding: 'Initial setup',
      commandPalette: 'Command palette',
      toggleSidebar: 'Toggle sidebar',
      toggleInspector: 'Toggle context panel',
      dbOk: 'SQLite healthy',
      dbRecovered: 'Database recovered',
      dbUnavailable: 'Storage unavailable',
      pendingApprovals: 'pending approvals',
      noNotifications: 'No recent notifications.',
      clearNotifications: 'Clear read',
      unsignedBuildNote: 'Windows x64 development build (unsigned)',
    },
  },
} as const;

export const getStrings = (lang: AppLanguage) => STRINGS[lang];

export const formatExecutionStatus = (
  status: ExecutionStatus | string,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  switch (status) {
    case 'queued':
      return { label: pt ? 'Inicializando (na fila)' : 'Initializing (queued)', tone: 'neutral' };
    case 'awaiting-approval':
      return { label: pt ? 'Aguardando aprovação' : 'Awaiting approval', tone: 'warning' };
    case 'running':
      return { label: pt ? 'Executando' : 'Running', tone: 'info' };
    case 'interrupting':
      return { label: pt ? 'Interrompendo…' : 'Interrupting…', tone: 'warning' };
    case 'completed':
      return { label: pt ? 'Finalizado' : 'Completed', tone: 'success' };
    case 'failed':
      return { label: pt ? 'Falhou' : 'Failed', tone: 'danger' };
    case 'cancelled':
      return { label: pt ? 'Cancelado' : 'Cancelled', tone: 'neutral' };
    case 'timed-out':
      return { label: pt ? 'Tempo esgotado' : 'Timed out', tone: 'danger' };
    default:
      return { label: pt ? 'Desconhecido' : 'Unknown', tone: 'outline' };
  }
};

export const formatSessionStatus = (
  status: SessionStatus | string,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  switch (status) {
    case 'starting':
      return { label: pt ? 'Inicializando' : 'Starting', tone: 'info' };
    case 'active':
      return { label: pt ? 'Ativa' : 'Active', tone: 'info' };
    case 'idle':
      return { label: pt ? 'Pronta' : 'Idle', tone: 'success' };
    case 'completed':
    case 'ended':
      return { label: pt ? 'Concluída' : 'Completed', tone: 'neutral' };
    case 'cancelled':
      return { label: pt ? 'Cancelada' : 'Cancelled', tone: 'neutral' };
    case 'interrupted':
    case 'suspended':
      return { label: pt ? 'Interrompida' : 'Interrupted', tone: 'warning' };
    case 'failed':
      return { label: pt ? 'Falhou' : 'Failed', tone: 'danger' };
    default:
      return { label: pt ? 'Desconhecido' : 'Unknown', tone: 'outline' };
  }
};

export const formatProviderKind = (
  kind: ProviderKind | string,
  lang: AppLanguage = 'pt-BR',
): string => {
  const pt = lang === 'pt-BR';
  switch (kind) {
    case 'cli-agent':
      return pt ? 'Integração externa (CLI local)' : 'External integration (local CLI)';
    case 'http-api':
      return pt ? 'Integração externa (API HTTPS)' : 'External integration (HTTPS API)';
    case 'local-model':
      return pt ? 'Modelo local' : 'Local model';
    default:
      return pt ? 'Desconhecido' : 'Unknown';
  }
};

/**
 * Computes transparent, non-fictional status badges for a configured provider + optional running state.
 * Explicitly distinguishes: Instalado, Não instalado, Configurado, Não autenticado, Disponível,
 * Em execução, Indisponível, Desativado.
 */
export const describeProviderStates = (
  profile: ProviderProfile,
  isRunningExecution: boolean,
  lang: AppLanguage = 'pt-BR',
): {
  primary: { label: string; tone: BadgeTone };
  secondary: { label: string; tone: BadgeTone }[];
} => {
  const pt = lang === 'pt-BR';
  const secondary: { label: string; tone: BadgeTone }[] = [
    { label: formatProviderKind(profile.provider.kind, lang), tone: 'outline' },
  ];

  if (!profile.provider.enabled || profile.readiness === 'disabled') {
    return {
      primary: { label: pt ? 'Desativado' : 'Disabled', tone: 'neutral' },
      secondary,
    };
  }

  if (isRunningExecution) {
    secondary.unshift({ label: pt ? 'Instalado' : 'Installed', tone: 'success' });
    return {
      primary: { label: pt ? 'Em execução' : 'Running', tone: 'info' },
      secondary,
    };
  }

  const { health, readiness, provider } = profile;

  if (health.installed.state === 'no' || provider.status === 'missing-dependency') {
    return {
      primary: { label: pt ? 'Não instalado' : 'Not installed', tone: 'danger' },
      secondary,
    };
  }

  if (health.installed.state === 'yes') {
    secondary.unshift({
      label: health.installed.detail
        ? `${pt ? 'Instalado' : 'Installed'} (${health.installed.detail})`
        : pt
          ? 'Instalado'
          : 'Installed',
      tone: 'success',
    });
  }

  if (health.authenticated.state === 'no' || provider.status === 'unauthenticated') {
    return {
      primary: { label: pt ? 'Não autenticado' : 'Unauthenticated', tone: 'warning' },
      secondary,
    };
  }

  if (readiness === 'failing' || provider.status === 'unavailable') {
    return {
      primary: { label: pt ? 'Indisponível' : 'Unavailable', tone: 'danger' },
      secondary,
    };
  }

  if (provider.status === 'quota-exhausted') {
    return {
      primary: { label: pt ? 'Cota esgotada' : 'Quota exhausted', tone: 'warning' },
      secondary,
    };
  }

  if (readiness === 'operational' || readiness === 'authenticated' || readiness === 'available') {
    if (health.authenticated.state === 'yes') {
      secondary.push({ label: pt ? 'Autenticado' : 'Authenticated', tone: 'success' });
    } else {
      secondary.push({
        label: pt ? 'Autenticação não verificada' : 'Auth unverified',
        tone: 'neutral',
      });
    }
    return {
      primary: {
        label:
          readiness === 'operational'
            ? pt
              ? 'Disponível (validado)'
              : 'Available (verified)'
            : pt
              ? 'Disponível'
              : 'Available',
        tone: 'success',
      },
      secondary,
    };
  }

  return {
    primary: {
      label: pt ? 'Configurado (não verificado)' : 'Configured (unverified)',
      tone: 'neutral',
    },
    secondary,
  };
};

export const formatDependencyStatus = (
  status: ProviderStatus | string,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  switch (status) {
    case 'available':
      return { label: pt ? 'Instalado' : 'Installed', tone: 'success' };
    case 'missing-dependency':
      return { label: pt ? 'Não instalado' : 'Not installed', tone: 'danger' };
    case 'unauthenticated':
      return { label: pt ? 'Não autenticado' : 'Unauthenticated', tone: 'warning' };
    case 'unavailable':
      return { label: pt ? 'Indisponível' : 'Unavailable', tone: 'danger' };
    case 'disabled':
      return { label: pt ? 'Desativado' : 'Disabled', tone: 'neutral' };
    default:
      return { label: pt ? 'Não verificado' : 'Unchecked', tone: 'outline' };
  }
};

export const formatAgentStatus = (
  agent: Agent,
  isRunningExecution: boolean,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  if (isRunningExecution || agent.status === 'busy') {
    return { label: pt ? 'Em execução' : 'Running', tone: 'info' };
  }
  switch (agent.status) {
    case 'idle':
      return { label: pt ? 'Disponível' : 'Available', tone: 'success' };
    case 'paused':
      return { label: pt ? 'Pausado' : 'Paused', tone: 'warning' };
    case 'unavailable':
      return { label: pt ? 'Indisponível' : 'Unavailable', tone: 'danger' };
    case 'disabled':
      return { label: pt ? 'Desativado' : 'Disabled', tone: 'neutral' };
    default:
      return { label: pt ? 'Desconhecido' : 'Unknown', tone: 'outline' };
  }
};

export interface EnforcementSummary {
  level: 'per-action' | 'adapter-sandbox' | 'none';
  badge: string;
  tone: BadgeTone;
  requiresSessionApproval: boolean;
  warnings: string[];
}

export const describeEnforcement = (
  capabilities: AgentCapabilities,
  lang: AppLanguage = 'pt-BR',
): EnforcementSummary => {
  const pt = lang === 'pt-BR';
  const level = capabilities.enforcement ?? 'none';
  if (level === 'per-action') {
    return {
      level,
      badge: pt ? 'Interceptação por ação' : 'Per-action interception',
      tone: 'success',
      requiresSessionApproval: false,
      warnings: [],
    };
  }
  if (level === 'adapter-sandbox') {
    return {
      level,
      badge: pt ? 'Sandbox do adaptador' : 'Adapter sandbox',
      tone: 'warning',
      requiresSessionApproval: true,
      warnings: pt
        ? [
            'O DevBrain não intercepta ações individuais de arquivo ou comando neste adaptador; aplica apenas o modo restrito suportado pela CLI.',
          ]
        : [
            'DevBrain cannot intercept individual file or command actions on this adapter; it configures the adapter sandbox mode only.',
          ],
    };
  }
  return {
    level: 'none',
    badge: pt ? 'Sem interceptação por ação' : 'No per-action interception',
    tone: 'warning',
    requiresSessionApproval: true,
    warnings: pt
      ? [
          'Limitação de segurança: este agente CLI não permite interceptar ações individuais no Windows. Após iniciar, ele atua com as permissões do seu usuário no sistema operacional.',
          'O DevBrain exige aprovação humana explícita para a sessão e restringe o diretório inicial de trabalho (cwd). Worktrees Git isolam alterações de código, não acesso ao disco.',
        ]
      : [
          'Security limitation: this CLI agent does not support per-action interception on Windows. Once started, it runs with your OS user permissions.',
          'DevBrain requires explicit human approval per session and sets the initial working directory (cwd). Git worktrees isolate code changes, not filesystem access.',
        ],
  };
};

/**
 * Honest usage & cost formatter: NEVER presents unknown/null cost as $0.00!
 */
export const formatUsageHonest = (
  usage: Usage | null | undefined,
  costModel: CostModel = 'unknown',
  lang: AppLanguage = 'pt-BR',
): { tokensLabel: string; costLabel: string; isCostKnown: boolean } => {
  const pt = lang === 'pt-BR';
  const hasTokens =
    usage !== null &&
    usage !== undefined &&
    (usage.inputTokens !== null || usage.outputTokens !== null);

  const tokensLabel = hasTokens
    ? `${pt ? 'Entrada' : 'In'}: ${usage?.inputTokens !== null ? usage?.inputTokens.toLocaleString(lang) : '—'} · ${pt ? 'Saída' : 'Out'}: ${usage?.outputTokens !== null ? usage?.outputTokens.toLocaleString(lang) : '—'} tokens`
    : pt
      ? 'Tokens não informados pelo provedor'
      : 'Tokens not reported by provider';

  if (usage && usage.costAmount !== null && usage.costCurrency !== null) {
    return {
      tokensLabel,
      costLabel: `${usage.costCurrency} ${usage.costAmount.toFixed(4)}`,
      isCostKnown: true,
    };
  }

  const costLabel =
    costModel === 'subscription'
      ? pt
        ? 'Custo desconhecido (assinatura externa — não reportado pela CLI)'
        : 'Unknown cost (external subscription — not reported by CLI)'
      : costModel === 'free'
        ? pt
          ? 'Gratuito (declarado pelo provedor)'
          : 'Free (provider declared)'
        : costModel === 'local'
          ? pt
            ? 'Execução local (sem tarifação por API)'
            : 'Local execution (no API billing)'
          : pt
            ? 'Custo desconhecido (não informado pelo provedor)'
            : 'Unknown cost (not reported by provider)';

  return { tokensLabel, costLabel, isCostKnown: false };
};

export const formatCostModel = (model: CostModel, lang: AppLanguage = 'pt-BR'): string => {
  const pt = lang === 'pt-BR';
  switch (model) {
    case 'subscription':
      return pt ? 'Assinatura externa (custo por execução não reportado)' : 'External subscription';
    case 'metered':
      return pt ? 'Tarifado por uso' : 'Metered';
    case 'local':
      return pt ? 'Modelo local' : 'Local';
    case 'free':
      return pt ? 'Gratuito' : 'Free';
    default:
      return pt ? 'Desconhecido' : 'Unknown';
  }
};

export const formatPermissionAction = (
  action: PermissionAction | string,
  lang: AppLanguage = 'pt-BR',
): string => {
  const pt = lang === 'pt-BR';
  const labels: Record<string, [string, string]> = {
    'fs.read': ['Leitura de arquivos (fs.read)', 'Read files (fs.read)'],
    'fs.write': ['Escrita de arquivos (fs.write)', 'Write files (fs.write)'],
    'fs.delete': ['Exclusão de arquivos (fs.delete)', 'Delete files (fs.delete)'],
    'process.spawn': [
      'Execução de processo / CLI (process.spawn)',
      'Spawn process / CLI (process.spawn)',
    ],
    'network.request': ['Acesso à rede (network.request)', 'Network request (network.request)'],
    'git.commit': ['Commit Git (git.commit)', 'Git commit (git.commit)'],
    'git.push': ['Push remoto Git (git.push)', 'Git push (git.push)'],
    'git.force-push': ['Force push Git (git.force-push)', 'Git force-push (git.force-push)'],
    'git.branch-delete': [
      'Exclusão de branch (git.branch-delete)',
      'Delete branch (git.branch-delete)',
    ],
    'git.history-rewrite': [
      'Reescrita de histórico Git (git.history-rewrite)',
      'Rewrite Git history',
    ],
    'package.install': [
      'Instalação de pacotes (package.install)',
      'Install packages (package.install)',
    ],
    'credential.use': ['Uso de credencial (credential.use)', 'Use credential (credential.use)'],
    'privilege.elevate': ['Elevação de privilégio (privilege.elevate)', 'Privilege elevation'],
    'external.publish': ['Publicação externa (external.publish)', 'External publication'],
    'scope.escape': ['Acesso fora do escopo autorizado (scope.escape)', 'Outside workspace scope'],
  };
  const pair = labels[action];
  if (!pair) return action;
  return pt ? pair[0] : pair[1];
};

export const formatRisk = (
  risk: RiskLevel | string,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  switch (risk) {
    case 'low':
      return { label: pt ? 'Risco baixo' : 'Low risk', tone: 'neutral' };
    case 'medium':
      return { label: pt ? 'Risco médio' : 'Medium risk', tone: 'info' };
    case 'high':
      return { label: pt ? 'Risco alto' : 'High risk', tone: 'warning' };
    case 'critical':
      return { label: pt ? 'Risco crítico' : 'Critical risk', tone: 'danger' };
    default:
      return { label: risk, tone: 'outline' };
  }
};

export const formatApprovalStatus = (
  status: ApprovalStatus | string,
  lang: AppLanguage = 'pt-BR',
): { label: string; tone: BadgeTone } => {
  const pt = lang === 'pt-BR';
  switch (status) {
    case 'pending':
      return { label: pt ? 'Pendente' : 'Pending', tone: 'warning' };
    case 'approved':
      return { label: pt ? 'Aprovada' : 'Approved', tone: 'success' };
    case 'denied':
      return { label: pt ? 'Recusada' : 'Denied', tone: 'danger' };
    case 'expired':
      return { label: pt ? 'Expirada' : 'Expired', tone: 'neutral' };
    case 'cancelled':
      return { label: pt ? 'Cancelada' : 'Cancelled', tone: 'neutral' };
    default:
      return { label: status, tone: 'outline' };
  }
};

export const formatTimestamp = (
  iso: string | null | undefined,
  lang: AppLanguage = 'pt-BR',
): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(lang, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};
