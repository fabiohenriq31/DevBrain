import type {
  BillingPolicy,
  BudgetStatus,
  CostState,
  ExclusionCode,
  ModelDefinition,
  ProjectAiPolicy,
} from '@devbrain/contracts';
import { scopeKey, type LedgerPort } from './ledger-port.js';
import { costMicros, isVerifiedFree, toMicros, type TokenUse } from './money.js';

const DAY = 86_400;
/** Session budgets have no calendar reset: one window spanning ~10 years. */
const SESSION_PERIOD = 10 * 365 * DAY;

export interface BudgetContext {
  billing: BillingPolicy;
  project: ProjectAiPolicy | null;
  sessionId: string | null;
}

export interface BudgetScope {
  quotaId: string;
  scope: 'global' | 'project' | 'session';
  scopeId: string;
  limitMicros: number | null;
}

export interface WorstCase {
  micros: number | null;
  state: Extract<CostState, 'free' | 'estimated' | 'unknown'>;
  note: string;
}

export interface BudgetVerdict {
  ok: boolean;
  code?: ExclusionCode;
  message: string;
  costState: WorstCase['state'];
  worstCaseMicros: number | null;
  /** Currency demands (micros) to reserve atomically with the provider quotas. */
  demands: { quotaId: string; amount: number }[];
}

/**
 * BudgetPolicyService — DevBrain-enforced money ceilings (global/day, project/day, session,
 * per inference). Money lives in the gateway QuotaLedger as `currency` quotas (integer micros,
 * origin `devbrain`) so admission is reserved in the SAME transaction as provider quotas: two
 * concurrent requests cannot both pass a ceiling only one of them fits under.
 *
 * What this does NOT guarantee: provider-side billing. DevBrain can stop dispatching, it cannot
 * cap a provider invoice; costs with unverified prices are `unknown`, never assumed zero.
 */
export class BudgetPolicyService {
  constructor(private readonly ledger: LedgerPort) {}

  currency(ctx: BudgetContext): string {
    return ctx.project?.budget.currency ?? ctx.billing.currency;
  }

  /** Ensures the ledger has the budget quotas for this context and returns them. */
  scopes(ctx: BudgetContext): BudgetScope[] {
    const currency = this.currency(ctx).toLowerCase();
    const out: BudgetScope[] = [];
    const add = (
      scope: BudgetScope['scope'],
      scopeValue: string,
      limitMicros: number | null,
      periodSeconds: number,
    ) => {
      const scopeId = scope === 'global' ? 'global' : scopeKey(scope, scopeValue);
      const quotaId = `budget.${scope === 'global' ? 'global' : scopeId}.${currency}`;
      this.ledger.define({
        id: quotaId,
        scope,
        scopeId,
        unit: 'currency',
        limit: limitMicros,
        periodSeconds,
        sourceUrl: null,
        verifiedAt: null,
        origin: 'devbrain',
      });
      out.push({ quotaId, scope, scopeId, limitMicros });
    };
    add(
      'global',
      'global',
      ctx.billing.maxCostPerDay === null ? null : toMicros(ctx.billing.maxCostPerDay),
      DAY,
    );
    if (ctx.project)
      add('project', ctx.project.projectId, ctx.project.budget.maxPerDayMicros, DAY);
    if (ctx.sessionId)
      add(
        'session',
        ctx.sessionId,
        ctx.project?.budget.maxPerSessionMicros ?? null,
        SESSION_PERIOD,
      );
    return out;
  }

  perInferenceLimit(ctx: BudgetContext): number | null {
    const limits = [
      ctx.billing.maxCostPerRequest === null ? null : toMicros(ctx.billing.maxCostPerRequest),
      ctx.project?.budget.maxPerInferenceMicros ?? null,
    ].filter((v): v is number => v !== null);
    return limits.length ? Math.min(...limits) : null;
  }

