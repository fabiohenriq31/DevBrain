import { createServer, type RequestListener } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import type {
  InferenceRequest,
  ModelDefinition,
  ProviderConnection,
  ProviderEndpoint,
} from '@devbrain/contracts';
import { AiGateway } from './gateway.js';
import { QuotaLedger } from './ledger.js';
import { SafeHttpTransport } from './transport.js';
import { ProtocolTransport } from './protocols.js';
import { ProviderCatalog } from './catalog.js';
import { SPECIFIC_CONNECTION_PROFILES, connectionRecipe } from './profiles.js';
import { OllamaRuntime, OpenAiLocalRuntime } from './local.js';
import { LocalGatewayServer } from './server.js';

const databases: DevBrainDatabase[] = [];
const db = () => {
  const database = createDatabase({ location: ':memory:' });
  databases.push(database);
  return database;
};
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const quota = (id: string, scopeId = 'provider-a', limit = 1) => ({
  id,
  scope: 'provider' as const,
  scopeId,
  unit: 'requests' as const,
  limit,
  periodSeconds: 60,
  sourceUrl: null,
  verifiedAt: null,
});

describe('transactional quota ledger', () => {
  it('records only numeric provider quota headers against an existing definition', () => {
    const ledger = new QuotaLedger(db().driver);
    ledger.define(quota('provider-rate', 'provider-a', 100));
    ledger.observeResponseHeaders(['provider-rate'], {
      'x-ratelimit-remaining-requests': '42',
    });
    expect(ledger.observations('provider-rate')[0]).toMatchObject({
      remaining: 42,
      used: 58,
      source: 'response-header',
    });
    ledger.observeResponseHeaders(['provider-rate'], {
      'x-ratelimit-remaining-requests': 'unknown',
    });
    expect(ledger.observations('provider-rate')).toHaveLength(1);
  });
  it('admits only one concurrent request against a shared provider limit', async () => {
    const ledger = new QuotaLedger(db().driver);
    ledger.define(quota('shared-quota'));
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        ledger.reserveAll('req-a', [{ quotaId: 'shared-quota', amount: 1 }]),
      ),
      Promise.resolve().then(() =>
        ledger.reserveAll('req-b', [{ quotaId: 'shared-quota', amount: 1 }]),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });

  it('renews windows and conservatively reconciles interrupted calls', () => {
    let now = Date.parse('2026-11-27T12:00:00.000Z');
    const ledger = new QuotaLedger(db().driver, () => now);
    ledger.define(quota('per-minute'));
    const [first] = ledger.reserveAll('request-1', [{ quotaId: 'per-minute', amount: 1 }]);
    expect(first).toBeDefined();
    expect(ledger.recover()).toBe(1);
    expect(ledger.reservations('per-minute')[0]?.status).toBe('uncertain');
    expect(() => ledger.reserveAll('request-2', [{ quotaId: 'per-minute', amount: 1 }])).toThrow();
    now += 60_000;
    expect(ledger.reserveAll('request-3', [{ quotaId: 'per-minute', amount: 1 }])).toHaveLength(1);
  });

  it('does not interpret unknown quota as zero', () => {
    const ledger = new QuotaLedger(db().driver);
    ledger.define(quota('unknown-quota', 'provider-a', 0));
    expect(() => ledger.reserveAll('request', [{ quotaId: 'unknown-quota', amount: 1 }])).toThrow();
  });
});

