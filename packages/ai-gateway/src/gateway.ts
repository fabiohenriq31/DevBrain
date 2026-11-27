import { randomUUID } from 'node:crypto';
import {
  BillingPolicySchema,
  DevBrainError,
  InferenceRequestSchema,
  InferenceResultSchema,
  ModelDefinitionSchema,
  ModelRouteSchema,
  PrivacyPolicySchema,
  ProviderConnectionSchema,
  ProviderEndpointSchema,
  RoutingPolicySchema,
  UsageRecordSchema,
  type BillingPolicy,
  type InferenceEvent,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ModelRoute,
  type PrivacyPolicy,
  type ProviderConnection,
  type ProviderEndpoint,
  type RoutingPolicy,
} from '@devbrain/contracts';
import type { SqlDriver } from '@devbrain/database';
import { QuotaLedger } from './ledger.js';
import { ProtocolTransport, type Generation } from './protocols.js';

type Stored = { data: string };
type Candidate = {
  route: ModelRoute;
  model: ModelDefinition;
  connection: ProviderConnection;
  endpoint: ProviderEndpoint;
};
type CredentialResolver = (id: string, providerId: string) => Promise<string>;

const read = <T>(db: SqlDriver, table: string, schema: { parse(value: unknown): T }): T[] =>
  db.all<Stored>(`SELECT data FROM ${table}`).map((row) => schema.parse(JSON.parse(row.data)));

