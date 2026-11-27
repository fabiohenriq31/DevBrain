import { useState } from 'react';
import {
  ALWAYS_ASK_ACTIONS,
  type Agent,
  type ApprovalRequest,
  type ApprovalScope,
  type Project,
} from '@devbrain/contracts';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  UntrustedBlock,
  tokens,
} from '@devbrain/ui';
import { AlertTriangle, CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { formatPermissionAction, formatRisk, formatTimestamp, type AppLanguage } from '../lib/i18n';

export interface ApprovalDecisionHandler {
  (input: {
    approvalId: string;
    decision: 'approved' | 'denied';
    scope: ApprovalScope;
    note?: string;
  }): Promise<void>;
}

const LIMITATION_LABELS_PT: Record<string, string> = {
  'no-enforcement':
    'O DevBrain não consegue interceptar ações individuais deste agente: ele executa com as permissões do seu usuário no sistema operacional. Apenas o diretório inicial (cwd) e a aprovação da sessão são aplicados.',
  'worktree-not-sandbox':
    'Worktrees Git isolam alterações de código entre tarefas, mas não funcionam como sandbox de sistema de arquivos.',
  'no-per-action-interception':
    'Ações individuais de arquivo e comando não passam pelo DevBrain; o agente roda apenas no modo restrito próprio do adaptador.',
  'network-depends-on-adapter':
    'O bloqueio de rede depende exclusivamente da configuração do adaptador externo.',
};

export interface ApprovalDecisionCardProps {
  approval: ApprovalRequest;
  agent: Agent | undefined;
  project: Project | undefined;
  onDecide: ApprovalDecisionHandler;
  language: AppLanguage;
}

export const ApprovalDecisionCard = ({
  approval,
  agent,
  project,
  onDecide,
  language,
}: ApprovalDecisionCardProps) => {
  const pt = language === 'pt-BR';
  const isAlwaysAsk = ALWAYS_ASK_ACTIONS.includes(approval.action);
  const [scope, setScope] = useState<ApprovalScope>(() =>
    !isAlwaysAsk && approval.sessionId && approval.target?.startsWith('agent:')
      ? 'session'
      : 'once',
  );
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<'approved' | 'denied' | null>(null);

  const riskBadge = formatRisk(approval.risk, language);
  const limitations = Array.isArray(approval.details.limitations)
    ? approval.details.limitations.filter((v): v is string => typeof v === 'string')
    : [];

  const submit = async (decision: 'approved' | 'denied') => {
    setSubmitting(decision);
    try {
      const effectiveScope: ApprovalScope = isAlwaysAsk ? 'once' : scope;
      const trimmed = note.trim();
      await onDecide({
        approvalId: approval.id,
        decision,
        scope: effectiveScope,
        ...(trimmed ? { note: trimmed } : {}),
      });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      data-testid={`approval-card-${approval.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 14,
        background: tokens.color.surface,
        border: `1px solid ${
          approval.risk === 'critical' || approval.untrustedOrigin
            ? tokens.color.danger
            : tokens.color.warning
        }`,
        borderRadius: tokens.radius.lg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={riskBadge.tone} dot>
            {riskBadge.label}
          </Badge>
          <Badge tone="info" mono>
            {formatPermissionAction(approval.action, language)}
          </Badge>
          {isAlwaysAsk ? (
            <Badge tone="danger">
              {pt ? 'Sempre exige aprovação pontual' : 'Always requires one-time approval'}
            </Badge>
          ) : null}
        </div>
        <span className="db-mono db-faint" style={{ fontSize: 11 }}>
          {approval.id}
        </span>
      </div>

      {approval.untrustedOrigin ? (
        <Banner
          tone="danger"
          icon={<ShieldAlert size={16} />}
          title={
            pt
              ? 'Atenção: solicitação disparada a partir de conteúdo não confiável'
              : 'Warning: triggered from untrusted content'
          }
        >
          {pt
            ? 'Esta ação foi originada enquanto o agente processava dados externos ou arquivos não confiáveis. Revise rigorosamente o alvo e recuse em caso de dúvida.'
            : 'Triggered while processing untrusted content. Verify target paths carefully before approving.'}
        </Banner>
      ) : null}

      {limitations.length > 0 ? (
        <Banner
          tone="warning"
          icon={<AlertTriangle size={16} />}
          title={
            pt ? 'Limitações reais de interceptação deste agente' : 'Agent enforcement limitations'
          }
        >
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
            {limitations.map((lim) => (
              <li key={lim} style={{ marginBottom: 3 }}>
                {pt ? (LIMITATION_LABELS_PT[lim] ?? lim) : lim}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.color.text }}>
        {approval.summary}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 8,
          padding: '8px 10px',
          borderRadius: tokens.radius.md,
          background: tokens.color.surfaceElevated,
          border: `1px solid ${tokens.color.border}`,
          fontSize: 12,
        }}
      >
        <div>
          <span className="db-muted">{pt ? 'Agente: ' : 'Agent: '}</span>
          <strong>{agent ? agent.name : approval.agentId}</strong>
        </div>
        <div>
          <span className="db-muted">{pt ? 'Projeto: ' : 'Project: '}</span>
          <strong>{project ? project.name : (approval.projectId ?? '—')}</strong>
        </div>
        {approval.target ? (
          <div style={{ gridColumn: '1 / -1' }}>
            <span className="db-muted">{pt ? 'Alvo / Caminho / Executável: ' : 'Target: '}</span>
            <span className="db-mono">{approval.target}</span>
          </div>
        ) : null}
        <div>
          <span className="db-muted">{pt ? 'Solicitada em: ' : 'Requested: '}</span>
          <span>{formatTimestamp(approval.requestedAt, language)}</span>
        </div>
        <div>
          <span className="db-muted">{pt ? 'Expira em: ' : 'Expires: '}</span>
          <span>{formatTimestamp(approval.expiresAt, language)}</span>
        </div>
      </div>

      {Object.keys(approval.details).length > 0 ? (
        <UntrustedBlock
          label={pt ? 'Contexto estruturado da operação' : 'Operation details'}
          text={JSON.stringify(approval.details, null, 2)}
          maxHeight={150}
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isAlwaysAsk ? '1fr' : '240px 1fr',
          gap: 10,
          alignItems: 'end',
        }}
      >
        {!isAlwaysAsk ? (
          <Field
            label={pt ? 'Escopo da aprovação' : 'Approval scope'}
            hint={
              pt
                ? 'Concessões de sessão/projeto podem ser revogadas a qualquer momento.'
                : 'Session/project grants can be revoked anytime.'
            }
          >
            {(props) => (
              <Select
                {...props}
                value={scope}
                onChange={(e) => setScope(e.target.value as ApprovalScope)}
              >
                <option value="once">
                  {pt ? 'Apenas esta vez (pontual)' : 'Once only (this operation)'}
                </option>
                {approval.sessionId ? (
                  <option value="session">{pt ? 'Durante esta sessão' : 'For this session'}</option>
                ) : null}
                {approval.projectId ? (
                  <option value="project">
                    {pt ? 'Neste projeto (com expiração)' : 'In this project (until expiry)'}
                  </option>
                ) : null}
              </Select>
            )}
          </Field>
        ) : null}

        <Field
          label={
            pt ? 'Nota de decisão (opcional, registrada na auditoria)' : 'Decision note (optional)'
          }
        >
          {(props) => (
            <Input
              {...props}
              value={note}
              placeholder={
                pt ? 'Ex.: comando verificado dentro do workspace' : 'e.g. verified command scope'
              }
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
        <Button
          variant="danger"
          icon={<XCircle size={14} />}
          loading={submitting === 'denied'}
          disabled={submitting !== null}
          onClick={() => void submit('denied')}
        >
          {pt ? 'Recusar ação' : 'Deny action'}
        </Button>
        <Button
          variant="primary"
          icon={<CheckCircle2 size={14} />}
          loading={submitting === 'approved'}
          disabled={submitting !== null}
          onClick={() => void submit('approved')}
        >
          {pt
            ? scope === 'once' || isAlwaysAsk
              ? 'Aprovar pontualmente'
              : scope === 'session'
                ? 'Aprovar para a sessão'
                : 'Aprovar para o projeto'
            : 'Approve'}
        </Button>
      </div>
    </div>
  );
};

export interface ApprovalModalProps {
  open: boolean;
  approvals: readonly ApprovalRequest[];
  agents: readonly Agent[];
  projects: readonly Project[];
  onClose: () => void;
  onDecide: ApprovalDecisionHandler;
  language: AppLanguage;
}

export const ApprovalModal = ({
  open,
  approvals,
  agents,
  projects,
  onClose,
  onDecide,
  language,
}: ApprovalModalProps) => {
  const pt = language === 'pt-BR';
  const current = approvals[0];
  if (!open || !current) return null;
  const agent = agents.find((a) => a.id === current.agentId);
  const project = projects.find((p) => p.id === current.projectId);

  return (
    <Dialog
      open={open}
      width={660}
      onClose={onClose}
      title={
        pt
          ? `Aprovação humana necessária (${approvals.length} pendente${approvals.length > 1 ? 's' : ''})`
          : `Human approval required (${approvals.length} pending)`
      }
      subtitle={
        pt
          ? 'Nenhuma operação sensível avança sem clique explícito do usuário.'
          : 'Sensitive operations never proceed without explicit user confirmation.'
      }
    >
      <ApprovalDecisionCard
        key={current.id}
        approval={current}
        agent={agent}
        project={project}
        onDecide={onDecide}
        language={language}
      />
    </Dialog>
  );
};
