import { randomUUID } from 'node:crypto';
import {
  BillingPolicySchema,
  DevBrainError,
  InferenceRequestSchema,
  InferenceResultSchema,
  ModelDefinitionSchema,
  ModelAvailabilitySchema,
  ModelRouteSchema,
  PrivacyPolicySchema,
  ProviderConnectionSchema,
  ProviderEndpointSchema,
  RoutingPolicySchema,
  UsageRecordSchema,
  type BenchmarkRun,
  type BillingPolicy,
  type BudgetStatus,
  type CostState,
  type ExplainedRoutingDecision,
  type InferenceEvent,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ModelEvidence,
  type ModelAvailability,
  type ModelRoute,
  type PrivacyPolicy,
  type ProviderConnection,
  type ProviderEndpoint,
  type RoutingPolicy,
} from '@devbrain/contracts';
import type { SqlDriver } from '@devbrain/database';
import {
  BenchmarkEngine,
  buildEvidence,
  ContextOptimizer,
  IntelligenceStore,
  SUITES,
  RoutingPolicyEngine,
  type PlannedCandidate,
  type RoutingContext,
  type RoutingPlan,
} from '@devbrain/intelligence';
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

export class AiGateway {
  readonly ledger: QuotaLedger;
  private readonly active = new Map<string, AbortController>();
  private readonly routing = new Map<
    string,
    { policy: RoutingPolicy; billing: BillingPolicy; privacy: PrivacyPolicy }
  >();

  /** Two-stage explainable router + budget/quota/privacy policies (Phase 02 intelligence). */
  readonly engine: RoutingPolicyEngine;
  readonly intelligence: IntelligenceStore;

