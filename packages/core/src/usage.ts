import {
  DevBrainError,
  type CostModel,
  UsageSummaryInputSchema,
  parseOrThrow,
  type PermissionPolicy,
  type UsageSummary,
} from '@devbrain/contracts';
import type { CoreContext } from './context.js';

const startOf = (period: 'day' | 'month', now = new Date()): string => {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === 'day' ? now.getUTCDate() : 1),
  );
  return d.toISOString();
};

/**
 * Consumption accounting from execution results (tokens and cost as REPORTED by providers;
 * DevBrain never estimates cost). Budgets are enforced before executions start.
 */
export class UsageService {
  constructor(private readonly ctx: CoreContext) {}

  async summary(
    input: { period?: 'day' | 'month'; projectId?: string; agentId?: string } = {},
  ): Promise<UsageSummary> {
    const parsed = parseOrThrow(UsageSummaryInputSchema, input);
    const since = startOf(parsed.period);
    const totals = this.ctx.db.usage.totals({
      since,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    });
    return { period: parsed.period, since, ...totals };
  }

  /**
   * Throws BUDGET_EXCEEDED when a global or policy budget is already spent (by REPORTED costs).
   *
   * Unknown cost is never zero: when any financial limit applies to a cost-bearing execution
   * whose integration cannot report cost (anything but `free`/`local`), the limit cannot be
   * enforced and the execution is refused with BUDGET_UNENFORCEABLE — unless the user
   * explicitly opted into running without a cost guarantee
   * (`settings.budget.allowWithoutCostGuarantee`). Returns whether a guarantee exists.
   */
  assertWithinBudget(input: {
    agentId: string;
    policies: readonly PermissionPolicy[];
    costModel?: CostModel;
    costBearing?: boolean;
  }): { limited: boolean; costGuaranteed: boolean } {
    const { budget } = this.ctx.db.settings.getSync();
    const limits = [
      budget.maxPerDay,
      budget.maxPerMonth,
      ...input.policies.flatMap((p) =>
        p.budget ? [p.budget.maxPerDay, p.budget.maxPerExecution] : [],
      ),
    ];
    const limited = limits.some((limit) => limit !== null);
    const costKnown = input.costModel === 'free' || input.costModel === 'local';
    const costBearing = input.costBearing ?? true;
    if (limited && costBearing && !costKnown && !budget.allowWithoutCostGuarantee) {
      throw new DevBrainError(
        'BUDGET_UNENFORCEABLE',
        'A budget limit is configured but this agent cannot report cost, so the limit cannot be enforced',
        { details: { costModel: input.costModel ?? 'unknown' } },
      );
    }
    const check = (
      spent: number | undefined,
      limit: number | null,
      scope: string,
      currency: string,
    ) => {
      if (limit !== null && (spent ?? 0) >= limit) {
        throw new DevBrainError(
          'BUDGET_EXCEEDED',
          `${scope} budget exhausted (${currency} ${limit})`,
          {
            details: { scope, limit, spent: spent ?? 0, currency },
          },
        );
      }
    };
    const day = this.ctx.db.usage.totals({ since: startOf('day') });
    const month = this.ctx.db.usage.totals({ since: startOf('month') });
    check(day.cost[budget.currency], budget.maxPerDay, 'Daily', budget.currency);
    check(month.cost[budget.currency], budget.maxPerMonth, 'Monthly', budget.currency);
    for (const policy of input.policies) {
      if (!policy.budget) continue;
      const agentDay = this.ctx.db.usage.totals({ since: startOf('day'), agentId: input.agentId });
      check(
        agentDay.cost[policy.budget.currency],
        policy.budget.maxPerDay,
        `Agent daily (${policy.name})`,
        policy.budget.currency,
      );
    }
    return { limited, costGuaranteed: !limited || costKnown || !costBearing };
  }
}
