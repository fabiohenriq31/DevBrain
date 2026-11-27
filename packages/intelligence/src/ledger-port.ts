import { createHash } from 'node:crypto';
import type { QuotaDefinition } from '@devbrain/contracts';

export interface WindowState {
  definition: QuotaDefinition;
  windowStart: string;
  resetAt: string;
  used: number;
  reserved: number;
  remaining: number | null;
}

/**
 * The subset of the gateway's QuotaLedger the policies need. There is ONE quota store (the
 * ledger, migration 003); policies read it and contribute demands to its atomic reserveAll.
 */
export interface LedgerPort {
  define(def: QuotaDefinition): void;
  definitions(scopeId?: string): QuotaDefinition[];
  windowState(quotaId: string): WindowState | null;
}

/** Stable resource id (contract Id charset) for an arbitrary scope value. */
export const scopeKey = (prefix: string, value: string): string =>
  `${prefix}.${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