const startServer = async (respond: RequestListener) => {
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('safe HTTP and protocol parsing', () => {
  it('authenticates OpenRouter separately from its public model catalog and preserves price/tool evidence', async () => {
    const upstream = await startServer((req, res) => {
      if (req.url === '/v1/key' && req.headers.authorization !== 'Bearer valid') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url === '/v1/key'
            ? { data: { label: 'test' } }
            : {
                data: [
                  {
                    id: 'lab/coder:free',
                    name: 'Coder Free',
                    supported_parameters: ['tools'],
                    context_length: 32000,
                    pricing: { prompt: '0', completion: '0' },
                  },
                  {
                    id: 'lab/coder-pro',
                    name: 'Coder Pro',
                    supported_parameters: ['tools'],
                    pricing: { prompt: '0.000001', completion: '0.000002' },
                  },
                  { id: 'lab/unknown', name: 'Unknown' },
                ],
              },
        ),
      );
    });
    try {
      const configured = { ...endpoint(upstream.url, 'ep-openrouter', 'openrouter') };
      const database = db();
      const gateway = new AiGateway(database.driver, async () => 'valid');
      gateway.saveEndpoint(configured);
      gateway.saveConnection({
        ...connection('conn-openrouter', configured.id, 'openrouter'),
        credentialId: 'crd_00000000-0000-4000-8000-000000000001',
        status: 'unknown',
      });
      const result = await gateway.discoverConnection('conn-openrouter');
      expect(result.authenticated).toBe(true);
      expect(result.models).toHaveLength(3);
      expect(result.models[0]).toMatchObject({
        tools: true,
        contextTokens: 32000,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      });
      expect(result.models[1]?.pricing).toMatchObject({ inputPerMillion: 1, outputPerMillion: 2 });
      expect(result.models[2]).toMatchObject({ tools: null, pricing: null });
      expect(gateway.connections()[0]?.status).toBe('ready');
      gateway.saveModel({
        ...model('model-free', 'openrouter'),
        upstreamModelId: result.models[0]!.upstreamModelId,
        capabilities: {
          ...model('model-free', 'openrouter').capabilities,
          tools: result.models[0]!.tools === true,
        },
        pricing: result.models[0]!.pricing,
      });
      gateway.saveRoute({
        id: 'route-free',
        modelId: 'model-free',
        connectionId: 'conn-openrouter',
        enabled: true,
        priority: 10,
        localOnly: false,
      });
      const resumed = new AiGateway(database.driver, async () => 'valid');
      expect(resumed.connections()[0]?.status).toBe('ready');
      expect(resumed.routes()).toMatchObject([{ id: 'route-free', modelId: 'model-free' }]);
    } finally {
      await upstream.close();
    }
  });

  it('rejects an invalid key without registering a route or a ready connection', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid' } }));
    });
    try {
      const database = db();
      const gateway = new AiGateway(database.driver, async () => 'invalid');
      gateway.saveEndpoint(endpoint(upstream.url, 'ep-groq', 'groq'));
      gateway.saveConnection({
        ...connection('conn-groq', 'ep-groq', 'groq'),
        credentialId: 'crd_00000000-0000-4000-8000-000000000001',
        status: 'unknown',
      });
      await expect(gateway.discoverConnection('conn-groq')).rejects.toMatchObject({
        code: 'CREDENTIAL_UNAVAILABLE',
      });
      expect(gateway.connections()[0]?.status).toBe('invalid-credential');
      expect(gateway.routes()).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });
  it('rejects SSRF and credential-bearing URLs before a request', async () => {
    const transport = new SafeHttpTransport();
    await expect(transport.open({ url: 'http://127.0.0.1:7777/api' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      transport.open({ url: 'https://user:secret@example.com/v1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses redirects and detects an error inside HTTP 200', async () => {
    const redirect = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    });
    try {
      await expect(
        new SafeHttpTransport().open({ url: `${redirect.url}/v1`, allowLoopback: true }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } finally {
      await redirect.close();
    }
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many' } }));
    });
    try {
      await expect(
        new ProtocolTransport().generate(endpoint(upstream.url), request(), 'model-a', null),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await upstream.close();
    }
  });

  it('parses a streamed chat completion and reports usage', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write(
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    try {
      const parts = [];
      for await (const part of new ProtocolTransport().stream(
        endpoint(upstream.url),
        request(true),
        'model-a',
        null,
      ))
        parts.push(part);
      expect(parts[0]).toEqual({ type: 'delta', text: 'hello' });
      expect(parts.at(-1)).toMatchObject({
        type: 'done',
        generation: { content: 'hello', inputTokens: 4, outputTokens: 1 },
      });
    } finally {
      await upstream.close();
    }
  });

  it('cancels an in-flight response after headers', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    try {
      const controller = new AbortController();
      const pending = new SafeHttpTransport().json({
        url: `${upstream.url}/v1`,
        allowLoopback: true,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow();
    } finally {
      await upstream.close();
    }
  });
});

const endpoint = (
  baseUrl: string,
  id = 'endpoint-a',
  providerId = 'provider-a',
): ProviderEndpoint => ({
  id,
  providerId,
  baseUrl: `${baseUrl}/v1`,
  protocol: 'openai-chat',
  documentationUrl: null,
});
const connection = (id: string, endpointId: string, providerId: string): ProviderConnection => ({
  id,
  endpointId,
  providerId,
  credentialId: null,
  enabled: true,
  status: 'ready',
  lastVerifiedAt: null,
});
const model = (id: string, providerId: string): ModelDefinition => ({
  id,
  providerId,
  upstreamModelId: id,
  name: id,
  capabilities: {
    input: ['text'],
    output: ['text'],
    tools: false,
    streaming: true,
    structuredOutput: false,
    reasoning: false,
    contextTokens: null,
    outputTokens: null,
  },
  pricing: {
    currency: 'USD',
    inputPerMillion: 0,
    outputPerMillion: 0,
    cachedInputPerMillion: null,
    verifiedAt: '2026-11-27T00:00:00.000Z',
    sourceUrl: null,
  },
  lifecycle: 'active',
  sourceId: 'manual',
  verifiedAt: null,
});
const request = (stream = false): InferenceRequest => ({
  id: `request-${crypto.randomUUID()}`,
  sessionId: null,
  modelId: null,
  messages: [{ role: 'user', content: 'Hi' }],
  maxOutputTokens: 50,
  temperature: null,
  stream,
  routingPolicyId: 'default-policy',
  idempotencyKey: null,
});

describe('gateway fallback', () => {
  it('continues to a second eligible provider after a failed first route', async () => {
    let forwardedMessages: { content: string }[] = [];
    const first = await startServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limit' } }));
    });
    const second = await startServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        forwardedMessages = (
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages: { content: string }[];
          }
        ).messages;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'second' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
        );
      })();
    });
    try {
      const gateway = new AiGateway(db().driver, async () => {
        throw new Error('Unexpected secret');
      });
      gateway.configurePolicy({
        policy: {
          id: 'default-policy',
          strategy: 'priority',
          billingPolicyId: 'billing',
          privacyPolicyId: 'privacy',
          maxAttempts: 2,
          requireTools: false,
        },
        billing: {
          id: 'billing',
          allowPaid: false,
          allowUnknownCost: false,
          maxCostPerRequest: null,
          maxCostPerDay: null,
          currency: 'USD',
        },
        privacy: {
          id: 'privacy',
          mode: 'any-configured',
          allowedProviderIds: [],
          allowPromptLogging: false,
        },
      });
      for (const [index, upstream] of [first, second].entries()) {
        const suffix = index ? 'b' : 'a';
        gateway.saveEndpoint(endpoint(upstream.url, `endpoint-${suffix}`, `provider-${suffix}`));
        gateway.saveConnection(
          connection(`connection-${suffix}`, `endpoint-${suffix}`, `provider-${suffix}`),
        );
        gateway.saveModel(model(`model-${suffix}`, `provider-${suffix}`));
        gateway.saveRoute({
          id: `route-${suffix}`,
          modelId: `model-${suffix}`,
          connectionId: `connection-${suffix}`,
          priority: index,
          enabled: true,
          localOnly: false,
        });
      }
      const input = request();
      const repeated = `Repeated context ${'x'.repeat(300)}`;
      input.messages = [
        { role: 'assistant', content: repeated },
        { role: 'assistant', content: repeated },
        { role: 'user', content: 'Continue.' },
      ];
      const result = await gateway.infer(input);
      expect(result.content).toBe('second');
      expect(result.attempts).toHaveLength(1);
      expect(forwardedMessages.filter((message) => message.content === repeated)).toHaveLength(1);
      expect(
        forwardedMessages.some((message) => message.content.includes('identical to message')),
      ).toBe(true);
      expect(gateway.result(result.requestId)?.content).toBe('');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('uses the next free route when the first shared quota is exhausted', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'free route' }, finish_reason: 'stop' }],
        }),
      );
    });
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      gateway.configurePolicy({
        policy: {
          id: 'default-policy',
          strategy: 'priority',
          billingPolicyId: 'billing',
          privacyPolicyId: 'privacy',
          maxAttempts: 2,
          requireTools: false,
        },
        billing: {
          id: 'billing',
          allowPaid: false,
          allowUnknownCost: false,
          maxCostPerRequest: null,
          maxCostPerDay: null,
          currency: 'USD',
        },
        privacy: {
          id: 'privacy',
          mode: 'any-configured',
          allowedProviderIds: [],
          allowPromptLogging: false,
        },
      });
      for (const suffix of ['a', 'b']) {
        gateway.saveEndpoint(endpoint(upstream.url, `endpoint-${suffix}`, `provider-${suffix}`));
        gateway.saveConnection(
          connection(`connection-${suffix}`, `endpoint-${suffix}`, `provider-${suffix}`),
        );
        gateway.saveModel(model(`model-${suffix}`, `provider-${suffix}`));
        gateway.saveRoute({
          id: `route-${suffix}`,
          modelId: `model-${suffix}`,
          connectionId: `connection-${suffix}`,
          priority: suffix === 'a' ? 0 : 1,
          enabled: true,
          localOnly: false,
        });
      }
      gateway.ledger.define(quota('exhausted', 'provider-a', 0));
      const result = await gateway.infer(request());
      expect(result.content).toBe('free route');
      expect(result.routeId).toBe('route-b');
      // Phase 02 intelligence: an exhausted quota excludes the route BEFORE any attempt
      // (stage 1), and the explanation records why.
      expect(result.attempts).toHaveLength(0);
      const decision = gateway.intelligence.decision(result.requestId);
      expect(decision?.excluded).toEqual([
        { routeId: 'route-a', reasons: [expect.objectContaining({ code: 'quota-exhausted' })] },
      ]);
    } finally {
      await upstream.close();
    }
  });
});

