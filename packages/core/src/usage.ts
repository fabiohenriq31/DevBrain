import {
  DevBrainError,
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

  /** Throws BUDGET_EXCEEDED when a global or policy budget is already spent. */
  assertWithinBudget(input: { agentId: string; policies: readonly PermissionPolicy[] }): void {
    const { budget } = this.ctx.db.settings.getSync();
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
  }
}
