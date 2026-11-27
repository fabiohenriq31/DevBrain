import { useMemo, useState } from 'react';
import { Badge, Button, Dialog, Input, KeyHint, tokens } from '@devbrain/ui';
import { Bell, Check, Search } from 'lucide-react';
import { formatTimestamp, type AppLanguage, type NavSection } from '../lib/i18n';

export interface AppNotification {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
  targetSection?: NavSection | undefined;
}

export interface NotificationsDialogProps {
  open: boolean;
  notifications: readonly AppNotification[];
  onClose: () => void;
  onMarkAllRead: () => void;
  onNavigate: (section: NavSection) => void;
  language: AppLanguage;
}

export const NotificationsDialog = ({
  open,
  notifications,
  onClose,
  onMarkAllRead,
  onNavigate,
  language,
}: NotificationsDialogProps) => {
  const pt = language === 'pt-BR';
  return (
    <Dialog
      open={open}
      width={540}
      onClose={onClose}
      title={pt ? 'Central de notificações' : 'Notification center'}
      subtitle={
        pt
          ? 'Eventos reais de aprovações, sessões, armazenamento e provedores.'
          : 'Real events from approvals, sessions, storage and providers.'
      }
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={<Check size={13} />}
            disabled={notifications.length === 0}
            onClick={onMarkAllRead}
          >
            {pt ? 'Marcar todas como lidas' : 'Mark all read'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onClose}>
            {pt ? 'Fechar' : 'Close'}
          </Button>
        </>
      }
    >
      {notifications.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: tokens.color.textMuted,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Bell size={20} />
          <span>{pt ? 'Nenhuma notificação registrada nesta sessão.' : 'No notifications.'}</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notifications.map((n) => (
            <div
              key={n.id}
              style={{
                padding: '9px 11px',
                borderRadius: tokens.radius.md,
                border: `1px solid ${n.read ? tokens.color.border : tokens.color.borderStrong}`,
                background: n.read ? tokens.color.surface : tokens.color.surfaceElevated,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Badge
                    tone={
                      n.tone === 'danger'
                        ? 'danger'
                        : n.tone === 'warning'
                          ? 'warning'
                          : n.tone === 'success'
                            ? 'success'
                            : 'info'
                    }
                    dot={!n.read}
                  >
                    {n.title}
                  </Badge>
                </div>
                <span className="db-mono db-faint" style={{ fontSize: 10.5 }}>
                  {formatTimestamp(n.timestamp, language)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{n.body}</div>
              {n.targetSection ? (
                <div style={{ alignSelf: 'flex-end' }}>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      if (n.targetSection) onNavigate(n.targetSection);
                      onClose();
                    }}
                  >
                    {pt ? 'Abrir seção →' : 'Open section →'}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
};

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
  language: AppLanguage;
}

export const ShortcutsDialog = ({ open, onClose, language }: ShortcutsDialogProps) => {
  const pt = language === 'pt-BR';
  const items: [string, string][] = pt
    ? [
        ['Ctrl+K', 'Abrir paleta rápida de comandos e navegação'],
        ['Ctrl+1', 'Ir para o Workspace de desenvolvimento'],
        ['Ctrl+2', 'Ir para Gerenciamento de projetos'],
        ['Ctrl+3', 'Ir para Central de agentes e provedores'],
        ['Ctrl+4', 'Ir para Segurança e aprovações'],
        ['Ctrl+5 / Ctrl+,', 'Ir para Configurações'],
        ['Ctrl+Enter', 'Enviar instrução / iniciar execução no Workspace'],
        ['Ctrl+B', 'Alternar barra lateral de navegação'],
        ['Ctrl+I', 'Alternar painel contextual direito'],
        ['Ctrl+J', 'Expandir ou restaurar terminal integrado'],
        ['F1', 'Exibir este guia de atalhos'],
        ['Esc', 'Fechar diálogo ou paleta aberta'],
      ]
    : [
        ['Ctrl+K', 'Open quick command palette'],
        ['Ctrl+1', 'Go to Development Workspace'],
        ['Ctrl+2', 'Go to Project Management'],
        ['Ctrl+3', 'Go to Agents & Providers'],
        ['Ctrl+4', 'Go to Security & Approvals'],
        ['Ctrl+5 / Ctrl+,', 'Go to Settings'],
        ['Ctrl+Enter', 'Submit instruction / run in Workspace'],
        ['Ctrl+B', 'Toggle navigation sidebar'],
        ['Ctrl+I', 'Toggle right context panel'],
        ['Ctrl+J', 'Expand or restore integrated terminal'],
        ['F1', 'Open keyboard shortcuts reference'],
        ['Esc', 'Close active dialog or palette'],
      ];

  return (
    <Dialog
      open={open}
      width={500}
      onClose={onClose}
      title={pt ? 'Atalhos de teclado' : 'Keyboard shortcuts'}
      subtitle={pt ? 'Navegação rápida para operação diária.' : 'Fast keyboard navigation.'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(([keys, desc]) => (
          <div
            key={keys}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 8px',
              borderBottom: `1px solid ${tokens.color.border}`,
              fontSize: 12.5,
            }}
          >
            <span>{desc}</span>
            <KeyHint keys={keys} />
          </div>
        ))}
      </div>
    </Dialog>
  );
};

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string | undefined;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly PaletteCommand[];
  onClose: () => void;
  language: AppLanguage;
}

export const CommandPalette = ({ open, commands, onClose, language }: CommandPaletteProps) => {
  const pt = language === 'pt-BR';
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  if (!open) return null;
  const safeIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  return (
    <Dialog
      open={open}
      width={520}
      onClose={onClose}
      title={pt ? 'Comandos rápidos' : 'Command palette'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ position: 'relative' }}>
          <Input
            autoFocus
            value={query}
            placeholder={pt ? 'Filtrar ações, telas ou projetos…' : 'Filter actions or views…'}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                const chosen = filtered[safeIndex];
                if (chosen) {
                  e.preventDefault();
                  onClose();
                  chosen.run();
                }
              }
            }}
            style={{ paddingLeft: 30 }}
          />
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: 9,
              top: 8,
              color: tokens.color.textFaint,
              pointerEvents: 'none',
            }}
          />
        </div>
        <div
          style={{
            maxHeight: 280,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: 14, textAlign: 'center', color: tokens.color.textMuted }}>
              {pt ? 'Nenhum comando correspondente.' : 'No matching commands.'}
            </div>
          ) : (
            filtered.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                onClick={() => {
                  onClose();
                  cmd.run();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  border: 'none',
                  borderRadius: tokens.radius.sm,
                  background: idx === safeIndex ? tokens.color.accentSubtle : 'transparent',
                  color: idx === safeIndex ? tokens.color.accent : tokens.color.text,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 12.5,
                  fontFamily: tokens.font.sans,
                }}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut ? <KeyHint keys={cmd.shortcut} /> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
};
