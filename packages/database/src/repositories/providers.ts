import {
  AgentSchema,
  PermissionPolicySchema,
  ProviderConfigSchema,
  ProviderHealthSchema,
  ProviderSchema,
  type Agent,
  type PermissionPolicy,
  type Provider,
  type ProviderConfig,
  type ProviderHealth,
} from '@devbrain/contracts';
import type { SqlDriver } from '../driver.js';
import { fromJson, json, notFound, validated } from './common.js';

export interface StoredProvider {
  provider: Provider;
  config: ProviderConfig;
  health: ProviderHealth;
}

interface ProviderRow {
  [k: string]: string | number | null;
  data: string;
  config: string;
  health: string;
}

const toStored = (row: ProviderRow): StoredProvider => ({
  provider: fromJson(ProviderSchema, row.data, 'provider'),
  config: fromJson(ProviderConfigSchema, row.config, 'provider config'),
  health: fromJson(ProviderHealthSchema, row.health, 'provider health'),
});

export class ProviderRepository {
  constructor(private readonly db: SqlDriver) {}

  upsert(stored: StoredProvider): StoredProvider {
    const provider = validated(ProviderSchema, stored.provider, 'provider');
    const config = validated(ProviderConfigSchema, stored.config, 'provider config');
    const health = validated(ProviderHealthSchema, stored.health, 'provider health');
    this.db.run(
      `INSERT INTO providers (id, adapter_key, data, config, health, enabled, updated_at)
       VALUES (:id, :adapterKey, :data, :config, :health, :enabled, :at)
       ON CONFLICT(id) DO UPDATE SET adapter_key = excluded.adapter_key, data = excluded.data,
         config = excluded.config, health = excluded.health, enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      {
        id: provider.id,
        adapterKey: provider.adapterKey,
        data: json(provider),
        config: json(config),
        health: json(health),
        enabled: provider.enabled ? 1 : 0,
        at: new Date().toISOString(),
      },
    );
    return { provider, config, health };
  }

  findById(id: string): StoredProvider | null {
    const row = this.db.get<ProviderRow>(
      'SELECT data, config, health FROM providers WHERE id = :id',
      { id },
    );
    return row ? toStored(row) : null;
  }

  list(): StoredProvider[] {
    return this.db
      .all<ProviderRow>('SELECT data, config, health FROM providers ORDER BY adapter_key, id')
      .map(toStored);
  }

  /** Fails with CONFLICT while agents still reference the provider (FK). */
  delete(id: string): void {
    const { changes } = this.db.run('DELETE FROM providers WHERE id = :id', { id });
    if (changes === 0) throw notFound('Provider', id);
  }
}

// ---------------------------------------------------------------------------

export class AgentRepository {
  constructor(private readonly db: SqlDriver) {}

  upsert(agent: Agent): Agent {
    const a = validated(AgentSchema, agent, 'agent');
    this.db.run(
      `INSERT INTO agents (id, provider_id, data, updated_at) VALUES (:id, :providerId, :data, :at)
       ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, data = excluded.data,
         updated_at = excluded.updated_at`,
      { id: a.id, providerId: a.providerId, data: json(a), at: a.updatedAt },
    );
    return a;
  }

  findById(id: string): Agent | null {
    const row = this.db.get<{ data: string }>('SELECT data FROM agents WHERE id = :id', { id });
    return row ? fromJson(AgentSchema, row.data, 'agent') : null;
  }

  list(): Agent[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM agents ORDER BY rowid')
      .map((r) => fromJson(AgentSchema, r.data, 'agent'));
  }

  countByProvider(providerId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agents WHERE provider_id = :providerId',
      { providerId },
    );
    return Number(row?.n ?? 0);
  }
}

// ---------------------------------------------------------------------------

export class PolicyRepository {
  constructor(private readonly db: SqlDriver) {}

  save(policy: PermissionPolicy): PermissionPolicy {
    const p = validated(PermissionPolicySchema, policy, 'permission policy');
    this.db.run(
      `INSERT INTO permission_policies (id, version, data, updated_at) VALUES (:id, :version, :data, :at)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data,
         updated_at = excluded.updated_at`,
      { id: p.id, version: p.version, data: json(p), at: new Date().toISOString() },
    );
    return p;
  }

  findById(id: string): PermissionPolicy | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM permission_policies WHERE id = :id',
      { id },
    );
    return row ? fromJson(PermissionPolicySchema, row.data, 'permission policy') : null;
  }

  list(): PermissionPolicy[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM permission_policies ORDER BY rowid')
      .map((r) => fromJson(PermissionPolicySchema, r.data, 'permission policy'));
  }
}
