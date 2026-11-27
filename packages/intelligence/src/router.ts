import type {
  BillingPolicy,
  ExclusionCode,
  ExplainedRoutingDecision,
  InferenceRequest,
  ModelEvidence,
  PrivacyPolicy,
  ProjectAiPolicy,
  ProviderPrivacyProfile,
  QualityTier,
  RoutingPolicy,
  TaskProfile,
} from '@devbrain/contracts';
import { BudgetPolicyService, type BudgetScope } from './budget.js';
import type { LedgerPort } from './ledger-port.js';
import { isLocalRoute, PrivacyPolicyService } from './privacy.js';
import { QuotaPolicyEngine, type QuotaCandidate } from './quota-policy.js';
import { buildEvidence, ModelScoringService, weightsFor } from './scoring.js';
import { assessTier, classifyTask, DEFAULT_MIN_TIER, specialtyFit, TIER_RANK } from './tiers.js';
import { estimateMessages, type Tokenizer } from './tokens.js';

export type Candidate = QuotaCandidate;

export interface RoutingContext {
  request: InferenceRequest;
  policy: RoutingPolicy;
  billing: BillingPolicy;
  privacy: PrivacyPolicy;
  project: ProjectAiPolicy | null;
  profiles: ReadonlyMap<string, ProviderPrivacyProfile>;
  /** routeId → cooldown end (ISO). */
  cooldowns: ReadonlyMap<string, string>;
  evidence?: (modelId: string) => ModelEvidence;
  /** Model of the session's last successful inference (continuity / cache reuse). */
  lastModelId?: string | null;
  tokenizer?: Tokenizer;
  now?: () => number;
}

export interface PlannedCandidate extends Candidate {
  local: boolean;
  worstCaseMicros: number | null;
  costState: ExplainedRoutingDecision['ranked'][number]['costState'];
  /** Provider quota + DevBrain budget demands, reserved atomically by the gateway. */
  demands: { quotaId: string; amount: number }[];
  budgetQuotaIds: string[];
}

export interface RoutingPlan {
  decision: ExplainedRoutingDecision;
  ordered: PlannedCandidate[];
  task: TaskProfile;
  inputTokens: number;
}

