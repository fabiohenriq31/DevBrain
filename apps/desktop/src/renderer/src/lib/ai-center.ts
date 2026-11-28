import type {
  BenchmarkResult,
  BillingPolicy,
  CreditBalance,
  DevBrainErrorPayload,
  FallbackAttempt,
  IpcChannelKey,
  IpcInput,
  IpcOutput,
  LocalModel,
  LocalRuntime,
  ModelAvailability,
  ModelDefinition,
  ModelRoute,
  PrivacyPolicy,
  ProviderCatalogEntry,
  ProviderConnection,
  ProviderEndpoint,
  QuotaDefinition,
  QuotaObservation,
  QuotaReservation,
  RoutingPolicy,
  UsageRecord,
} from '@devbrain/contracts';

// ---------------------------------------------------------------------------
// 1. Typed Phase 02 IPC Probing & Honest UNSUPPORTED Handling
// ---------------------------------------------------------------------------

export const AI_CHANNEL_KEYS = [
  'ai.catalog.list',
  'ai.catalog.import',
  'ai.endpoints.list',
  'ai.endpoints.save',
  'ai.connections.list',
  'ai.connections.save',
  'ai.connections.remove',
  'ai.connections.validate',
  'ai.models.list',
  'ai.models.save',
  'ai.models.availability',
  'ai.routes.list',
  'ai.routes.save',
  'ai.routes.select',
  'ai.routes.explain',
  'ai.privacyProfiles.list',
  'ai.privacyProfiles.save',
  'ai.policies.configure',
  'ai.inference.submit',
  'ai.inference.result',
  'ai.inference.cancel',
  'ai.inference.attempts',
  'ai.quota.definitions',
  'ai.quota.observations',
  'ai.quota.reservations',
  'ai.quota.forecast',
  'ai.usage.list',
  'ai.budget.status',
  'ai.cost.get',
  'ai.credits.get',
  'ai.local.list',
  'ai.local.models',
  'ai.local.pull',
  'ai.local.cancelPull',
  'ai.local.remove',
  'ai.local.benchmark',
  'ai.checkpoints.latest',
  'ai.handoff.build',
  'ai.benchmark.suites',
  'ai.benchmark.run',
  'ai.benchmark.quality',
] as const satisfies readonly IpcChannelKey[];

export type AiChannelKey = (typeof AI_CHANNEL_KEYS)[number];
export type ChannelSupportState = 'unprobed' | 'ready' | 'unsupported' | 'error';

export type AiCallOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'unsupported'; channel: AiChannelKey; message: string }
  | { status: 'error'; channel: AiChannelKey; error: DevBrainErrorPayload };

export const callAiChannel = async <K extends AiChannelKey>(
  key: K,
  input: IpcInput<K>,
): Promise<AiCallOutcome<IpcOutput<K>>> => {
  const response = await window.devbrain.invoke(key, input);
  if (response.ok) {
    return { status: 'ok', data: response.data };
  }
  if (response.error.code === 'UNSUPPORTED') {
    return { status: 'unsupported', channel: key, message: response.error.message };
  }
  return { status: 'error', channel: key, error: response.error };
};

// ---------------------------------------------------------------------------
// 2. Project Privacy Classification & Route Eligibility (§14)
// ---------------------------------------------------------------------------

export type ProjectPrivacyClass =
  'public' | 'personal-private' | 'commercial-confidential' | 'restricted';

export interface PrivacyClassificationSpec {
  id: ProjectPrivacyClass;
  labelPt: string;
  labelEn: string;
  summaryPt: string;
  summaryEn: string;
  requiredPrivacyMode: PrivacyPolicy['mode'];
  allowsExternalCloud: boolean;
  requiresExplicitApprovedList: boolean;
  warningsPt: string[];
}

export const PRIVACY_CLASSIFICATIONS: Readonly<
  Record<ProjectPrivacyClass, PrivacyClassificationSpec>
