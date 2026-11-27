import { DevBrainError, type PricingDefinition } from '@devbrain/contracts';

/**
 * Money is integer micro-units (1 currency unit = 1_000_000 micros). Prices arrive as decimal
 * "per million tokens", so one micro per million tokens is the exact unit of a price:
 * cost(micros) = ceil(tokens × priceMicrosPerMillion / 1_000_000). Products use BigInt, so no
 * floating-point error enters accounting; rounding always goes UP (never under-reserve).
 */
export const MICROS = 1_000_000;

const assertMicros = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DevBrainError('VALIDATION_FAILED', 'Monetary amount out of range');
  return Number(value);
};

/** Decimal price/amount → micros, exact for up to 6 decimals, rounding up beyond that. */
export const toMicros = (amount: number): number => {
  if (!Number.isFinite(amount) || amount < 0)
    throw new DevBrainError('VALIDATION_FAILED', 'Invalid monetary amount');
  const [whole, fraction = ''] = amount.toFixed(9).split('.');
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  const remainder = fraction.slice(6).replace(/0+$/, '');
  return assertMicros(remainder ? micros + 1n : micros);
};

export const fromMicros = (micros: number): number => micros / MICROS;

export const addMicros = (...values: number[]): number =>
  assertMicros(values.reduce((sum, v) => sum + BigInt(v), 0n));

/** ceil(tokens × pricePerMillion) in micros. */
export const tokenCostMicros = (tokens: number, pricePerMillion: number): number => {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new DevBrainError('VALIDATION_FAILED', 'Invalid token count');
  const priceMicros = BigInt(toMicros(pricePerMillion));
  const product = BigInt(tokens) * priceMicros;
  return assertMicros((product + 999_999n) / 1_000_000n);
};

export interface TokenUse {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

/** Applicable flat or long-context tier for a prompt size. */
export const priceFor = (
  pricing: PricingDefinition,
  inputTokens: number,
): { input: number; output: number; cachedInput: number | null } | null => {
  if (pricing.inputPerMillion === null || pricing.outputPerMillion === null) return null;
  const tier = [...(pricing.contextTiers ?? [])]
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find((t) => inputTokens > t.aboveInputTokens);
  return tier
    ? {
        input: tier.inputPerMillion,
        output: tier.outputPerMillion,
        cachedInput: tier.cachedInputPerMillion,
      }
    : {
        input: pricing.inputPerMillion,
        output: pricing.outputPerMillion,
        cachedInput: pricing.cachedInputPerMillion,
      };
};

/**
 * Cost of a token use under verified pricing; null when pricing is missing or unverified
 * ("missing price is not free"). Cached tokens use the cached price only when published,
 * otherwise the full input price (conservative).
 */
export const costMicros = (pricing: PricingDefinition | null, use: TokenUse): number | null => {
  if (!pricing || !pricing.verifiedAt) return null;
  const price = priceFor(pricing, use.inputTokens);
  if (!price) return null;
  const cached = Math.min(use.cachedInputTokens ?? 0, use.inputTokens);
  return addMicros(
    tokenCostMicros(use.inputTokens - cached, price.input),
    tokenCostMicros(cached, price.cachedInput ?? price.input),
    tokenCostMicros(use.outputTokens, price.output),
  );
};

/** Known-free means verified zero prices — absent or unverified pricing is never free. */
export const isVerifiedFree = (pricing: PricingDefinition | null): boolean =>
  !!pricing?.verifiedAt &&
  pricing.inputPerMillion === 0 &&
  pricing.outputPerMillion === 0 &&
  (pricing.contextTiers ?? []).every((t) => t.inputPerMillion === 0 && t.outputPerMillion === 0);
