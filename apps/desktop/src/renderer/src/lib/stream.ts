import type { ExecutionEvent } from '@devbrain/contracts';

/**
 * Strips dangerous terminal control sequences (OSC, DCS, APC, PM, SOS, CSI cursor/window
 * manipulation) from untrusted agent output while preserving basic SGR color codes (`\x1b[...m`),
 * newlines and printable UTF-8 text. Prevents OSC 52 clipboard/title spoofing.
 */
/**
 * Strips dangerous terminal control sequences (OSC, DCS, APC, PM, SOS and non-SGR CSI cursor/window
 * manipulation) from untrusted agent output while preserving SGR color codes (`ESC [ ... m`),
 * tabs, CRLF newlines and printable UTF-8 text. Prevents OSC 52 clipboard/title spoofing.
 */
export const sanitizeTerminalChunk = (raw: string): string => {
  const ESC = 0x1b;
  const BEL = 0x07;
  let out = '';
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const code = raw.charCodeAt(i);

    if (code === ESC) {
      const next = raw.charCodeAt(i + 1);
      // OSC: ESC ] ... (BEL or ESC \)
      if (next === 0x5d) {
        i += 2;
        while (i < len) {
          const c = raw.charCodeAt(i);
          if (c === BEL) {
            i += 1;
            break;
          }
          if (c === ESC && raw.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      // DCS (P=0x50), SOS (X=0x58), PM (^=0x5e), APC (_=0x5f): ESC <char> ... ESC \
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i += 2;
        while (i < len) {
          if (raw.charCodeAt(i) === ESC && raw.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      // CSI: ESC [ <params> <final> — keep only SGR (`m` = 0x6d) with digits/semicolons
      if (next === 0x5b) {
        let j = i + 2;
        let onlyDigitsAndSemicolons = true;
        while (j < len) {
          const c = raw.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) {
            if (c === 0x6d && onlyDigitsAndSemicolons) {
              out += raw.slice(i, j + 1);
            }
            j += 1;
            break;
          }
          if (!((c >= 0x30 && c <= 0x39) || c === 0x3b)) {
            onlyDigitsAndSemicolons = false;
          }
          j += 1;
        }
        i = j;
        continue;
      }
      // Drop any bare/unknown ESC sequence
      i += 1;
      continue;
    }

    // Normalize CR / CRLF / LF to CRLF for xterm.js
    if (code === 0x0d) {
      if (raw.charCodeAt(i + 1) === 0x0a) i += 2;
      else i += 1;
      out += '\r\n';
      continue;
    }
    if (code === 0x0a) {
      i += 1;
      out += '\r\n';
      continue;
    }
    // Keep horizontal tab (0x09) and printable UTF-16 code units; drop C0/DEL control chars
    if (code === 0x09 || (code >= 0x20 && code !== 0x7f)) {
      out += raw[i];
    }
    i += 1;
  }

  return out;
};

export interface StreamSnapshot {
  readonly executionId: string;
  readonly events: readonly ExecutionEvent[];
  readonly highestSeq: number;
  readonly hasGap: boolean;
}

/**
 * Pure, immutable state helper that merges live `execution.event` pushes with persisted
 * `executions.listEvents` history without ever duplicating an event (`seq` monotonic per run).
 */
export const createStreamSnapshot = (executionId: string): StreamSnapshot => ({
  executionId,
  events: [],
  highestSeq: -1,
  hasGap: false,
});

export const mergeExecutionEvents = (
  current: StreamSnapshot,
  incoming: readonly ExecutionEvent[],
): { snapshot: StreamSnapshot; appended: readonly ExecutionEvent[] } => {
  const relevant = incoming.filter((e) => e.executionId === current.executionId);
  if (relevant.length === 0) return { snapshot: current, appended: [] };

  const bySeq = new Map<number, ExecutionEvent>();
  for (const ev of current.events) bySeq.set(ev.seq, ev);

  const fresh: ExecutionEvent[] = [];
  for (const ev of relevant) {
    if (!bySeq.has(ev.seq)) {
      bySeq.set(ev.seq, ev);
      fresh.push(ev);
    }
  }
  if (fresh.length === 0) return { snapshot: current, appended: [] };

  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const highestSeq = ordered[ordered.length - 1]?.seq ?? -1;
  let hasGap = false;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]?.seq !== i) {
      hasGap = true;
      break;
    }
  }

  fresh.sort((a, b) => a.seq - b.seq);
  return {
    snapshot: {
      executionId: current.executionId,
      events: ordered,
      highestSeq,
      hasGap,
    },
    appended: fresh,
  };
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
} as const;