  /**
   * Upper bound of what one call can cost: every input token at the (tier) input price, no
   * cache discount, and the full output allowance. No output bound → cannot be bounded.
   */
  worstCase(
    model: ModelDefinition,
    local: boolean,
    inputTokens: number,
    maxOutputTokens: number | null,
    currency: string,
  ): WorstCase {
    if (local) return { micros: 0, state: 'free', note: 'local runtime: no metered cost' };
    if (isVerifiedFree(model.pricing))
      return { micros: 0, state: 'free', note: 'verified zero pricing' };
    if (!model.pricing?.verifiedAt)
      return { micros: null, state: 'unknown', note: 'pricing missing or unverified' };
    if (model.pricing.currency.toUpperCase() !== currency.toUpperCase())
      return { micros: null, state: 'unknown', note: `pricing in ${model.pricing.currency}` };
    const output = maxOutputTokens ?? model.capabilities.outputTokens;
    if (output === null)
      return { micros: null, state: 'unknown', note: 'no output-token bound' };
    const micros = costMicros(model.pricing, { inputTokens, outputTokens: output });
    return micros === null
      ? { micros: null, state: 'unknown', note: 'pricing incomplete' }
      : { micros, state: 'estimated', note: 'worst case: full output, no cache discount' };
  }

  paidAuthorized(ctx: BudgetContext): boolean {
    return ctx.billing.allowPaid && (ctx.project ? ctx.project.budget.allowPaid : true);
  }

  evaluate(ctx: BudgetContext, scopes: BudgetScope[], worst: WorstCase): BudgetVerdict {
    const base = { costState: worst.state, worstCaseMicros: worst.micros };
    if (worst.state === 'free')
      return { ...base, ok: true, message: worst.note, demands: [] };
    if (!this.paidAuthorized(ctx))
      return {
        ...base,
        ok: false,
        code: 'paid-not-authorized',
        message: 'route may be paid and paid usage is not explicitly authorized',
        demands: [],
      };
    const perInference = this.perInferenceLimit(ctx);
    const ceilings = perInference !== null || scopes.some((s) => s.limitMicros !== null);
    if (worst.micros === null) {
      const consented =
        ctx.billing.allowUnknownCost && (ctx.project ? ctx.project.budget.allowUnboundedCost : true);
      if (!consented || ceilings)
        return {
          ...base,
          ok: false,
          code: 'cost-unbounded',
          message: ceilings
            ? `${worst.note}: a ceiling applies and cannot be guaranteed (strict policy)`
            : `${worst.note}: unknown cost not authorized`,
          demands: [],
        };
      return { ...base, ok: true, message: `${worst.note}: unbounded cost consented`, demands: [] };
    }
    if (perInference !== null && worst.micros > perInference)
      return {
        ...base,
        ok: false,
        code: 'budget',
        message: `worst case ${worst.micros}µ exceeds per-inference ceiling ${perInference}µ`,
        demands: [],
      };
    for (const scope of scopes) {
      const state = this.ledger.windowState(scope.quotaId);
      if (state?.remaining !== null && state?.remaining !== undefined && worst.micros > state.remaining)
        return {
          ...base,
          ok: false,
          code: 'budget',
          message: `${scope.scope} budget: ${state.remaining}µ left, worst case ${worst.micros}µ`,
          demands: [],
        };
    }
    return {
      ...base,
      ok: true,
      message: worst.note,
      demands: scopes.map((s) => ({ quotaId: s.quotaId, amount: worst.micros! })),
    };
  }

  /** Measured cost for reconciliation; null when tokens or verified pricing are missing. */
  measured(model: ModelDefinition, local: boolean, use: Partial<TokenUse>): number | null {
    if (local || isVerifiedFree(model.pricing)) return 0;
    if (use.inputTokens == null || use.outputTokens == null) return null;
    return costMicros(model.pricing, {
      inputTokens: use.inputTokens,
      outputTokens: use.outputTokens,
      ...(use.cachedInputTokens !== undefined ? { cachedInputTokens: use.cachedInputTokens } : {}),
    });
  }

  status(
    ctx: BudgetContext,
    unknownCostRequests: (scope: BudgetScope) => number,
  ): BudgetStatus[] {
    const currency = this.currency(ctx).toUpperCase();
    return this.scopes(ctx).map((scope) => {
      const w = this.ledger.windowState(scope.quotaId);
      return {
        scope: scope.scope,
        scopeId: scope.scopeId,
        currency,
        limitMicros: scope.limitMicros,
        committedMicros: Math.round(w?.used ?? 0),
        reservedMicros: Math.round(w?.reserved ?? 0),
        unknownCostRequests: unknownCostRequests(scope),
        enforcedBy: 'devbrain' as const,
      };
    });
  }
}