describe('catalog', () => {
  it('ships distinct documented recipes without inferring free pricing or activating connections', () => {
    expect(SPECIFIC_CONNECTION_PROFILES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SPECIFIC_CONNECTION_PROFILES.map((entry) => entry.id)).size).toBe(
      SPECIFIC_CONNECTION_PROFILES.length,
    );
    for (const entry of SPECIFIC_CONNECTION_PROFILES) {
      expect(entry.documentationUrl).toMatch(/^https:\/\//);
      expect(entry.sourceUrls).toContain(entry.documentationUrl);
      expect(entry.offer).toBe(entry.kind === 'local' ? 'local' : 'unknown');
      if (entry.endpointUrl) expect(connectionRecipe(entry.id)?.baseUrl).toBe(entry.endpointUrl);
    }
  });
  it('rejects invalid input and leaves the prior snapshot intact', () => {
    const catalog = new ProviderCatalog(db().driver);
    expect(() =>
      catalog.import(
        Buffer.from(
          '{"formatVersion":1,"sourceId":"official","revision":"1","license":"MIT","entries":[{"id":"bad"}]}',
        ),
        'official',
      ),
    ).toThrow();
    expect(catalog.list().length).toBeGreaterThanOrEqual(20);
  });
  it('imports the pinned models.dev discovery snapshot without enabling connections', () => {
    const database = db();
    const catalog = new ProviderCatalog(database.driver);
    const bytes = readFileSync('catalog/models-dev-candidates.json');
    const snapshot = catalog.import(bytes, 'models-dev');
    expect(snapshot.providerCount).toBeGreaterThan(100);
    expect(catalog.list().length).toBeGreaterThanOrEqual(snapshot.providerCount);
    expect(database.driver.all('SELECT id FROM ai_connections')).toEqual([]);
  });
});

