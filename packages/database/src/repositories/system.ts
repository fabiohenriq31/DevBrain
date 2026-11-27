import { createHash } from 'node:crypto';
import {
  ApplicationSettingsSchema,
  AuditEventSchema,
  DEFAULT_SETTINGS,
  newId,
  nowTimestamp,
  type ApplicationSettings,
  type AuditEvent,
  type AuditEventInput,
  type AuditLog,
  type SettingsPatch,
  type SettingsStore,
  type UsageRecordInput,
} from '@devbrain/contracts';
import { redactRecord, redactString } from '@devbrain/security';
import type { SqlDriver, SqlParams } from '../driver.js';
import { fromJson, json, validated } from './common.js';

/** Append-only audit log. Details and targets are redacted before persistence. */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: SqlDriver) {}

  appendSync(input: AuditEventInput): AuditEvent {
    const event = validated(
      AuditEventSchema,
      {
        ...input,
        id: newId('audit'),
        timestamp: nowTimestamp(),
        target: input.target === null ? null : redactString(input.target),
        details: redactRecord(input.details),
      },
      'audit event',
    );
    this.db.run(
      `INSERT INTO audit_events (id, timestamp, action, project_id, outcome, data)
       VALUES (:id, :timestamp, :action, :projectId, :outcome, :data)`,
      {
        id: event.id,
        timestamp: event.timestamp,
        action: event.action,
        projectId: event.projectId,
        outcome: event.outcome,
        data: json(event),
      },
    );
    return event;
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    return this.appendSync(input);
  }

  async list(filter: { projectId?: string; limit: number }): Promise<AuditEvent[]> {
    const rows = filter.projectId
      ? this.db.all<{ data: string }>(
          'SELECT data FROM audit_events WHERE project_id = :projectId ORDER BY seq DESC LIMIT :limit',
          { projectId: filter.projectId, limit: filter.limit },
        )
      : this.db.all<{ data: string }>(
          'SELECT data FROM audit_events ORDER BY seq DESC LIMIT :limit',
          {
            limit: filter.limit,
          },
        );
    return rows.map((r) => fromJson(AuditEventSchema, r.data, 'audit event'));
  }

  /**
   * Retention: deletes audit rows older than `before` and appends an `audit.pruned` row with
   * the count and a SHA-256 over the pruned rows (tamper evidence). The DELETE trigger only
   * lets this guarded path through.
   */
  pruneBefore(before: string): number {
    return this.db.transaction(() => {
      const rows = this.db.all<{ seq: number; data: string }>(
        'SELECT seq, data FROM audit_events WHERE timestamp < :before ORDER BY seq',
        { before },
      );
      if (rows.length === 0) return 0;
      const hash = createHash('sha256');
      for (const r of rows) hash.update(r.data);
      this.db.run('UPDATE audit_guard SET allow_prune = 1 WHERE id = 1');
      try {
        this.db.run('DELETE FROM audit_events WHERE timestamp < :before', { before });
      } finally {
        this.db.run('UPDATE audit_guard SET allow_prune = 0 WHERE id = 1');
      }
      this.appendSync({
        actor: { type: 'system', component: 'retention' },
        action: 'audit.pruned',
        permission: null,
        projectId: null,
        target: null,
        outcome: 'success',
        details: {
          count: rows.length,
          before,
          firstSeq: rows[0]?.seq ?? null,
          lastSeq: rows.at(-1)?.seq ?? null,
          sha256: hash.digest('hex'),
        },
        correlationId: null,
      });
      return rows.length;
    });
  }
}

// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'application';

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: SqlDriver) {}

  /** Corrupt or outdated settings fall back to defaults (with new fields defaulted). */
  getSync(): ApplicationSettings {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = :key', {
      key: SETTINGS_KEY,
    });
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = ApplicationSettingsSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async get(): Promise<ApplicationSettings> {
    return this.getSync();
  }

  async update(patch: SettingsPatch): Promise<ApplicationSettings> {
    const current = this.getSync();
    const next = validated(
      ApplicationSettingsSchema,
      {
        ...current,
        ...(patch.language ? { language: patch.language } : {}),
        ...(patch.theme ? { theme: patch.theme } : {}),
        execution: { ...current.execution, ...patch.execution },
        security: { ...current.security, ...patch.security },
        retention: { ...current.retention, ...patch.retention },
        budget: { ...current.budget, ...patch.budget },
      },
      'settings',
    );
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key: SETTINGS_KEY, value: json(next), at: nowTimestamp() },
    );
    return next;
  }
}

// ---------------------------------------------------------------------------