> = Object.freeze({
  public: {
    id: 'public',
    labelPt: 'Público',
    labelEn: 'Public',
    summaryPt: 'Código aberto ou dados públicos sem segredos comerciais ou dados pessoais.',
    summaryEn: 'Open-source or public data with no confidential or personal material.',
    requiredPrivacyMode: 'any-configured',
    allowsExternalCloud: true,
    requiresExplicitApprovedList: false,
    warningsPt: [
      'Ofertas gratuitas externas podem reter prompts e utilizá-los para treinamento de modelos.',
      'Mesmo em projetos públicos, credenciais e arquivos .env permanecem bloqueados pelo escopo do workspace.',
    ],
  },
  'personal-private': {
    id: 'personal-private',
    labelPt: 'Pessoal privado',
    labelEn: 'Personal private',
    summaryPt:
      'Projetos privados pessoais; requer provedores explicitamente aprovados ou inferência local.',
    summaryEn:
      'Private personal repositories; requires explicitly approved providers or local inference.',
    requiredPrivacyMode: 'approved-providers',
    allowsExternalCloud: true,
    requiresExplicitApprovedList: true,
    warningsPt: [
      'Verifique a política de retenção e treinamento antes de aprovar provedores gratuitos.',
      'Provedores sem termos verificados não são aprovados automaticamente.',
    ],
  },
  'commercial-confidential': {
    id: 'commercial-confidential',
    labelPt: 'Comercial confidencial',
    labelEn: 'Commercial confidential',
    summaryPt:
      'Propriedade intelectual ou código corporativo; exige provedores aprovados com uso comercial permitido e sem treinamento sobre prompts.',
    summaryEn:
      'Corporate IP; requires explicitly approved providers with commercial terms and zero prompt training.',
    requiredPrivacyMode: 'approved-providers',
    allowsExternalCloud: true,
    requiresExplicitApprovedList: true,
    warningsPt: [
      'Planos gratuitos de APIs públicas frequentemente proíbem uso comercial ou treinam com prompts enviados.',
      'Agentes CLI externos sem interceptação (enforcement: none) atuam com permissões do usuário local.',
      'Provedores que não informam custo por chamada limitam o controle financeiro automático.',
    ],
  },
  restricted: {
    id: 'restricted',
    labelPt: 'Restrito (somente local)',
    labelEn: 'Restricted (local-only)',
    summaryPt:
      'Dados altamente sensíveis ou regulados; bloqueia qualquer envio para provedores externos e exige execução exclusivamente local (loopback).',
    summaryEn:
      'Highly sensitive data; blocks all external cloud endpoints and enforces loopback-only local inference.',
    requiredPrivacyMode: 'local-only',
    allowsExternalCloud: false,
    requiresExplicitApprovedList: false,
    warningsPt: [
      'Qualquer rota ou conexão apontando para fora de localhost / 127.0.0.1 é bloqueada.',
      'Agentes CLI conectados a nuvens externas (Codex Cloud, Claude Code, Antigravity) não atendem ao modo estritamente local.',
    ],
  },
});

export const isLoopbackUrl = (urlStr: string | null | undefined): boolean => {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
};

export interface RouteEligibilityVerdict {
  eligible: boolean;
  reasonsPt: string[];
}

export const evaluateProviderEligibility = (input: {
  privacyClass: ProjectPrivacyClass;
  provider: ProviderCatalogEntry | undefined;
  endpoint: ProviderEndpoint | undefined;
  connection: ProviderConnection | undefined;
  approvedProviderIds: readonly string[];
}): RouteEligibilityVerdict => {
  const { privacyClass, provider, endpoint, connection, approvedProviderIds } = input;
  const reasons: string[] = [];
  const isLocal =
    provider?.kind === 'local' ||
    endpoint?.protocol === 'ollama' ||
    isLoopbackUrl(endpoint?.baseUrl);

  if (connection && (!connection.enabled || connection.status === 'disabled')) {
    reasons.push('Conexão desativada manualmente pelo usuário.');
  }
  if (connection?.status === 'invalid-credential') {
    reasons.push('Credencial rejeitada pelo provedor (invalid-credential).');
  }

  if (privacyClass === 'restricted' && !isLocal) {
    reasons.push(
      'Bloqueado pela classificação Restrito: apenas runtimes locais em 127.0.0.1 / localhost são permitidos.',
    );
  }

  const spec = PRIVACY_CLASSIFICATIONS[privacyClass];
  if (spec.requiresExplicitApprovedList && !isLocal) {
    const pid = provider?.id ?? endpoint?.providerId ?? connection?.providerId;
    if (!pid || !approvedProviderIds.includes(pid)) {
      reasons.push(
        `Bloqueado pela classificação "${spec.labelPt}": o provedor "${provider?.name ?? pid ?? 'desconhecido'}" não consta na lista de provedores aprovados da política de privacidade.`,
      );
    }
    if (privacyClass === 'commercial-confidential' && provider && !provider.termsUrl) {
      reasons.push(
        'Aviso de conformidade comercial: termos de uso e retenção de dados deste provedor são desconhecidos (termsUrl ausente).',
      );
    }
  }

  return {
    eligible: reasons.filter((r) => !r.startsWith('Aviso')).length === 0,
    reasonsPt: reasons,
  };
};