describe('local runtime', () => {
  it('discovers OpenAI-compatible local models with upstream IDs containing slashes', async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'publisher/coder:Q4_K_M' }] }));
    });
    try {
      const runtime = new OpenAiLocalRuntime('custom', `${upstream.url}/v1`);
      expect((await runtime.inspect()).status).toBe('available');
      expect((await runtime.models())[0]?.modelId).toBe('publisher/coder:Q4_K_M');
    } finally {
      await upstream.close();
    }
  });
  it('discovers installed Ollama models on an explicitly local endpoint', async () => {
    const upstream = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url === '/api/version'
          ? JSON.stringify({ version: '0.1.0' })
          : JSON.stringify({ models: [{ name: 'test:latest', size: 1234, digest: 'sha256:abc' }] }),
      );
    });
    try {
      const runtime = new OllamaRuntime(upstream.url);
      expect((await runtime.inspect()).status).toBe('available');
      expect(await runtime.models()).toMatchObject([{ modelId: 'test:latest', sizeBytes: 1234 }]);
    } finally {
      await upstream.close();
    }
  });
  it('measures installed Ollama models using provider token counters', async () => {
    let generated = false;
    const upstream = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'test:latest', size: 1234 }] }));
      } else if (req.url === '/api/generate') {
        generated = true;
        res.end(JSON.stringify({ done: true, eval_count: 20, eval_duration: 1_000_000_000 }));
      } else {
        res.end(JSON.stringify({ version: '0.1.0' }));
      }
    });
    try {
      const runtime = new OllamaRuntime(upstream.url);
      const result = await runtime.benchmark('test:latest');
      expect(generated).toBe(true);
      expect(result).toMatchObject({
        runtimeId: runtime.id,
        modelId: 'test:latest',
        tokensPerSecond: 20,
        timeToFirstTokenMs: null,
        success: true,
      });
      await expect(runtime.benchmark('absent')).rejects.toThrow('not installed');
    } finally {
      await upstream.close();
    }
  });
});