type Reason = { code: ExclusionCode; message: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** One tier up, for regeneration after a quality failure (never down). */
export const escalate = (tier: QualityTier): QualityTier =>
  tier === 'basic' ? 'standard' : tier === 'standard' ? 'advanced' : 'frontier';

/**
 * RoutingPolicyEngine — two stages, no model call involved:
 *  1. Hard constraints (authorization, availability, security, protocol, capability, context,
 *     privacy, preset, minimum quality, budget, quota). Any failure excludes the route and the
 *     reasons are recorded.
 *  2. Scoring orders the survivors. A score cannot override stage 1.
 * Works with zero external models: local routes pass privacy/budget trivially, and an empty
 * result is an explained decision, not an exception inside the engine.
 */
export class RoutingPolicyEngine {
  readonly privacyService = new PrivacyPolicyService();
  readonly budget: BudgetPolicyService;
  readonly quota: QuotaPolicyEngine;
  private readonly scoring = new ModelScoringService();

  constructor(ledger: LedgerPort, clock: () => number = Date.now) {
    this.budget = new BudgetPolicyService(ledger);
    this.quota = new QuotaPolicyEngine(ledger, clock);
  }

  plan(candidates: readonly Candidate[], ctx: RoutingContext): RoutingPlan {
    const now = ctx.now ?? Date.now;
    const task = classifyTask(ctx.request);
    const declared = !!ctx.request.task;
    // A keyword guess never excludes routes; only a declared task profile sets a hard floor.
    const minTier: QualityTier =
      task.minQualityTier ?? (declared ? DEFAULT_MIN_TIER[task.kind] : 'basic');
    const estimate = estimateMessages(ctx.request.messages, ctx.tokenizer);
    const budgetCtx = {
      billing: ctx.billing,
      project: ctx.project,
      sessionId: ctx.request.sessionId,
    };
    const scopes = this.budget.scopes(budgetCtx);
    const weights = weightsFor(ctx.policy);
    const preset = ctx.policy.preset;
    const excluded: ExplainedRoutingDecision['excluded'] = [];
    const ranked: (ExplainedRoutingDecision['ranked'][number] & { planned: PlannedCandidate })[] =
      [];

    for (const c of candidates) {
      const reasons: Reason[] = [];
      const local = isLocalRoute(c.route, c.endpoint);
      const why = (code: ExclusionCode, message: string) => reasons.push({ code, message });

      if (ctx.request.modelId && c.model.id !== ctx.request.modelId)
        why('model-pinned', `request pins model ${ctx.request.modelId}`);
      if (c.connection.status === 'invalid-credential')
        why('not-authorized', 'credential rejected by the provider');
      if (!c.route.enabled || !c.connection.enabled || c.connection.status !== 'ready')
        why('unavailable', `route/connection not ready (${c.connection.status})`);
      const cooldown = ctx.cooldowns.get(c.route.id);
      if (cooldown && Date.parse(cooldown) > now()) why('cooldown', `cooling down until ${cooldown}`);
      const url = new URL(c.endpoint.baseUrl);
      if (url.username || url.password || (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)))
        why('security', 'endpoint must be HTTPS (or loopback) without embedded credentials');
      if (!c.model.capabilities.input.includes('text') || !c.model.capabilities.output.includes('text'))
        why('protocol', 'model does not accept and produce text');
      if (ctx.request.stream && !c.model.capabilities.streaming)
        why('protocol', 'streaming requested but not supported');
      if ((ctx.policy.requireTools || task.requiresTools) && !c.model.capabilities.tools)
        why('missing-capability', 'tool calling required');
      if (task.requiresStructuredOutput && !c.model.capabilities.structuredOutput)
        why('missing-capability', 'structured output required');
      if (task.requiresReasoning && !c.model.capabilities.reasoning)
        why('missing-capability', 'reasoning model required');
      const outputBound = ctx.request.maxOutputTokens ?? c.model.capabilities.outputTokens ?? 0;
      const window = c.model.capabilities.contextTokens;
      if (window !== null && estimate.tokens + outputBound > window)
        why('context-too-small', `needs ~${estimate.tokens + outputBound} tokens, window ${window}`);

      const privacy = this.privacyService.evaluate({
        route: c.route,
        endpoint: c.endpoint,
        gatewayPolicy: ctx.privacy,
        project: ctx.project,
        profile: ctx.profiles.get(c.endpoint.providerId) ?? null,
      });
      if (!privacy.allowed) why('privacy', privacy.reason);
      if (preset === 'local-only' && !local) why('privacy', 'preset local-only: no external egress');

      const evidence = ctx.evidence?.(c.model.id) ?? buildEvidence(c.model.id, null, null);
      const tier = assessTier(c.model, evidence);
      if (TIER_RANK[tier.tier] < TIER_RANK[minTier])
        why('quality-below-minimum', `${tier.tier} < required ${minTier} (${tier.note})`);

      const worst = this.budget.worstCase(
        c.model,
        local,
        estimate.tokens,
        ctx.request.maxOutputTokens,
        this.budget.currency(budgetCtx),
      );
      if (preset === 'free-only' && worst.state !== 'free')
        why('paid-not-authorized', `preset free-only: ${worst.note}`);
      const money = this.budget.evaluate(budgetCtx, scopes, worst);
      if (!money.ok) why(money.code ?? 'budget', money.message);
      const quota = this.quota.evaluate(c, ctx.request, estimate.tokens, task.priority);
      if (!quota.ok) why(quota.code ?? 'quota-exhausted', quota.message);

      if (reasons.length) {
        excluded.push({ routeId: c.route.id, reasons });
        continue;
      }
      const components = this.scoring.components({
        specialty: specialtyFit(task, c.model),
        tierRank: TIER_RANK[tier.tier],
        evidence,
        worstCaseMicros: worst.micros,
        remainingFraction: quota.remainingFraction,
        continuity: !!ctx.lastModelId && ctx.lastModelId === c.model.id,
        explore: !!ctx.policy.allowExploration && worst.state === 'free',
      });
      const notes = [privacy.reason, worst.note, tier.note];
      if (evidence.confidence === 'insufficient') notes.push('under-tested: score is a prior');
      ranked.push({
        routeId: c.route.id,
        modelId: c.model.id,
        providerId: c.endpoint.providerId,
        score: this.scoring.score(components, weights),
        components,
        qualityTier: tier.tier,
        evidence: tier.evidence,
        worstCaseCostMicros: worst.micros,
        costState: worst.state,
        notes,
        planned: {
          ...c,
          local,
          worstCaseMicros: worst.micros,
          costState: worst.state,
          demands: [...quota.demands, ...money.demands],
          budgetQuotaIds: money.demands.map((d) => d.quotaId),
        },
      });
    }

    const legacyCost = (r: (typeof ranked)[number]) =>
      (r.planned.model.pricing?.inputPerMillion ?? Infinity) +
      (r.planned.model.pricing?.outputPerMillion ?? Infinity);
    ranked.sort((a, b) => {
      if (!preset) {
        // No preset: the operator's legacy strategy and route priority stay authoritative.
        if (ctx.policy.strategy === 'local-first' && a.planned.local !== b.planned.local)
          return a.planned.local ? -1 : 1;
        if (ctx.policy.strategy === 'lowest-known-cost' && legacyCost(a) !== legacyCost(b))
          return legacyCost(a) - legacyCost(b);
        if (a.planned.route.priority !== b.planned.route.priority)
          return a.planned.route.priority - b.planned.route.priority;
      }
      return (
        b.score - a.score ||
        a.planned.route.priority - b.planned.route.priority ||
        a.routeId.localeCompare(b.routeId)
      );
    });
    const firstFree = ranked[0]?.costState === 'free';
    for (const r of ranked.slice(1))
      if (firstFree && r.costState !== 'free')
        r.notes.push('paid fallback after a free primary: allowed only by explicit paid authorization');

    const decision: ExplainedRoutingDecision = {
      requestId: ctx.request.id,
      policyId: ctx.policy.id,
      preset: preset ?? 'custom',
      taskKind: task.kind,
      minQualityTier: minTier,
      estimate: { inputTokens: estimate.tokens, tokenizer: estimate.tokenizer },
      ranked: ranked.map(({ planned: _planned, ...rest }) => rest),
      excluded,
      decidedAt: new Date(now()).toISOString(),
    };
    return { decision, ordered: ranked.map((r) => r.planned), task, inputTokens: estimate.tokens };
  }

  /** Budget scopes for status/reconciliation of a context. */
  scopes(ctx: Pick<RoutingContext, 'billing' | 'project' | 'request'>): BudgetScope[] {
    return this.budget.scopes({
      billing: ctx.billing,
      project: ctx.project,
      sessionId: ctx.request.sessionId,
    });
  }
}
