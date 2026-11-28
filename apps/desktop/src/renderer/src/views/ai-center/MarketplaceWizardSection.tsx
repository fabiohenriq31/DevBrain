import { useMemo, useState } from 'react';
import type {
  CredentialReference,
  DiscoveredProviderModel,
  ProviderCatalogEntry,
  ProviderEndpoint,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  SplitPane,
  tokens,
} from '@devbrain/ui';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  ListPlus,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  PRIVACY_CLASSIFICATIONS,
  buildPresetStrategy,
  callAiChannel,
  evaluateProviderEligibility,
  formatPricePerMillion,
  toContractPolicies,
  type AiResourceSnapshot,
  type ProjectPrivacyClass,
} from '../../lib/ai-center';
import { describeError, invoke } from '../../lib/bridge';
import { formatTimestamp, type AppLanguage } from '../../lib/i18n';
import type { AssistedSignupQueueItem } from '../../lib/preferences';

export interface MarketplaceWizardSectionProps {
  snapshot: AiResourceSnapshot;
  activeProjectId: string | null;
  credentials: readonly CredentialReference[];
  projectPrivacy: ProjectPrivacyClass;
  approvedProviderIds: readonly string[];
  signupQueue: readonly AssistedSignupQueueItem[];
  onUpdateSignupQueue: (next: AssistedSignupQueueItem[]) => void;
  onRefreshAll: () => Promise<void>;
  language: AppLanguage;
}

