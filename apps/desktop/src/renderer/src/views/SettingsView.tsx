import { useCallback, useEffect, useState } from 'react';
import {
  ALWAYS_ASK_ACTIONS,
  PermissionActionSchema,
  SettingsPatchSchema,
  type ApplicationSettings,
  type PermissionAction,
  type StorageHealth,
  type SystemInfo,
  type UsageSummary,
} from '@devbrain/contracts';
import { Badge, Banner, Button, Checkbox, Field, Input, Select, Tabs } from '@devbrain/ui';
import { Database, HardDriveDownload, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { describeError, invoke } from '../lib/bridge';
import { formatPermissionAction, formatTimestamp, type AppLanguage } from '../lib/i18n';

export interface SettingsViewProps {
  settings: ApplicationSettings | null;
  systemInfo: SystemInfo | null;
  storageHealth: StorageHealth | null;
  onRefreshSystem: () => Promise<void>;
  onReopenOnboarding: () => void;
  language: AppLanguage;
}

const EXTRA_CANDIDATES = PermissionActionSchema.options.filter(
  (act) => !ALWAYS_ASK_ACTIONS.includes(act),
);

export const SettingsView = ({
  settings,
  systemInfo,
  storageHealth,
  onRefreshSystem,
  onReopenOnboarding,
  language,
}: SettingsViewProps) => {
  const pt = language === 'pt-BR';
  const [tab, setTab] = useState<'general' | 'execution' | 'security' | 'storage'>('general');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'danger' | 'success'; text: string } | null>(
    null,
  );

  // Editable state synced from `settings`
  const [lang, setLang] = useState<'pt-BR' | 'en'>(settings?.language ?? 'pt-BR');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(settings?.theme ?? 'system');

  const [maxConcurrent, setMaxConcurrent] = useState('4');
  const [maxPerAgent, setMaxPerAgent] = useState('2');
  const [timeoutMinutes, setTimeoutMinutes] = useState('30');

  const [approvalMinutes, setApprovalMinutes] = useState('15');
  const [grantHours, setGrantHours] = useState('8');
  const [extraActions, setExtraActions] = useState<PermissionAction[]>([]);

  const [eventsDays, setEventsDays] = useState('30');
  const [backupsToKeep, setBackupsToKeep] = useState('5');
  const [currency, setCurrency] = useState('USD');
  const [maxPerDay, setMaxPerDay] = useState('');
  const [maxPerMonth, setMaxPerMonth] = useState('');
  const [allowWithoutCostGuarantee, setAllowWithoutCostGuarantee] = useState(false);

  const [usageDay, setUsageDay] = useState<UsageSummary | null>(null);
  const [usageMonth, setUsageMonth] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (!settings) return;
    setLang(settings.language);
    setTheme(settings.theme);
    setMaxConcurrent(String(settings.execution.maxConcurrentExecutions));
    setMaxPerAgent(String(settings.execution.maxConcurrentPerAgent));
    setTimeoutMinutes(String(Math.round(settings.execution.defaultTimeoutMs / 60_000)));
    setApprovalMinutes(String(Math.round(settings.security.approvalTimeoutMs / 60_000)));
    setGrantHours(String(Math.round(settings.security.defaultGrantTtlMs / 3_600_000)));
    setExtraActions(settings.security.extraApprovalActions);
    setEventsDays(String(settings.retention.executionEventsMaxAgeDays));
    setBackupsToKeep(String(settings.retention.backupsToKeep));
    setCurrency(settings.budget.currency);
    setMaxPerDay(settings.budget.maxPerDay !== null ? String(settings.budget.maxPerDay) : '');
    setMaxPerMonth(settings.budget.maxPerMonth !== null ? String(settings.budget.maxPerMonth) : '');
    setAllowWithoutCostGuarantee(settings.budget.allowWithoutCostGuarantee);
  }, [settings]);

  const loadUsage = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        invoke('usage.summary', { period: 'day' }),
        invoke('usage.summary', { period: 'month' }),
      ]);
      setUsageDay(d);
      setUsageMonth(m);
    } catch {
      /* ignore if core unavailable */
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const handleSave = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const rawPatch = {
        language: lang,
        theme,
        execution: {
          maxConcurrentExecutions: Number.parseInt(maxConcurrent, 10) || 4,
          maxConcurrentPerAgent: Number.parseInt(maxPerAgent, 10) || 2,
          defaultTimeoutMs: (Number.parseInt(timeoutMinutes, 10) || 30) * 60_000,
        },
        security: {
          approvalTimeoutMs: (Number.parseInt(approvalMinutes, 10) || 15) * 60_000,
          defaultGrantTtlMs: (Number.parseInt(grantHours, 10) || 8) * 3_600_000,
          extraApprovalActions: extraActions,
        },
        retention: {
          executionEventsMaxAgeDays: Number.parseInt(eventsDays, 10) || 30,
          backupsToKeep: Number.parseInt(backupsToKeep, 10) || 5,
        },
        budget: {
          currency: currency.trim().toUpperCase(),
          maxPerDay: maxPerDay.trim() ? Number(maxPerDay) : null,
          maxPerMonth: maxPerMonth.trim() ? Number(maxPerMonth) : null,
          allowWithoutCostGuarantee,
        },
      };
      const parsed = SettingsPatchSchema.parse(rawPatch);
      await invoke('settings.update', parsed);
      await onRefreshSystem();
      setFeedback({
        tone: 'success',
        text: pt ? 'Configurações salvas e aplicadas.' : 'Settings saved and applied.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  const handleBackupNow = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const res = await invoke('system.backup', {});
      await onRefreshSystem();
      setFeedback({
        tone: 'success',
        text: pt
          ? `Backup local criado com sucesso (${Math.round(res.bytes / 1024)} KiB): ${res.path}`
          : `Backup created: ${res.path}`,
      });
    } catch (e) {
      setFeedback({ tone: 'danger', text: describeError(e, language).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--db-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--db-surface)',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            {pt ? 'Configurações do Aplicativo' : 'Application Settings'}
          </h2>
          <div className="db-muted" style={{ fontSize: 12 }}>
            {pt
              ? 'Preferências validadas por contrato (SettingsPatchSchema) e persistidas localmente.'
              : 'Validated via SettingsPatchSchema and persisted in SQLite.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={13} />}
            onClick={onReopenOnboarding}
          >
            {pt ? 'Retomar configuração inicial' : 'Reopen setup wizard'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Save size={13} />}
            loading={busy}
            onClick={() => void handleSave()}
          >
            {pt ? 'Salvar configurações' : 'Save settings'}
          </Button>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'general', label: pt ? 'Aparência e Idioma' : 'Appearance & Language' },
          { id: 'execution', label: pt ? 'Execução, Retenção e Orçamento' : 'Execution & Budget' },
          { id: 'security', label: pt ? 'Segurança global' : 'Global Security' },
          { id: 'storage', label: pt ? 'Armazenamento, Backup e Sistema' : 'Storage & System' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
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

        {tab === 'general' ? (
          <div
            className="db-card"
            style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label={pt ? 'Idioma da interface' : 'Interface language'}>
                {(props) => (
                  <Select
                    {...props}
                    value={lang}
                    onChange={(e) => setLang(e.target.value as 'pt-BR' | 'en')}
                  >
                    <option value="pt-BR">Português (Brasil)</option>
                    <option value="en">English</option>
                  </Select>
                )}
              </Field>
              <Field label={pt ? 'Tema visual' : 'Theme'}>
                {(props) => (
                  <Select
                    {...props}
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}
                  >
                    <option value="system">{pt ? 'Seguir o Windows (Sistema)' : 'System'}</option>
                    <option value="dark">{pt ? 'Escuro (Dark)' : 'Dark'}</option>
                    <option value="light">{pt ? 'Claro (Light)' : 'Light'}</option>
                  </Select>
                )}
              </Field>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge tone="success">
                {pt ? 'Telemetria desativada (telemetry: false)' : 'Telemetry disabled'}
              </Badge>
              <span className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Nenhum dado de uso ou código sai da sua máquina sem ação explícita em agentes externos.'
                  : 'Zero telemetry leaves your machine.'}
              </span>
            </div>
          </div>
        ) : null}

        {tab === 'execution' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 780 }}>
            <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 className="db-section-title">
                {pt ? 'Concorrência e tempo limite padrão' : 'Concurrency & default timeout'}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <Field label={pt ? 'Execuções simultâneas globais' : 'Global max concurrent'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={64}
                      value={maxConcurrent}
                      onChange={(e) => setMaxConcurrent(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Execuções simultâneas por agente' : 'Max concurrent per agent'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={64}
                      value={maxPerAgent}
                      onChange={(e) => setMaxPerAgent(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Timeout padrão (minutos)' : 'Default timeout (minutes)'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={1440}
                      value={timeoutMinutes}
                      onChange={(e) => setTimeoutMinutes(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </div>

            <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 className="db-section-title">
                {pt ? 'Retenção e teto de orçamento' : 'Retention & budget ceiling'}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10 }}>
                <Field label={pt ? 'Retenção eventos (dias)' : 'Event retention (days)'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={3650}
                      value={eventsDays}
                      onChange={(e) => setEventsDays(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Backups mantidos' : 'Backups kept'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={100}
                      value={backupsToKeep}
                      onChange={(e) => setBackupsToKeep(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Moeda (ISO)' : 'Currency'}>
                  {(props) => (
                    <Input
                      {...props}
                      mono
                      maxLength={3}
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Máx./dia (vazio = livre)' : 'Max/day'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={0}
                      step="0.01"
                      value={maxPerDay}
                      onChange={(e) => setMaxPerDay(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={pt ? 'Máx./mês (vazio = livre)' : 'Max/month'}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={0}
                      step="0.01"
                      value={maxPerMonth}
                      onChange={(e) => setMaxPerMonth(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Checkbox
                checked={allowWithoutCostGuarantee}
                onChange={(e) => setAllowWithoutCostGuarantee(e.target.checked)}
                label={
                  pt
                    ? 'Permitir execuções SEM garantia de custo: com um teto configurado, agentes que não informam custo (Codex, Claude Code, Antigravity) rodam mesmo assim, e o teto considera apenas custos informados.'
                    : 'Allow executions WITHOUT a cost guarantee: with a limit set, agents that do not report cost still run and the limit only counts reported costs.'
                }
              />
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? 'Com um teto definido e esta opção desmarcada, execuções de agentes cujo custo é desconhecido são bloqueadas (custo desconhecido nunca é tratado como zero).'
                  : 'With a limit set and this option off, agent executions with unknown cost are blocked (unknown cost is never zero).'}
              </div>
              <div className="db-muted" style={{ fontSize: 12 }}>
                {pt
                  ? `Consumo registrado hoje: ${usageDay?.executions ?? 0} execução(ões), entrada=${usageDay?.inputTokens ?? 0} tok, saída=${usageDay?.outputTokens ?? 0} tok, custos informados=${
                      usageDay && Object.keys(usageDay.cost).length > 0
                        ? Object.entries(usageDay.cost)
                            .map(([k, v]) => `${k} ${v.toFixed(4)}`)
                            .join(', ')
                        : 'nenhum'
                    }, execuções com custo desconhecido=${usageDay?.unknownCostExecutions ?? 0}${
                      (usageDay?.unknownCostExecutions ?? 0) > 0
                        ? ' (o total informado é apenas um limite inferior)'
                        : ''
                    }. No mês: ${usageMonth?.executions ?? 0} execução(ões), ${usageMonth?.unknownCostExecutions ?? 0} com custo desconhecido.`
                  : `Today: ${usageDay?.executions ?? 0} executions, ${usageDay?.unknownCostExecutions ?? 0} with unknown cost. This month: ${usageMonth?.executions ?? 0} executions, ${usageMonth?.unknownCostExecutions ?? 0} with unknown cost.`}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'security' ? (
          <div
            className="db-card"
            style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field
                label={
                  pt ? 'Expiração de aprovações pendentes (minutos)' : 'Approval timeout (min)'
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={1440}
                    value={approvalMinutes}
                    onChange={(e) => setApprovalMinutes(e.target.value)}
                  />
                )}
              </Field>
              <Field
                label={pt ? 'Duração padrão de concessões (horas)' : 'Default grant TTL (hours)'}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={720}
                    value={grantHours}
                    onChange={(e) => setGrantHours(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {pt
                  ? 'Ações adicionais que exigem aprovação humana global (além de ALWAYS_ASK):'
                  : 'Additional actions requiring human approval:'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {EXTRA_CANDIDATES.map((act) => (
                  <Checkbox
                    key={act}
                    checked={extraActions.includes(act)}
                    onChange={(e) =>
                      setExtraActions((prev) =>
                        e.target.checked ? [...prev, act] : prev.filter((a) => a !== act),
                      )
                    }
                    label={formatPermissionAction(act, language)}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'storage' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
            <div className="db-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="db-card-header" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Database size={16} />
                  <h3 className="db-section-title">
                    {pt ? 'Saúde da persistência SQLite' : 'SQLite storage health'}
                  </h3>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={<RefreshCw size={12} />}
                    onClick={() => void onRefreshSystem()}
                  >
                    {pt ? 'Atualizar' : 'Refresh'}
                  </Button>
                  <Button
                    size="xs"
                    variant="primary"
                    icon={<HardDriveDownload size={12} />}
                    loading={busy}
                    onClick={() => void handleBackupNow()}
                  >
                    {pt ? 'Criar backup local agora' : 'Create local backup now'}
                  </Button>
                </div>
              </div>

              {!storageHealth ? (
                <Banner tone="danger">
                  {pt
                    ? 'Banco de dados indisponível. Verifique permissões do diretório %APPDATA%\\DevBrain AI.'
                    : 'Database unavailable.'}
                </Banner>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 10,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <span className="db-muted">{pt ? 'Integridade: ' : 'Integrity: '}</span>
                    <Badge tone={storageHealth.integrity === 'ok' ? 'success' : 'warning'}>
                      {storageHealth.integrity} (v{storageHealth.schemaVersion})
                    </Badge>
                  </div>
                  <div>
                    <span className="db-muted">{pt ? 'Tamanho do banco: ' : 'DB size: '}</span>
                    <strong>
                      {Math.max(1, Math.round(storageHealth.databaseBytes / 1024))} KiB
                    </strong>
                  </div>
                  <div>
                    <span className="db-muted">{pt ? 'Último backup: ' : 'Last backup: '}</span>
                    <span>{formatTimestamp(storageHealth.lastBackupAt, language)}</span>
                  </div>
                  <div>
                    <span className="db-muted">
                      {pt ? 'Sessões recuperadas: ' : 'Recovered sessions: '}
                    </span>
                    <strong>{storageHealth.recoveredSessions}</strong>
                  </div>
                </div>
              )}
            </div>

            <div
              className="db-card"
              style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}
            >
              <h3 className="db-section-title">
                {pt ? 'Ambiente e empacotamento' : 'Runtime & packaging'}
              </h3>
              <div className="db-mono">
                DevBrain AI {systemInfo?.appVersion ?? '—'} · Contracts{' '}
                {systemInfo?.contractsVersion ?? '—'} · Electron{' '}
                {systemInfo?.electronVersion ?? '—'} · Node {systemInfo?.nodeVersion ?? '—'} ·{' '}
                {systemInfo?.platform ?? '—'}
              </div>
              <div className="db-muted">
                {pt
                  ? 'Nota de distribuição Windows: este pacote é um build de desenvolvimento x64 não assinado com certificado Authenticode; o Windows SmartScreen pode exibir aviso na instalação inicial. Na desinstalação, os dados do usuário em %APPDATA%\\DevBrain AI são preservados.'
                  : 'Windows packaging note: unsigned x64 development build; user data in %APPDATA%\\DevBrain AI is preserved on uninstall.'}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