export const formatEventForTerminal = (event: ExecutionEvent): string => {
  const time = new Date(event.timestamp).toLocaleTimeString('pt-BR', { hour12: false });
  switch (event.type) {
    case 'status':
      return `${ANSI.dim}[${time} #${event.seq}]${ANSI.reset} ${ANSI.cyan}[ESTADO]${ANSI.reset} ${event.status}\r\n`;
    case 'output': {
      const safe = sanitizeTerminalChunk(event.chunk);
      if (event.stream === 'stderr') {
        return `${ANSI.red}${safe}${ANSI.reset}${safe.endsWith('\r\n') ? '' : '\r\n'}`;
      }
      return safe;
    }
    case 'message': {
      const safe = sanitizeTerminalChunk(event.text);
      return `\r\n${ANSI.magenta}[${event.role.toUpperCase()}]${ANSI.reset} ${safe}\r\n`;
    }
    case 'tool-call':
      return `${ANSI.dim}[${time}]${ANSI.reset} ${ANSI.yellow}[FERRAMENTA]${ANSI.reset} ${sanitizeTerminalChunk(event.tool)}${event.state ? ` ${sanitizeTerminalChunk(event.state)}` : ''}${event.result ? `\r\n  ${sanitizeTerminalChunk(event.result.slice(0, 600))}` : ''}\r\n`;
    case 'approval-required':
      return `${ANSI.yellow}[APROVAÇÃO NECESSÁRIA]${ANSI.reset} ${event.action} (${event.approvalId})\r\n`;
    case 'file-change':
      return `${ANSI.green}[ARQUIVO ${event.change.toUpperCase()}]${ANSI.reset} ${sanitizeTerminalChunk(event.path)}\r\n`;
    case 'usage': {
      const inTok = event.usage.inputTokens ?? '—';
      const outTok = event.usage.outputTokens ?? '—';
      const cost =
        event.usage.costAmount !== null && event.usage.costCurrency !== null
          ? `${event.usage.costCurrency} ${event.usage.costAmount.toFixed(4)}`
          : 'custo não informado';
      return `${ANSI.dim}[USO] entrada=${inTok} saída=${outTok} (${cost})${ANSI.reset}\r\n`;
    }
    case 'error':
      return `${ANSI.red}[ERRO ${event.error.code}]${ANSI.reset} ${sanitizeTerminalChunk(event.error.message)}\r\n`;
    case 'heartbeat':
      return '';
  }
};

export const tokenizeCommandArgs = (raw: string): string[] => {
  if (raw.includes('\n')) {
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < raw.length && raw[i + 1] === quote) {
        current += quote;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) args.push(current);
  return args;
};

export const extractPlainTranscript = (events: readonly ExecutionEvent[]): string =>
  events
    .map((ev) => {
      switch (ev.type) {
        case 'status':
          return `[#${ev.seq} ESTADO] ${ev.status}`;
        case 'output':
          return `[#${ev.seq} ${ev.stream}] ${ev.chunk.replace(/\r?\n$/, '')}`;
        case 'message':
          return `[#${ev.seq} ${ev.role}] ${ev.text}`;
        case 'tool-call':
          return `[#${ev.seq} tool:${ev.tool}${ev.state ? ` ${ev.state}` : ''}] ${JSON.stringify(ev.input)}${ev.result ? ` -> ${ev.result}` : ''}`;
        case 'approval-required':
          return `[#${ev.seq} approval] ${ev.action} (${ev.approvalId})`;
        case 'file-change':
          return `[#${ev.seq} file:${ev.change}] ${ev.path}`;
        case 'usage':
          return `[#${ev.seq} usage] in=${ev.usage.inputTokens ?? 'n/a'} out=${ev.usage.outputTokens ?? 'n/a'}`;
        case 'error':
          return `[#${ev.seq} ERROR ${ev.error.code}] ${ev.error.message}`;
        case 'heartbeat':
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
