import {
  BenchmarkRunSchema,
  CostRecordSchema,
  ExplainedRoutingDecisionSchema,
  ProjectAiPolicySchema,
  ProviderPrivacyProfileSchema,
  type BenchmarkRun,
  type CostRecord,
  type ExplainedRoutingDecision,
  type ProjectAiPolicy,
  type ProviderPrivacyProfile,
} from '@devbrain/contracts';
import type { SqlDriver } from '@devbrain/database';
import type { Observations } from './scoring.js';

/**
 * Main-process persistence for intelligence (migration 004). The renderer never decides
 * eligibility: it reads/writes these through validated IPC and the gateway reads them before
 * every inference. Nothing here stores prompts, outputs or secrets.
 */
export class IntelligenceStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  projectPolicy(projectId: string): ProjectAiPolicy | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM ai_project_policies WHERE project_id=:id',
      { id: projectId },
    );
    return row ? ProjectAiPolicySchema.parse(JSON.parse(row.data)) : null;
  }

  /** Never-configured projects get the conservative default (personal-private, no paid). */
  projectPolicyOrDefault(projectId: string): ProjectAiPolicy {
    return (
      this.projectPolicy(projectId) ??
      ProjectAiPolicySchema.parse({ projectId, updatedAt: this.now() })
    );
  }

  saveProjectPolicy(input: Omit<ProjectAiPolicy, 'updatedAt'>): ProjectAiPolicy {
    const policy = ProjectAiPolicySchema.parse({ ...input, updatedAt: this.now() });
    this.db.run(
      'INSERT INTO ai_project_policies (project_id,data,updated_at) VALUES (:id,:data,:at) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      { id: policy.projectId, data: JSON.stringify(policy), at: policy.updatedAt },
    );
    return policy;
  }

  privacyProfiles(): ProviderPrivacyProfile[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM ai_privacy_profiles ORDER BY provider_id')
      .map((r) => ProviderPrivacyProfileSchema.parse(JSON.parse(r.data)));
  }

  profileMap(): Map<string, ProviderPrivacyProfile> {
    return new Map(this.privacyProfiles().map((p) => [p.providerId, p]));
  }

  /** Facts are user-verified: saving stamps verifiedAt/verifiedBy, unless every fact is unknown. */
  savePrivacyProfile(input: ProviderPrivacyProfile): ProviderPrivacyProfile {
    const parsed = ProviderPrivacyProfileSchema.parse(input);
    const profile = ProviderPrivacyProfileSchema.parse({
      ...parsed,
      verifiedAt: this.now(),
      verifiedBy: 'user',
    });
    this.db.run(
      'INSERT INTO ai_privacy_profiles (provider_id,data,updated_at) VALUES (:id,:data,:at) ON CONFLICT(provider_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      { id: profile.providerId, data: JSON.stringify(profile), at: this.now() },
    );
    return profile;
  }

  saveDecision(decision: ExplainedRoutingDecision): void {
    const parsed = ExplainedRoutingDecisionSchema.parse(decision);
    this.db.run(
      'INSERT INTO ai_routing_decisions (request_id,data,decided_at) VALUES (:id,:data,:at) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data,decided_at=excluded.decided_at',
      { id: parsed.requestId, data: JSON.stringify(parsed), at: parsed.decidedAt },
    );
  }

  decision(requestId: string): ExplainedRoutingDecision | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM ai_routing_decisions WHERE request_id=:id',
      { id: requestId },
    );
    return row ? ExplainedRoutingDecisionSchema.parse(JSON.parse(row.data)) : null;
  }

  saveCost(record: CostRecord, projectId: string | null, sessionId: string | null): void {
    const parsed = CostRecordSchema.parse(record);
    this.db.run(
      'INSERT INTO ai_cost_records (request_id,route_id,project_id,session_id,currency,state,data,recorded_at) VALUES (:request,:route,:project,:session,:currency,:state,:data,:at) ON CONFLICT(request_id,route_id) DO UPDATE SET state=excluded.state,data=excluded.data,recorded_at=excluded.recorded_at',
      {
        request: parsed.requestId,
        route: parsed.routeId,
        project: projectId,
        session: sessionId,
        currency: parsed.currency,
        state: parsed.state,
        data: JSON.stringify(parsed),
        at: parsed.recordedAt,
      },
    );
  }

  /** Latest cost record of a request (the attempt that produced the answer, or the last one). */
  cost(requestId: string): CostRecord | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM ai_cost_records WHERE request_id=:id ORDER BY recorded_at DESC LIMIT 1',
      { id: requestId },
    );
    return row ? CostRecordSchema.parse(JSON.parse(row.data)) : null;
  }

  unknownCostCount(filter: { projectId?: string; sessionId?: string; since?: string }): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ai_cost_records WHERE state='unknown'${filter.projectId ? ' AND project_id=:project' : ''}${filter.sessionId ? ' AND session_id=:session' : ''}${filter.since ? ' AND recorded_at>=:since' : ''}`,
      {
        ...(filter.projectId ? { project: filter.projectId } : {}),
        ...(filter.sessionId ? { session: filter.sessionId } : {}),
        ...(filter.since ? { since: filter.since } : {}),
      },
    );
    return Number(row?.n ?? 0);
  }

  saveBenchmarkRun(run: BenchmarkRun): void {
    const parsed = BenchmarkRunSchema.parse(run);
    this.db.run(
      'INSERT INTO ai_benchmark_runs (id,suite_id,suite_version,route_id,model_id,data,finished_at) VALUES (:id,:suite,:version,:route,:model,:data,:at)',
      {
        id: parsed.id,
        suite: parsed.suiteId,
        version: parsed.suiteVersion,
        route: parsed.routeId,
        model: parsed.modelId,
        data: JSON.stringify(parsed),
        at: parsed.finishedAt,
      },
    );
  }

  benchmarkRuns(modelId?: string): BenchmarkRun[] {
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM ai_benchmark_runs${modelId ? ' WHERE model_id=:model' : ''} ORDER BY finished_at`,
        modelId ? { model: modelId } : {},
      )
      .map((r) => BenchmarkRunSchema.parse(JSON.parse(r.data)));
  }

  benchmarkObservations(modelId: string): Observations | null {
    const runs = this.benchmarkRuns(modelId);
    if (!runs.length) return null;
    const results = runs.flatMap((r) => r.results);
    return {
      samples: results.length,
      successes: results.filter((r) => r.passed).length,
      latenciesMs: results.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs])),
      suiteVersions: [...new Set(runs.map((r) => `${r.suiteId}@${r.suiteVersion}`))],
    };
  }

  /**
   * Production history (migration 003): completed inferences count as successes for their
   * model, failed attempts as failures for the route's model. This measures availability and
   * protocol success — NOT answer quality — and is labelled `history` for that reason.
   */
  historyObservations(modelId: string, routeIds: readonly string[]): Observations | null {
    const done = this.db.all<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM ai_inference WHERE model_id=:model AND status='completed' ORDER BY updated_at DESC LIMIT 500",
      { model: modelId },
    );
    let failures = 0;
    for (const route of routeIds)
      failures += Number(
        this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_attempts WHERE route_id=:route', {
          route,
        })?.n ?? 0,
      );
    const samples = done.length + failures;
    if (!samples) return null;
    return {
      samples,
      successes: done.length,
      latenciesMs: done.map((r) =>
        Math.max(0, Date.parse(r.updated_at) - Date.parse(r.created_at)),
      ),
    };
  }

  lastModelForSession(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const row = this.db.get<{ model_id: string | null }>(
      "SELECT i.model_id FROM ai_inference i JOIN ai_cost_records c ON c.request_id=i.request_id WHERE c.session_id=:session AND i.status='completed' ORDER BY i.updated_at DESC LIMIT 1",
      { session: sessionId },
    );
    return row?.model_id ?? null;
  }
}