export interface UsageTotals {
  executions: number;
  inputTokens: number;
  outputTokens: number;
  cost: Record<string, number>;
  /** Executions whose cost the provider did not report (`cost` is then a lower bound). */
  unknownCostExecutions: number;
}

export class UsageRepository {
  constructor(private readonly db: SqlDriver) {}

  record(input: UsageRecordInput, at = nowTimestamp()): void {
    this.db.run(
      `INSERT INTO usage_records (execution_id, agent_id, provider_id, project_id, input_tokens,
         output_tokens, cost_amount, cost_currency, recorded_at)
       VALUES (:executionId, :agentId, :providerId, :projectId, :inTok, :outTok, :cost, :currency, :at)`,
      {
        executionId: input.executionId,
        agentId: input.agentId,
        providerId: input.providerId,
        projectId: input.projectId,
        inTok: input.usage.inputTokens,
        outTok: input.usage.outputTokens,
        cost: input.usage.costAmount,
        currency: input.usage.costCurrency,
        at,
      },
    );
  }

  totals(filter: { since: string; projectId?: string; agentId?: string }): UsageTotals {
    const where = ['recorded_at >= :since'];
    const params: SqlParams = { since: filter.since };
    if (filter.projectId) {
      where.push('project_id = :projectId');
      params['projectId'] = filter.projectId;
    }
    if (filter.agentId) {
      where.push('agent_id = :agentId');
      params['agentId'] = filter.agentId;
    }
    const clause = where.join(' AND ');
    const base = this.db.get<{ n: number; i: number | null; o: number | null; u: number | null }>(
      `SELECT COUNT(DISTINCT execution_id) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
         COUNT(DISTINCT CASE WHEN cost_amount IS NULL OR cost_currency IS NULL
           THEN execution_id END) AS u
       FROM usage_records WHERE ${clause}`,
      params,
    );
    const costs = this.db.all<{ currency: string; total: number }>(
      `SELECT cost_currency AS currency, SUM(cost_amount) AS total FROM usage_records
       WHERE ${clause} AND cost_amount IS NOT NULL AND cost_currency IS NOT NULL GROUP BY cost_currency`,
      params,
    );
    return {
      executions: Number(base?.n ?? 0),
      inputTokens: Number(base?.i ?? 0),
      outputTokens: Number(base?.o ?? 0),
      cost: Object.fromEntries(costs.map((c) => [String(c.currency), Number(c.total)])),
      unknownCostExecutions: Number(base?.u ?? 0),
    };
  }
}

// ---------------------------------------------------------------------------

/** One row per app start; `clean_shutdown` = 0 on a previous row means a crash/kill. */
export class AppRunRepository {
  constructor(private readonly db: SqlDriver) {}

  start(id: string, appVersion: string | null): { previousUnclean: boolean } {
    return this.db.transaction(() => {
      const unclean = this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM app_runs WHERE clean_shutdown = 0 AND ended_at IS NULL',
      );
      this.db.run(
        'UPDATE app_runs SET ended_at = COALESCE(ended_at, :now) WHERE clean_shutdown = 0 AND ended_at IS NULL',
        { now: nowTimestamp() },
      );
      this.db.run(
        'INSERT INTO app_runs (id, started_at, clean_shutdown, app_version) VALUES (:id, :at, 0, :v)',
        { id, at: nowTimestamp(), v: appVersion },
      );
      // Keep the table small.
      this.db.run(
        'DELETE FROM app_runs WHERE id NOT IN (SELECT id FROM app_runs ORDER BY started_at DESC LIMIT 100)',
      );
      return { previousUnclean: Number(unclean?.n ?? 0) > 0 };
    });
  }

  finish(id: string): void {
    this.db.run('UPDATE app_runs SET ended_at = :at, clean_shutdown = 1 WHERE id = :id', {
      id,
      at: nowTimestamp(),
    });
  }
}

export class MaintenanceStateRepository {
  constructor(private readonly db: SqlDriver) {}

  get(key: string): string | null {
    const row = this.db.get<{ value: string }>(
      'SELECT value FROM maintenance_state WHERE key = :key',
      {
        key,
      },
    );
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO maintenance_state (key, value) VALUES (:key, :value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      { key, value },
    );
  }

  pruneExecutionEvents(before: string): number {
    return this.db.run(
      `DELETE FROM execution_events WHERE timestamp < :before AND execution_id IN (
         SELECT id FROM executions WHERE status IN ('completed', 'failed', 'cancelled', 'timed-out'))`,
      { before },
    ).changes;
  }
}