const DEFAULT_ENDPOINTS_BY_PROVIDER: Readonly<
  Record<string, { baseUrl: string; protocol: ProviderEndpoint['protocol'] }>
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-chat' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-chat' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai-chat' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', protocol: 'openai-chat' },
  cohere: { baseUrl: 'https://api.cohere.ai/compatibility/v1', protocol: 'openai-chat' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', protocol: 'openai-chat' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', protocol: 'openai-chat' },
  vercel: { baseUrl: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai-chat' },
  togetherai: { baseUrl: 'https://api.together.xyz/v1', protocol: 'openai-chat' },
  'fireworks-ai': { baseUrl: 'https://api.fireworks.ai/inference/v1', protocol: 'openai-chat' },
  deepinfra: { baseUrl: 'https://api.deepinfra.com/v1/openai', protocol: 'openai-chat' },
  'siliconflow-cn': { baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-chat' },
  'alibaba-cn': {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai-chat',
  },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', protocol: 'openai-chat' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat' },
  anthropic: { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages' },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'google-gemini',
  },
  ollama: { baseUrl: 'http://127.0.0.1:11434', protocol: 'ollama' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai-chat' },
  'llama-cpp': { baseUrl: 'http://127.0.0.1:9931/v1', protocol: 'openai-chat' },
};

export const MarketplaceWizardSection = ({
  snapshot,
  activeProjectId,
  credentials,
  projectPrivacy,
  approvedProviderIds,
  signupQueue,
  onUpdateSignupQueue,
  onRefreshAll,
  language,
}: MarketplaceWizardSectionProps) => {
  const pt = language === 'pt-BR';

  // Search & all 12 filters (§5)
  const [query, setQuery] = useState('');
  const [filterRecurringFree, setFilterRecurringFree] = useState<'all' | 'verified-free'>('all');
  const [filterPromoCredits, setFilterPromoCredits] = useState<'all' | 'with-credits'>('all');
  const [filterCardRequired, setFilterCardRequired] = useState<'all' | 'unknown-only'>('all');
  const [filterCommercial, setFilterCommercial] = useState<'all' | 'terms-documented'>('all');
  const [filterPrivacy, setFilterPrivacy] = useState<'all' | 'eligible-project' | 'local-only'>(
    'all',
  );
  const [filterRegion, setFilterRegion] = useState<'all' | 'documented'>('all');
  const [filterCoding, setFilterCoding] = useState<'all' | 'coding-ready'>('all');
  const [filterTools, setFilterTools] = useState<'all' | 'tools-yes'>('all');
  const [filterContext, setFilterContext] = useState<'all' | '32k' | '128k' | '200k'>('all');
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<
    'all' | 'ready' | 'configured' | 'discovered' | 'unavailable'
  >('all');
  const [filterHasModels, setFilterHasModels] = useState<'all' | 'with-models'>('all');

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    snapshot.catalog[0]?.id ?? null,
  );

  // Assisted 11-step onboarding wizard (§6)
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<number>(1);
  const [wizardProviderId, setWizardProviderId] = useState<string>('openrouter');
  const [wizardProviderName, setWizardProviderName] = useState<string>('OpenRouter');
  const [wizardSignupUrl, setWizardSignupUrl] = useState<string>('https://openrouter.ai/keys');
  const [wizardDocUrl, setWizardDocUrl] = useState<string>(
    'https://openrouter.ai/docs/quick-start',
  );
  const [wizardBaseUrl, setWizardBaseUrl] = useState<string>('https://openrouter.ai/api/v1');
  const [wizardProtocol, setWizardProtocol] = useState<ProviderEndpoint['protocol']>('openai-chat');
  const [wizardCredMode, setWizardCredMode] = useState<'existing' | 'os-encrypted' | 'environment'>(
    'os-encrypted',
  );
  const [wizardExistingCredId, setWizardExistingCredId] = useState<string>('');
  const [wizardCredLabel, setWizardCredLabel] = useState<string>('');
  const [wizardSecretValue, setWizardSecretValue] = useState<string>('');
  const [wizardEnvVar, setWizardEnvVar] = useState<string>('');
  const [wizardStoredCredId, setWizardStoredCredId] = useState<string>('');
  const [wizardEndpointId, setWizardEndpointId] = useState<string>('');
  const [wizardConnectionId, setWizardConnectionId] = useState<string>('');
  const [wizardModelUpstreamId, setWizardModelUpstreamId] = useState<string>('');
  const [wizardSavedModelId, setWizardSavedModelId] = useState<string>('');
  const [wizardValidationSummary, setWizardValidationSummary] = useState<string | null>(null);
  const [wizardDiscoveredModels, setWizardDiscoveredModels] = useState<DiscoveredProviderModel[]>(
    [],
  );
  const [wizardAuthorizeInferenceTest, setWizardAuthorizeInferenceTest] = useState<boolean>(false);
  const [wizardInferenceTestSummary, setWizardInferenceTestSummary] = useState<string | null>(null);
  const [wizardRoutePriority, setWizardRoutePriority] = useState<string>('10');
  const [wizardLocalOnly, setWizardLocalOnly] = useState<boolean>(false);
  const [wizardPrivacy, setWizardPrivacy] = useState<ProjectPrivacyClass>(projectPrivacy);
  const [wizardAllowPaid, setWizardAllowPaid] = useState(false);
  const [wizardApproveProvider, setWizardApproveProvider] = useState(false);
  const [wizardDailyBudget, setWizardDailyBudget] = useState('');
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  // Enrich catalog entries strictly from verified contract records (never inventing free/commercial badges!)
  const enrichedCatalog = useMemo(() => {
    return snapshot.catalog.map((entry) => {
      const provModels = snapshot.models.filter((m) => m.providerId === entry.id);
      const provEndpoints = snapshot.endpoints.filter((e) => e.providerId === entry.id);
      const provConns = snapshot.connections.filter((c) => c.providerId === entry.id);
      const provQuotas = snapshot.quotas.filter(
        (q) => q.scope === 'provider' && q.scopeId === entry.id,
      );
      const hasVerifiedFreeModel = provModels.some(
        (m) =>
          m.pricing !== null && m.pricing.inputPerMillion === 0 && m.pricing.outputPerMillion === 0,
      );
      const hasVerifiedPaidModel = provModels.some(
        (m) =>
          m.pricing !== null &&
          ((m.pricing.inputPerMillion ?? 0) > 0 || (m.pricing.outputPerMillion ?? 0) > 0),
      );
      const hasPromoCredit = snapshot.credits.some(
        (cr) => cr.accountId.includes(entry.id) && (cr.amount ?? 0) > 0,
      );
      const maxContext = provModels.reduce(
        (mx, m) => Math.max(mx, m.capabilities.contextTokens ?? 0),
        0,
      );
      const supportsTools = provModels.some((m) => m.capabilities.tools);
      const supportsCoding =
        supportsTools ||
        provModels.some((m) =>
          /code|coder|sonnet|gpt|deepseek|qwen|gemini/i.test(m.upstreamModelId),
        );

      const bestConn = provConns.find((c) => c.enabled && c.status === 'ready') ?? provConns[0];
      const opState: 'ready' | 'configured' | 'unavailable' | 'discovered' = bestConn
        ? bestConn.status === 'ready'
          ? 'ready'
          : bestConn.status === 'unavailable' || bestConn.status === 'invalid-credential'
            ? 'unavailable'
            : 'configured'
        : 'discovered';

      const eligibility = evaluateProviderEligibility({
        privacyClass: projectPrivacy,
        provider: entry,
        endpoint: provEndpoints[0],
        connection: bestConn,
        approvedProviderIds,
      });

      return {
        entry,
        provModels,
        provEndpoints,
        provConns,
        provQuotas,
        hasVerifiedFreeModel,
        hasVerifiedPaidModel,
        hasPromoCredit,
        maxContext,
        supportsTools,
        supportsCoding,
        opState,
        eligibility,
      };
    });
  }, [
    approvedProviderIds,
    projectPrivacy,
    snapshot.catalog,
    snapshot.connections,
    snapshot.credits,
    snapshot.endpoints,
    snapshot.models,
    snapshot.quotas,
  ]);

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enrichedCatalog.filter((item) => {
      if (q) {
        const hit =
          item.entry.name.toLowerCase().includes(q) ||
          item.entry.id.toLowerCase().includes(q) ||
          item.entry.sourceId.toLowerCase().includes(q) ||
          item.provModels.some((m) => m.upstreamModelId.toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (filterRecurringFree === 'verified-free' && !item.hasVerifiedFreeModel) return false;
      if (filterPromoCredits === 'with-credits' && !item.hasPromoCredit) return false;
      if (filterCardRequired === 'unknown-only' && item.entry.kind === 'local') return false;
      if (filterCommercial === 'terms-documented' && !item.entry.termsUrl) return false;
      if (filterPrivacy === 'eligible-project' && !item.eligibility.eligible) return false;
      if (filterPrivacy === 'local-only' && item.entry.kind !== 'local') return false;
      if (filterRegion === 'documented' && !item.entry.documentationUrl) return false;
      if (filterCoding === 'coding-ready' && !item.supportsCoding) return false;
      if (filterTools === 'tools-yes' && !item.supportsTools) return false;
      if (filterContext === '32k' && item.maxContext < 32_000) return false;
      if (filterContext === '128k' && item.maxContext < 128_000) return false;
      if (filterContext === '200k' && item.maxContext < 200_000) return false;
      if (
        filterProtocol !== 'all' &&
        !item.provEndpoints.some((ep) => ep.protocol === filterProtocol)
      ) {
        return false;
      }
      if (filterStatus !== 'all' && item.opState !== filterStatus) return false;
      if (filterHasModels === 'with-models' && item.provModels.length === 0) return false;
      return true;
    });
  }, [
    enrichedCatalog,
    filterCardRequired,
    filterCoding,
    filterCommercial,
    filterContext,
    filterHasModels,
    filterPrivacy,
    filterPromoCredits,
    filterProtocol,
    filterRecurringFree,
    filterRegion,
    filterStatus,
    filterTools,
    query,
  ]);

  const selectedItem = useMemo(
    () =>
      filteredCatalog.find((i) => i.entry.id === selectedProviderId) ??
      enrichedCatalog.find((i) => i.entry.id === selectedProviderId) ??
      filteredCatalog[0] ??
      null,
    [enrichedCatalog, filteredCatalog, selectedProviderId],
  );
  const persistedCompleted = (providerId: string) =>
    snapshot.connections.some(
      (connection) =>
        connection.providerId === providerId &&
        connection.status === 'ready' &&
        snapshot.routes.some(
          (route) =>
            route.connectionId === connection.id &&
            route.enabled &&
            snapshot.models.some((model) => model.id === route.modelId),
        ),
    );

  const enqueueProvider = (entry: ProviderCatalogEntry) => {
    if (signupQueue.some((q) => q.providerId === entry.id)) return;
    onUpdateSignupQueue([
      ...signupQueue,
      {
        providerId: entry.id,
        providerName: entry.name,
        currentStep: 1,
        status: 'queued',
        updatedAt: new Date().toISOString(),
      },
    ]);
  };

  const openWizardFor = (entry?: ProviderCatalogEntry, _resumeStep = 1) => {
    const pid = entry?.id ?? 'openrouter';
    const pname = entry?.name ?? 'OpenRouter';
    const presetEp = DEFAULT_ENDPOINTS_BY_PROVIDER[pid];
    const existingEp = snapshot.endpoints.find((e) => e.providerId === pid);
    const existingConn = snapshot.connections.find((c) => c.providerId === pid);
    const existingModel = snapshot.models.find((m) => m.providerId === pid);
    const existingRoute = snapshot.routes.find(
      (route) => route.connectionId === existingConn?.id && route.modelId === existingModel?.id,
    );
    const matchingCredentials = credentials.filter((credential) =>
      credential.label.toLowerCase().includes(pname.toLowerCase()),
    );
    const recoveredCredentialId =
      existingConn?.credentialId ??
      (matchingCredentials.length === 1 ? matchingCredentials[0]?.id : null) ??
      '';
    setWizardProviderId(pid);
    setWizardProviderName(pname);
    setWizardSignupUrl(entry?.signupUrl ?? '');
    setWizardDocUrl(entry?.documentationUrl ?? '');
    setWizardBaseUrl(existingEp?.baseUrl ?? presetEp?.baseUrl ?? 'https://');
    setWizardProtocol(existingEp?.protocol ?? presetEp?.protocol ?? 'openai-chat');
    setWizardCredLabel(`${pname} API Key`);
    setWizardSecretValue('');
    setWizardEnvVar('');
    setWizardStoredCredId(recoveredCredentialId);
    setWizardExistingCredId(recoveredCredentialId);
    setWizardCredMode(recoveredCredentialId ? 'existing' : 'os-encrypted');
    setWizardEndpointId(existingEp?.id ?? `ep-${pid}`);
    setWizardConnectionId(existingConn?.id ?? `conn-${pid}`);
    setWizardValidationSummary(null);
    setWizardDiscoveredModels([]);
    setWizardSavedModelId(existingModel?.id ?? '');
    setWizardModelUpstreamId(existingModel?.upstreamModelId ?? '');
    setWizardInferenceTestSummary(null);
    setWizardAuthorizeInferenceTest(false);
    setWizardLocalOnly(entry?.kind === 'local' || presetEp?.protocol === 'ollama');
    setWizardPrivacy(projectPrivacy);
    setWizardAllowPaid(false);
    setWizardApproveProvider(false);
    setWizardDailyBudget('');
    setWizardError(null);
    setWizardStep(existingRoute ? 9 : existingConn ? 7 : recoveredCredentialId ? 6 : 1);
    setWizardOpen(true);
  };

  const persistQueueProgress = (step: number, status: AssistedSignupQueueItem['status']) => {
    const now = new Date().toISOString();
    const exists = signupQueue.some((q) => q.providerId === wizardProviderId);
    const next = exists
      ? signupQueue.map((q) =>
          q.providerId === wizardProviderId
            ? { ...q, currentStep: step, status, updatedAt: now }
            : q,
        )
      : [
          ...signupQueue,
          {
            providerId: wizardProviderId,
            providerName: wizardProviderName,
            currentStep: step,
            status,
            updatedAt: now,
          },
        ];
    onUpdateSignupQueue(next);
  };

  const handleWizardStoreCredential = async () => {
    setWizardError(null);
    setWizardBusy(true);
    try {
      let storedId = wizardExistingCredId;
      if (wizardCredMode === 'existing') {
        if (!wizardExistingCredId && wizardProtocol !== 'ollama')
          throw new Error('Select an existing credential for this provider');
        setWizardStoredCredId(wizardExistingCredId);
      } else if (wizardCredMode === 'os-encrypted') {
        const stored = await invoke('credentials.store', {
          storage: 'os-encrypted',
          label: wizardCredLabel.trim() || `${wizardProviderName} Key`,
          secret: wizardSecretValue,
        });
        // Immediately wipe secret from React state memory!
        setWizardSecretValue('');
        setWizardStoredCredId(stored.id);
        storedId = stored.id;
      } else {
        const stored = await invoke('credentials.store', {
          storage: 'environment',
          label: wizardCredLabel.trim() || `${wizardProviderName} Env`,
          variable: wizardEnvVar.trim(),
        });
        setWizardEnvVar('');
        setWizardStoredCredId(stored.id);
        storedId = stored.id;
      }
      const savedCredentials = await invoke('credentials.list', {});
      if (storedId && !savedCredentials.some((ref) => ref.id === storedId))
        throw new Error('Credential was not persisted');
      await onRefreshAll();
      persistQueueProgress(6, 'in-progress');
      setWizardStep(6);
    } catch (e) {
      setWizardError(describeError(e, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const handleWizardRegisterConnection = async () => {
    setWizardError(null);
    setWizardBusy(true);
    try {
      const epId = wizardEndpointId.trim() || `ep-${wizardProviderId}`;
      const connId = wizardConnectionId.trim() || `conn-${wizardProviderId}`;
      const epRes = await callAiChannel('ai.endpoints.save', {
        id: epId,
        providerId: wizardProviderId,
        baseUrl: wizardBaseUrl.trim(),
        protocol: wizardProtocol,
        documentationUrl: wizardDocUrl.trim() ? wizardDocUrl.trim() : null,
      });
      if (epRes.status === 'unsupported') throw new Error(epRes.message);
      if (epRes.status === 'error') throw new Error(`${epRes.error.code}: ${epRes.error.message}`);

      const connRes = await callAiChannel('ai.connections.save', {
        id: connId,
        providerId: wizardProviderId,
        endpointId: epId,
        credentialId: wizardStoredCredId || null,
        enabled: true,
        status: 'unknown',
        lastVerifiedAt: null,
      });
      if (connRes.status !== 'ok') {
        throw new Error(
          connRes.status === 'unsupported'
            ? connRes.message
            : `${connRes.error.code}: ${connRes.error.message}`,
        );
      }
      const readBack = await callAiChannel('ai.connections.list', {});
      if (
        readBack.status !== 'ok' ||
        !readBack.data.some((item) => item.id === connId && item.endpointId === epId)
      )
        throw new Error('Connection was not persisted');
      await onRefreshAll();
      persistQueueProgress(7, 'in-progress');
      setWizardStep(7);
    } catch (e) {
      setWizardError(describeError(e, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const handleWizardValidateAuth = async () => {
    setWizardError(null);
    setWizardBusy(true);
    try {
      const res = await callAiChannel('ai.connections.discover', { id: wizardConnectionId });
      if (res.status === 'ok' && (res.data.authenticated || wizardLocalOnly)) {
        setWizardDiscoveredModels(res.data.models);
        setWizardValidationSummary(
          `${pt ? 'Credencial aceita' : 'Credential accepted'} · ${res.data.models.length} ${pt ? 'modelos descobertos' : 'models discovered'}`,
        );
        const free = res.data.models.find(
          (model) =>
            model.pricing?.inputPerMillion === 0 &&
            model.pricing.outputPerMillion === 0 &&
            model.tools === true,
        );
        setWizardModelUpstreamId(
          free?.upstreamModelId ?? res.data.models[0]?.upstreamModelId ?? '',
        );
        const connectionRead = await callAiChannel('ai.connections.list', {});
        if (
          connectionRead.status !== 'ok' ||
          !connectionRead.data.some(
            (item) => item.id === wizardConnectionId && item.status === 'ready',
          )
        )
          throw new Error('Authentication state was not persisted');
        await onRefreshAll();
        persistQueueProgress(8, 'in-progress');
        setWizardStep(8);
      } else if (res.status === 'unsupported') {
        setWizardError(res.message);
      } else {
        setWizardError(
          res.status === 'error'
            ? `${res.error.code}: ${res.error.message}`
            : 'Authentication not confirmed',
        );
      }
    } catch (error) {
      setWizardError(describeError(error, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const handleWizardSaveModel = async () => {
    if (!wizardModelUpstreamId.trim()) return;
    setWizardError(null);
    setWizardBusy(true);
    try {
      const sanitizedId = `${wizardProviderId}-${wizardModelUpstreamId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]/g, '-')}`.slice(0, 120);
      const discovered = wizardDiscoveredModels.find(
        (item) => item.upstreamModelId === wizardModelUpstreamId,
      );
      if (!discovered) throw new Error('Choose a model returned by authenticated discovery');
      const res = await callAiChannel('ai.models.save', {
        id: sanitizedId,
        providerId: wizardProviderId,
        upstreamModelId: wizardModelUpstreamId.trim(),
        name: discovered.name,
        capabilities: {
          input: ['text'],
          output: ['text'],
          tools: discovered.tools === true,
          streaming: true,
          structuredOutput: false,
          reasoning: false,
          contextTokens: discovered.contextTokens,
          outputTokens: discovered.outputTokens,
        },
        pricing: discovered.pricing,
        lifecycle: 'unknown',
        sourceId: 'provider-api',
        verifiedAt: discovered.observedAt,
      });
      if (res.status === 'ok') {
        const readBack = await callAiChannel('ai.models.list', {});
        if (
          readBack.status !== 'ok' ||
          !readBack.data.some(
            (item) =>
              item.id === res.data.id && item.upstreamModelId === discovered.upstreamModelId,
          )
        )
          throw new Error('Model was not persisted');
        setWizardSavedModelId(res.data.id);
        await onRefreshAll();
        persistQueueProgress(10, 'in-progress');
        setWizardStep(10);
      } else {
        setWizardError(res.status === 'unsupported' ? res.message : res.error.message);
      }
    } catch (error) {
      setWizardError(describeError(error, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const saveWizardProjectPolicy = async () => {
    if (!activeProjectId) throw new Error('Select a project');
    const current = await callAiChannel('ai.projectPolicy.get', { projectId: activeProjectId });
    if (current.status !== 'ok') throw new Error('Project policy is unavailable');
    const dollars = wizardDailyBudget.trim() ? Number(wizardDailyBudget) : null;
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000))
      throw new Error('Invalid daily budget');
    const saved = await callAiChannel('ai.projectPolicy.save', {
      ...current.data,
      privacyClass: wizardPrivacy,
      approvedProviderIds: wizardApproveProvider
        ? [...new Set([...current.data.approvedProviderIds, wizardProviderId])]
        : current.data.approvedProviderIds,
      budget: {
        ...current.data.budget,
        allowPaid: wizardAllowPaid,
        maxPerDayMicros:
          dollars === null ? current.data.budget.maxPerDayMicros : Math.round(dollars * 1_000_000),
      },
    });
    if (saved.status !== 'ok')
      throw new Error(saved.status === 'error' ? saved.error.message : saved.message);
    const confirmed = await callAiChannel('ai.projectPolicy.get', { projectId: activeProjectId });
    if (
      confirmed.status !== 'ok' ||
      confirmed.data.privacyClass !== wizardPrivacy ||
      confirmed.data.budget.allowPaid !== wizardAllowPaid
    )
      throw new Error('Project policy was not persisted');
    const strategy = buildPresetStrategy(wizardAllowPaid ? 'balanced' : 'free-only', {
      policyId: `policy-project-${activeProjectId}`,
      allowedProviderIds: [wizardProviderId],
    });
    const configured = await callAiChannel(
      'ai.policies.configure',
      toContractPolicies({
        ...strategy,
        policyId: `policy-project-${activeProjectId}`,
        allowPaid: wizardAllowPaid,
        privacyMode: wizardPrivacy === 'restricted' ? 'local-only' : 'approved-providers',
        allowedProviderIds: [wizardProviderId],
      }),
    );
    if (configured.status !== 'ok')
      throw new Error(
        configured.status === 'error' ? configured.error.message : configured.message,
      );
  };

  const handleWizardAuthorizedTestInference = async () => {
    if (!wizardAuthorizeInferenceTest || !activeProjectId || !wizardSavedModelId) return;
    setWizardError(null);
    setWizardBusy(true);
    try {
      await saveWizardProjectPolicy();
      const reqId = `req-test-${Date.now()}`;
      const sub = await callAiChannel('ai.inference.submit', {
        id: reqId,
        sessionId: null,
        modelId: wizardSavedModelId || null,
        messages: [{ role: 'user', content: 'Responda apenas OK.' }],
        maxOutputTokens: 16,
        temperature: 0,
        stream: false,
        routingPolicyId: `policy-project-${activeProjectId}`,
        idempotencyKey: reqId,
        projectId: activeProjectId,
      });
      if (sub.status !== 'ok') {
        setWizardError(sub.status === 'unsupported' ? sub.message : sub.error.message);
        return;
      }
      let result = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        const out = await callAiChannel('ai.inference.result', { requestId: sub.data.requestId });
        if (out.status === 'error') throw new Error(out.error.message);
        if (out.status === 'ok' && out.data) {
          result = out.data;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (result) {
        setWizardInferenceTestSummary(
          `${pt ? 'Inferência concluída' : 'Inference succeeded'} (${result.finishReason}): "${result.content.slice(0, 80)}"`,
        );
      } else {
        setWizardError(
          pt ? 'Teste ainda sem resultado confirmado.' : 'Test has no confirmed result yet.',
        );
      }
    } catch (error) {
      setWizardError(describeError(error, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const handleWizardConfigureRoute = async () => {
    setWizardError(null);
    setWizardBusy(true);
    try {
      if (wizardSavedModelId && wizardConnectionId) {
        const routeRes = await callAiChannel('ai.routes.save', {
          id: `route-${wizardSavedModelId}`,
          modelId: wizardSavedModelId,
          connectionId: wizardConnectionId,
          priority: Math.max(0, Number.parseInt(wizardRoutePriority, 10) || 10),
          enabled: true,
          localOnly: wizardLocalOnly,
        });
        if (routeRes.status !== 'ok')
          throw new Error(routeRes.status === 'error' ? routeRes.error.message : routeRes.message);
      }
      const routes = await callAiChannel('ai.routes.list', {});
      if (
        routes.status !== 'ok' ||
        !routes.data.some(
          (route) =>
            route.connectionId === wizardConnectionId &&
            route.modelId === wizardSavedModelId &&
            route.enabled,
        )
      )
        throw new Error('Operational route was not persisted');
      await onRefreshAll();
      persistQueueProgress(9, 'in-progress');
      setWizardStep(9);
    } catch (error) {
      setWizardError(describeError(error, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const handleWizardComplete = async () => {
    setWizardError(null);
    setWizardBusy(true);
    try {
      if (!activeProjectId) throw new Error('Select a project before completing setup');
      const [connections, models, routes] = await Promise.all([
        callAiChannel('ai.connections.list', {}),
        callAiChannel('ai.models.list', {}),
        callAiChannel('ai.routes.list', {}),
      ]);
      if (
        connections.status !== 'ok' ||
        !connections.data.some((item) => item.id === wizardConnectionId && item.status === 'ready')
      )
        throw new Error('Authentication is not confirmed');
      if (models.status !== 'ok' || !models.data.some((item) => item.id === wizardSavedModelId))
        throw new Error('No persisted model selected');
      if (
        routes.status !== 'ok' ||
        !routes.data.some(
          (item) =>
            item.connectionId === wizardConnectionId &&
            item.modelId === wizardSavedModelId &&
            item.enabled,
        )
      )
        throw new Error('No persisted route for this model');
      await saveWizardProjectPolicy();
      const check = await callAiChannel('ai.routes.explain', {
        id: `req-onboard-${Date.now()}`,
        sessionId: null,
        modelId: wizardSavedModelId,
        messages: [{ role: 'user', content: 'Connection readiness check' }],
        maxOutputTokens: 16,
        temperature: 0,
        stream: false,
        routingPolicyId: `policy-project-${activeProjectId}`,
        idempotencyKey: null,
        projectId: activeProjectId,
      });
      if (
        check.status !== 'ok' ||
        !check.data.ranked.some((route) => route.routeId === `route-${wizardSavedModelId}`)
      )
        throw new Error(
          pt
            ? 'Rota salva, mas ainda inelegível para este projeto. Revise privacidade, preço e capacidades.'
            : 'Route saved but not eligible for this project. Review privacy, price and capabilities.',
        );
      persistQueueProgress(11, 'completed');
      await onRefreshAll();
      setWizardStep(11);
    } catch (error) {
      setWizardError(describeError(error, language).message);
    } finally {
      setWizardBusy(false);
    }
  };

  const leftListPane = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: tokens.color.surface,
      }}
    >
      {/* Search + Quick Assisted Wizard */}
      <div
        style={{
          padding: 10,
          borderBottom: `1px solid ${tokens.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Input
              value={query}
              placeholder={
                pt
                  ? `Pesquisar ${snapshot.catalog.length} provedores ou modelos…`
                  : 'Search providers or models…'
              }
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 28, height: 28 }}
            />
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: 8,
                top: 7,
                color: tokens.color.textFaint,
                pointerEvents: 'none',
              }}
            />
          </div>
          <Button
            size="xs"
            variant="primary"
            icon={<Sparkles size={12} />}
            onClick={() => openWizardFor(selectedItem?.entry)}
          >
            {pt ? 'Cadastro assistido' : 'Guided setup'}
          </Button>
        </div>

        {/* Compact 12-filter matrix */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 5,
          }}
        >
          <Select
            aria-label={pt ? 'Gratuidade recorrente' : 'Recurring free'}
            value={filterRecurringFree}
            onChange={(e) => setFilterRecurringFree(e.target.value as 'all' | 'verified-free')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Oferta: Todas' : 'Offer: All'}</option>
            <option value="verified-free">{pt ? 'Gratuito verificado' : 'Verified free'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Créditos promocionais' : 'Promo credits'}
            value={filterPromoCredits}
            onChange={(e) => setFilterPromoCredits(e.target.value as 'all' | 'with-credits')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Créditos: Todos' : 'Credits: All'}</option>
            <option value="with-credits">{pt ? 'Com crédito ativo' : 'Active credit'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Cartão obrigatório' : 'Card requirement'}
            value={filterCardRequired}
            onChange={(e) => setFilterCardRequired(e.target.value as 'all' | 'unknown-only')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Cartão: Todos' : 'Card: All'}</option>
            <option value="unknown-only">{pt ? 'Exige verificação' : 'Unverified card req'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Uso comercial' : 'Commercial use'}
            value={filterCommercial}
            onChange={(e) => setFilterCommercial(e.target.value as 'all' | 'terms-documented')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Comercial: Todos' : 'Commercial: All'}</option>
            <option value="terms-documented">
              {pt ? 'Termos publicados' : 'Terms documented'}
            </option>
          </Select>

          <Select
            aria-label={pt ? 'Privacidade' : 'Privacy'}
            value={filterPrivacy}
            onChange={(e) =>
              setFilterPrivacy(e.target.value as 'all' | 'eligible-project' | 'local-only')
            }
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Privacidade: Todas' : 'Privacy: All'}</option>
            <option value="eligible-project">
              {pt ? 'Elegível no projeto' : 'Project eligible'}
            </option>
            <option value="local-only">{pt ? 'Somente local' : 'Local only'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Região e documentação' : 'Region'}
            value={filterRegion}
            onChange={(e) => setFilterRegion(e.target.value as 'all' | 'documented')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Região: Todas' : 'Region: All'}</option>
            <option value="documented">{pt ? 'Com doc oficial' : 'Documented'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Programação' : 'Coding'}
            value={filterCoding}
            onChange={(e) => setFilterCoding(e.target.value as 'all' | 'coding-ready')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Código: Todos' : 'Coding: All'}</option>
            <option value="coding-ready">{pt ? 'Apto p/ código' : 'Coding capable'}</option>
          </Select>

          <Select
            aria-label="Tool calling"
            value={filterTools}
            onChange={(e) => setFilterTools(e.target.value as 'all' | 'tools-yes')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Tools: Todos' : 'Tools: All'}</option>
            <option value="tools-yes">{pt ? 'Com Tool Calling' : 'Tool calling'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Contexto' : 'Context'}
            value={filterContext}
            onChange={(e) => setFilterContext(e.target.value as 'all' | '32k' | '128k' | '200k')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Contexto: Todos' : 'Context: All'}</option>
            <option value="32k">&ge; 32k tok</option>
            <option value="128k">&ge; 128k tok</option>
            <option value="200k">&ge; 200k tok</option>
          </Select>

          <Select
            aria-label={pt ? 'Protocolo' : 'Protocol'}
            value={filterProtocol}
            onChange={(e) => setFilterProtocol(e.target.value)}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Protocolo: Todos' : 'Protocol: All'}</option>
            <option value="openai-chat">openai-chat</option>
            <option value="openai-responses">openai-responses</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-gemini">google-gemini</option>
            <option value="ollama">ollama</option>
          </Select>

          <Select
            aria-label={pt ? 'Estado operacional' : 'Status'}
            value={filterStatus}
            onChange={(e) =>
              setFilterStatus(
                e.target.value as 'all' | 'ready' | 'configured' | 'discovered' | 'unavailable',
              )
            }
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Estado: Todos' : 'State: All'}</option>
            <option value="ready">{pt ? 'Operacional' : 'Ready'}</option>
            <option value="configured">{pt ? 'Configurado' : 'Configured'}</option>
            <option value="discovered">{pt ? 'Descoberto' : 'Discovered'}</option>
            <option value="unavailable">{pt ? 'Indisponível' : 'Unavailable'}</option>
          </Select>

          <Select
            aria-label={pt ? 'Modelos disponíveis' : 'Models'}
            value={filterHasModels}
            onChange={(e) => setFilterHasModels(e.target.value as 'all' | 'with-models')}
            style={{ height: 24, fontSize: 11 }}
          >
            <option value="all">{pt ? 'Modelos: Todos' : 'Models: All'}</option>
            <option value="with-models">{pt ? 'Com modelos' : 'Has models'}</option>
          </Select>
        </div>
      </div>

      {/* Queue of Free/Assisted Signups */}
      {signupQueue.length > 0 ? (
        <div
          style={{
            padding: '8px 10px',
            borderBottom: `1px solid ${tokens.color.border}`,
            background: tokens.color.surfaceElevated,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted }}>
            {pt
              ? `Fila de cadastros assistidos (${signupQueue.length})`
              : `Assisted signup queue (${signupQueue.length})`}
          </div>
          {signupQueue.slice(0, 4).map((qItem) => (
            <div
              key={qItem.providerId}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                fontSize: 11.5,
              }}
            >
              <span>
                <strong>{qItem.providerName}</strong>{' '}
                <Badge tone={persistedCompleted(qItem.providerId) ? 'success' : 'info'} mono>
                  {persistedCompleted(qItem.providerId)
                    ? pt
                      ? 'Rota salva'
                      : 'Route saved'
                    : pt
                      ? 'Pendente'
                      : 'Pending'}
                </Badge>
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    const entry = snapshot.catalog.find((c) => c.id === qItem.providerId);
                    openWizardFor(entry, qItem.currentStep);
                  }}
                >
                  {pt ? 'Retomar' : 'Resume'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 size={11} />}
                  onClick={() =>
                    onUpdateSignupQueue(
                      signupQueue.filter((x) => x.providerId !== qItem.providerId),
                    )
                  }
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Virtualized/windowed fast list (caps initial DOM render at 150 items with search narrowing) */}
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
        {filteredCatalog.length === 0 ? (
          <div
            style={{
              padding: 18,
              textAlign: 'center',
              fontSize: 12,
              color: tokens.color.textMuted,
            }}
          >
            {snapshot.catalog.length === 0
              ? pt
                ? 'Nenhum catálogo carregado no main ainda. Você pode iniciar um Cadastro Assistido manual ou importar um snapshot em Diagnóstico.'
                : 'No catalog entries loaded yet.'
              : pt
                ? 'Nenhum provedor corresponde aos filtros atuais.'
                : 'No providers match current filters.'}
          </div>
        ) : (
          filteredCatalog.slice(0, 150).map((item) => {
            const active = selectedItem?.entry.id === item.entry.id;
            return (
              <button
                key={item.entry.id}
                type="button"
                onClick={() => setSelectedProviderId(item.entry.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '7px 9px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
                  background: active ? tokens.color.accentSubtle : tokens.color.surfaceElevated,
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
                  <strong style={{ fontSize: 12.5 }}>{item.entry.name}</strong>
                  <Badge
                    tone={
                      item.opState === 'ready'
                        ? 'success'
                        : item.opState === 'unavailable'
                          ? 'danger'
                          : item.opState === 'configured'
                            ? 'info'
                            : 'outline'
                    }
                  >
                    {item.opState === 'ready'
                      ? pt
                        ? 'Operacional'
                        : 'Ready'
                      : item.opState === 'configured'
                        ? pt
                          ? 'Configurado'
                          : 'Configured'
                        : item.opState === 'unavailable'
                          ? pt
                            ? 'Indisponível'
                            : 'Unavailable'
                          : pt
                            ? 'Descoberto'
                            : 'Discovered'}
                  </Badge>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <Badge tone="outline" mono>
                    {item.entry.kind}
                  </Badge>
                  {item.hasVerifiedFreeModel ? (
                    <Badge tone="success">{pt ? 'Gratuito verificado' : 'Verified free'}</Badge>
                  ) : (
                    <Badge tone="neutral">{pt ? 'Oferta desconhecida' : 'Unknown offer'}</Badge>
                  )}
                  {item.provModels.length > 0 ? (
                    <Badge tone="info" mono>
                      {item.provModels.length} mod.
                    </Badge>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const rightDetailPane = (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {!selectedItem ? (
        <EmptyState
          title={pt ? 'Marketplace de Provedores de IA' : 'AI Provider Marketplace'}
          description={
            pt
              ? 'Selecione um provedor descoberto à esquerda ou inicie o Cadastro Assistido de 11 etapas para conectar OpenRouter, Groq, OpenAI, Anthropic, Gemini ou modelos locais.'
              : 'Select a provider on the left or start the 11-step Guided Connection Setup.'
          }
          actions={
            <Button
              variant="primary"
              icon={<Sparkles size={14} />}
              onClick={() => openWizardFor(undefined, 1)}
            >
              {pt ? 'Iniciar Cadastro Assistido' : 'Start Guided Setup'}
            </Button>
          }
        />
      ) : (
        <>
          <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h3 style={{ margin: 0, fontSize: 16 }}>{selectedItem.entry.name}</h3>
                  <Badge tone="outline" mono>
                    {selectedItem.entry.id}
                  </Badge>
                  <Badge tone="info">{selectedItem.entry.kind}</Badge>
                  {selectedItem.hasVerifiedFreeModel ? (
                    <Badge tone="success">
                      {pt ? 'Modelo gratuito verificado' : 'Verified free model'}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      {pt ? 'Oferta comercial: Desconhecida' : 'Offer: Unknown'}
                    </Badge>
                  )}
                </div>
                <div className="db-muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {pt
                    ? `Fonte do catálogo: ${selectedItem.entry.sourceId} · Verificado em: ${formatTimestamp(selectedItem.entry.verifiedAt, language)}`
                    : `Source: ${selectedItem.entry.sourceId} · Verified: ${formatTimestamp(selectedItem.entry.verifiedAt, language)}`}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Button
                  size="xs"
                  variant="secondary"
                  icon={<ListPlus size={12} />}
                  onClick={() => enqueueProvider(selectedItem.entry)}
                >
                  {pt ? 'Enfileirar cadastro' : 'Add to queue'}
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={<Sparkles size={12} />}
                  onClick={() => openWizardFor(selectedItem.entry, 1)}
                >
                  {pt ? 'Conectar (Cadastro Assistido)' : 'Connect (Guided Setup)'}
                </Button>
              </div>
            </div>

            {/* Official Links: Site / Signup / Docs / Terms */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
              {selectedItem.entry.documentationUrl ? (
                <a
                  href={selectedItem.entry.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: tokens.color.accent,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>{pt ? 'Documentação oficial' : 'Documentation'}</span>
                  <ExternalLink size={11} />
                </a>
              ) : (
                <span className="db-faint">
                  {pt ? 'Documentação: desconhecida' : 'Docs: unknown'}
                </span>
              )}
              {selectedItem.entry.signupUrl ? (
                <a
                  href={selectedItem.entry.signupUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: tokens.color.accent,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>{pt ? 'Página oficial de cadastro' : 'Official signup'}</span>
                  <ExternalLink size={11} />
                </a>
              ) : (
                <span className="db-faint">
                  {pt ? 'URL de cadastro: desconhecida' : 'Signup URL: unknown'}
                </span>
              )}
              {selectedItem.entry.termsUrl ? (
                <a
                  href={selectedItem.entry.termsUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: tokens.color.accent,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>{pt ? 'Termos e Política de Dados' : 'Terms & Data Policy'}</span>
                  <ExternalLink size={11} />
                </a>
              ) : (
                <span className="db-faint">
                  {pt ? 'Política de dados/treinamento: desconhecida' : 'Data policy: unknown'}
                </span>
              )}
            </div>

            {/* Privacy Eligibility for Active Project */}
            {!selectedItem.eligibility.eligible ? (
              <Banner
                tone="danger"
                title={
                  pt
                    ? `Rota bloqueada para a classificação atual (${PRIVACY_CLASSIFICATIONS[projectPrivacy].labelPt})`
                    : 'Blocked by project privacy classification'
                }
              >
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {selectedItem.eligibility.reasonsPt.map((r, idx) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              </Banner>
            ) : selectedItem.eligibility.reasonsPt.length > 0 ? (
              <Banner tone="warning">{selectedItem.eligibility.reasonsPt.join(' ')}</Banner>
            ) : null}

            {/* Detailed Attributes Grid (§5) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: 8,
                padding: 10,
                background: tokens.color.surfaceElevated,
                borderRadius: tokens.radius.md,
                fontSize: 12,
              }}
            >
              <div>
                <span className="db-muted">{pt ? 'Oferta conhecida: ' : 'Known offer: '}</span>
                <strong>
                  {selectedItem.hasVerifiedFreeModel
                    ? pt
                      ? 'Possui modelo(s) gratuito(s) verificado(s)'
                      : 'Has verified free model(s)'
                    : selectedItem.hasVerifiedPaidModel
                      ? pt
                        ? 'Tarifado por uso'
                        : 'Metered'
                      : pt
                        ? 'Desconhecida (sem evidência verificada)'
                        : 'Unknown'}
                </strong>
              </div>
              <div>
                <span className="db-muted">{pt ? 'Cartão obrigatório: ' : 'Card required: '}</span>
                <strong>{pt ? 'Desconhecido (verificar no provedor)' : 'Unknown'}</strong>
              </div>
              <div>
                <span className="db-muted">{pt ? 'Uso comercial: ' : 'Commercial use: '}</span>
                <strong>
                  {selectedItem.entry.termsUrl
                    ? pt
                      ? 'Consultar termos publicados'
                      : 'See published terms'
                    : pt
                      ? 'Desconhecido'
                      : 'Unknown'}
                </strong>
              </div>
              <div>
                <span className="db-muted">
                  {pt ? 'Restrições regionais: ' : 'Regional limits: '}
                </span>
                <strong>{pt ? 'Desconhecidas' : 'Unknown'}</strong>
              </div>
              <div>
                <span className="db-muted">
                  {pt ? 'Estado de confiabilidade: ' : 'Reliability state: '}
                </span>
                <strong>
                  {selectedItem.opState === 'ready'
                    ? pt
                      ? 'Conexão validada (ready)'
                      : 'Validated (ready)'
                    : selectedItem.entry.verifiedAt
                      ? pt
                        ? 'Documentado e verificado'
                        : 'Verified'
                      : pt
                        ? 'Candidato descoberto (não validado)'
                        : 'Discovered candidate (unverified)'}
                </strong>
              </div>
              <div>
                <span className="db-muted">{pt ? 'Protocolos configurados: ' : 'Protocols: '}</span>
                <span className="db-mono">
                  {selectedItem.provEndpoints.map((e) => e.protocol).join(', ') || '—'}
                </span>
              </div>
            </div>

            {/* Connection procedure */}
            <div style={{ fontSize: 12 }}>
              <strong>
                {pt ? 'Procedimento de conexão seguro:' : 'Safe connection procedure:'}
              </strong>
              <ol style={{ margin: '4px 0 0 0', paddingLeft: 18 }} className="db-muted">
                <li>
                  {pt
                    ? 'Acesse a página oficial do provedor no navegador externo e crie sua chave de API com escopo mínimo.'
                    : 'Open the official provider page and generate a scoped API key.'}
                </li>
                <li>
                  {pt
                    ? 'Armazene a chave no Cofre DPAPI do DevBrain (etapa 5 do Cadastro Assistido); o valor nunca retorna ao renderer.'
                    : 'Store the secret in the OS-encrypted DPAPI vault.'}
                </li>
                <li>
                  {pt
                    ? 'Registre o endpoint HTTPS e valide a autenticação sem gerar texto antes de habilitar rotas.'
                    : 'Register the HTTPS endpoint and validate authentication before enabling routes.'}
                </li>
              </ol>
            </div>
          </div>

          {/* Models of this provider */}
          <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h4 className="db-section-title">
              {pt
                ? `Modelos conhecidos deste provedor (${selectedItem.provModels.length})`
                : `Known models (${selectedItem.provModels.length})`}
            </h4>
            {selectedItem.provModels.length === 0 ? (
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Nenhum modelo verificado registrado ainda para este provedor. Conecte o provedor para descobrir e registrar modelos.'
                  : 'No verified models registered yet for this provider.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedItem.provModels.slice(0, 20).map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 10px',
                      background: tokens.color.surfaceElevated,
                      borderRadius: tokens.radius.sm,
                      fontSize: 12,
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong>{m.name}</strong>{' '}
                      <span className="db-mono db-faint">({m.upstreamModelId})</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Badge tone="outline" mono>
                        ctx: {m.capabilities.contextTokens?.toLocaleString(language) ?? '?'}
                      </Badge>
                      {m.capabilities.tools ? <Badge tone="info">tools</Badge> : null}
                      <Badge tone="neutral" mono>
                        in: {formatPricePerMillion(m.pricing?.inputPerMillion, m.pricing?.currency)}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div style={{ height: '100%', minHeight: 500, display: 'flex', flexDirection: 'column' }}>
      <SplitPane
        direction="horizontal"
        initialSize={370}
        minSize={300}
        maxSize={520}
        first={leftListPane}
        second={rightDetailPane}
      />

      {/* Guided registration; every advance is gated by a persisted outcome. */}
      <Dialog
        open={wizardOpen}
        width={680}
        onClose={() => {
          setWizardSecretValue('');
          setWizardOpen(false);
        }}
        title={pt ? 'Conectar provedor de IA' : 'Connect AI provider'}
        subtitle={
          pt
            ? 'Fluxo guiado sem automação indevida de contas; segredos cifrados via DPAPI e retomável a qualquer momento.'
            : 'Guided setup with OS-encrypted credentials; resumable anytime.'
        }
        footer={
          <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setWizardSecretValue('');
                persistQueueProgress(wizardStep, wizardStep === 11 ? 'completed' : 'in-progress');
                setWizardOpen(false);
              }}
            >
              {pt ? 'Salvar na fila e retomar depois' : 'Save to queue & resume later'}
            </Button>
            <div style={{ display: 'flex', gap: 8 }}>
              {wizardStep === 1 ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    persistQueueProgress(5, 'in-progress');
                    setWizardStep(5);
                  }}
                >
                  {pt ? 'Escolher credencial' : 'Choose credential'}
                </Button>
              ) : wizardStep === 9 ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<CheckCircle2 size={14} />}
                  loading={wizardBusy}
                  disabled={!activeProjectId}
                  onClick={() => void handleWizardComplete()}
                >
                  {pt ? 'Concluir cadastro' : 'Finish'}
                </Button>
              ) : wizardStep === 11 ? (
                <Button size="sm" variant="primary" onClick={() => setWizardOpen(false)}>
                  {pt ? 'Fechar' : 'Close'}
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="db-muted" style={{ fontSize: 12 }}>
            {pt
              ? 'Fluxo: provedor → credencial → conexão → autenticação e modelos → rota → política e teste.'
              : 'Flow: provider → credential → connection → authentication and models → route → policy and test.'}
          </div>

          {wizardError ? <Banner tone="danger">{wizardError}</Banner> : null}

          {wizardStep === 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>{pt ? '1. Escolher provedor' : '1. Choose provider'}</strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label={pt ? 'ID do provedor (a-z0-9._:-)' : 'Provider ID'} required>
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      value={wizardProviderId}
                      onChange={(e) => {
                        const v = e.target.value.toLowerCase();
                        setWizardProviderId(v);
                        const preset = DEFAULT_ENDPOINTS_BY_PROVIDER[v];
                        if (preset) {
                          setWizardBaseUrl(preset.baseUrl);
                          setWizardProtocol(preset.protocol);
                        }
                      }}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Nome de exibição' : 'Display name'} required>
                  {(props) => (
                    <Input
                      {...props}
                      value={wizardProviderName}
                      onChange={(e) => setWizardProviderName(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </div>
          ) : null}

          {wizardStep === 2 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong>
                {pt ? '2. Requisitos, privacidade e condições' : '2. Requirements & conditions'}
              </strong>
              <Banner tone="info" icon={<ShieldCheck size={15} />}>
                {pt
                  ? 'O DevBrain nunca automatiza criação de contas, preenchimento de CAPTCHAs ou verificação de identidade. Revise os termos de retenção de dados, uso comercial e cobrança diretamente no provedor.'
                  : 'DevBrain never automates account creation or identity checks.'}
              </Banner>
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? `Classificação atual do projeto ativo: ${PRIVACY_CLASSIFICATIONS[projectPrivacy].labelPt}.`
                  : `Active project classification: ${PRIVACY_CLASSIFICATIONS[projectPrivacy].labelEn}.`}
              </div>
            </div>
          ) : null}

          {wizardStep === 3 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt ? '3. Abrir página oficial de cadastro' : '3. Open official signup page'}
              </strong>
              <Field
                label={pt ? 'URL oficial de cadastro / chaves (HTTPS)' : 'Official signup URL'}
              >
                {(props) => (
                  <Input
                    {...props}
                    mono
                    value={wizardSignupUrl}
                    placeholder="https://openrouter.ai/keys"
                    onChange={(e) => setWizardSignupUrl(e.target.value)}
                  />
                )}
              </Field>
              {wizardSignupUrl.startsWith('https://') ? (
                <div>
                  <a
                    href={wizardSignupUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: tokens.color.accent,
                      fontWeight: 600,
                    }}
                  >
                    <span>
                      {pt ? 'Abrir página oficial no navegador padrão' : 'Open in browser'}
                    </span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}

          {wizardStep === 4 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong>
                {pt
                  ? '4. Obter credencial diretamente no provedor'
                  : '4. Obtain API key at provider'}
              </strong>
              <div className="db-muted" style={{ fontSize: 12.5 }}>
                {pt
                  ? 'Gere uma chave dedicada ao DevBrain com limite financeiro configurado no painel do provedor, quando suportado. Copie o token para inseri-lo na próxima etapa.'
                  : 'Create a dedicated key with spending limits in the provider dashboard.'}
              </div>
            </div>
          ) : null}

          {wizardStep === 5 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt
                  ? '2. Inserir ou reutilizar credencial cifrada'
                  : '2. Store or reuse credential'}
              </strong>
              <Field label={pt ? 'Modo de credencial' : 'Credential mode'}>
                {(props) => (
                  <Select
                    {...props}
                    value={wizardCredMode}
                    onChange={(e) =>
                      setWizardCredMode(
                        e.target.value as 'existing' | 'os-encrypted' | 'environment',
                      )
                    }
                  >
                    <option value="os-encrypted">
                      {pt ? 'Novo segredo cifrado pelo Windows DPAPI' : 'New OS-encrypted secret'}
                    </option>
                    <option value="environment">
                      {pt ? 'Variável de ambiente do sistema' : 'Environment variable'}
                    </option>
                    <option value="existing">
                      {pt
                        ? 'Reutilizar credencial existente / Sem credencial (local)'
                        : 'Existing / None'}
                    </option>
                  </Select>
                )}
              </Field>

              {wizardCredMode === 'existing' ? (
                <Field label={pt ? 'Credencial existente' : 'Existing credential'}>
                  {(props) => (
                    <Select
                      {...props}
                      value={wizardExistingCredId}
                      onChange={(e) => setWizardExistingCredId(e.target.value)}
                    >
                      <option value="">{pt ? 'Sem credencial (ex.: Ollama local)' : 'None'}</option>
                      {credentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} ({c.storage})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : wizardCredMode === 'os-encrypted' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10 }}>
                  <Field label={pt ? 'Rótulo' : 'Label'}>
                    {(props) => (
                      <Input
                        {...props}
                        value={wizardCredLabel}
                        onChange={(e) => setWizardCredLabel(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label={pt ? 'Chave secreta (nunca será exibida novamente)' : 'Secret key'}
                    required
                  >
                    {(props) => (
                      <Input
                        {...props}
                        type="password"
                        autoComplete="off"
                        value={wizardSecretValue}
                        onChange={(e) => setWizardSecretValue(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              ) : (
                <Field
                  label={pt ? 'Nome da variável de ambiente' : 'Environment variable'}
                  required
                >
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      value={wizardEnvVar}
                      placeholder="OPENROUTER_API_KEY"
                      onChange={(e) => setWizardEnvVar(e.target.value)}
                    />
                  )}
                </Field>
              )}

              <div>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<KeyRound size={13} />}
                  loading={wizardBusy}
                  disabled={
                    (wizardCredMode === 'os-encrypted' && !wizardSecretValue) ||
                    (wizardCredMode === 'environment' && !wizardEnvVar.trim())
                  }
                  onClick={() => void handleWizardStoreCredential()}
                >
                  {pt ? 'Armazenar credencial e avançar' : 'Store credential & continue'}
                </Button>
              </div>
            </div>
          ) : null}

          {wizardStep === 6 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt ? '3. Registrar endpoint e conexão' : '3. Register endpoint & connection'}
              </strong>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <Field label={pt ? 'Base URL (HTTPS ou loopback)' : 'Base URL'} required>
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      value={wizardBaseUrl}
                      onChange={(e) => setWizardBaseUrl(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Protocolo' : 'Protocol'}>
                  {(props) => (
                    <Select
                      {...props}
                      value={wizardProtocol}
                      onChange={(e) =>
                        setWizardProtocol(e.target.value as ProviderEndpoint['protocol'])
                      }
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
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={wizardBusy}
                  onClick={() => void handleWizardRegisterConnection()}
                >
                  {pt ? 'Registrar conexão no Gateway' : 'Register connection'}
                </Button>
              </div>
            </div>
          ) : null}

          {wizardStep === 7 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt
                  ? '4. Validar autenticação e descobrir modelos sem gerar texto'
                  : '4. Authenticate and discover models'}
              </strong>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={wizardBusy}
                  onClick={() => void handleWizardValidateAuth()}
                >
                  {pt ? 'Executar validação de autenticação' : 'Validate authentication'}
                </Button>
              </div>
              {wizardValidationSummary ? (
                <Banner tone="info">{wizardValidationSummary}</Banner>
              ) : null}
            </div>
          ) : null}

          {wizardStep === 8 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt ? '5. Escolher modelo descoberto' : '5. Choose a discovered model'}
              </strong>
              <Field label={pt ? 'Modelos retornados pela API' : 'Models returned by provider API'}>
                {(props) => (
                  <Select
                    {...props}
                    value={wizardModelUpstreamId}
                    onChange={(e) => setWizardModelUpstreamId(e.target.value)}
                  >
                    <option value="">{pt ? 'Selecione um modelo' : 'Select a model'}</option>
                    {wizardDiscoveredModels.map((model) => (
                      <option key={model.upstreamModelId} value={model.upstreamModelId}>
                        {model.name} ·{' '}
                        {model.pricing?.inputPerMillion === 0 &&
                        model.pricing.outputPerMillion === 0
                          ? pt
                            ? 'gratuito verificado'
                            : 'verified free'
                          : model.pricing
                            ? pt
                              ? 'pago'
                              : 'paid'
                            : pt
                              ? 'preço desconhecido'
                              : 'unknown price'}{' '}
                        · {model.tools === true ? 'tools ✓' : 'tools ?'}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Preços e ferramentas só são afirmados quando constam dos metadados oficiais. Dados ausentes permanecem desconhecidos.'
                  : 'Prices and tools are shown only when provider metadata confirms them.'}
              </div>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={wizardBusy}
                  disabled={!wizardModelUpstreamId}
                  onClick={() => void handleWizardSaveModel()}
                >
                  {pt ? 'Registrar modelo e avançar' : 'Save model & continue'}
                </Button>
              </div>
            </div>
          ) : null}

          {wizardStep === 9 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>
                {pt
                  ? '7. Privacidade, orçamento e teste opcional'
                  : '7. Privacy, budget and optional inference test'}
              </strong>
              <Field label={pt ? 'Privacidade do projeto' : 'Project privacy'}>
                {(props) => (
                  <Select
                    {...props}
                    value={wizardPrivacy}
                    onChange={(event) =>
                      setWizardPrivacy(event.target.value as ProjectPrivacyClass)
                    }
                  >
                    {Object.entries(PRIVACY_CLASSIFICATIONS).map(([value, meta]) => (
                      <option key={value} value={value}>
                        {pt ? meta.labelPt : meta.labelEn}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Checkbox
                checked={wizardAllowPaid}
                onChange={(event) => setWizardAllowPaid(event.target.checked)}
                label={
                  pt ? 'Autorizar modelos pagos neste projeto' : 'Allow paid models in this project'
                }
              />
              <Checkbox
                checked={wizardApproveProvider}
                onChange={(event) => setWizardApproveProvider(event.target.checked)}
                label={
                  pt
                    ? 'Aprovo este provedor para receber conteúdo deste projeto'
                    : 'Approve this provider for this project content'
                }
              />
              <Field
                label={pt ? 'Teto diário em USD (opcional)' : 'Daily ceiling in USD (optional)'}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={0}
                    step="0.01"
                    value={wizardDailyBudget}
                    onChange={(event) => setWizardDailyBudget(event.target.value)}
                  />
                )}
              </Field>
              {!activeProjectId ? (
                <Banner tone="danger">
                  {pt
                    ? 'Selecione um projeto para aplicar privacidade, orçamento e teste.'
                    : 'Select a project for privacy, budget and test.'}
                </Banner>
              ) : null}
              <Checkbox
                checked={wizardAuthorizeInferenceTest}
                onChange={(e) => setWizardAuthorizeInferenceTest(e.target.checked)}
                label={
                  pt
                    ? 'Autorizo o envio de uma chamada mínima de teste ("Responda apenas OK", máx. 16 tokens) que pode consumir cota ou saldo do provedor.'
                    : 'I authorize sending a minimal 16-token test inference.'
                }
              />
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Play size={12} />}
                  disabled={!wizardAuthorizeInferenceTest}
                  loading={wizardBusy}
                  onClick={() => void handleWizardAuthorizedTestInference()}
                >
                  {pt ? 'Executar teste autorizado' : 'Run authorized test'}
                </Button>
              </div>
              {wizardInferenceTestSummary ? (
                <Banner tone="success">{wizardInferenceTestSummary}</Banner>
              ) : null}
            </div>
          ) : null}

          {wizardStep === 10 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong>{pt ? '6. Criar rota para o modelo' : '6. Create model route'}</strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label={pt ? 'Prioridade da rota (menor = preferida)' : 'Route priority'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={0}
                      max={1000}
                      value={wizardRoutePriority}
                      onChange={(e) => setWizardRoutePriority(e.target.value)}
                    />
                  )}
                </Field>
                <div style={{ paddingTop: 22 }}>
                  <Checkbox
                    checked={wizardLocalOnly}
                    onChange={(e) => setWizardLocalOnly(e.target.checked)}
                    label={
                      pt ? 'Marcar rota como estritamente local (localOnly)' : 'Local-only route'
                    }
                  />
                </div>
              </div>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={wizardBusy}
                  onClick={() => void handleWizardConfigureRoute()}
                >
                  {pt ? 'Salvar rota e configurar política' : 'Save route & configure policy'}
                </Button>
              </div>
            </div>
          ) : null}

          {wizardStep === 11 ? (
            <Banner tone="success" title={pt ? 'Configuração persistida' : 'Setup persisted'}>
              {pt
                ? `Provedor "${wizardProviderName}" registrado no fluxo assistido. Você pode gerenciar chaves, cotas, modelos e rotas nas abas Minhas Conexões e Estratégias.`
                : `Provider "${wizardProviderName}" setup completed.`}
            </Banner>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
};