describe('authenticated loopback gateway', () => {
  it('requires its ephemeral token and never binds a public interface', async () => {
    const gateway = new AiGateway(db().driver, async () => '');
    const server = new LocalGatewayServer(gateway, 'default-policy');
    await server.start();
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect((await fetch(`${server.baseUrl}/models`)).status).toBe(401);
      const authorized = await fetch(`${server.baseUrl}/models`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toMatchObject({ object: 'list', data: [] });
      const toolsAttempt = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'model-a',
          messages: [{ role: 'user', content: 'edit a file' }],
          // Legacy function calling is not translated: refused, never guessed.
          functions: [{ name: 'write_file' }],
        }),
      });
      expect(toolsAttempt.status).toBe(501);
    } finally {
      await server.close();
    }
  });
});

describe('routing recovery', () => {
  it('loads the saved deterministic policy after a gateway restart', async () => {
    const database = db();
    const first = new AiGateway(database.driver, async () => '');
    first.configurePolicy({
      policy: {
        id: 'default-policy',
        strategy: 'priority',
        billingPolicyId: 'billing',
        privacyPolicyId: 'privacy',
        maxAttempts: 1,
        requireTools: false,
      },
      billing: {
        id: 'billing',
        allowPaid: false,
        allowUnknownCost: false,
        maxCostPerRequest: null,
        maxCostPerDay: null,
        currency: 'USD',
      },
      privacy: {
        id: 'privacy',
        mode: 'local-only',
        allowedProviderIds: [],
        allowPromptLogging: false,
      },
    });
    const restarted = new AiGateway(database.driver, async () => '');
    await expect(restarted.infer(request())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});

describe('connection validation', () => {
  it('probes a configured model without inference and enables the route only after validation', async () => {
    let inferenceCalls = 0;
    const upstream = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url === '/v1/models')
        res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
      else {
        inferenceCalls++;
        res.end(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        );
      }
    });
    try {
      const gateway = new AiGateway(db().driver, async () => '');
      gateway.saveEndpoint(endpoint(upstream.url));
      gateway.saveConnection({
        ...connection('connection-a', 'endpoint-a', 'provider-a'),
        status: 'unknown',
      });
      gateway.saveModel(model('model-a', 'provider-a'));
      gateway.saveRoute({
        id: 'route-a',
        modelId: 'model-a',
        connectionId: 'connection-a',
        priority: 0,
        enabled: true,
        localOnly: false,
      });
      const availability = await gateway.validateConnection('connection-a');
      expect(availability.state).toBe('available');
      expect(gateway.connections()[0]?.status).toBe('ready');
      expect(inferenceCalls).toBe(0);
    } finally {
      await upstream.close();
    }
  });
});
