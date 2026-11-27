import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import type {
  BillingPolicy,
  InferenceRequest,
  ModelDefinition,
  PrivacyPolicy,
  RoutingPolicy,
} from '@devbrain/contracts';
import { AiGateway } from './gateway.js';
import { LocalGatewayServer } from './server.js';
import { isPublicAddress } from './transport.js';

/** Gateway-level enforcement of the Phase 02 intelligence policies (no real provider used). */
const databases: DevBrainDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const db = () => {
  const database = createDatabase({ location: ':memory:' });
  databases.push(database);
  return database;
};

interface Upstream {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}
const upstream = async (respond: RequestListener): Promise<Upstream> => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
const ok = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }));
  };
const status = (code: number): RequestListener => (_req, res) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'x' } }));
};

const VERIFIED = '2026-11-27T00:00:00.000Z';
const model = (
  id: string,
  providerId: string,
  price: { input: number; output: number } | 'unverified' | null,
  extra: Partial<ModelDefinition['capabilities']> = {},
): ModelDefinition => ({
  id,
  providerId,
  upstreamModelId: id,
  name: id,
  capabilities: {
    input: ['text'],
    output: ['text'],
    tools: true,
    streaming: true,
    structuredOutput: true,
    reasoning: false,
    contextTokens: 128_000,
    outputTokens: 8_000,
    ...extra,
  },
  pricing:
    price === null
      ? null
      : {
          currency: 'USD',
          inputPerMillion: price === 'unverified' ? 0 : price.input,
          outputPerMillion: price === 'unverified' ? 0 : price.output,
          cachedInputPerMillion: null,
          verifiedAt: price === 'unverified' ? null : VERIFIED,
          sourceUrl: null,
        },
  lifecycle: 'active',
  sourceId: 'manual',
  verifiedAt: null,
});

const setup = (
  gateway: AiGateway,
  routes: {
    id: string;
    url: string;
    provider: string;
    model: ModelDefinition;
    priority?: number;
    local?: boolean;
    connection?: string;
  }[],
  options: {
    policy?: Partial<RoutingPolicy>;
    billing?: Partial<BillingPolicy>;
    privacy?: Partial<PrivacyPolicy>;
  } = {},
) => {
  gateway.configurePolicy({
    policy: {
      id: 'policy',
      strategy: 'priority',
      billingPolicyId: 'billing',
      privacyPolicyId: 'privacy',
      maxAttempts: 3,
      requireTools: false,
      ...options.policy,
    },
    billing: {
      id: 'billing',
      allowPaid: false,
      allowUnknownCost: false,
      maxCostPerRequest: null,
      maxCostPerDay: null,
      currency: 'USD',
      ...options.billing,
    },
    privacy: {
      id: 'privacy',
      mode: 'any-configured',
      allowedProviderIds: [],
      allowPromptLogging: false,
      ...options.privacy,
    },
  });
  for (const [index, r] of routes.entries()) {
    const endpointId = `endpoint-${r.id}`;
    const connectionId = r.connection ?? `connection-${r.id}`;
    if (!gateway.endpoints().some((e) => e.id === endpointId))
      gateway.saveEndpoint({
        id: endpointId,
        providerId: r.provider,
        baseUrl: `${r.url}/v1`,
        protocol: 'openai-chat',
        documentationUrl: null,
      });
    gateway.saveConnection({
      id: connectionId,
      providerId: r.provider,
      endpointId,
      credentialId: null,
      enabled: true,
      status: 'ready',
      lastVerifiedAt: null,
    });
    gateway.saveModel(r.model);
    gateway.saveRoute({
      id: r.id,
      modelId: r.model.id,
      connectionId,
      priority: r.priority ?? index,
      enabled: true,
      localOnly: r.local ?? false,
    });
  }
};

const req = (extra: Partial<InferenceRequest> = {}): InferenceRequest => ({
  id: `req-${crypto.randomUUID()}`,
  sessionId: null,
  modelId: null,
  messages: [{ role: 'user', content: 'Write a function that adds two numbers.' }],
  maxOutputTokens: 100,
  temperature: null,
  stream: false,
  routingPolicyId: 'policy',
  idempotencyKey: null,
  ...extra,
});
const PROJECT = 'prj_00000000-0000-4000-8000-000000000001';