// ---------------------------------------------------------------------------
// 3. Execution Strategies & Non-Bypassable Policy Validation (§11)
// ---------------------------------------------------------------------------

export type StrategyPresetId =
  'free-only' | 'local-only' | 'max-savings' | 'balanced' | 'max-quality' | 'custom';

export interface StrategyDraft {
  preset: StrategyPresetId;
  policyId: string;
  strategy: RoutingPolicy['strategy'];
  maxAttempts: number;
  requireTools: boolean;
  allowPaid: boolean;
  allowUnknownCost: boolean;
  maxCostPerRequest: number | null;
  maxCostPerDay: number | null;
  currency: string;
  privacyMode: PrivacyPolicy['mode'];
  allowedProviderIds: string[];
  allowPromptLogging: boolean;
  prioritizeSubscriptions: boolean;
  allowPromotionalCredits: boolean;
  preferLocalInference: boolean;
}

export const buildPresetStrategy = (
  preset: StrategyPresetId,
  base?: Partial<StrategyDraft>,
): StrategyDraft => {
  const currency = base?.currency ?? 'USD';
  const allowedProviderIds = base?.allowedProviderIds ?? [];
  switch (preset) {
    case 'free-only':
      return {
        preset,
        policyId: 'policy-free-only',
        strategy: 'lowest-known-cost',
        maxAttempts: 3,
        requireTools: base?.requireTools ?? false,
        allowPaid: false,
        allowUnknownCost: false,
        maxCostPerRequest: 0,
        maxCostPerDay: 0,
        currency,
        privacyMode: base?.privacyMode === 'local-only' ? 'local-only' : 'approved-providers',
        allowedProviderIds,
        allowPromptLogging: false,
        prioritizeSubscriptions: false,
        allowPromotionalCredits: false,
        preferLocalInference: true,
      };
    case 'local-only':
      return {
        preset,
        policyId: 'policy-local-only',
        strategy: 'local-first',
        maxAttempts: 2,
        requireTools: base?.requireTools ?? false,
        allowPaid: false,
        allowUnknownCost: false,
        maxCostPerRequest: 0,
        maxCostPerDay: 0,
        currency,
        privacyMode: 'local-only',
        allowedProviderIds: [],
        allowPromptLogging: false,
        prioritizeSubscriptions: false,
        allowPromotionalCredits: false,
        preferLocalInference: true,
      };
    case 'max-savings':
      return {
        preset,
        policyId: 'policy-max-savings',
        strategy: 'lowest-known-cost',
        maxAttempts: 4,
        requireTools: base?.requireTools ?? false,
        allowPaid: true,
        allowUnknownCost: false,
        maxCostPerRequest: 0.02,
        maxCostPerDay: 1,
        currency,
        privacyMode: 'approved-providers',
        allowedProviderIds,
        allowPromptLogging: false,
        prioritizeSubscriptions: true,
        allowPromotionalCredits: true,
        preferLocalInference: true,
      };
    case 'balanced':
      return {
        preset,
        policyId: 'policy-balanced',
        strategy: 'priority',
        maxAttempts: 3,
        requireTools: base?.requireTools ?? false,
        allowPaid: true,
        allowUnknownCost: false,
        maxCostPerRequest: 0.25,
        maxCostPerDay: 10,
        currency,
        privacyMode: 'approved-providers',
        allowedProviderIds,
        allowPromptLogging: false,
        prioritizeSubscriptions: true,
        allowPromotionalCredits: true,
        preferLocalInference: false,
      };
    case 'max-quality':
      return {
        preset,
        policyId: 'policy-max-quality',
        strategy: 'priority',
        maxAttempts: 3,
        requireTools: base?.requireTools ?? true,
        allowPaid: true,
        allowUnknownCost: false,
        maxCostPerRequest: 2,
        maxCostPerDay: 50,
        currency,
        privacyMode: 'approved-providers',
        allowedProviderIds,
        allowPromptLogging: false,
        prioritizeSubscriptions: true,
        allowPromotionalCredits: true,
        preferLocalInference: false,
      };
    case 'custom':
      return {
        preset: 'custom',
        policyId: base?.policyId ?? 'policy-custom',
        strategy: base?.strategy ?? 'priority',
        maxAttempts: base?.maxAttempts ?? 3,
        requireTools: base?.requireTools ?? false,
        allowPaid: base?.allowPaid ?? false,
        allowUnknownCost: base?.allowUnknownCost ?? false,
        maxCostPerRequest: base?.maxCostPerRequest ?? null,
        maxCostPerDay: base?.maxCostPerDay ?? null,
        currency,
        privacyMode: base?.privacyMode ?? 'approved-providers',
        allowedProviderIds,
        allowPromptLogging: base?.allowPromptLogging ?? false,
        prioritizeSubscriptions: base?.prioritizeSubscriptions ?? true,
        allowPromotionalCredits: base?.allowPromotionalCredits ?? false,
        preferLocalInference: base?.preferLocalInference ?? false,
      };
  }
};

