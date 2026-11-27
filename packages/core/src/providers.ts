import {
  DevBrainError,
  EMPTY_PROVIDER_CONFIG,
  NO_CAPABILITIES,
  PermissionPolicySchema,
  ProviderEvidenceInputSchema,
  RegisterAgentInputSchema,
  RegisterProviderInputSchema,
  SetProviderEnabledInputSchema,
  UNKNOWN_EVIDENCE,
  UpdateAgentInputSchema,
  UpdateProviderInputSchema,
  newId,
  nowTimestamp,
  parseOrThrow,
  type Agent,
  type AgentCapabilities,
  type Evidence,
  type PermissionPolicy,
  type Provider,
  type ProviderConfig,
  type ProviderEvidenceInput,
  type ProviderHealth,
  type ProviderProfile,
  type ProviderReadiness,
  type ProviderStatus,
  type RegisterAgentInput,
  type RegisterProviderInput,
  type UpdateAgentInput,
  type UpdateProviderInput,
} from '@devbrain/contracts';
import type { StoredProvider } from '@devbrain/database';
import { createDefaultPolicy, redactString } from '@devbrain/security';
import { audit, type CoreContext } from './context.js';

const UNKNOWN_HEALTH: ProviderHealth = {
  installed: UNKNOWN_EVIDENCE,
  authenticated: UNKNOWN_EVIDENCE,
  operational: UNKNOWN_EVIDENCE,
};

/**
 * Readiness is DERIVED from evidence recorded by the execution engine; configuration alone
 * never makes a provider "available".
 */
export const deriveReadiness = (provider: Provider, health: ProviderHealth): ProviderReadiness => {
  if (!provider.enabled) return 'disabled';
  if (health.authenticated.state === 'no' || health.operational.state === 'no') return 'failing';
  if (health.operational.state === 'yes') return 'operational';
  if (health.installed.state === 'no') return 'configured';
  if (health.authenticated.state === 'yes') return 'authenticated';
  if (health.installed.state === 'yes') return 'available';
  return 'configured';
};

const statusOf = (readiness: ProviderReadiness, health: ProviderHealth): ProviderStatus => {
  switch (readiness) {
    case 'disabled':
      return 'disabled';
    case 'configured':
      return health.installed.state === 'no' ? 'missing-dependency' : 'unknown';
    case 'failing':
      return health.authenticated.state === 'no' ? 'unauthenticated' : 'unavailable';
    default:
      return 'available';
  }
};

const mergeConfig = (
  base: ProviderConfig,
  patch: Partial<Record<keyof ProviderConfig, unknown>> = {},
): ProviderConfig => {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return { ...base, ...defined } as ProviderConfig;
};

const profileOf = (stored: StoredProvider): ProviderProfile => ({
  provider: stored.provider,
  config: stored.config,
  health: stored.health,
  readiness: deriveReadiness(stored.provider, stored.health),
});

export class ProviderService {
  constructor(private readonly ctx: CoreContext) {}

  private require(id: string): StoredProvider {
    const stored = this.ctx.db.providers.findById(id);
    if (!stored) throw new DevBrainError('NOT_FOUND', 'Provider not found', { details: { id } });
    return stored;
  }

  private assertCredential(id: string | null | undefined): void {
    if (id && !this.ctx.db.credentials.findById(id)) {
      throw new DevBrainError('NOT_FOUND', 'Credential reference not found', { details: { id } });
    }
  }