  constructor(
    private readonly db: SqlDriver,
    private readonly resolveCredential: CredentialResolver,
    private readonly protocol = new ProtocolTransport(),
    clock: () => number = Date.now,
  ) {
    this.ledger = new QuotaLedger(db, clock);
    this.engine = new RoutingPolicyEngine(this.ledger, clock);
    this.intelligence = new IntelligenceStore(db, clock);
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
    const url = new URL(endpoint.baseUrl);
    if (url.search || url.hash)
      throw new DevBrainError('VALIDATION_FAILED', 'Endpoint URL cannot contain query or fragment');
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
  async validateConnection(id: string): Promise<ModelAvailability> {
    const connection = this.connections().find((item) => item.id === id);
    if (!connection) throw new DevBrainError('NOT_FOUND', 'Connection missing');
    const endpoint = this.endpoints().find((item) => item.id === connection.endpointId);
    const route = this.routes().find((item) => item.connectionId === id);
    const model = this.models().find((item) => item.id === route?.modelId);
    if (!endpoint || !model)
      throw new DevBrainError('NOT_FOUND', 'Connection needs an endpoint and model route');
    const credential = connection.credentialId
      ? await this.resolveCredential(connection.credentialId, connection.providerId)
      : null;
    let state: 'available' | 'unavailable' | 'unknown';
    try {
      state = await this.protocol.probeModel(endpoint, model.upstreamModelId, credential);
    } catch (error) {
      if (DevBrainError.is(error) && error.code === 'CREDENTIAL_UNAVAILABLE')
        this.saveConnection({
          ...connection,
          status: 'invalid-credential',
          lastVerifiedAt: new Date().toISOString(),
        });
      throw error;
    }
    const now = new Date().toISOString();
    this.saveConnection({
      ...connection,
      status: state === 'available' ? 'ready' : 'unavailable',
      lastVerifiedAt: now,
    });
    return ModelAvailabilitySchema.parse({
      modelId: model.id,
      connectionId: id,
      state,
      observedAt: now,
      retryAt: null,
      evidence: 'provider-api',
    });
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

  private usage(
    requestId: string,
    routeId: string,
    generation: Generation,
    cost: { micros: number | null; currency: string },
  ) {
    return UsageRecordSchema.parse({
      id: `use_${randomUUID()}`,
      requestId,
      routeId,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      cost: cost.micros === null ? null : cost.micros / 1_000_000,
      currency: cost.micros === null ? null : cost.currency,
      source:
        generation.inputTokens === null && generation.outputTokens === null
          ? 'unknown'
          : 'provider',
      recordedAt: new Date().toISOString(),
    });
  }

  private routingContext(request: InferenceRequest): RoutingContext {
    const policies = this.routing.get(request.routingPolicyId);
    if (!policies) throw new DevBrainError('NOT_FOUND', 'Routing policy not configured');
    const routes = this.routes();
    const cooldowns = new Map(
      this.db
        .all<{ route_id: string; until_at: string }>('SELECT route_id, until_at FROM ai_cooldowns')
        .map((r) => [r.route_id, r.until_at] as const),
    );
    return {
      request,
      policy: policies.policy,
      billing: policies.billing,
      privacy: policies.privacy,
      // Project policy is read from the main-process store, never from the renderer.
      project: request.projectId
        ? this.intelligence.projectPolicyOrDefault(request.projectId)
        : null,
      profiles: this.intelligence.profileMap(),
      cooldowns,
      evidence: (modelId) =>
        buildEvidence(
          modelId,
          this.intelligence.benchmarkObservations(modelId),
          this.intelligence.historyObservations(
            modelId,
            routes.filter((r) => r.modelId === modelId).map((r) => r.id),
          ),
        ),
      lastModelId: this.intelligence.lastModelForSession(request.sessionId),
    };
  }

  modelEvidence(modelId: string): ModelEvidence {
    return buildEvidence(
      modelId,
      this.intelligence.benchmarkObservations(modelId),
      this.intelligence.historyObservations(
        modelId,
        this.routes()
          .filter((r) => r.modelId === modelId)
          .map((r) => r.id),
      ),
    );
  }

  /** DevBrain-enforced budget state for every configured billing policy + project/session. */
  budgetStatus(input: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
  }): BudgetStatus[] {
    const project = input.projectId
      ? this.intelligence.projectPolicyOrDefault(input.projectId)
      : null;
    const out = new Map<string, BudgetStatus>();
    for (const { billing } of this.routing.values()) {
      const ctx = { billing, project, sessionId: input.sessionId ?? null };
      for (const status of this.engine.budget.status(ctx, (scope) =>
        this.intelligence.unknownCostCount(
          scope.scope === 'project' && input.projectId
            ? { projectId: input.projectId }
            : scope.scope === 'session' && input.sessionId
              ? { sessionId: input.sessionId }
              : { since: this.ledger.windowState(scope.quotaId)?.windowStart ?? '' },
        ),
      ))
        out.set(`${status.scope}:${status.scopeId}`, status);
    }
    return [...out.values()];
  }

  /**
   * Runs a versioned suite against one route THROUGH this gateway (model pinned), so privacy,
   * budget and quota policies apply to benchmark traffic exactly as to any other request.
   */
  async runBenchmark(input: {
    suiteId: string;
    routeId: string;
    routingPolicyId: string;
    projectId?: string | undefined;
  }): Promise<BenchmarkRun> {
    const suite = SUITES.find((s) => s.id === input.suiteId);
    const route = this.routes().find((r) => r.id === input.routeId);
    const model = route && this.models().find((m) => m.id === route.modelId);
    if (!suite || !route || !model)
      throw new DevBrainError('NOT_FOUND', 'Benchmark suite or route missing');
    const run = await new BenchmarkEngine().run(
      suite,
      { routeId: route.id, modelId: model.id, upstreamModelId: model.upstreamModelId },
      async (benchCase) => {
        const started = Date.now();
        const result = await this.infer({
          id: `bench-${randomUUID()}`,
          sessionId: null,
          modelId: model.id,
          messages: benchCase.messages,
          maxOutputTokens: benchCase.maxOutputTokens,
          temperature: 0,
          stream: false,
          routingPolicyId: input.routingPolicyId,
          idempotencyKey: null,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        });
        return {
          // An answer from another route (same model, different connection) is not counted.
          content: result.routeId === route.id ? result.content : '',
          latencyMs: Date.now() - started,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          costMicros: this.intelligence.cost(result.requestId)?.reconciledMicros ?? null,
          attempts: result.attempts.length + 1,
        };
      },
    );
    this.intelligence.saveBenchmarkRun(run);
    return run;
  }

  /** Configured routing strategies with their billing and privacy policies. */
  policies() {
    return [...this.routing.values()].map((entry) => ({ ...entry }));
  }

  /**
   * True when the routing policy can only reach routes with a known zero cost (no paid and no
   * unknown-cost routes), so requests under it carry no provider charge.
   */
  freeOnly(routingPolicyId: string): boolean {
    const configured = this.routing.get(routingPolicyId);
    return !!configured && !configured.billing.allowPaid && !configured.billing.allowUnknownCost;
  }

  /** Dry run: the explained decision for a request. Reserves nothing, sends nothing. */
  explain(raw: InferenceRequest): ExplainedRoutingDecision {
    const request = InferenceRequestSchema.parse(raw);
    return this.engine.plan(this.candidates(), this.routingContext(request)).decision;
  }

  private recordCost(
    request: InferenceRequest,
    candidate: PlannedCandidate,
    currency: string,
    state: CostState,
    reconciledMicros: number | null,
  ): void {
    this.intelligence.saveCost(
      {
        requestId: request.id,
        routeId: candidate.route.id,
        currency,
        estimatedMicros: candidate.worstCaseMicros,
        reconciledMicros,
        reportedMicros: null,
        state,
        recordedAt: new Date().toISOString(),
      },
      request.projectId ?? null,
      request.sessionId,
    );
  }

  async *stream(raw: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceEvent> {
    const parsed = InferenceRequestSchema.parse(raw);
    // Apply deterministic deduplication on the live path without budget-based omission.
    // Omission needs a durable reference retrieval path before it can be enabled here.
    const optimized = new ContextOptimizer().optimize(parsed.messages, {
      budgetTokens: Number.MAX_SAFE_INTEGER,
    });
    const request = { ...parsed, messages: optimized.messages };
    if (this.db.get('SELECT request_id FROM ai_inference WHERE request_id=:id', { id: request.id }))
      throw new DevBrainError('ALREADY_EXISTS', 'Inference request already exists');
    const policies = this.routing.get(request.routingPolicyId);
    if (!policies) throw new DevBrainError('NOT_FOUND', 'Routing policy not configured');
    const all = this.candidates();
    const context = this.routingContext(request);
    const plan: RoutingPlan = this.engine.plan(all, context);
    const decision = plan.decision;
    this.intelligence.saveDecision(decision);
    const candidates = plan.ordered;
    const currency = this.engine.budget.currency({
      billing: context.billing,
      project: context.project,
      sessionId: request.sessionId,
    });
    if (!candidates.length)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'No eligible model route', {
        details: { excluded: decision.excluded.length },
      });
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
      for (const planned of candidates) {
        if (attempts >= policies.policy.maxAttempts) break;
        if (controller.signal.aborted)
          throw new DevBrainError(
            timedOut ? 'TIMEOUT' : 'CANCELLED',
            timedOut ? 'Inference deadline exceeded' : 'Inference cancelled',
          );
        // Every attempt (first and each fallback) is re-checked against CURRENT policy, quota,
        // budget, cooldown and privacy state: an earlier failure or a concurrent request may
        // have changed eligibility since the plan was made.
        const recheck = this.engine.plan(
          all.filter((c) => c.route.id === planned.route.id),
          this.routingContext(request),
        );
        const candidate = recheck.ordered[0];
        if (!candidate) {
          decision.excluded.push(
            ...recheck.decision.excluded.map((e) => ({
              routeId: e.routeId,
              reasons: e.reasons.map((r) => ({
                code: r.code,
                message: `re-check before attempt: ${r.message}`.slice(0, 500),
              })),
            })),
          );
          this.intelligence.saveDecision(decision);
          continue;
        }
        let reservations: ReturnType<QuotaLedger['reserveAll']> = [];
        try {
          // Provider quotas + DevBrain money ceilings in ONE transaction (race-safe).
          reservations = this.ledger.reserveAll(request.id, candidate.demands);
        } catch (error) {
          if (!DevBrainError.is(error) || error.code !== 'QUOTA_EXCEEDED') throw error;
          // Lost a race for the last quota/budget unit: nothing was dispatched, no cooldown.
          decision.excluded.push({
            routeId: candidate.route.id,
            reasons: [{ code: 'quota-exhausted', message: 'reservation refused at admission' }],
          });
          this.intelligence.saveDecision(decision);
          continue;
        }
        attempts++;
        const startedAt = new Date().toISOString();
        const budgetIds = new Set(candidate.budgetQuotaIds);
        let dispatched = false;
        try {
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
              } else if (part.type === 'tool-call-delta') {
                // A streamed call fragment is output: no silent fallback past this point.
                exposed = true;
                yield {
                  type: 'tool-call-delta',
                  requestId: request.id,
                  seq: seq++,
                  index: part.index,
                  id: part.id,
                  name: part.name,
                  argumentsDelta: part.argumentsDelta,
                };
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
          if (generation.quotaHeaders)
            this.ledger.observeResponseHeaders(
              candidate.demands.map((demand) => demand.quotaId),
              generation.quotaHeaders,
            );
          const definitions = new Map(this.ledger.definitions().map((d) => [d.id, d]));
          const costMicros = this.engine.budget.measured(candidate.model, candidate.local, {
            inputTokens: generation.inputTokens,
            outputTokens: generation.outputTokens,
          });
          for (const reservation of reservations) {
            const unit = definitions.get(reservation.quotaId)?.unit;
            const measured = budgetIds.has(reservation.quotaId)
              ? costMicros
              : unit === 'requests'
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
          const usage = this.usage(request.id, candidate.route.id, generation, {
            micros: costMicros,
            currency,
          });
          this.ledger.saveUsage(usage);
          this.recordCost(
            request,
            candidate,
            currency,
            candidate.costState === 'free'
              ? 'free'
              : costMicros === null
                ? 'unknown'
                : 'reconciled',
            costMicros,
          );
          const result = InferenceResultSchema.parse({
            requestId: request.id,
            routeId: candidate.route.id,
            modelId: candidate.model.id,
            content: generation.content,
            finishReason: generation.finishReason,
            usage,
            attempts: this.attempts(request.id),
            completedAt: new Date().toISOString(),
            ...(generation.toolCalls?.length ? { toolCalls: generation.toolCalls } : {}),
          });
          // Persist metadata only. Full prompt/output stay in the live response, not SQLite.
          this.db.run(
            "UPDATE ai_inference SET route_id=:route,model_id=:model,status='completed',result=:result,updated_at=:at WHERE request_id=:id",
            {
              route: candidate.route.id,
              model: candidate.model.id,
              // Tool arguments are model output (may embed code/data): only names are kept.
              result: JSON.stringify({
                ...result,
                content: '',
                toolCalls: result.toolCalls?.map((c) => ({
                  id: c.id,
                  name: c.name,
                  arguments: '',
                })),
              }),
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
          // A dispatched call that failed may still be billed: its worst case stays committed.
          if (dispatched && candidate.costState !== 'free')
            this.recordCost(request, candidate, currency, 'unknown', null);
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
          // Rate/quota signals cool down every route of the provider: other keys or
          // connections of the same provider are not independent capacity.
          const cooled =
            code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED'
              ? this.engine.quota.sharedCooldownRoutes(candidate, all)
              : [candidate.route.id];
          if (retryable)
            for (const routeId of cooled)
              this.db.run(
                'INSERT INTO ai_cooldowns (route_id,until_at,failures) VALUES (:id,:until,1) ON CONFLICT(route_id) DO UPDATE SET until_at=excluded.until_at,failures=failures+1',
                {
                  id: routeId,
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