export interface StrategyValidationResult {
  valid: boolean;
  violationsPt: string[];
}

export const validateStrategyGuardrails = (input: {
  draft: StrategyDraft;
  projectPrivacy: ProjectPrivacyClass;
  globalMaxPerDay: number | null;
  globalAllowWithoutCostGuarantee: boolean;
  routes: readonly ModelRoute[];
  models: readonly ModelDefinition[];
}): StrategyValidationResult => {
  const {
    draft,
    projectPrivacy,
    globalMaxPerDay,
    globalAllowWithoutCostGuarantee,
    routes,
    models,
  } = input;
  const violations: string[] = [];

  // Invariant 1: Free-only mode MUST NOT allow paid or unknown-cost routes or paid fallbacks
  if (draft.preset === 'free-only') {
    if (draft.allowPaid) {
      violations.push('O modo "Somente gratuito" não pode habilitar chamadas pagas (allowPaid).');
    }
    if (draft.allowUnknownCost) {
      violations.push(
        'O modo "Somente gratuito" não pode permitir custo desconhecido (custo desconhecido nunca equivale a zero).',
      );
    }
    if ((draft.maxCostPerRequest ?? 0) > 0 || (draft.maxCostPerDay ?? 0) > 0) {
      violations.push('O modo "Somente gratuito" exige teto financeiro igual a 0.');
    }
    const enabledPaidRoute = routes.find((r) => {
      if (!r.enabled || r.localOnly) return false;
      const model = models.find((m) => m.id === r.modelId);
      if (!model?.pricing) return true; // unknown price cannot be guaranteed free!
      return (model.pricing.inputPerMillion ?? 1) > 0 || (model.pricing.outputPerMillion ?? 1) > 0;
    });
    if (enabledPaidRoute) {
      violations.push(
        `A rota ativa "${enabledPaidRoute.id}" possui preço pago ou não verificado e não pode atuar como fallback no modo Somente gratuito.`,
      );
    }
  }

  // Invariant 2: Local-only mode MUST NOT send data to external providers
  if (draft.preset === 'local-only') {
    if (draft.privacyMode !== 'local-only') {
      violations.push('O modo "Somente local" exige política de privacidade "local-only".');
    }
    const externalRoute = routes.find((r) => r.enabled && !r.localOnly);
    if (externalRoute) {
      violations.push(
        `A rota externa "${externalRoute.id}" está habilitada; desative rotas externas ou marque-as como localOnly para o modo Somente local.`,
      );
    }
  }

  // Invariant 3: Cannot weaken upper Project Privacy Classification
  const privacySpec = PRIVACY_CLASSIFICATIONS[projectPrivacy];
  if (projectPrivacy === 'restricted' && draft.privacyMode !== 'local-only') {
    violations.push(
      'Violação de política superior: o projeto ativo está classificado como "Restrito", exigindo modo "local-only" (nenhum dado pode sair para provedores externos).',
    );
  }
  if (privacySpec.requiresExplicitApprovedList && draft.privacyMode === 'any-configured') {
    violations.push(
      `Violação de política superior: projetos "${privacySpec.labelPt}" não permitem o modo "any-configured"; utilize "approved-providers" ou "local-only".`,
    );
  }

  // Invariant 4: Cannot bypass global Core budget ceiling
  if (globalMaxPerDay !== null && !globalAllowWithoutCostGuarantee && draft.allowUnknownCost) {
    violations.push(
      'Violação de política financeira superior: há um teto diário global configurado sem permissão para custo desconhecido em Configurações > Orçamento.',
    );
  }
  if (
    globalMaxPerDay !== null &&
    draft.maxCostPerDay !== null &&
    draft.maxCostPerDay > globalMaxPerDay
  ) {
    violations.push(
      `O limite diário da estratégia (${draft.maxCostPerDay} ${draft.currency}) excede o teto global do aplicativo (${globalMaxPerDay}).`,
    );
  }

  return { valid: violations.length === 0, violationsPt: violations };
};

