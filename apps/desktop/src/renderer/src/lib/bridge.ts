import type {
  DevBrainErrorPayload,
  ErrorCode,
  IpcChannelKey,
  IpcEventKey,
  IpcEventPayload,
  IpcInput,
  IpcOutput,
} from '@devbrain/contracts';

export class UiClientError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly correlationId: string | undefined;

  constructor(payload: DevBrainErrorPayload, correlationId?: string) {
    super(payload.message);
    this.name = 'UiClientError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.details = payload.details;
    this.correlationId = payload.correlationId ?? correlationId;
  }
}

export const invoke = async <K extends IpcChannelKey>(
  key: K,
  input: IpcInput<K>,
): Promise<IpcOutput<K>> => {
  const response = await window.devbrain.invoke(key, input);
  if (!response.ok) {
    throw new UiClientError(response.error, response.correlationId);
  }
  return response.data;
};

export const subscribe = <E extends IpcEventKey>(
  event: E,
  listener: (payload: IpcEventPayload<E>) => void,
): (() => void) => window.devbrain.subscribe(event, listener);

export interface DescribedError {
  code: ErrorCode | 'UNKNOWN';
  title: string;
  message: string;
  remediation: string;
  retryable: boolean;
}

const ERROR_REMEDIATION_PT: Record<ErrorCode, { title: string; remediation: string }> = {
  VALIDATION_FAILED: {
    title: 'Dados inválidos',
    remediation:
      'Verifique os campos obrigatórios, caminhos absolutos e formatos permitidos antes de tentar novamente.',
  },
  NOT_FOUND: {
    title: 'Registro não encontrado',
    remediation:
      'Atualize a tela para sincronizar com o banco local; o item pode ter sido removido ou o diretório não existe.',
  },
  ALREADY_EXISTS: {
    title: 'Cadastro duplicado',
    remediation:
      'Este diretório ou identificador já está registrado no DevBrain. Selecione o item existente na lista.',
  },
  CONFLICT: {
    title: 'Conflito de estado',
    remediation:
      'A operação não é compatível com o estado atual (ex.: projeto arquivado, sessão encerrada ou agentes vinculados ao provedor).',
  },
  PERMISSION_DENIED: {
    title: 'Permissão negada pela política',
    remediation:
      'A política de segurança ou decisão humana bloqueou esta ação. Revise a Central de Segurança e Aprovações.',
  },
  APPROVAL_REQUIRED: {
    title: 'Aprovação humana obrigatória',
    remediation:
      'Aprove ou recuse a solicitação pendente na Central de Aprovações antes de prosseguir.',
  },
  PATH_OUTSIDE_SCOPE: {
    title: 'Caminho fora do escopo autorizado',
    remediation:
      'O caminho aponta para fora das raízes permitidas do workspace. Ajuste os diretórios autorizados nas configurações do projeto se necessário.',
  },
  COMMAND_NOT_ALLOWED: {
    title: 'Comando bloqueado',
    remediation:
      'Interpretadores de shell irrestritos (cmd, powershell, bash) ou binários bloqueados pela política não podem ser executados diretamente.',
  },
  DEPENDENCY_MISSING: {
    title: 'Ferramenta ou CLI não instalada',
    remediation:
      'Instale a CLI oficial do agente no sistema e valide o executável na Central de Agentes e Provedores.',
  },
  PROVIDER_UNAVAILABLE: {
    title: 'Agente ou provedor indisponível',
    remediation:
      'Verifique se o provedor está habilitado, instalado no PATH, autenticado na ferramenta oficial e funcionando.',
  },
  QUOTA_EXCEEDED: {
    title: 'Cota do provedor esgotada',
    remediation:
      'Consulte sua conta no provedor externo ou selecione outro agente configurado para continuar.',
  },
  RATE_LIMITED: {
    title: 'Limite de taxa atingido',
    remediation: 'Aguarde alguns instantes antes de reenviar a instrução ao provedor.',
  },
  TIMEOUT: {
    title: 'Tempo limite de execução excedido',
    remediation:
      'Divida a instrução em etapas menores ou ajuste o tempo limite em Configurações > Execução.',
  },
  CANCELLED: {
    title: 'Execução cancelada',
    remediation:
      'A operação foi interrompida manualmente. Você pode enviar uma nova instrução na sessão.',
  },
  CONCURRENCY_LIMIT: {
    title: 'Limite de execuções simultâneas atingido',
    remediation:
      'Aguarde o término de uma execução ativa ou ajuste o limite de concorrência nas Configurações.',
  },
  CREDENTIAL_UNAVAILABLE: {
    title: 'Credencial indisponível ou falha de autenticação',
    remediation:
      'Cadastre novamente o segredo no cofre seguro (DPAPI) ou confirme a variável de ambiente configurada.',
  },
  UNSUPPORTED: {
    title: 'Capacidade não suportada nesta fase',
    remediation:
      'Esta operação não é suportada pelo adaptador selecionado ou pertence às próximas fases da plataforma.',
  },
  CONTRACT_VERSION_MISMATCH: {
    title: 'Versão de contrato incompatível',
    remediation: 'Reinicie ou reinstale o aplicativo para alinhar os módulos Main e Renderer.',
  },
  INTERRUPTED: {
    title: 'Sessão interrompida anteriormente',
    remediation:
      'O processo anterior foi encerrado abruptamente. Inicie uma nova sessão a partir do último checkpoint.',
  },
  STORAGE_ERROR: {
    title: 'Falha de persistência local (SQLite)',
    remediation:
      'Verifique o espaço em disco e permissões do diretório de dados do usuário, ou restaure um backup local.',
  },
  BUDGET_EXCEEDED: {
    title: 'Limite de orçamento atingido',
    remediation:
      'O consumo registrado atingiu o teto diário/mensal configurado. Revise Configurações > Orçamento.',
  },
  BUDGET_UNENFORCEABLE: {
    title: 'Orçamento não pode ser garantido',
    remediation:
      'Há um teto de orçamento, mas este agente não informa custo. Remova o teto ou habilite, de forma consciente, "execuções sem garantia de custo" em Configurações.',
  },
  INTERNAL: {
    title: 'Erro interno inesperado',
    remediation:
      'Tente repetir a operação. Caso persista, verifique a saúde do armazenamento em Configurações.',
  },
};

