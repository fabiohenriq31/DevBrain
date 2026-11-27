import {
  ApprovalRequestSchema,
  PermissionGrantSchema,
  type ApprovalRequest,
  type PermissionAction,
  type PermissionGrant,
} from '@devbrain/contracts';
import type { SqlDriver, SqlParams } from '../driver.js';
import { fromJson, json, notFound, validated } from './common.js';

export class ApprovalRepository {
  constructor(private readonly db: SqlDriver) {}

  save(approval: ApprovalRequest): ApprovalRequest {
    const a = validated(ApprovalRequestSchema, approval, 'approval');
    this.db.run(
      `INSERT INTO approvals (id, status, data, requested_at, expires_at, agent_id, session_id, project_id)
       VALUES (:id, :status, :data, :requestedAt, :expiresAt, :agentId, :sessionId, :projectId)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
         expires_at = excluded.expires_at`,
      {
        id: a.id,
        status: a.status,
        data: json(a),
        requestedAt: a.requestedAt,
        expiresAt: a.expiresAt,
        agentId: a.agentId,
        sessionId: a.sessionId,
        projectId: a.projectId,
      },
    );
    return a;
  }

  findById(id: string): ApprovalRequest | null {
    const row = this.db.get<{ data: string }>('SELECT data FROM approvals WHERE id = :id', { id });
    return row ? fromJson(ApprovalRequestSchema, row.data, 'approval') : null;
  }

  listByStatus(status: ApprovalRequest['status'], limit = 500): ApprovalRequest[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM approvals WHERE status = :status ORDER BY requested_at LIMIT :limit',
        { status, limit },
      )
      .map((r) => fromJson(ApprovalRequestSchema, r.data, 'approval'));
  }

  /** Pending approvals whose expiry is before `now`. */
  listExpired(now: string): ApprovalRequest[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM approvals WHERE status = 'pending' AND expires_at <= :now",
        { now },
      )
      .map((r) => fromJson(ApprovalRequestSchema, r.data, 'approval'));
  }
}

// ---------------------------------------------------------------------------

interface GrantRow {
  [k: string]: string | null;
  id: string;
  approval_id: string;
  agent_id: string;
  project_id: string | null;
  session_id: string | null;
  action: string;
  scope: string;
  target: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const toGrant = (r: GrantRow): PermissionGrant =>
  validated(
    PermissionGrantSchema,
    {
      id: r.id,
      approvalId: r.approval_id,
      agentId: r.agent_id,
      projectId: r.project_id,
      sessionId: r.session_id,
      action: r.action,
      scope: r.scope,
      target: r.target,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      revokedReason: r.revoked_reason,
    },
    'stored grant',
  );

export class GrantRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(grant: PermissionGrant): PermissionGrant {
    const g = validated(PermissionGrantSchema, grant, 'grant');
    this.db.run(
      `INSERT INTO permission_grants (id, approval_id, agent_id, project_id, session_id, action, scope,
         target, created_at, expires_at, revoked_at, revoked_reason)
       VALUES (:id, :approvalId, :agentId, :projectId, :sessionId, :action, :scope, :target,
         :createdAt, :expiresAt, :revokedAt, :revokedReason)`,
      {
        id: g.id,
        approvalId: g.approvalId,
        agentId: g.agentId,
        projectId: g.projectId,
        sessionId: g.sessionId,
        action: g.action,
        scope: g.scope,
        target: g.target,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        revokedReason: g.revokedReason,
      },
    );
    return g;
  }

  findById(id: string): PermissionGrant | null {
    const row = this.db.get<GrantRow>('SELECT * FROM permission_grants WHERE id = :id', { id });
    return row ? toGrant(row) : null;
  }

  revoke(id: string, reason: string | null, at: string): PermissionGrant {
    const { changes } = this.db.run(
      `UPDATE permission_grants SET revoked_at = :at, revoked_reason = :reason
       WHERE id = :id AND revoked_at IS NULL`,
      { id, at, reason },
    );
    const grant = this.findById(id);
    if (!grant) throw notFound('Grant', id);
    if (changes === 0 && grant.revokedAt === null) throw notFound('Grant', id);
    return grant;
  }

  /** Revokes every active grant of a session (called when the session ends). */
  revokeForSession(sessionId: string, reason: string, at: string): number {
    return this.db.run(
      `UPDATE permission_grants SET revoked_at = :at, revoked_reason = :reason
       WHERE session_id = :sessionId AND revoked_at IS NULL`,
      { sessionId, reason, at },
    ).changes;
  }

  /** Active (not revoked, not expired) grants of an agent for an action. */
  findActive(input: {
    agentId: string;
    action: PermissionAction;
    projectId: string | null;
    sessionId: string | null;
    now: string;
  }): PermissionGrant[] {
    return this.db
      .all<GrantRow>(
        `SELECT * FROM permission_grants
         WHERE agent_id = :agentId AND action = :action AND revoked_at IS NULL AND expires_at > :now
           AND ((scope = 'session' AND session_id IS :sessionId AND :sessionId IS NOT NULL)
             OR (scope = 'project' AND project_id IS :projectId AND :projectId IS NOT NULL))
         ORDER BY created_at DESC`,
        {
          agentId: input.agentId,
          action: input.action,
          projectId: input.projectId,
          sessionId: input.sessionId,
          now: input.now,
        },
      )
      .map(toGrant);
  }

  list(filter: {
    agentId?: string;
    projectId?: string;
    includeInactive: boolean;
    now: string;
  }): PermissionGrant[] {
    const where: string[] = [];
    // node:sqlite rejects named parameters the statement does not use, so `now` is bound
    // only together with the clause that references it.
    const params: SqlParams = {};
    if (filter.agentId) {
      where.push('agent_id = :agentId');
      params['agentId'] = filter.agentId;
    }
    if (filter.projectId) {
      where.push('project_id = :projectId');
      params['projectId'] = filter.projectId;
    }
    if (!filter.includeInactive) {
      where.push('revoked_at IS NULL AND expires_at > :now');
      params['now'] = filter.now;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .all<GrantRow>(
        `SELECT * FROM permission_grants ${clause} ORDER BY created_at DESC LIMIT 1000`,
        params,
      )
      .map(toGrant);
  }

  countExpiredActive(now: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM permission_grants WHERE revoked_at IS NULL AND expires_at <= :now',
      { now },
    );
    return Number(row?.n ?? 0);
  }

  markExpired(now: string): number {
    return this.db.run(
      `UPDATE permission_grants SET revoked_at = :now, revoked_reason = 'expired'
       WHERE revoked_at IS NULL AND expires_at <= :now`,
      { now },
    ).changes;
  }
}