describe('budget enforcement in the gateway', () => {
  it('blocks a paid route without explicit authorization and never contacts it', async () => {
    const paid = await upstream(ok('paid'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [{ id: 'paid', url: paid.url, provider: 'ppx', model: model('mx', 'ppx', { input: 1, output: 2 }) }]);
      await expect(gateway.infer(req())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(paid.hits()).toBe(0);
      const decision = gateway.explain(req());
      expect(decision.excluded[0]?.reasons.map((r) => r.code)).toContain('paid-not-authorized');
    } finally {
      await paid.close();
    }
  });

  it('a free route that fails never falls silently to a paid route', async () => {
    const free = await upstream(status(429));
    const paid = await upstream(ok('paid'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'free', url: free.url, provider: 'ffx', model: model('mfx', 'ffx', { input: 0, output: 0 }) },
        { id: 'paid', url: paid.url, provider: 'ppx', model: model('mpx', 'ppx', { input: 1, output: 2 }) },
      ]);
      await expect(gateway.infer(req())).rejects.toBeDefined();
      expect(free.hits()).toBe(1);
      expect(paid.hits()).toBe(0);
    } finally {
      await free.close();
      await paid.close();
    }
  });

  it('reconciles measured cost exactly (micros), even when the provider reports more than estimated', async () => {
    const paid = await upstream(ok('done', { prompt_tokens: 1000, completion_tokens: 500 }));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(
        gateway,
        [{ id: 'paid', url: paid.url, provider: 'ppx', model: model('mx', 'ppx', { input: 3, output: 15 }) }],
        { billing: { allowPaid: true, maxCostPerDay: 1 } },
      );
      const result = await gateway.infer(req());
      // 1000 × $3/M + 500 × $15/M = $0.003 + $0.0075 = 10_500 micros.
      const cost = gateway.intelligence.cost(result.requestId);
      expect(cost).toMatchObject({ state: 'reconciled', reconciledMicros: 10_500 });
      // The fake upstream reports 1000 prompt tokens for a ~15-token prompt: a wrong estimate.
      // The ledger commits what was measured, not what was estimated.
      expect(cost!.estimatedMicros).toBeGreaterThan(0);
      expect(result.usage?.cost).toBeCloseTo(0.0105, 10);
      const [global] = gateway.budgetStatus({});
      expect(global).toMatchObject({ committedMicros: 10_500, reservedMicros: 0, enforcedBy: 'devbrain' });
    } finally {
      await paid.close();
    }
  });

  it('concurrent requests cannot jointly exceed a daily ceiling', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = await upstream((req, res) => {
      void gate.then(() => ok('x', { prompt_tokens: 10, completion_tokens: 10 })(req, res));
    });
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      // Worst case per call ≈ (input + 100 output) × $100/M ≈ 0.011 → ceiling $0.015 fits one.
      setup(
        gateway,
        [{ id: 'paid', url: slow.url, provider: 'ppx', model: model('mx', 'ppx', { input: 100, output: 100 }) }],
        { billing: { allowPaid: true, maxCostPerDay: 0.015 } },
      );
      const a = gateway.infer(req());
      const b = gateway.infer(req());
      setTimeout(release, 50);
      const outcomes = await Promise.allSettled([a, b]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(slow.hits()).toBe(1);
    } finally {
      await slow.close();
    }
  });

  it('strict policy blocks a route whose cost cannot be bounded when a ceiling applies', async () => {
    const unknown = await upstream(ok('x'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(
        gateway,
        [{ id: 'uux', url: unknown.url, provider: 'uux', model: model('mux', 'uux', null) }],
        { billing: { allowPaid: true, allowUnknownCost: true, maxCostPerDay: 5 } },
      );
      const decision = gateway.explain(req());
      expect(decision.excluded[0]?.reasons.map((r) => r.code)).toContain('cost-unbounded');
      await expect(gateway.infer(req())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(unknown.hits()).toBe(0);
    } finally {
      await unknown.close();
    }
  });

  it('a failed paid call stays committed at worst case (uncertain), never assumed free', async () => {
    const broken = await upstream(status(500));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(
        gateway,
        [{ id: 'paid', url: broken.url, provider: 'ppx', model: model('mx', 'ppx', { input: 1, output: 1 }) }],
        { billing: { allowPaid: true, maxCostPerDay: 1 }, policy: { maxAttempts: 1 } },
      );
      const request = req();
      await expect(gateway.infer(request)).rejects.toBeDefined();
      expect(gateway.intelligence.cost(request.id)).toMatchObject({ state: 'unknown', reconciledMicros: null });
      const [global] = gateway.budgetStatus({});
      expect(global!.committedMicros).toBeGreaterThan(0);
    } finally {
      await broken.close();
    }
  });

  it('adversarial metadata: zero prices without verification are not free', async () => {
    const fake = await upstream(ok('x'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [{ id: 'fake', url: fake.url, provider: 'ppx', model: model('mx', 'ppx', 'unverified') }], {
        policy: { preset: 'free-only' },
      });
      const codes = gateway.explain(req()).excluded[0]?.reasons.map((r) => r.code);
      expect(codes).toContain('paid-not-authorized');
      expect(fake.hits()).toBe(0);
    } finally {
      await fake.close();
    }
  });
});

