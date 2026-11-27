import { createHash } from 'node:crypto';
import type { ContextOptimizationReport, InferenceRequest } from '@devbrain/contracts';
import { scopeKey } from './ledger-port.js';
import { estimateMessages, estimateText, type Tokenizer } from './tokens.js';

type Message = InferenceRequest['messages'][number];
type Action = ContextOptimizationReport['actions'][number];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Local, in-memory, size-bounded content cache for on-demand retrieval of content replaced by
 * references. Keys are scoped by project AND user, so a reference minted in one scope can never
 * be resolved from another (no cross-project/user leakage). Nothing is written to disk.
 */
export class ReferenceCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

  private scope(projectId: string, userId: string): string {
    return scopeKey('ctx', `${userId}\u0000${projectId}`);
  }

  put(projectId: string, userId: string, content: string): string {
    const ref = `ctx://${this.scope(projectId, userId)}/${sha(content).slice(0, 32)}`;
    if (!this.entries.has(ref)) {
      this.entries.set(ref, content);
      this.bytes += content.length * 2;
      for (const [key, value] of this.entries) {
        if (this.bytes <= this.maxBytes) break;
        this.entries.delete(key);
        this.bytes -= value.length * 2;
      }
    }
    return ref;
  }

  /** Returns null for references of another scope, even if the content exists. */
  get(projectId: string, userId: string, ref: string): string | null {
    if (!ref.startsWith(`ctx://${this.scope(projectId, userId)}/`)) return null;
    return this.entries.get(ref) ?? null;
  }
}

export interface OptimizeOptions {
  budgetTokens: number;
  tokenizer?: Tokenizer;
  /** Needed for references; without it large content is truncated-with-notice instead. */
  cache?: { store: ReferenceCache; projectId: string; userId: string };
  /** Messages above this size become references (tokens). */
  referenceThreshold?: number;
  /** Wrap tool/file content as untrusted data (default true). */
  wrapUntrusted?: boolean;
}

export interface OptimizeResult {
  messages: Message[];
  report: ContextOptimizationReport;
}

const isCritical = (m: Message, index: number, lastUser: number) =>
  m.role === 'system' || m.role === 'developer' || index === lastUser;

const LOG_SIGNAL = /\b(error|fail|failed|exception|fatal|panic|warn|warning|assert|traceback)\b/i;

/** Collapse runs of identical lines and keep head, tail and every signal line. */
export const compactLog = (text: string, keepHead = 20, keepTail = 40): string => {
  const lines = text.split(/\r?\n/);
  const runs: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    runs.push(j - i > 1 ? `${lines[i]}  [×${j - i}]` : lines[i]!);
    i = j;
  }
  if (runs.length <= keepHead + keepTail) return runs.join('\n');
  const middle = runs.slice(keepHead, runs.length - keepTail);
  const signals = middle.filter((l) => LOG_SIGNAL.test(l));
  return [
    ...runs.slice(0, keepHead),
    `[… ${middle.length - signals.length} non-signal log lines omitted by DevBrain …]`,
    ...signals,
    ...runs.slice(runs.length - keepTail),
  ].join('\n');
};

const looksLikeLog = (text: string) => {
  const lines = text.split(/\r?\n/);
  return lines.length >= 80;
};

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g)?.slice(0, 5000) ?? []);

/**
 * ContextOptimizer v1 — deterministic, measurable, no model call.
 * Order: dedup → log compaction → references for large content → relevance-ordered omission of
 * old non-critical messages (with an explicit manifest + extractive excerpts). System/developer
 * instructions and the latest user instruction are never modified or removed. Tool content is
 * wrapped as untrusted data so it cannot pose as instructions. Every action is reported with
 * the tokens it saved, measured with the same estimator as the totals.
 */