const save = (db: SqlDriver, table: string, value: { id: string }): void => {
  db.run(
    `INSERT INTO ${table} (id,data,updated_at) VALUES (:id,:data,:at) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
    { id: value.id, data: JSON.stringify(value), at: new Date().toISOString() },
  );
};

/** Deterministic routing policy placeholder; Claude may replace this single selection point. */
export class DeterministicRouter {
  select(
    candidates: Candidate[],
    request: InferenceRequest,
    policy: RoutingPolicy,
    billing: BillingPolicy,
    privacy: PrivacyPolicy,
  ): Candidate[] {
    const eligible = candidates.filter(({ route, model, connection, endpoint }) => {
      if (!route.enabled || !connection.enabled || connection.status === 'disabled') return false;
      if (request.modelId && model.id !== request.modelId) return false;
      if (policy.requireTools && !model.capabilities.tools) return false;
      if (!model.capabilities.input.includes('text') || !model.capabilities.output.includes('text'))
        return false;
      const hostname = new URL(endpoint.baseUrl).hostname.toLowerCase();
      const local = route.localOnly && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
      if (privacy.mode === 'local-only' && !local) return false;
      if (
        privacy.mode === 'approved-providers' &&
        !local &&
        !privacy.allowedProviderIds.includes(endpoint.providerId)
      )
        return false;
      const pricing = model.pricing;
      if (
        !local &&
        (!pricing ||
          !pricing.verifiedAt ||
          pricing.inputPerMillion === null ||
          pricing.outputPerMillion === null)
      )
        return (
          billing.allowPaid &&
          billing.allowUnknownCost &&
          billing.maxCostPerRequest === null &&
          billing.maxCostPerDay === null
        );
      if (
        !local &&
        !billing.allowPaid &&
        ((pricing?.inputPerMillion ?? 0) > 0 || (pricing?.outputPerMillion ?? 0) > 0)
      )
        return false;
      // This gateway does not yet enforce a monetary ledger. A configured ceiling
      // must therefore fail closed for any potentially paid route.
      if (
        !local &&
        (billing.maxCostPerRequest !== null || billing.maxCostPerDay !== null) &&
        ((pricing?.inputPerMillion ?? 0) > 0 || (pricing?.outputPerMillion ?? 0) > 0)
      )
        return false;
      return true;
    });
    return eligible.sort((a, b) => {
      if (policy.strategy === 'local-first' && a.route.localOnly !== b.route.localOnly)
        return a.route.localOnly ? -1 : 1;
      if (policy.strategy === 'lowest-known-cost') {
        const cost = (candidate: Candidate) =>
          (candidate.model.pricing?.inputPerMillion ?? Infinity) +
          (candidate.model.pricing?.outputPerMillion ?? Infinity);
        if (cost(a) !== cost(b)) return cost(a) - cost(b);
      }
      return a.route.priority - b.route.priority || a.route.id.localeCompare(b.route.id);
    });
  }
}

export class AiGateway {
  readonly ledger: QuotaLedger;
  private readonly active = new Map<string, AbortController>();
  private readonly routing = new Map<
    string,
    { policy: RoutingPolicy; billing: BillingPolicy; privacy: PrivacyPolicy }
  >();

  constructor(
    private readonly db: SqlDriver,
    private readonly resolveCredential: CredentialResolver,
    private readonly protocol = new ProtocolTransport(),
    private readonly router = new DeterministicRouter(),
  ) {
    this.ledger = new QuotaLedger(db);
    this.ledger.recover();
    for (const row of db.all<{ data: string }>('SELECT data FROM ai_routing_policies')) {
      const stored = JSON.parse(row.data) as Record<string, unknown>;
      const policy = RoutingPolicySchema.parse(stored.policy);
      const billing = BillingPolicySchema.parse(stored.billing);
      const privacy = PrivacyPolicySchema.parse(stored.privacy);
      this.routing.set(policy.id, { policy, billing, privacy });
    }
    db.run("UPDATE ai_inference SET status='interrupted',updated_at=:at WHERE status='running'", {
      at: new Date().toISOString(),
    });
  }

  configurePolicy(input: {
    policy: RoutingPolicy;
    billing: BillingPolicy;
    privacy: PrivacyPolicy;
  }): void {
    const policy = RoutingPolicySchema.parse(input.policy);
    const billing = BillingPolicySchema.parse(input.billing);
    const privacy = PrivacyPolicySchema.parse(input.privacy);
    if (policy.billingPolicyId !== billing.id || policy.privacyPolicyId !== privacy.id)
      throw new DevBrainError('VALIDATION_FAILED', 'Routing policy references a different policy');
    this.db.run(
      'INSERT INTO ai_routing_policies (id,data,updated_at) VALUES (:id,:data,:at) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      {
        id: policy.id,
        data: JSON.stringify({ policy, billing, privacy }),
        at: new Date().toISOString(),
      },
    );
    this.routing.set(policy.id, { policy, billing, privacy });
  }

  saveEndpoint(input: ProviderEndpoint): void {
    const endpoint = ProviderEndpointSchema.parse(input);
    const previous = this.endpoints().find((e) => e.id === endpoint.id);
    if (previous && previous.baseUrl !== endpoint.baseUrl)
      throw new DevBrainError(
        'CONFLICT',
        'Endpoint change requires a new endpoint and credential validation',
      );
    save(this.db, 'ai_endpoints', endpoint);
  }
  endpoints(): ProviderEndpoint[] {
    return read(this.db, 'ai_endpoints', ProviderEndpointSchema);
  }

  saveConnection(input: ProviderConnection): void {
    const connection = ProviderConnectionSchema.parse(input);
    const endpoint = this.endpoints().find((e) => e.id === connection.endpointId);
    if (!endpoint || endpoint.providerId !== connection.providerId)
      throw new DevBrainError('VALIDATION_FAILED', 'Connection endpoint/provider mismatch');
    const previous = this.connections().find((c) => c.id === connection.id);
    if (
      previous &&
      (previous.endpointId !== connection.endpointId ||
        previous.credentialId !== connection.credentialId)
    ) {
      if (connection.status === 'ready')
        throw new DevBrainError(
          'VALIDATION_FAILED',
          'Changed credentials or endpoint require revalidation',
        );
    }
    save(this.db, 'ai_connections', connection);
  }
  connections(): ProviderConnection[] {
    return read(this.db, 'ai_connections', ProviderConnectionSchema);
  }
  removeConnection(id: string): void {
    if (this.routes().some((r) => r.connectionId === id))
      throw new DevBrainError('CONFLICT', 'Connection is used by a route');
    this.db.run('DELETE FROM ai_connections WHERE id=:id', { id });
  }

  saveModel(input: ModelDefinition): void {
    save(this.db, 'ai_models', ModelDefinitionSchema.parse(input));
  }
  models(): ModelDefinition[] {
    return read(this.db, 'ai_models', ModelDefinitionSchema);
  }
  saveRoute(input: ModelRoute): void {
    const route = ModelRouteSchema.parse(input);
    const connection = this.connections().find((c) => c.id === route.connectionId);
    const endpoint = connection && this.endpoints().find((e) => e.id === connection.endpointId);
    if (
      route.localOnly &&
      (!endpoint ||
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(endpoint.baseUrl).hostname.toLowerCase(),
        ))
    )
      throw new DevBrainError('VALIDATION_FAILED', 'Local route must target loopback');
    if (
      !this.models().some((m) => m.id === route.modelId) ||
      !this.connections().some((c) => c.id === route.connectionId)
    )
      throw new DevBrainError('NOT_FOUND', 'Route model or connection missing');
    save(this.db, 'ai_routes', route);
  }
  routes(): ModelRoute[] {
    return read(this.db, 'ai_routes', ModelRouteSchema);
  }

  private candidates(): Candidate[] {
    const models = new Map(this.models().map((m) => [m.id, m]));
    const connections = new Map(this.connections().map((c) => [c.id, c]));
    const endpoints = new Map(this.endpoints().map((e) => [e.id, e]));
    return this.routes().flatMap((route) => {
      const model = models.get(route.modelId),
        connection = connections.get(route.connectionId);
      const endpoint = connection && endpoints.get(connection.endpointId);
      return model && connection && endpoint && model.providerId === connection.providerId
        ? [{ route, model, connection, endpoint }]
        : [];
    });
  }

  cancel(id: string): boolean {
    const active = this.active.get(id);
    if (!active) return false;
    active.abort();
    return true;
  }

  /** Fire-and-report entry point for IPC. Failures are emitted, never unhandled. */
  submit(request: InferenceRequest, onEvent: (event: InferenceEvent) => void): string {
    const parsed = InferenceRequestSchema.parse(request);
    void (async () => {
      let seq = 0;
      try {
        for await (const event of this.stream(parsed)) {
          seq = event.seq + 1;
          onEvent(event);
        }
      } catch (error) {
        const code = DevBrainError.is(error) ? error.code : 'PROVIDER_UNAVAILABLE';
        onEvent({
          type: 'failed',
          requestId: parsed.id,
          seq,
          error: {
            code:
              code === 'CANCELLED'
                ? 'CANCELLED'
                : code === 'TIMEOUT'
                  ? 'TIMEOUT'
                  : code === 'RATE_LIMITED'
                    ? 'RATE_LIMITED'
                    : code === 'QUOTA_EXCEEDED'
                      ? 'QUOTA_EXCEEDED'
                      : code === 'CREDENTIAL_UNAVAILABLE'
                        ? 'AUTHENTICATION'
                        : 'UNKNOWN',
            message: DevBrainError.is(error) ? error.message : 'Inference failed',
            retryable: DevBrainError.is(error) ? error.retryable : false,
            retryAt: null,
            providerStatus: null,
          },
        });
      }
    })();
    return parsed.id;
  }

  result(id: string): InferenceResult | null {
    const row = this.db.get<{ result: string | null }>(
      'SELECT result FROM ai_inference WHERE request_id=:id',
      { id },
    );
    return row?.result ? InferenceResultSchema.parse(JSON.parse(row.result)) : null;
  }

  private quotaDemands(
    candidate: Candidate,
    request: InferenceRequest,
  ): { quotaId: string; amount: number }[] {
    const scopes = new Set([
      candidate.model.id,
      candidate.connection.id,
      candidate.connection.providerId,
      candidate.endpoint.id,
      candidate.connection.credentialId,
    ]);
    return this.ledger
      .definitions()
      .filter((d) => scopes.has(d.scopeId))
      .map((d) => ({
        quotaId: d.id,
        amount:
          d.unit === 'requests'
            ? 1
            : d.unit === 'output-tokens' || d.unit === 'total-tokens'
              ? (request.maxOutputTokens ?? 0)
              : 0,
      }));
  }

  private usage(requestId: string, routeId: string, generation: Generation) {
    return UsageRecordSchema.parse({
      id: `use_${randomUUID()}`,
      requestId,
      routeId,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      cost: null,
      currency: null,
      source:
        generation.inputTokens === null && generation.outputTokens === null
          ? 'unknown'
          : 'provider',
      recordedAt: new Date().toISOString(),
    });
  }

  async *stream(raw: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceEvent> {
    const request = InferenceRequestSchema.parse(raw);
    if (this.db.get('SELECT request_id FROM ai_inference WHERE request_id=:id', { id: request.id }))
      throw new DevBrainError('ALREADY_EXISTS', 'Inference request already exists');
    const policies = this.routing.get(request.routingPolicyId);
    if (!policies) throw new DevBrainError('NOT_FOUND', 'Routing policy not configured');
    const candidates = this.router.select(
      this.candidates(),
      request,
      policies.policy,
      policies.billing,
      policies.privacy,
    );
    if (!candidates.length)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'No eligible model route');
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.deadlineMs ?? 120_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(request.id, controller);
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO ai_inference (request_id,status,created_at,updated_at) VALUES (:id,'running',:at,:at)",
      { id: request.id, at: now },
    );
    let seq = 0,
      attempts = 0,
      exposed = false;
    try {
      for (const candidate of candidates) {
        if (attempts >= policies.policy.maxAttempts) break;
        if (controller.signal.aborted)
          throw new DevBrainError(
            timedOut ? 'TIMEOUT' : 'CANCELLED',
            timedOut ? 'Inference deadline exceeded' : 'Inference cancelled',
          );
        const cooldown = this.db.get<{ until_at: string }>(
          'SELECT until_at FROM ai_cooldowns WHERE route_id=:id',
          { id: candidate.route.id },
        );
        if (cooldown && cooldown.until_at > new Date().toISOString()) continue;
        attempts++;
        const startedAt = new Date().toISOString();
        let reservations: ReturnType<QuotaLedger['reserveAll']> = [];
        let dispatched = false;
        try {
          reservations = this.ledger.reserveAll(request.id, this.quotaDemands(candidate, request));
          const credential = candidate.connection.credentialId
            ? await this.resolveCredential(
                candidate.connection.credentialId,
                candidate.connection.providerId,
              )
            : null;
          if (!dispatched) {
            dispatched = true;
            yield {
              type: 'started',
              requestId: request.id,
              seq: seq++,
              routeId: candidate.route.id,
            };
          }
          let generation: Generation | null = null;
          if (request.stream) {
            for await (const part of this.protocol.stream(
              candidate.endpoint,
              request,
              candidate.model.upstreamModelId,
              credential,
              controller.signal,
            )) {
              if (part.type === 'delta') {
                exposed = true;
                yield { type: 'delta', requestId: request.id, seq: seq++, text: part.text };
              } else generation = part.generation;
            }
          } else {
            generation = await this.protocol.generate(
              candidate.endpoint,
              request,
              candidate.model.upstreamModelId,
              credential,
              controller.signal,
            );
            if (generation.content) {
              exposed = true;
              yield { type: 'delta', requestId: request.id, seq: seq++, text: generation.content };
            }
          }
          if (!generation)
            throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Inference ended without a result');
          const definitions = new Map(this.ledger.definitions().map((d) => [d.id, d]));
          for (const reservation of reservations) {
            const unit = definitions.get(reservation.quotaId)?.unit;
            const measured =
              unit === 'requests'
                ? 1
                : unit === 'input-tokens'
                  ? generation.inputTokens
                  : unit === 'output-tokens'
                    ? generation.outputTokens
                    : unit === 'total-tokens' &&
                        generation.inputTokens !== null &&
                        generation.outputTokens !== null
                      ? generation.inputTokens + generation.outputTokens
                      : null;
            this.ledger.reconcile(reservation.id, measured);
          }
          const usage = this.usage(request.id, candidate.route.id, generation);
          this.ledger.saveUsage(usage);
          const result = InferenceResultSchema.parse({
            requestId: request.id,
            routeId: candidate.route.id,
            modelId: candidate.model.id,
            content: generation.content,
            finishReason: generation.finishReason,
            usage,
            attempts: this.attempts(request.id),
            completedAt: new Date().toISOString(),
          });
          // Persist metadata only. Full prompt/output stay in the live response, not SQLite.
          this.db.run(
            "UPDATE ai_inference SET route_id=:route,model_id=:model,status='completed',result=:result,updated_at=:at WHERE request_id=:id",
            {
              route: candidate.route.id,
              model: candidate.model.id,
              result: JSON.stringify({ ...result, content: '' }),
              at: result.completedAt,
              id: request.id,
            },
          );
          this.db.run('DELETE FROM ai_cooldowns WHERE route_id=:id', { id: candidate.route.id });
          yield { type: 'completed', requestId: request.id, seq: seq++, result };
          return;
        } catch (error) {
          for (const reservation of reservations) {
            if (dispatched) this.ledger.reconcile(reservation.id, null);
            else this.ledger.releaseUndispatched(reservation.id);
          }
          if (timedOut) throw new DevBrainError('TIMEOUT', 'Inference deadline exceeded');
          const code = DevBrainError.is(error) ? error.code : 'PROVIDER_UNAVAILABLE';
          const retryable = [
            'RATE_LIMITED',
            'QUOTA_EXCEEDED',
            'PROVIDER_UNAVAILABLE',
            'TIMEOUT',
          ].includes(code);
          this.db.run(
            'INSERT INTO ai_attempts (request_id,seq,route_id,data) VALUES (:request,:seq,:route,:data)',
            {
              request: request.id,
              seq: attempts,
              route: candidate.route.id,
              data: JSON.stringify({
                routeId: candidate.route.id,
                startedAt,
                endedAt: new Date().toISOString(),
                error: {
                  code:
                    code === 'CREDENTIAL_UNAVAILABLE'
                      ? 'AUTHENTICATION'
                      : code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED' || code === 'TIMEOUT'
                        ? code
                        : 'PROVIDER_UNAVAILABLE',
                  message: DevBrainError.is(error) ? error.message : 'Provider unavailable',
                  retryable,
                  retryAt: null,
                  providerStatus: null,
                },
              }),
            },
          );
          const priorFailures = this.db.get<{ failures: number }>(
            'SELECT failures FROM ai_cooldowns WHERE route_id=:id',
            { id: candidate.route.id },
          );
          const exp = Math.min(Number(priorFailures?.failures ?? 0) + 1, 8);
          const hinted =
            DevBrainError.is(error) && typeof error.details?.retryAfterMs === 'number'
              ? error.details.retryAfterMs
              : 0;
          const backoffMs = Math.max(
            hinted,
            Math.min(60_000, 500 * 2 ** exp) + Math.floor(Math.random() * 250),
          );
          if (retryable)
            this.db.run(
              'INSERT INTO ai_cooldowns (route_id,until_at,failures) VALUES (:id,:until,1) ON CONFLICT(route_id) DO UPDATE SET until_at=excluded.until_at,failures=failures+1',
              {
                id: candidate.route.id,
                until: new Date(Date.now() + backoffMs).toISOString(),
              },
            );
          if (!retryable || exposed || attempts >= policies.policy.maxAttempts) throw error;
        }
      }
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'No eligible route remains');
    } catch (error) {
      const code = DevBrainError.is(error) ? error.code : 'PROVIDER_UNAVAILABLE';
      this.db.run('UPDATE ai_inference SET status=:status,updated_at=:at WHERE request_id=:id', {
        status: code === 'CANCELLED' ? 'cancelled' : 'failed',
        at: new Date().toISOString(),
        id: request.id,
      });
      throw error;
    } finally {
      clearTimeout(deadline);
      this.active.delete(request.id);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  attempts(requestId: string) {
    return this.db
      .all<Stored>('SELECT data FROM ai_attempts WHERE request_id=:id ORDER BY seq', {
        id: requestId,
      })
      .map((r) => JSON.parse(r.data) as InferenceResult['attempts'][number]);
  }

  async infer(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
    for await (const event of this.stream(request, signal))
      if (event.type === 'completed') return event.result;
    throw new DevBrainError('INTERNAL', 'Inference ended without result');
  }
}