describe('privacy and project policy in the gateway', () => {
  it('restricted project: external egress blocked, local route used', async () => {
    const external = await upstream(ok('external'));
    const local = await upstream(ok('local'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'ext', url: external.url, provider: 'cloud', model: model('cloud-m', 'cloud', { input: 0, output: 0 }) },
        { id: 'loc', url: local.url, provider: 'ollama', model: model('local-m', 'ollama', null), local: true, priority: 5 },
      ]);
      gateway.intelligence.saveProjectPolicy({
        projectId: PROJECT,
        privacyClass: 'restricted',
        approvedProviderIds: ['cloud'],
        budget: {
          currency: 'USD',
          maxPerDayMicros: null,
          maxPerSessionMicros: null,
          maxPerInferenceMicros: null,
          allowPaid: false,
          allowUnboundedCost: false,
        },
      });
      const result = await gateway.infer(req({ projectId: PROJECT }));
      expect(result.content).toBe('local');
      expect(external.hits()).toBe(0);
      const decision = gateway.intelligence.decision(result.requestId);
      expect(decision?.excluded).toEqual([
        { routeId: 'ext', reasons: [expect.objectContaining({ code: 'privacy' })] },
      ]);
    } finally {
      await external.close();
      await local.close();
    }
  });

  it('never-configured project defaults to personal-private: unknown provider is excluded', async () => {
    const external = await upstream(ok('external'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [{ id: 'ext', url: external.url, provider: 'cloud', model: model('mmx', 'cloud', { input: 0, output: 0 }) }]);
      await expect(gateway.infer(req({ projectId: PROJECT }))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(external.hits()).toBe(0);
      // Verified no-training facts make it eligible, without approving the provider.
      gateway.intelligence.savePrivacyProfile({
        providerId: 'cloud',
        retention: 'limited',
        retentionDays: 30,
        trainingOnInputs: 'no',
        commercialUse: 'unknown',
        processingRegion: null,
        intermediaries: 'unknown',
        contract: 'unknown',
        deletion: 'unknown',
        security: 'unknown',
        sourceUrl: null,
        verifiedAt: null,
        verifiedBy: null,
      });
      expect((await gateway.infer(req({ projectId: PROJECT }))).content).toBe('external');
    } finally {
      await external.close();
    }
  });

  it('fallback keeps the privacy class: a privacy-ineligible fallback is never tried', async () => {
    const approved = await upstream(status(503));
    const other = await upstream(ok('leak'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'approved', url: approved.url, provider: 'good', model: model('g-model', 'good', { input: 0, output: 0 }) },
        { id: 'other', url: other.url, provider: 'other', model: model('o-model', 'other', { input: 0, output: 0 }) },
      ]);
      gateway.intelligence.saveProjectPolicy({
        projectId: PROJECT,
        privacyClass: 'personal-private',
        approvedProviderIds: ['good'],
        budget: {
          currency: 'USD',
          maxPerDayMicros: null,
          maxPerSessionMicros: null,
          maxPerInferenceMicros: null,
          allowPaid: false,
          allowUnboundedCost: false,
        },
      });
      await expect(gateway.infer(req({ projectId: PROJECT }))).rejects.toBeDefined();
      expect(approved.hits()).toBe(1);
      expect(other.hits()).toBe(0);
    } finally {
      await approved.close();
      await other.close();
    }
  });
});