  private save(
    stored: StoredProvider,
    action: string,
    details: Record<string, unknown> = {},
  ): ProviderProfile {
    const readiness = deriveReadiness(stored.provider, stored.health);
    const next: StoredProvider = {
      ...stored,
      provider: { ...stored.provider, status: statusOf(readiness, stored.health) },
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.providers.upsert(next);
      audit(this.ctx, { action, target: next.provider.id, details });
    });
    this.ctx.events.emit('providers.changed', { providerId: next.provider.id });
    return profileOf(next);
  }

  async list(): Promise<ProviderProfile[]> {
    return this.ctx.db.providers.list().map(profileOf);
  }

  async get(id: string): Promise<ProviderProfile> {
    return profileOf(this.require(id));
  }

  async register(input: RegisterProviderInput): Promise<ProviderProfile> {
    const parsed = parseOrThrow(RegisterProviderInputSchema, input);
    this.assertCredential(parsed.credentialRef);
    const provider: Provider = {
      id: newId('provider'),
      adapterKey: parsed.adapterKey,
      kind: parsed.kind,
      displayName: parsed.displayName,
      vendor: parsed.vendor ?? null,
      status: 'unknown',
      enabled: true,
      credentialRef: parsed.credentialRef ?? null,
      endpoint: parsed.endpoint ?? null,
      // Nothing is assumed: capabilities come from verified evidence only.
      capabilities: { ...NO_CAPABILITIES },
      lastCheckedAt: null,
    };
    return this.save(
      {
        provider,
        config: mergeConfig(EMPTY_PROVIDER_CONFIG, parsed.config),
        health: UNKNOWN_HEALTH,
      },
      'provider.registered',
      { adapterKey: provider.adapterKey, kind: provider.kind },
    );
  }

  async update(input: UpdateProviderInput): Promise<ProviderProfile> {
    const parsed = parseOrThrow(UpdateProviderInputSchema, input);
    const current = this.require(parsed.id);
    this.assertCredential(parsed.credentialRef);
    const configChanged =
      parsed.config !== undefined ||
      parsed.endpoint !== undefined ||
      parsed.credentialRef !== undefined;
    const provider: Provider = {
      ...current.provider,
      ...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}),
      ...(parsed.vendor !== undefined ? { vendor: parsed.vendor } : {}),
      ...(parsed.endpoint !== undefined ? { endpoint: parsed.endpoint } : {}),
      ...(parsed.credentialRef !== undefined ? { credentialRef: parsed.credentialRef } : {}),
    };
    return this.save(
      {
        provider,
        config: mergeConfig(current.config, parsed.config),
        // Evidence about a different configuration is no longer evidence.
        health: configChanged ? UNKNOWN_HEALTH : current.health,
      },
      'provider.updated',
      { fields: Object.keys(parsed).filter((k) => k !== 'id'), evidenceReset: configChanged },
    );
  }

  async setEnabled(input: { id: string; enabled: boolean }): Promise<ProviderProfile> {
    const parsed = parseOrThrow(SetProviderEnabledInputSchema, input);
    const current = this.require(parsed.id);
    return this.save(
      { ...current, provider: { ...current.provider, enabled: parsed.enabled } },
      parsed.enabled ? 'provider.enabled' : 'provider.disabled',
    );
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    if (this.ctx.db.agents.countByProvider(id) > 0) {
      throw new DevBrainError(
        'CONFLICT',
        'Agents still use this provider; remove or reassign them first',
      );
    }
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.providers.delete(id);
      audit(this.ctx, { action: 'provider.removed', target: id });
    });
    this.ctx.events.emit('providers.changed', { providerId: id });
  }

  /**
   * Records a fact observed by the execution engine (dependency check, auth probe, real
   * request). MAIN PROCESS ONLY — deliberately not exposed over IPC, so neither the UI nor an
   * agent can declare a provider available.
   */
  async recordEvidence(input: ProviderEvidenceInput): Promise<ProviderProfile> {
    const parsed = parseOrThrow(ProviderEvidenceInputSchema, input);
    const current = this.require(parsed.providerId);
    const at = nowTimestamp();
    const fact: Evidence = {
      state: parsed.state,
      checkedAt: at,
      source: 'execution-engine',
      detail: parsed.detail ? redactString(parsed.detail).slice(0, 2000) : null,
    };
    const implied = (detail: string): Evidence => ({ ...fact, state: 'yes', detail });
    let health: ProviderHealth = { ...current.health, [parsed.aspect]: fact };
    if (parsed.state === 'yes' && parsed.aspect === 'operational') {
      health = {
        installed: implied('implied by a successful operation'),
        authenticated: implied('implied by a successful operation'),
        operational: fact,
      };
    } else if (parsed.state === 'yes' && parsed.aspect === 'authenticated') {
      health = { ...health, installed: implied('implied by successful authentication') };
    } else if (parsed.state === 'no' && parsed.aspect === 'installed') {
      health = { installed: fact, authenticated: UNKNOWN_EVIDENCE, operational: UNKNOWN_EVIDENCE };
    }
    const capabilities: AgentCapabilities = parsed.capabilities ?? current.provider.capabilities;
    const profile = this.save(
      {
        ...current,
        provider: { ...current.provider, capabilities, lastCheckedAt: at },
        health,
      },
      'provider.evidence-recorded',
      { aspect: parsed.aspect, state: parsed.state },
    );
    if (parsed.capabilities) {
      // Agents mirror the verified capabilities of their provider.
      for (const agent of this.ctx.db.agents
        .list()
        .filter((a) => a.providerId === parsed.providerId)) {
        this.ctx.db.agents.upsert({ ...agent, capabilities, updatedAt: at });
      }
    }
    return profile;
  }
}