export const toContractPolicies = (
  draft: StrategyDraft,
): {
  policy: RoutingPolicy;
  billing: BillingPolicy;
  privacy: PrivacyPolicy;
} => ({
  policy: {
    id: draft.policyId,
    strategy: draft.strategy,
    billingPolicyId: `${draft.policyId}-billing`,
    privacyPolicyId: `${draft.policyId}-privacy`,
    maxAttempts: Math.max(1, Math.min(10, Math.round(draft.maxAttempts))),
    requireTools: draft.requireTools,
  },
  billing: {
    id: `${draft.policyId}-billing`,
    allowPaid: draft.allowPaid,
    allowUnknownCost: draft.allowUnknownCost,
    maxCostPerRequest: draft.maxCostPerRequest,
    maxCostPerDay: draft.maxCostPerDay,
    currency: draft.currency.toUpperCase().slice(0, 3),
  },
  privacy: {
    id: `${draft.policyId}-privacy`,
    mode: draft.privacyMode,
    allowedProviderIds: draft.allowedProviderIds,
    allowPromptLogging: draft.allowPromptLogging,
  },
});

// ---------------------------------------------------------------------------
// 4. Quotas, Reservations & Unit-Honest Accounting (§4, §9)
// ---------------------------------------------------------------------------

export type QuotaWindowLabel =
  | 'RPM'
  | 'RPD'
  | 'TPM'
  | 'TPD'
  | 'Semanal'
  | 'Mensal'
  | 'Créditos'
  | 'Unidade do provedor'
  | 'Janela personalizada';

export const classifyQuotaWindow = (def: QuotaDefinition): QuotaWindowLabel => {
  if (def.unit === 'currency') return 'Créditos';
  if (def.unit === 'provider-unit') return 'Unidade do provedor';
  const isTokens = def.unit.endsWith('tokens');
  if (def.periodSeconds === 60) return isTokens ? 'TPM' : 'RPM';
  if (def.periodSeconds === 86_400) return isTokens ? 'TPD' : 'RPD';
  if (def.periodSeconds === 604_800) return 'Semanal';
  if (
    def.periodSeconds !== null &&
    def.periodSeconds >= 2_419_200 &&
    def.periodSeconds <= 2_678_400
  ) {
    return 'Mensal';
  }
  return 'Janela personalizada';
};

