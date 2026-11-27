import { randomUUID } from 'node:crypto';
import {
  DevBrainError,
  QuotaDefinitionSchema,
  QuotaReservationSchema,
  UsageRecordSchema,
  type QuotaDefinition,
  type QuotaReservation,
  type UsageRecord,
} from '@devbrain/contracts';
import type { SqlDriver } from '@devbrain/database';

type WindowRow = { used: number; reserved: number };
type ReservationRow = {
  id: string;
  quota_id: string;
  request_id: string;
  window_start: string;
  amount: number;
  status: string;
  expires_at: string;
};

/** SQLite BEGIN IMMEDIATE makes admission atomic across concurrent callers/processes. */
export class QuotaLedger {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: () => number = Date.now,
  ) {}

  define(input: QuotaDefinition): void {
    const def = QuotaDefinitionSchema.parse(input);
    this.db.run(
      'INSERT INTO ai_quota_definitions (id, data) VALUES (:id, :data) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      { id: def.id, data: JSON.stringify(def) },
    );
  }

  definitions(scopeId?: string): QuotaDefinition[] {
    const rows = this.db.all<{ data: string }>('SELECT data FROM ai_quota_definitions');
    return rows
      .map((r) => QuotaDefinitionSchema.parse(JSON.parse(r.data)))
      .filter((d) => !scopeId || d.scopeId === scopeId);
  }

  private start(def: QuotaDefinition): string {
    const period = (def.periodSeconds ?? 86_400) * 1000;
    return new Date(Math.floor(this.clock() / period) * period).toISOString();
  }

  /** Admission for all shared quota scopes succeeds or fails as one transaction. */
  reserveAll(
    requestId: string,
    demands: readonly { quotaId: string; amount: number }[],
    ttlMs = 120_000,
  ): QuotaReservation[] {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid reservation TTL');
    if (demands.some((d) => !Number.isFinite(d.amount) || d.amount < 0))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid quota amount');
    if (new Set(demands.map((d) => d.quotaId)).size !== demands.length)
      throw new DevBrainError('VALIDATION_FAILED', 'Duplicate quota scope');
    return this.db.transaction(() => {
      const now = new Date(this.clock()).toISOString();
      const expiry = new Date(this.clock() + ttlMs).toISOString();
      const out: QuotaReservation[] = [];
      for (const demand of demands) {
        const row = this.db.get<{ data: string }>(
          'SELECT data FROM ai_quota_definitions WHERE id=:id',
          { id: demand.quotaId },
        );
        if (!row) throw new DevBrainError('NOT_FOUND', 'Quota definition missing');
        const def = QuotaDefinitionSchema.parse(JSON.parse(row.data));
        const start = this.start(def);
        this.db.run(
          'INSERT OR IGNORE INTO ai_quota_windows (quota_id, window_start) VALUES (:id, :start)',
          { id: def.id, start },
        );
        const window = this.db.get<WindowRow>(
          'SELECT used, reserved FROM ai_quota_windows WHERE quota_id=:id AND window_start=:start',
          { id: def.id, start },
        );
        if (!window) throw new DevBrainError('STORAGE_ERROR', 'Quota window missing');
        if (
          def.limit !== null &&
          Number(window.used) + Number(window.reserved) + demand.amount > def.limit
        )
          throw new DevBrainError('QUOTA_EXCEEDED', 'Quota exhausted', {
            details: { quotaId: def.id },
          });
        const reservation = QuotaReservationSchema.parse({
          id: `res_${randomUUID()}`,
          quotaId: def.id,
          requestId,
          amount: demand.amount,
          status: 'held',
          expiresAt: expiry,
        });
        this.db.run(
          'UPDATE ai_quota_windows SET reserved=reserved+:amount WHERE quota_id=:id AND window_start=:start',
          { amount: demand.amount, id: def.id, start },
        );
        this.db.run(
          'INSERT INTO ai_reservations (id, quota_id, request_id, window_start, amount, status, expires_at, created_at) VALUES (:id,:quota,:request,:start,:amount,:status,:expiry,:now)',
          {
            id: reservation.id,
            quota: def.id,
            request: requestId,
            start,
            amount: demand.amount,
            status: 'held',
            expiry,
            now,
          },
        );
        out.push(reservation);
      }
      return out;
    });
  }

  /** Missing measured usage remains uncertain and keeps the reserved amount committed. */
  reconcile(id: string, measured: number | null): QuotaReservation {
    if (measured !== null && (!Number.isFinite(measured) || measured < 0))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid measured usage');
    return this.db.transaction(() => {
      const row = this.db.get<ReservationRow>('SELECT * FROM ai_reservations WHERE id=:id', { id });
      if (!row) throw new DevBrainError('NOT_FOUND', 'Reservation missing');
      if (row.status !== 'held')
        throw new DevBrainError('CONFLICT', 'Reservation is already reconciled');
      const committed = measured ?? row.amount;
      this.db.run(
        'UPDATE ai_quota_windows SET reserved=reserved-:reserved, used=used+:used WHERE quota_id=:quota AND window_start=:start',
        { reserved: row.amount, used: committed, quota: row.quota_id, start: row.window_start },
      );
      this.db.run('UPDATE ai_reservations SET status=:status WHERE id=:id', {
        status: measured === null ? 'uncertain' : 'committed',
        id,
      });
      return QuotaReservationSchema.parse({
        id,
        quotaId: row.quota_id,
        requestId: row.request_id,
        amount: committed,
        status: measured === null ? 'uncertain' : 'committed',
        expiresAt: row.expires_at,
      });
    });
  }

  /** Explicit release is allowed only when no upstream call was dispatched. */
  releaseUndispatched(id: string): QuotaReservation {
    return this.db.transaction(() => {
      const row = this.db.get<ReservationRow>('SELECT * FROM ai_reservations WHERE id=:id', { id });
      if (!row) throw new DevBrainError('NOT_FOUND', 'Reservation missing');
      if (row.status !== 'held')
        throw new DevBrainError('CONFLICT', 'Reservation is already reconciled');
      this.db.run(
        'UPDATE ai_quota_windows SET reserved=reserved-:amount WHERE quota_id=:quota AND window_start=:start',
        { amount: row.amount, quota: row.quota_id, start: row.window_start },
      );
      this.db.run("UPDATE ai_reservations SET status='released' WHERE id=:id", { id });
      return QuotaReservationSchema.parse({
        id,
        quotaId: row.quota_id,
        requestId: row.request_id,
        amount: row.amount,
        status: 'released',
        expiresAt: row.expires_at,
      });
    });
  }

  /** Crash recovery: outstanding calls are uncertain, never assumed free. */
  recover(): number {
    const ids = this.db.all<{ id: string }>("SELECT id FROM ai_reservations WHERE status='held'");
    for (const row of ids) this.reconcile(row.id, null);
    return ids.length;
  }

  saveUsage(input: UsageRecord): void {
    const record = UsageRecordSchema.parse(input);
    this.db.run(
      'INSERT INTO ai_usage (id,request_id,route_id,data,recorded_at) VALUES (:id,:request,:route,:data,:at)',
      {
        id: record.id,
        request: record.requestId,
        route: record.routeId,
        data: JSON.stringify(record),
        at: record.recordedAt,
      },
    );
  }

  usage(requestId: string): UsageRecord[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM ai_usage WHERE request_id=:id ORDER BY recorded_at',
        { id: requestId },
      )
      .map((r) => UsageRecordSchema.parse(JSON.parse(r.data)));
  }

  reservations(quotaId: string): QuotaReservation[] {
    return this.db
      .all<ReservationRow>('SELECT * FROM ai_reservations WHERE quota_id=:id ORDER BY created_at', {
        id: quotaId,
      })
      .map((row) =>
        QuotaReservationSchema.parse({
          id: row.id,
          quotaId: row.quota_id,
          requestId: row.request_id,
          amount: row.amount,
          status: row.status,
          expiresAt: row.expires_at,
        }),
      );
  }
}