export class ContextOptimizer {
  optimize(input: readonly Message[], options: OptimizeOptions): OptimizeResult {
    const count = (t: string) => estimateText(t, options.tokenizer);
    const original = estimateMessages(input, options.tokenizer);
    const lastUser = input.map((m) => m.role).lastIndexOf('user');
    const actions: Action[] = [];
    const work = input.map((m, index) => ({ ...m, index, critical: isCritical(m, index, lastUser) }));
    const wrap = options.wrapUntrusted ?? true;
    const threshold = options.referenceThreshold ?? 2000;

    const replace = (i: number, kind: Action['kind'], content: string, reference: string | null) => {
      const before = count(work[i]!.content);
      work[i]!.content = content;
      actions.push({ kind, messageIndex: work[i]!.index, tokensSaved: before - count(content), reference });
    };

    // 1. Deduplicate repeated non-critical content.
    const seen = new Map<string, number>();
    for (let i = 0; i < work.length; i++) {
      const m = work[i]!;
      if (m.critical || m.content.length < 200) continue;
      const h = sha(m.content);
      const first = seen.get(h);
      if (first === undefined) seen.set(h, m.index);
      else replace(i, 'deduplicated', `[identical to message #${first}; omitted by DevBrain]`, null);
    }
    // 2. Compact logs in tool output.
    for (let i = 0; i < work.length; i++) {
      const m = work[i]!;
      if (m.critical || m.role !== 'tool' || !looksLikeLog(m.content)) continue;
      const compacted = compactLog(m.content);
      if (compacted.length < m.content.length) replace(i, 'log-compacted', compacted, null);
    }
    // 3. Large non-critical content → reference (retrievable on demand) when over budget.
    const total = () =>
      work.reduce((sum, m) => sum + count(m.content) + 8, 3);
    if (total() > options.budgetTokens)
      for (let i = 0; i < work.length; i++) {
        const m = work[i]!;
        if (m.critical || count(m.content) <= threshold) continue;
        const head = m.content.split(/\r?\n/).slice(0, 8).join('\n').slice(0, 800);
        if (options.cache) {
          const ref = options.cache.store.put(options.cache.projectId, options.cache.userId, m.content);
          replace(
            i,
            'replaced-by-reference',
            `[content stored locally as ${ref} (~${count(m.content)} tokens); first lines:]\n${head}`,
            ref,
          );
        } else replace(i, 'truncated', `${head}\n[… truncated by DevBrain: ~${count(m.content)} tokens]`, null);
        if (total() <= options.budgetTokens) break;
      }
    // 4. Omit least relevant old non-critical messages, keeping an explicit manifest.
    const omitted: { index: number; excerpt: string }[] = [];
    if (total() > options.budgetTokens) {
      const query = words(input[lastUser]?.content ?? '');
      const order = work
        .filter((m) => !m.critical)
        .map((m) => {
          const w = words(m.content);
          let overlap = 0;
          for (const x of w) if (query.has(x)) overlap++;
          return { m, relevance: w.size ? overlap / w.size : 0 };
        })
        .sort((a, b) => a.relevance - b.relevance || a.m.index - b.m.index);
      for (const { m } of order) {
        if (total() <= options.budgetTokens * 0.95) break;
        const saved = count(m.content) + 8;
        omitted.push({ index: m.index, excerpt: m.content.split(/\r?\n/)[0]!.slice(0, 160) });
        actions.push({ kind: 'dropped-irrelevant', messageIndex: m.index, tokensSaved: saved, reference: null });
        work.splice(work.indexOf(m), 1);
      }
    }
    let output: Message[] = work.map(({ role, content, toolCallId }) => ({
      role,
      content:
        wrap && role === 'tool'
          ? `<untrusted-data source="tool">\n${content}\n</untrusted-data>`
          : content,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    }));
    if (omitted.length) {
      const manifest = [
        `[DevBrain context note: ${omitted.length} earlier message(s) omitted to fit the budget.`,
        'Extractive first lines (NOT a model summary):',
        ...omitted.map((o) => `- #${o.index}: ${o.excerpt}`),
        ']',
      ].join('\n');
      const at = output.findIndex((m) => m.role !== 'system' && m.role !== 'developer');
      output = [...output.slice(0, at < 0 ? output.length : at), { role: 'user', content: manifest }, ...output.slice(at < 0 ? output.length : at)];
      actions.push({ kind: 'summarized', messageIndex: 0, tokensSaved: -(count(manifest) + 8), reference: null });
    }
    const optimized = estimateMessages(output, options.tokenizer).tokens;
    const critical = input.filter((m, i) => isCritical(m, i, lastUser));
    return {
      messages: output,
      report: {
        tokenizer: original.tokenizer,
        originalTokens: original.tokens,
        optimizedTokens: optimized,
        budgetTokens: options.budgetTokens,
        preservedCritical: critical.length,
        actions,
        overBudget: optimized > options.budgetTokens,
      },
    };
  }
}