export interface QuotaCapacityBreakdown {
  quotaId: string;
  windowLabel: QuotaWindowLabel;
  unit: QuotaDefinition['unit'];
  scope: QuotaDefinition['scope'];
  scopeId: string;
  nominal: number | null;
  consumed: number | null;
  reserved: number;
  estimatedUncertain: number;
  available: number | null;
  /** Strictly null when nominal denominator is unknown or zero — never invented! */
  utilizationPercent: number | null;
  resetAt: string | null;
  observedAt: string | null;
  source: QuotaObservation['source'] | 'unknown';
}

export const computeQuotaBreakdown = (
  def: QuotaDefinition,
  observations: readonly QuotaObservation[],
  reservations: readonly QuotaReservation[],
): QuotaCapacityBreakdown => {
  const latest = [...observations]
    .filter((o) => o.quotaId === def.id)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];

  const relRes = reservations.filter((r) => r.quotaId === def.id);
  const reserved = relRes.filter((r) => r.status === 'held').reduce((acc, r) => acc + r.amount, 0);
  const estimatedUncertain = relRes
    .filter((r) => r.status === 'uncertain')
    .reduce((acc, r) => acc + r.amount, 0);

  const nominal = def.limit;
  const consumed = latest?.used ?? null;
  let available: number | null = latest?.remaining ?? null;
  if (available === null && nominal !== null && consumed !== null) {
    available = Math.max(0, nominal - consumed - reserved - estimatedUncertain);
  } else if (available !== null && (reserved > 0 || estimatedUncertain > 0)) {
    available = Math.max(0, available - reserved - estimatedUncertain);
  }

  let utilizationPercent: number | null = null;
  if (nominal !== null && nominal > 0) {
    const effectiveUsed =
      consumed !== null
        ? consumed + reserved + estimatedUncertain
        : latest?.remaining !== null && latest?.remaining !== undefined
          ? Math.max(0, nominal - latest.remaining) + reserved + estimatedUncertain
          : null;
    if (effectiveUsed !== null) {
      utilizationPercent = Math.min(100, Math.round((effectiveUsed / nominal) * 100));
    }
  }

  return {
    quotaId: def.id,
    windowLabel: classifyQuotaWindow(def),
    unit: def.unit,
    scope: def.scope,
    scopeId: def.scopeId,
    nominal,
    consumed,
    reserved,
    estimatedUncertain,
    available,
    utilizationPercent,
    resetAt: latest?.resetAt ?? null,
    observedAt: latest?.observedAt ?? def.verifiedAt,
    source: latest?.source ?? 'unknown',
  };
};

export interface UsageByCurrency {
  byCurrency: Record<string, { totalCost: number; requests: number }>;
  unknownCostRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  unreportedTokenRequests: number;
}

/**
 * Aggregates UsageRecord items WITHOUT mixing incompatible currencies or inventing a fake global
 * remaining token balance.
 */
export const summarizeUsageRecords = (records: readonly UsageRecord[]): UsageByCurrency => {
  const byCurrency: Record<string, { totalCost: number; requests: number }> = {};
  let unknownCostRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let unreportedTokenRequests = 0;

  for (const r of records) {
    if (r.cost !== null && r.currency !== null) {
      const bucket = byCurrency[r.currency] ?? { totalCost: 0, requests: 0 };
      bucket.totalCost += r.cost;
      bucket.requests += 1;
      byCurrency[r.currency] = bucket;
    } else {
      unknownCostRequests += 1;
    }

    if (r.inputTokens === null && r.outputTokens === null) {
      unreportedTokenRequests += 1;
    } else {
      totalInputTokens += r.inputTokens ?? 0;
      totalOutputTokens += r.outputTokens ?? 0;
    }
  }

  return {
    byCurrency,
    unknownCostRequests,
    totalInputTokens,
    totalOutputTokens,
    unreportedTokenRequests,
  };
};

// ---------------------------------------------------------------------------
// 5. Model Grouping Across Endpoints & Hardware Feasibility Estimates (§8, §10)
// ---------------------------------------------------------------------------

export interface CanonicalModelGroup {
  canonicalKey: string;
  displayName: string;
  family: string;
  offerings: {
    model: ModelDefinition;
    providerName: string;
    endpoint: ProviderEndpoint | undefined;
    connection: ProviderConnection | undefined;
    route: ModelRoute | undefined;
    availability: ModelAvailability | undefined;
    benchmark: BenchmarkResult | undefined;
  }[];
}