const ERROR_REMEDIATION_EN: Record<ErrorCode, { title: string; remediation: string }> = {
  VALIDATION_FAILED: {
    title: 'Validation failed',
    remediation: 'Check required fields, absolute paths and allowed formats before retrying.',
  },
  NOT_FOUND: {
    title: 'Record not found',
    remediation: 'Refresh the view; the record may have been removed or the path no longer exists.',
  },
  ALREADY_EXISTS: {
    title: 'Already registered',
    remediation: 'This directory or identifier is already registered in DevBrain.',
  },
  CONFLICT: {
    title: 'State conflict',
    remediation:
      'The operation conflicts with current state (archived project, ended session or linked agents).',
  },
  PERMISSION_DENIED: {
    title: 'Permission denied',
    remediation:
      'Security policy or human decision blocked this action. Review Security & Approvals.',
  },
  APPROVAL_REQUIRED: {
    title: 'Human approval required',
    remediation: 'Approve or deny the pending request in the Approvals Center.',
  },
  PATH_OUTSIDE_SCOPE: {
    title: 'Path outside authorized scope',
    remediation: 'Target path resolves outside workspace allowed roots.',
  },
  COMMAND_NOT_ALLOWED: {
    title: 'Command not allowed',
    remediation: 'Unrestricted shells or disallowed executables cannot be spawned directly.',
  },
  DEPENDENCY_MISSING: {
    title: 'Agent CLI not installed',
    remediation: 'Install the official CLI and re-run dependency detection in Agents & Providers.',
  },
  PROVIDER_UNAVAILABLE: {
    title: 'Provider unavailable',
    remediation: 'Verify that the provider is enabled, installed, authenticated and reachable.',
  },
  QUOTA_EXCEEDED: {
    title: 'Provider quota exhausted',
    remediation: 'Check your external provider account or select another configured agent.',
  },
  RATE_LIMITED: {
    title: 'Rate limited',
    remediation: 'Wait briefly before submitting another request.',
  },
  TIMEOUT: {
    title: 'Execution timed out',
    remediation: 'Split the task into smaller steps or increase the execution timeout in Settings.',
  },
  CANCELLED: {
    title: 'Execution cancelled',
    remediation: 'The run was stopped manually. You can submit a new instruction.',
  },
  CONCURRENCY_LIMIT: {
    title: 'Concurrency limit reached',
    remediation: 'Wait for an active execution to complete or adjust concurrency limits.',
  },
  CREDENTIAL_UNAVAILABLE: {
    title: 'Credential unavailable',
    remediation: 'Re-register the OS-encrypted secret or verify the environment variable.',
  },
  UNSUPPORTED: {
    title: 'Unsupported capability',
    remediation: 'This adapter or phase does not support the requested capability.',
  },
  CONTRACT_VERSION_MISMATCH: {
    title: 'Contract version mismatch',
    remediation: 'Restart or reinstall the desktop application.',
  },
  INTERRUPTED: {
    title: 'Session was interrupted',
    remediation: 'Start a new session from the latest saved checkpoint.',
  },
  STORAGE_ERROR: {
    title: 'Local database error',
    remediation: 'Check disk space and userData permissions, or create/restore a backup.',
  },
  BUDGET_EXCEEDED: {
    title: 'Budget limit exceeded',
    remediation: 'Recorded usage reached the configured budget ceiling in Settings.',
  },
  BUDGET_UNENFORCEABLE: {
    title: 'Budget cannot be guaranteed',
    remediation:
      'A budget limit is set but this agent does not report cost. Remove the limit or knowingly allow executions without a cost guarantee in Settings.',
  },
  INTERNAL: {
    title: 'Unexpected internal error',
    remediation: 'Retry the operation and inspect storage health in Settings if it persists.',
  },
};

export const describeError = (err: unknown, language: 'pt-BR' | 'en' = 'pt-BR'): DescribedError => {
  const map = language === 'en' ? ERROR_REMEDIATION_EN : ERROR_REMEDIATION_PT;
  if (err instanceof UiClientError) {
    const entry = map[err.code] ?? map.INTERNAL;
    return {
      code: err.code,
      title: entry.title,
      message: err.message,
      remediation: entry.remediation,
      retryable: err.retryable,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN',
    title: language === 'en' ? 'Operation failed' : 'Falha na operação',
    message: msg,
    remediation:
      language === 'en'
        ? 'Check input parameters and service status.'
        : 'Verifique os dados informados e o estado dos serviços locais.',
    retryable: false,
  };
};