describe('routing behaviour', () => {
  it('works when every external model is unavailable (local only, no AI used to route)', async () => {
    const local = await upstream(ok('local answer'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'ext', url: local.url, provider: 'cloud', model: model('cloud-model', 'cloud', { input: 0, output: 0 }) },
        { id: 'loc', url: local.url, provider: 'ollama', model: model('l-model', 'ollama', null), local: true },
      ]);
      gateway.saveConnection({
        id: 'connection-ext',
        providerId: 'cloud',
        endpointId: 'endpoint-ext',
        credentialId: null,
        enabled: true,
        status: 'unavailable',
        lastVerifiedAt: null,
      });
      const result = await gateway.infer(req());
      expect(result.content).toBe('local answer');
      expect(result.routeId).toBe('loc');
    } finally {
      await local.close();
    }
  });

  it('a score can never re-admit an excluded route (quality preset vs. paid model)', async () => {
    const strong = await upstream(ok('strong'));
    const weak = await upstream(ok('weak'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(
        gateway,
        [
          { id: 'strong', url: strong.url, provider: 'ssx', model: model('ssxx', 'ssx', { input: 30, output: 60 }, { reasoning: true }) },
          { id: 'weak', url: weak.url, provider: 'wwx', model: model('wwxx', 'wwx', { input: 0, output: 0 }) },
        ],
        { policy: { preset: 'quality' } },
      );
      const decision = gateway.explain(req());
      expect(decision.ranked.map((r) => r.routeId)).toEqual(['weak']);
      expect(decision.excluded[0]).toMatchObject({ routeId: 'strong' });
      expect((await gateway.infer(req())).content).toBe('weak');
    } finally {
      await strong.close();
      await weak.close();
    }
  });

  it('a declared minimum quality tier excludes weaker models (no silent downgrade)', async () => {
    const small = await upstream(ok('small'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'small', url: small.url, provider: 'xxx', model: model('smallx', 'xxx', { input: 0, output: 0 }, { tools: false, contextTokens: 8000 }) },
      ]);
      const decision = gateway.explain(
        req({ task: { kind: 'architecture', priority: 'normal', requiresTools: false, requiresStructuredOutput: false, requiresReasoning: false } }),
      );
      expect(decision.minQualityTier).toBe('advanced');
      expect(decision.excluded[0]?.reasons.map((r) => r.code)).toContain('quality-below-minimum');
      // A keyword guess alone never excludes.
      expect(gateway.explain(req()).ranked).toHaveLength(1);
    } finally {
      await small.close();
    }
  });

  it('a rate limit on one key cools down every connection of the same provider', async () => {
    const limited = await upstream(status(429));
    const secondKey = await upstream(ok('second key'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [
        { id: 'key1', url: limited.url, provider: 'same', model: model('m1', 'same', { input: 0, output: 0 }) },
        { id: 'key2', url: secondKey.url, provider: 'same', model: model('m2', 'same', { input: 0, output: 0 }) },
      ]);
      await expect(gateway.infer(req())).rejects.toBeDefined();
      expect(secondKey.hits()).toBe(0);
      const decision = gateway.explain(req());
      expect(decision.excluded.map((e) => e.reasons[0]?.code)).toEqual(['cooldown', 'cooldown']);
    } finally {
      await limited.close();
      await secondKey.close();
    }
  });

  it('explain() is a dry run: nothing is reserved or sent', async () => {
    const up = await upstream(ok('x'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [{ id: 'rrx', url: up.url, provider: 'ppx', model: model('mx', 'ppx', { input: 0, output: 0 }) }]);
      gateway.ledger.define({
        id: 'rpm',
        scope: 'provider',
        scopeId: 'ppx',
        unit: 'requests',
        limit: 10,
        periodSeconds: 60,
        sourceUrl: null,
        verifiedAt: null,
      });
      const decision = gateway.explain(req());
      expect(decision.ranked).toHaveLength(1);
      expect(gateway.ledger.reservations('rpm')).toHaveLength(0);
      expect(up.hits()).toBe(0);
    } finally {
      await up.close();
    }
  });

  it('input tokens now count against token quotas', async () => {
    const up = await upstream(ok('x'));
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      setup(gateway, [{ id: 'rrx', url: up.url, provider: 'ppx', model: model('mx', 'ppx', { input: 0, output: 0 }) }]);
      gateway.ledger.define({
        id: 'tpm',
        scope: 'provider',
        scopeId: 'ppx',
        unit: 'input-tokens',
        limit: 20,
        periodSeconds: 60,
        sourceUrl: null,
        verifiedAt: null,
      });
      const big = req({ messages: [{ role: 'user', content: 'x'.repeat(600) }] });
      expect(gateway.explain(big).excluded[0]?.reasons[0]?.code).toBe('quota-exhausted');
    } finally {
      await up.close();
    }
  });
});

describe('local gateway server and transport hardening', () => {
  const raw = (port: number, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/v1/models', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });

  it('rejects foreign Host headers (DNS rebinding) and browser origins', async () => {
    const gateway = new AiGateway(db().driver, async () => '');
    const server = new LocalGatewayServer(gateway, 'policy');
    await server.start();
    try {
      const port = Number(new URL(server.baseUrl).port);
      const auth = { authorization: `Bearer ${server.token}` };
      expect(await raw(port, { ...auth, host: 'attacker.example:80' })).toBe(403);
      expect(await raw(port, { ...auth, host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).toBe(403);
      expect(await raw(port, { ...auth, host: `127.0.0.1:${port}` })).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('treats 6to4 and Teredo IPv6 as non-public (embedded IPv4 tunnels)', () => {
    expect(isPublicAddress('2002:c0a8:0101::1')).toBe(false);
    expect(isPublicAddress('2001:0:4136:e378::1')).toBe(false);
    expect(isPublicAddress('2001::1')).toBe(false);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('fd00::1')).toBe(false);
  });
});
