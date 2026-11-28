import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { AgentSession, ExecutionEvent, ExecutionStatus } from '@devbrain/contracts';
import { Badge, Button, Input, tokens } from '@devbrain/ui';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { formatExecutionStatus, formatSessionStatus, type AppLanguage } from '../lib/i18n';
import { extractPlainTranscript, formatEventForTerminal } from '../lib/stream';

export type TerminalFilter = 'all' | 'output' | 'errors' | 'events';

export interface TerminalPaneProps {
  executionId: string | null;
  executionStatus: ExecutionStatus | null;
  session: AgentSession | null;
  events: readonly ExecutionEvent[];
  highestSeq: number;
  hasGap: boolean;
  autoScroll: boolean;
  expanded: boolean;
  onToggleAutoScroll: () => void;
  onToggleExpanded: () => void;
  onReplay: () => Promise<void>;
  language: AppLanguage;
}

const matchesFilter = (ev: ExecutionEvent, filter: TerminalFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'output') return ev.type === 'output';
  if (filter === 'errors') {
    return (ev.type === 'output' && ev.stream === 'stderr') || ev.type === 'error';
  }
  return ev.type !== 'output' && ev.type !== 'heartbeat';
};

export const TerminalPane = ({
  executionId,
  executionStatus,
  session,
  events,
  highestSeq,
  hasGap,
  autoScroll,
  expanded,
  onToggleAutoScroll,
  onToggleExpanded,
  onReplay,
  language,
}: TerminalPaneProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const renderedKeyRef = useRef<string>('');
  const renderedCountRef = useRef<number>(0);

  const [filter, setFilter] = useState<TerminalFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const filteredEvents = useMemo(
    () => events.filter((ev) => matchesFilter(ev, filter)),
    [events, filter],
  );

  // Mount xterm.js strictly as a read-only output/diagnostic terminal (no renderer shell stdin).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      disableStdin: true,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 25_000,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      theme: {
        background: '#090c11',
        foreground: '#dce2ee',
        cursor: '#4c9aff',
        selectionBackground: 'rgba(76, 154, 255, 0.32)',
        black: '#0d1016',
        red: '#eb5763',
        green: '#36c688',
        yellow: '#e5a93c',
        blue: '#4c9aff',
        magenta: '#b88eff',
        cyan: '#52c7dc',
        white: '#e6eaf2',
        brightBlack: '#667187',
      },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* container may have 0 size before layout settles */
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    renderedKeyRef.current = '';
    renderedCountRef.current = 0;

    const syncBufferAttrs = () => {
      const root = rootRef.current;
      if (!root) return;
      root.setAttribute('data-viewport-y', String(term.buffer.active.viewportY));
      root.setAttribute('data-base-y', String(term.buffer.active.baseY));
    };
    const scrollDisp = term.onScroll(syncBufferAttrs);
    const writeDisp = term.onWriteParsed(syncBufferAttrs);
    syncBufferAttrs();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        syncBufferAttrs();
      } catch {
        /* ignore transient layout resize */
      }
    });
    observer.observe(el);

    return () => {
      scrollDisp.dispose();
      writeDisp.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, []);

  // Incremental stream writer ordered by `seq`.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const renderKey = `${executionId ?? 'none'}:${filter}`;

    if (renderedKeyRef.current !== renderKey || filteredEvents.length < renderedCountRef.current) {
      term.reset();
      renderedKeyRef.current = renderKey;
      renderedCountRef.current = 0;
      if (!executionId) {
        term.writeln(
          '\x1b[90mDevBrain Terminal — selecione um agente e inicie uma execução para acompanhar o stream real (stdout, stderr e eventos).\x1b[0m',
        );
        return;
      }
    }

    const slice = filteredEvents.slice(renderedCountRef.current);
    if (slice.length === 0) return;

    const batch = slice.map(formatEventForTerminal).join('');
    renderedCountRef.current = filteredEvents.length;
    if (batch) {
      term.write(batch, () => {
        if (autoScroll) term.scrollToBottom();
        const root = rootRef.current;
        if (root) {
          root.setAttribute('data-viewport-y', String(term.buffer.active.viewportY));
          root.setAttribute('data-base-y', String(term.buffer.active.baseY));
        }
      });
    }
  }, [executionId, filter, filteredEvents, autoScroll]);

  const handleCopy = useCallback(async () => {
    const selection = termRef.current?.getSelection();
    const text =
      selection && selection.length > 0 ? selection : extractPlainTranscript(filteredEvents);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore clipboard denial */
    }
  }, [filteredEvents]);

  const handleReplay = useCallback(async () => {
    setReplaying(true);
    try {
      await onReplay();
    } finally {
      setReplaying(false);
    }
  }, [onReplay]);

  const pt = language === 'pt-BR';
  const sessionBadge = session ? formatSessionStatus(session.status, language) : null;
  const execBadge = executionStatus ? formatExecutionStatus(executionStatus, language) : null;

  return (
    <div
      ref={rootRef}
      data-testid="terminal-pane"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        background: '#090c11',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '5px 10px',
          background: tokens.color.surface,
          borderBottom: `1px solid ${tokens.color.border}`,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11.5,
              fontWeight: 600,
              color: tokens.color.text,
            }}
          >
            <TerminalIcon size={13} />
            <span>
              {pt ? 'Terminal de execução (somente leitura)' : 'Execution terminal (read-only)'}
            </span>
          </span>
          {session && sessionBadge ? (
            <Badge tone={sessionBadge.tone} dot mono title={session.id}>
              {session.id.slice(0, 12)} · {sessionBadge.label}
            </Badge>
          ) : null}
          {execBadge ? (
            <Badge tone={execBadge.tone} dot>
              {execBadge.label}
            </Badge>
          ) : null}
          {executionId ? (
            <Badge tone={hasGap ? 'warning' : 'outline'} mono>
              seq {highestSeq >= 0 ? `0..${highestSeq}` : '—'} ({events.length})
            </Badge>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {(
            [
              ['all', pt ? 'Tudo' : 'All'],
              ['output', 'stdout/stderr'],
              ['errors', pt ? 'Erros' : 'Errors'],
              ['events', pt ? 'Eventos' : 'Events'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="xs"
              variant="ghost"
              active={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}

          <Button
            size="xs"
            variant="ghost"
            active={autoScroll}
            icon={<ArrowDownToLine size={12} />}
            title={pt ? 'Rolagem automática ao final' : 'Auto-scroll to bottom'}
            onClick={onToggleAutoScroll}
          >
            {pt ? 'Auto-scroll' : 'Auto-scroll'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            active={searchOpen}
            icon={<Search size={12} />}
            onClick={() => setSearchOpen((v) => !v)}
          >
            {pt ? 'Buscar' : 'Find'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<Copy size={12} />}
            onClick={() => void handleCopy()}
          >
            {copied ? (pt ? 'Copiado' : 'Copied') : pt ? 'Copiar' : 'Copy'}
          </Button>
          {executionId ? (
            <Button
              size="xs"
              variant={hasGap ? 'warning' : 'ghost'}
              loading={replaying}
              icon={<RefreshCw size={12} />}
              title={
                pt
                  ? 'Ressincronizar eventos persistidos por seq (reconexão)'
                  : 'Replay persisted events by seq'
              }
              onClick={() => void handleReplay()}
            >
              {pt ? 'Sincronizar' : 'Sync'}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            icon={expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            title={
              expanded ? (pt ? 'Restaurar altura' : 'Restore') : pt ? 'Expandir terminal' : 'Expand'
            }
            onClick={onToggleExpanded}
          />
        </div>
      </div>

      {searchOpen ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            background: tokens.color.surfaceElevated,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <Input
            value={query}
            placeholder={pt ? 'Buscar texto no terminal…' : 'Find in terminal…'}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              if (v) searchRef.current?.findNext(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query) {
                if (e.shiftKey) searchRef.current?.findPrevious(query);
                else searchRef.current?.findNext(query);
              }
            }}
            style={{ maxWidth: 280, height: 26 }}
          />
          <Button
            size="xs"
            variant="secondary"
            icon={<ChevronUp size={12} />}
            disabled={!query}
            onClick={() => searchRef.current?.findPrevious(query)}
          >
            {pt ? 'Anterior' : 'Prev'}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            icon={<ChevronDown size={12} />}
            disabled={!query}
            onClick={() => searchRef.current?.findNext(query)}
          >
            {pt ? 'Próximo' : 'Next'}
          </Button>
        </div>
      ) : null}

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          padding: '4px 6px',
          overflow: 'hidden',
        }}
      />
    </div>
  );
};
