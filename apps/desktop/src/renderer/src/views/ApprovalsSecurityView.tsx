import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALWAYS_ASK_ACTIONS,
  PermissionActionSchema,
  type Agent,
  type ApprovalRequest,
  type AuditEvent,
  type PermissionAction,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionPolicy,
  type PermissionRule,
  type Project,
  type Workspace,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  Tabs,
  tokens,
} from '@devbrain/ui';
import { CheckCircle2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { ApprovalDecisionCard, type ApprovalDecisionHandler } from '../components/ApprovalModal';
import { describeError, invoke } from '../lib/bridge';
import { formatPermissionAction, formatTimestamp, type AppLanguage } from '../lib/i18n';

export interface ApprovalsSecurityViewProps {
  pendingApprovals: readonly ApprovalRequest[];
  agents: readonly Agent[];
  projects: readonly Project[];
  policies: readonly PermissionPolicy[];
  activeProjectId: string | null;
  onDecideApproval: ApprovalDecisionHandler;
  onRefreshPolicies: () => Promise<void>;
  language: AppLanguage;
}

const ALL_ACTIONS = PermissionActionSchema.options;

export const ApprovalsSecurityView = ({
  pendingApprovals,
  agents,
  projects,
  policies,
  activeProjectId,
  onDecideApproval,
  onRefreshPolicies,
  language,
}: ApprovalsSecurityViewProps) => {
  const pt = language === 'pt-BR';
  const [tab, setTab] = useState<'pending' | 'grants' | 'history' | 'policies'>('pending');
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [onlySecurityAudit, setOnlySecurityAudit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'danger' | 'success'; text: string } | null>(
    null,
  );

  // Policy editor state
  const [selectedPolicyId, setSelectedPolicyId] = useState<string>(policies[0]?.id ?? '');
  const selectedPolicy = useMemo(
    () => policies.find((p) => p.id === selectedPolicyId) ?? policies[0] ?? null,
    [policies, selectedPolicyId],
  );
  const [polName, setPolName] = useState('');
  const [polDefault, setPolDefault] = useState<PermissionDecision>('ask');
  const [polMaxConcurrent, setPolMaxConcurrent] = useState('2');
  const [polMaxMinutes, setPolMaxMinutes] = useState('30');
  const [polMaxOutputMb, setPolMaxOutputMb] = useState('16');
  const [polRules, setPolRules] = useState<PermissionRule[]>([]);

  // New rule inputs
  const [ruleAction, setRuleAction] = useState<PermissionAction>('fs.write');
  const [ruleDecision, setRuleDecision] = useState<PermissionDecision>('ask');
  const [rulePaths, setRulePaths] = useState('');
  const [ruleExecs, setRuleExecs] = useState('');

  // Permission dry-run evaluator
  const [evalAgentId, setEvalAgentId] = useState<string>(agents[0]?.id ?? '');
  const [evalWorkspaces, setEvalWorkspaces] = useState<Workspace[]>([]);
  const [evalWorkspaceId, setEvalWorkspaceId] = useState<string>('');
  const [evalAction, setEvalAction] = useState<PermissionAction>('fs.read');
  const [evalPath, setEvalPath] = useState('src/index.ts');
  const [evalExec, setEvalExec] = useState('');
  const [evalVerdict, setEvalVerdict] = useState<{
    decision: 'allow' | 'ask' | 'deny';
    reason: string;
  } | null>(null);

  useEffect(() => {
    if (selectedPolicy) {
      setPolName(selectedPolicy.name);
      setPolDefault(selectedPolicy.defaultDecision);
      setPolMaxConcurrent(String(selectedPolicy.limits.maxConcurrentExecutions));
      setPolMaxMinutes(
        String(Math.max(1, Math.round(selectedPolicy.limits.maxExecutionMs / 60_000))),
      );
      setPolMaxOutputMb(
        String(Math.max(1, Math.round(selectedPolicy.limits.maxOutputBytes / (1024 * 1024)))),
      );
      setPolRules(selectedPolicy.rules);
    }
  }, [selectedPolicy]);

  useEffect(() => {
    if (!evalAgentId && agents[0]) setEvalAgentId(agents[0].id);
  }, [agents, evalAgentId]);

  useEffect(() => {
    const projId = activeProjectId ?? projects.find((p) => !p.archivedAt)?.id;
    if (!projId) {
      setEvalWorkspaces([]);
      setEvalWorkspaceId('');
      return;
    }
    void invoke('workspaces.list', { projectId: projId })
      .then((ws) => {
        setEvalWorkspaces(ws);
        if (ws[0]) setEvalWorkspaceId(ws[0].id);
      })
      .catch(() => undefined);
  }, [activeProjectId, projects]);

  const refreshSecurityRecords = useCallback(async () => {
    try {
      const [g, a] = await Promise.all([
        invoke('permissions.listGrants', { includeInactive: true }),
        invoke('audit.list', {
          limit: 300,
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
        }),
      ]);
      setGrants(g);
      setAuditEvents(a);
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    }
  }, [activeProjectId, language]);

  useEffect(() => {
    void refreshSecurityRecords();
  }, [refreshSecurityRecords, pendingApprovals.length]);

  const handleRevokeGrant = async (grantId: string) => {
    setFeedback(null);
    setBusy(true);
    try {
      await invoke('permissions.revokeGrant', {
        id: grantId,
        reason: pt ? 'Revogado manualmente pelo usuário' : 'Revoked manually by user',
      });
      await refreshSecurityRecords();
      setFeedback({
        tone: 'success',
        text: pt ? 'Concessão revogada imediatamente.' : 'Grant revoked.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleAddRule = () => {
    const paths = rulePaths
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const executables = ruleExecs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const nextRule: PermissionRule = {
      action: ruleAction,
      decision: ruleDecision,
      ...(paths.length > 0 ? { paths } : {}),
      ...(executables.length > 0 ? { executables } : {}),
    };
    setPolRules((prev) => [...prev, nextRule]);
    setRulePaths('');
    setRuleExecs('');
  };

  const handleSavePolicy = async () => {
    if (!selectedPolicy) return;
    setFeedback(null);
    setBusy(true);
    try {
      const maxConcurrent = Math.max(1, Math.min(64, Number.parseInt(polMaxConcurrent, 10) || 2));
      const maxMinutes = Math.max(1, Math.min(1440, Number.parseInt(polMaxMinutes, 10) || 30));
      const maxMb = Math.max(1, Math.min(512, Number.parseInt(polMaxOutputMb, 10) || 16));
      await invoke('permissions.savePolicy', {
        id: selectedPolicy.id,
        name: polName.trim() || selectedPolicy.name,
        version: selectedPolicy.version,
        defaultDecision: polDefault,
        rules: polRules,
        limits: {
          maxConcurrentExecutions: maxConcurrent,
          maxExecutionMs: maxMinutes * 60_000,
          maxOutputBytes: maxMb * 1024 * 1024,
        },
        budget: selectedPolicy.budget,
      });
      await onRefreshPolicies();
      setFeedback({
        tone: 'success',
        text: pt ? 'Política salva (nova versão registrada).' : 'Policy saved.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleEvaluateDryRun = async () => {
    if (!evalAgentId || !evalWorkspaceId) return;
    setFeedback(null);
    setBusy(true);
    try {
      const res = await invoke('permissions.evaluate', {
        agentId: evalAgentId,
        workspaceId: evalWorkspaceId,
        action: evalAction,
        ...(evalPath.trim() ? { path: evalPath.trim() } : {}),
        ...(evalExec.trim() ? { executable: evalExec.trim() } : {}),
      });
      setEvalVerdict({ decision: res.decision, reason: res.reason });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const visibleAudit = useMemo(() => {
    if (!onlySecurityAudit) return auditEvents;
    return auditEvents.filter(
      (ev) =>
        ev.action.startsWith('approval.') ||
        ev.action.startsWith('permission.') ||
        ev.action.startsWith('policy.') ||
        ev.action.startsWith('execution.') ||
        ev.outcome === 'denied',
    );
  }, [auditEvents, onlySecurityAudit]);

  const nowIso = new Date().toISOString();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${tokens.color.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          flexShrink: 0,
          background: tokens.color.surface,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            {pt ? 'Segurança, Aprovações e Políticas' : 'Security, Approvals & Policies'}
          </h2>
          <div className="db-muted" style={{ fontSize: 12 }}>
            {pt
              ? 'Decisões humanas auditadas, revogação imediata de concessões e políticas por agente.'
              : 'Audited human decisions, immediate grant revocation and per-agent policies.'}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={13} />}
          onClick={() => void refreshSecurityRecords()}
        >
          {pt ? 'Atualizar registros' : 'Refresh'}
        </Button>
      </div>

      <Tabs
        tabs={[
          {
            id: 'pending',
            label: pt ? 'Solicitações pendentes' : 'Pending approvals',
            badge: pendingApprovals.length,
          },
          {
            id: 'grants',
            label: pt ? 'Concessões e revogação' : 'Grants & revocation',
            badge: grants.filter((g) => !g.revokedAt && g.expiresAt > nowIso).length,
          },
          {
            id: 'history',
            label: pt ? 'Histórico de decisões e auditoria' : 'Decision & audit history',
            badge: visibleAudit.length,
          },
          {
            id: 'policies',
            label: pt ? 'Políticas de permissão' : 'Permission policies',
            badge: policies.length,
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div
        data-scroll-region="security-body"
        style={{
          flex: '1 1 0%',
          minWidth: 0,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {feedback ? (
          <Banner
            tone={feedback.tone}
            actions={
              <Button size="xs" variant="ghost" onClick={() => setFeedback(null)}>
                ×
              </Button>
            }
          >
            {feedback.text}
          </Banner>
        ) : null}

        {tab === 'pending' ? (
          pendingApprovals.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={26} />}
              title={pt ? 'Nenhuma aprovação pendente' : 'No pending approvals'}
              description={
                pt
                  ? 'Quando um agente ou comando solicitar uma ação sensível ou iniciar uma sessão sem interceptação por ação, ela aparecerá aqui para aprovação ou recusa explícita.'
                  : 'Sensitive actions requiring human approval will appear here.'
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {pendingApprovals.map((req) => (
                <ApprovalDecisionCard
                  key={req.id}
                  approval={req}
                  agent={agents.find((a) => a.id === req.agentId)}
                  project={projects.find((p) => p.id === req.projectId)}
                  onDecide={async (input) => {
                    await onDecideApproval(input);
                    await refreshSecurityRecords();
                  }}
                  language={language}
                />
              ))}
            </div>
          )
        ) : null}

        {tab === 'grants' ? (
          <DataTable
            columns={[
              {
                key: 'action',
                header: pt ? 'Ação autorizada' : 'Action',
                render: (g) => (
                  <div>
                    <strong>{formatPermissionAction(g.action, language)}</strong>
                    {g.target ? (
                      <div className="db-mono db-faint" style={{ fontSize: 11 }}>
                        {g.target}
                      </div>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'agent',
                header: pt ? 'Agente' : 'Agent',
                render: (g) => agents.find((a) => a.id === g.agentId)?.name ?? g.agentId,
              },
              {
                key: 'scope',
                header: pt ? 'Escopo' : 'Scope',
                render: (g) => (
                  <Badge tone="info">
                    {g.scope === 'session'
                      ? pt
                        ? 'Sessão'
                        : 'Session'
                      : pt
                        ? 'Projeto'
                        : 'Project'}
                  </Badge>
                ),
              },
              {
                key: 'state',
                header: pt ? 'Estado' : 'State',
                render: (g) => {
                  const expired = g.expiresAt <= nowIso;
                  if (g.revokedAt) {
                    return <Badge tone="danger">{pt ? 'Revogada' : 'Revoked'}</Badge>;
                  }
                  if (expired) {
                    return <Badge tone="neutral">{pt ? 'Expirada' : 'Expired'}</Badge>;
                  }
                  return (
                    <Badge tone="success" dot>
                      {pt ? 'Ativa' : 'Active'}
                    </Badge>
                  );
                },
              },
              {
                key: 'expires',
                header: pt ? 'Expira / Revogada em' : 'Expires / Revoked',
                render: (g) => formatTimestamp(g.revokedAt ?? g.expiresAt, language),
              },
              {
                key: 'revoke',
                header: '',
                render: (g) =>
                  !g.revokedAt && g.expiresAt > nowIso ? (
                    <Button
                      size="xs"
                      variant="danger"
                      loading={busy}
                      onClick={() => void handleRevokeGrant(g.id)}
                    >
                      {pt ? 'Revogar' : 'Revoke'}
                    </Button>
                  ) : null,
              },
            ]}
            rows={grants}
            rowKey={(g) => g.id}
            emptyMessage={
              pt
                ? 'Nenhuma concessão de sessão ou projeto registrada.'
                : 'No session or project grants recorded.'
            }
          />
        ) : null}

        {tab === 'history' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Trilha append-only redigida (não pode ser desativada pelo renderer).'
                  : 'Append-only redacted audit trail.'}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button
                  size="xs"
                  variant={onlySecurityAudit ? 'primary' : 'secondary'}
                  onClick={() => setOnlySecurityAudit(true)}
                >
                  {pt ? 'Decisões e segurança' : 'Security decisions'}
                </Button>
                <Button
                  size="xs"
                  variant={!onlySecurityAudit ? 'primary' : 'secondary'}
                  onClick={() => setOnlySecurityAudit(false)}
                >
                  {pt ? 'Auditoria completa' : 'All audit events'}
                </Button>
              </div>
            </div>

            <DataTable
              columns={[
                {
                  key: 'timestamp',
                  header: pt ? 'Data/Hora' : 'Timestamp',
                  render: (ev) => (
                    <span className="db-mono" style={{ fontSize: 11 }}>
                      {formatTimestamp(ev.timestamp, language)}
                    </span>
                  ),
                },
                {
                  key: 'action',
                  header: pt ? 'Evento' : 'Event',
                  render: (ev) => (
                    <div>
                      <strong className="db-mono" style={{ fontSize: 11.5 }}>
                        {ev.action}
                      </strong>
                      {ev.permission ? (
                        <div className="db-muted" style={{ fontSize: 11 }}>
                          {formatPermissionAction(ev.permission, language)}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'actor',
                  header: pt ? 'Ator' : 'Actor',
                  render: (ev) => {
                    if (ev.actor.type === 'user') return pt ? 'Usuário' : 'User';
                    if (ev.actor.type === 'agent') {
                      const actorAgentId = ev.actor.agentId;
                      return agents.find((a) => a.id === actorAgentId)?.name ?? actorAgentId;
                    }
                    return `system:${ev.actor.component}`;
                  },
                },
                {
                  key: 'outcome',
                  header: pt ? 'Resultado' : 'Outcome',
                  render: (ev) => (
                    <Badge
                      tone={
                        ev.outcome === 'success'
                          ? 'success'
                          : ev.outcome === 'denied' || ev.outcome === 'failure'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {ev.outcome}
                    </Badge>
                  ),
                },
                {
                  key: 'target',
                  header: pt ? 'Alvo / Detalhes' : 'Target / Details',
                  render: (ev) => (
                    <div
                      className="db-mono"
                      style={{ fontSize: 11, maxWidth: 340, wordBreak: 'break-all' }}
                    >
                      {ev.target ?? ''}
                      {Object.keys(ev.details).length > 0 ? (
                        <div className="db-faint">{JSON.stringify(ev.details)}</div>
                      ) : null}
                    </div>
                  ),
                },
              ]}
              rows={visibleAudit}
              rowKey={(ev) => ev.id}
              emptyMessage={pt ? 'Nenhum evento registrado.' : 'No audit events recorded.'}
            />
          </div>
        ) : null}

        {tab === 'policies' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Banner tone="info" icon={<ShieldCheck size={15} />}>
              {pt
                ? `Piso inegociável ALWAYS_ASK (${ALWAYS_ASK_ACTIONS.join(', ')}): mesmo que uma política marque "allow", o DevBrain eleva para "ask" pontual.`
                : 'ALWAYS_ASK floor actions can never be auto-allowed by any policy.'}
            </Banner>

            {policies.length === 0 || !selectedPolicy ? (
              <EmptyState
                title={pt ? 'Nenhuma política cadastrada' : 'No policies yet'}
                description={
                  pt
                    ? 'Ao registrar um agente na Central de Agentes, uma política restritiva padrão é criada automaticamente.'
                    : 'Register an agent to create a default restrictive policy.'
                }
              />
            ) : (
              <div
                className="db-card"
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div className="db-card-header" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Select
                      value={selectedPolicy.id}
                      onChange={(e) => setSelectedPolicyId(e.target.value)}
                      style={{ width: 280 }}
                    >
                      {policies.map((pol) => (
                        <option key={pol.id} value={pol.id}>
                          {pol.name} (v{pol.version})
                        </option>
                      ))}
                    </Select>
                    <Badge tone="outline" mono>
                      v{selectedPolicy.version}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() => void handleSavePolicy()}
                  >
                    {pt ? 'Salvar política' : 'Save policy'}
                  </Button>
                </div>

                <div
                  style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 10 }}
                >
                  <Field label={pt ? 'Nome da política' : 'Policy name'}>
                    {(props) => (
                      <Input
                        {...props}
                        value={polName}
                        onChange={(e) => setPolName(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Decisão padrão' : 'Default decision'}>
                    {(props) => (
                      <Select
                        {...props}
                        value={polDefault}
                        onChange={(e) => setPolDefault(e.target.value as PermissionDecision)}
                      >
                        <option value="allow">allow</option>
                        <option value="ask">ask</option>
                        <option value="deny">deny</option>
                      </Select>
                    )}
                  </Field>
                  <Field label={pt ? 'Concorrência máx.' : 'Max concurrent'}>
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min={1}
                        max={64}
                        value={polMaxConcurrent}
                        onChange={(e) => setPolMaxConcurrent(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Timeout (min)' : 'Timeout (min)'}>
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min={1}
                        max={1440}
                        value={polMaxMinutes}
                        onChange={(e) => setPolMaxMinutes(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Saída máx. (MiB)' : 'Max output (MiB)'}>
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min={1}
                        max={512}
                        value={polMaxOutputMb}
                        onChange={(e) => setPolMaxOutputMb(e.target.value)}
                      />
                    )}
                  </Field>
                </div>

                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    {pt ? `Regras específicas (${polRules.length})` : `Rules (${polRules.length})`}
                  </div>
                  <DataTable
                    columns={[
                      {
                        key: 'action',
                        header: pt ? 'Ação' : 'Action',
                        render: (r) => formatPermissionAction(r.action, language),
                      },
                      {
                        key: 'decision',
                        header: pt ? 'Decisão' : 'Decision',
                        render: (r) => (
                          <Badge
                            tone={
                              r.decision === 'allow'
                                ? 'success'
                                : r.decision === 'deny'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {r.decision}
                          </Badge>
                        ),
                      },
                      {
                        key: 'filters',
                        header: pt ? 'Filtros (globs / executáveis)' : 'Filters',
                        render: (r) => (
                          <span className="db-mono" style={{ fontSize: 11 }}>
                            {[
                              r.paths ? `paths=${r.paths.join(',')}` : '',
                              r.executables ? `exec=${r.executables.join(',')}` : '',
                            ]
                              .filter(Boolean)
                              .join(' · ') || (pt ? 'Todos os alvos' : 'All targets')}
                          </span>
                        ),
                      },
                      {
                        key: 'del',
                        header: '',
                        render: (r) => (
                          <Button
                            size="xs"
                            variant="ghost"
                            icon={<Trash2 size={12} />}
                            onClick={() => setPolRules((prev) => prev.filter((item) => item !== r))}
                          />
                        ),
                      },
                    ]}
                    rows={polRules}
                    rowKey={(r) =>
                      `${r.action}:${r.decision}:${(r.paths ?? []).join('|')}:${(r.executables ?? []).join('|')}`
                    }
                  />

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.3fr 0.8fr 1fr 1fr auto',
                      gap: 8,
                      alignItems: 'end',
                      marginTop: 10,
                    }}
                  >
                    <Field label={pt ? 'Nova regra — Ação' : 'Action'}>
                      {(props) => (
                        <Select
                          {...props}
                          value={ruleAction}
                          onChange={(e) => setRuleAction(e.target.value as PermissionAction)}
                        >
                          {ALL_ACTIONS.map((act) => (
                            <option key={act} value={act}>
                              {act}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={pt ? 'Decisão' : 'Decision'}>
                      {(props) => (
                        <Select
                          {...props}
                          value={ruleDecision}
                          onChange={(e) => setRuleDecision(e.target.value as PermissionDecision)}
                        >
                          <option value="allow">allow</option>
                          <option value="ask">ask</option>
                          <option value="deny">deny</option>
                        </Select>
                      )}
                    </Field>
                    <Field label={pt ? 'Globs de caminho (opcional)' : 'Path globs'}>
                      {(props) => (
                        <Input
                          {...props}
                          mono
                          value={rulePaths}
                          placeholder="src/**, tests/**"
                          onChange={(e) => setRulePaths(e.target.value)}
                        />
                      )}
                    </Field>
                    <Field label={pt ? 'Executáveis (opcional)' : 'Executables'}>
                      {(props) => (
                        <Input
                          {...props}
                          mono
                          value={ruleExecs}
                          placeholder="node, git"
                          onChange={(e) => setRuleExecs(e.target.value)}
                        />
                      )}
                    </Field>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Plus size={13} />}
                      onClick={handleAddRule}
                    >
                      {pt ? 'Adicionar' : 'Add'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Real-path evaluator */}
            {agents.length > 0 && evalWorkspaces.length > 0 ? (
              <div
                className="db-card"
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <h3 className="db-section-title">
                  {pt
                    ? 'Simulador de avaliação de permissão (real-path no Core)'
                    : 'Permission dry-run evaluator'}
                </h3>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr auto',
                    gap: 8,
                    alignItems: 'end',
                  }}
                >
                  <Field label={pt ? 'Agente' : 'Agent'}>
                    {(props) => (
                      <Select
                        {...props}
                        value={evalAgentId}
                        onChange={(e) => setEvalAgentId(e.target.value)}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={pt ? 'Ação' : 'Action'}>
                    {(props) => (
                      <Select
                        {...props}
                        value={evalAction}
                        onChange={(e) => setEvalAction(e.target.value as PermissionAction)}
                      >
                        {ALL_ACTIONS.map((act) => (
                          <option key={act} value={act}>
                            {act}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={pt ? 'Caminho (opcional)' : 'Path (optional)'}>
                    {(props) => (
                      <Input
                        {...props}
                        mono
                        value={evalPath}
                        onChange={(e) => setEvalPath(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={pt ? 'Executável (opcional)' : 'Executable (optional)'}>
                    {(props) => (
                      <Input
                        {...props}
                        mono
                        value={evalExec}
                        onChange={(e) => setEvalExec(e.target.value)}
                      />
                    )}
                  </Field>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() => void handleEvaluateDryRun()}
                  >
                    {pt ? 'Simular' : 'Evaluate'}
                  </Button>
                </div>
                {evalVerdict ? (
                  <Banner
                    tone={
                      evalVerdict.decision === 'allow'
                        ? 'success'
                        : evalVerdict.decision === 'deny'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    <strong>{evalVerdict.decision.toUpperCase()}</strong> — {evalVerdict.reason}
                  </Banner>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