export class PolicyService {
  constructor(private readonly ctx: CoreContext) {}

  async list(): Promise<PermissionPolicy[]> {
    return this.ctx.db.policies.list();
  }

  get(id: string): PermissionPolicy {
    const policy = this.ctx.db.policies.findById(id);
    if (!policy)
      throw new DevBrainError('NOT_FOUND', 'Permission policy not found', { details: { id } });
    return policy;
  }

  /** Creates or replaces a policy; replacing bumps the version. */
  async save(input: PermissionPolicy): Promise<PermissionPolicy> {
    const parsed = parseOrThrow(PermissionPolicySchema, input);
    const existing = this.ctx.db.policies.findById(parsed.id);
    const next: PermissionPolicy = {
      ...parsed,
      version: existing ? existing.version + 1 : parsed.version,
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.policies.save(next);
      audit(this.ctx, {
        action: existing ? 'policy.updated' : 'policy.created',
        target: next.id,
        details: {
          version: next.version,
          defaultDecision: next.defaultDecision,
          rules: next.rules.length,
        },
      });
    });
    return next;
  }
}

export class AgentService {
  constructor(private readonly ctx: CoreContext) {}

  async list(): Promise<Agent[]> {
    return this.ctx.db.agents.list();
  }

  get(id: string): Agent {
    const agent = this.ctx.db.agents.findById(id);
    if (!agent) throw new DevBrainError('NOT_FOUND', 'Agent not found', { details: { id } });
    return agent;
  }

  async register(input: RegisterAgentInput): Promise<Agent> {
    const parsed = parseOrThrow(RegisterAgentInputSchema, input);
    const provider = this.ctx.db.providers.findById(parsed.providerId);
    if (!provider) throw new DevBrainError('NOT_FOUND', 'Provider not found');
    if (parsed.permissionPolicyId && !this.ctx.db.policies.findById(parsed.permissionPolicyId)) {
      throw new DevBrainError('NOT_FOUND', 'Permission policy not found');
    }
    const now = nowTimestamp();
    const id = newId('agent');
    const permissionPolicyId = parsed.permissionPolicyId ?? newId('policy');
    const policy = parsed.permissionPolicyId
      ? null
      : createDefaultPolicy(permissionPolicyId, `Default — ${parsed.name}`);
    const agent: Agent = {
      id,
      providerId: provider.provider.id,
      name: parsed.name,
      role: parsed.role ?? null,
      model: parsed.model ?? provider.config.defaultModel,
      capabilities: provider.provider.capabilities,
      permissionPolicyId,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
    this.ctx.db.driver.transaction(() => {
      if (policy) this.ctx.db.policies.save(policy);
      this.ctx.db.agents.upsert(agent);
      audit(this.ctx, {
        action: 'agent.registered',
        target: id,
        details: {
          providerId: agent.providerId,
          policyId: agent.permissionPolicyId,
          defaultPolicy: !!policy,
        },
      });
    });
    return agent;
  }

  async update(input: UpdateAgentInput): Promise<Agent> {
    const parsed = parseOrThrow(UpdateAgentInputSchema, input);
    const current = this.get(parsed.id);
    if (parsed.permissionPolicyId && !this.ctx.db.policies.findById(parsed.permissionPolicyId)) {
      throw new DevBrainError('NOT_FOUND', 'Permission policy not found');
    }
    const next: Agent = {
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.role !== undefined ? { role: parsed.role } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.permissionPolicyId !== undefined
        ? { permissionPolicyId: parsed.permissionPolicyId }
        : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      updatedAt: nowTimestamp(),
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.agents.upsert(next);
      audit(this.ctx, {
        action: 'agent.updated',
        target: next.id,
        details: { fields: Object.keys(parsed).filter((k) => k !== 'id') },
      });
    });
    return next;
  }
}