export const extractModelFamily = (upstreamModelId: string): string => {
  const cleaned = upstreamModelId.split('/').pop() ?? upstreamModelId;
  const lower = cleaned.toLowerCase();
  if (lower.startsWith('claude')) return 'Claude';
  if (
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  )
    return 'OpenAI GPT / o-series';
  if (lower.startsWith('gemini')) return 'Gemini';
  if (lower.startsWith('deepseek')) return 'DeepSeek';
  if (lower.startsWith('qwen')) return 'Qwen';
  if (lower.startsWith('llama')) return 'Llama';
  if (lower.startsWith('mistral') || lower.startsWith('codestral')) return 'Mistral';
  if (lower.startsWith('glm')) return 'GLM';
  if (lower.startsWith('kimi')) return 'Kimi';
  if (lower.startsWith('grok')) return 'Grok';
  return cleaned.split(/[-_:]/)[0] ?? 'Other';
};

export const normalizeCanonicalModelKey = (upstreamModelId: string): string =>
  (upstreamModelId.split('/').pop() ?? upstreamModelId)
    .toLowerCase()
    .replace(/:free$|:beta$|:latest$/i, '');

export const groupModelsAcrossProviders = (input: {
  models: readonly ModelDefinition[];
  catalog: readonly ProviderCatalogEntry[];
  endpoints: readonly ProviderEndpoint[];
  connections: readonly ProviderConnection[];
  routes: readonly ModelRoute[];
  availabilities: Readonly<Record<string, ModelAvailability>>;
  benchmarks: readonly BenchmarkResult[];
}): CanonicalModelGroup[] => {
  const groups = new Map<string, CanonicalModelGroup>();
  for (const model of input.models) {
    const key = normalizeCanonicalModelKey(model.upstreamModelId);
    const prov = input.catalog.find((c) => c.id === model.providerId);
    const route = input.routes.find((r) => r.modelId === model.id);
    const conn = route
      ? input.connections.find((c) => c.id === route.connectionId)
      : input.connections.find((c) => c.providerId === model.providerId);
    const endpoint = conn
      ? input.endpoints.find((e) => e.id === conn.endpointId)
      : input.endpoints.find((e) => e.providerId === model.providerId);
    const availKey = conn ? `${model.id}:${conn.id}` : '';
    const availability = availKey ? input.availabilities[availKey] : undefined;
    const benchmark = input.benchmarks.find((b) => b.modelId === model.id);

    let group = groups.get(key);
    if (!group) {
      group = {
        canonicalKey: key,
        displayName: model.name,
        family: extractModelFamily(model.upstreamModelId),
        offerings: [],
      };
      groups.set(key, group);
    }
    group.offerings.push({
      model,
      providerName: prov?.name ?? model.providerId,
      endpoint,
      connection: conn,
      route,
      availability,
      benchmark,
    });
  }
  return [...groups.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
};

export interface LocalModelReferenceSpec {
  modelTag: string;
  displayName: string;
  family: string;
  quantization: string;
  approxBytes: number;
  contextTokens: number;
  codingFocused: boolean;
}

/**
 * Reference open-weight model identifiers for explicit user-approved local pulls (Ollama).
 * Sizes and memory numbers are strictly marked as ESTIMATES, never guarantees.
 */
export const LOCAL_MODEL_REFERENCE_CATALOG: readonly LocalModelReferenceSpec[] = Object.freeze([
  {
    modelTag: 'qwen2.5-coder:7b',
    displayName: 'Qwen 2.5 Coder 7B',
    family: 'Qwen',
    quantization: 'Q4_K_M',
    approxBytes: 4_700_000_000,
    contextTokens: 32_768,
    codingFocused: true,
  },
  {
    modelTag: 'qwen2.5-coder:14b',
    displayName: 'Qwen 2.5 Coder 14B',
    family: 'Qwen',
    quantization: 'Q4_K_M',
    approxBytes: 9_000_000_000,
    contextTokens: 32_768,
    codingFocused: true,
  },
  {
    modelTag: 'qwen2.5-coder:32b',
    displayName: 'Qwen 2.5 Coder 32B',
    family: 'Qwen',
    quantization: 'Q4_K_M',
    approxBytes: 19_800_000_000,
    contextTokens: 32_768,
    codingFocused: true,
  },
  {
    modelTag: 'deepseek-r1:8b',
    displayName: 'DeepSeek R1 Distill 8B',
    family: 'DeepSeek',
    quantization: 'Q4_K_M',
    approxBytes: 4_900_000_000,
    contextTokens: 32_768,
    codingFocused: true,
  },
  {
    modelTag: 'llama3.2:3b',
    displayName: 'Llama 3.2 3B Instruct',
    family: 'Llama',
    quantization: 'Q4_K_M',
    approxBytes: 2_000_000_000,
    contextTokens: 128_000,
    codingFocused: false,
  },
]);

export type FeasibilityTier =
  'gpu-estimated' | 'cpu-ram-estimated' | 'insufficient-estimated' | 'hardware-unknown';

export interface LocalFeasibilityEstimate {
  tier: FeasibilityTier;
  requiredRamBytesEstimate: number;
  requiredVramBytesEstimate: number;
  labelPt: string;
}

export const estimateLocalFeasibility = (input: {
  modelSizeBytes: number | null;
  systemMemoryBytes: number | null;
  gpuMemoryBytes: number | null;
}): LocalFeasibilityEstimate => {
  const bytes = input.modelSizeBytes ?? 0;
  // Rule-of-thumb KV cache + runtime overhead (~1.25x model file size) — explicitly an ESTIMATE
  const requiredVramBytesEstimate = Math.round(bytes * 1.25);
  const requiredRamBytesEstimate = Math.round(bytes * 1.35 + 2_000_000_000);

  if (!bytes || (input.systemMemoryBytes === null && input.gpuMemoryBytes === null)) {
    return {
      tier: 'hardware-unknown',
      requiredRamBytesEstimate,
      requiredVramBytesEstimate,
      labelPt: 'Estimativa indisponível (VRAM/RAM não reportada pelo runtime)',
    };
  }
  if (input.gpuMemoryBytes !== null && input.gpuMemoryBytes >= requiredVramBytesEstimate) {
    return {
      tier: 'gpu-estimated',
      requiredRamBytesEstimate,
      requiredVramBytesEstimate,
      labelPt: 'Estimativa: compatível com aceleração em VRAM (não é garantia)',
    };
  }
  if (input.systemMemoryBytes !== null && input.systemMemoryBytes >= requiredRamBytesEstimate) {
    return {
      tier: 'cpu-ram-estimated',
      requiredRamBytesEstimate,
      requiredVramBytesEstimate,
      labelPt: 'Estimativa: executável em RAM/CPU ou offload parcial (menor velocidade)',
    };
  }
  return {
    tier: 'insufficient-estimated',
    requiredRamBytesEstimate,
    requiredVramBytesEstimate,
    labelPt: 'Estimativa: memória insuficiente provável para esta quantização',
  };
};

export const formatBytesGiB = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) return 'Desconhecido';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

export const formatPricePerMillion = (
  amount: number | null | undefined,
  currency: string | null | undefined,
): string => {
  if (amount === null || amount === undefined || !currency) return 'Desconhecido';
  if (amount === 0) return `${currency} 0.00 / 1M (gratuito verificado)`;
  return `${currency} ${amount.toFixed(4)} / 1M`;
};

export interface AiResourceSnapshot {
  channelStates: Record<AiChannelKey, ChannelSupportState>;
  catalog: ProviderCatalogEntry[];
  endpoints: ProviderEndpoint[];
  connections: ProviderConnection[];
  models: ModelDefinition[];
  routes: ModelRoute[];
  quotas: QuotaDefinition[];
  observations: Record<string, QuotaObservation[]>;
  reservations: Record<string, QuotaReservation[]>;
  credits: CreditBalance[];
  localRuntimes: LocalRuntime[];
  localModels: Record<string, LocalModel[]>;
  availabilities: Record<string, ModelAvailability>;
  benchmarks: BenchmarkResult[];
  recentAttempts: Record<string, FallbackAttempt[]>;
  recentUsage: UsageRecord[];
}
