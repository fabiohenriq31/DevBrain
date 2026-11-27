import type {
  InferenceRequest,
  ModelDefinition,
  ModelEvidence,
  QualityTier,
  TaskKind,
  TaskProfile,
} from '@devbrain/contracts';

export const TIER_RANK: Record<QualityTier, number> = {
  basic: 0,
  standard: 1,
  advanced: 2,
  frontier: 3,
};

/** Minimum tier a task kind needs when the caller does not say. */
export const DEFAULT_MIN_TIER: Record<TaskKind, QualityTier> = {
  architecture: 'advanced',
  security: 'advanced',
  coding: 'standard',
  bugfix: 'standard',
  testing: 'standard',
  'structured-output': 'standard',
  'tool-use': 'standard',
  research: 'standard',
  documentation: 'basic',
  classification: 'basic',
  summarization: 'basic',
  'log-analysis': 'basic',
};

const KEYWORDS: [TaskKind, RegExp][] = [
  ['security', /\b(vulnerab|security|seguran|cve|exploit|xss|sqli|ssrf|threat|amea[cç])/i],
  ['architecture', /\b(architect|arquitet|design (doc|system)|trade-?offs?|adr\b)/i],
  ['bugfix', /\b(bug|fix|corrig|erro|error|exception|stack ?trace|regress)/i],
  ['testing', /\b(tests?|testes?|vitest|jest|pytest|coverage|cobertura)\b/i],
  ['log-analysis', /\b(logs?\b|traceback|stderr|journal)/i],
  ['structured-output', /\b(json|schema|yaml|csv)\b/i],
  ['documentation', /\b(docs?|documenta|readme|changelog)\b/i],
  ['summarization', /\b(summar|resum|tl;?dr)/i],
  ['classification', /\b(classif|categori|label|rotul)/i],
  ['research', /\b(research|pesquis|compare|compar)/i],
  ['coding', /\b(implement|refactor|function|fun[cç][aã]o|class|code|c[oó]digo)\b/i],
];

/**
 * Deterministic task classification (no model call). Looks only at the LAST user message — the
 * instruction — never at tool output or file content, which are untrusted data.
 */
export const classifyTask = (request: Pick<InferenceRequest, 'messages' | 'task'>): TaskProfile => {
  if (request.task) return request.task;
  const instruction = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const head = instruction.slice(0, 4000);
  const kind = KEYWORDS.find(([, pattern]) => pattern.test(head))?.[0] ?? 'coding';
  return {
    kind,
    priority: 'normal',
    requiresTools: false,
    requiresStructuredOutput: kind === 'structured-output',
    requiresReasoning: false,
  };
};

export interface TierAssessment {
  tier: QualityTier;
  evidence: 'benchmark' | 'history' | 'metadata';
  note: string;
}

/**
 * Capacity tier. Measured evidence wins once it has at least `low` confidence. Without
 * evidence, metadata gives a conservative prior that can never reach `frontier`: nominal
 * availability or a big context window does not prove programming quality.
 */
export const assessTier = (model: ModelDefinition, evidence?: ModelEvidence): TierAssessment => {
  if (evidence && evidence.source !== 'none' && evidence.confidence !== 'insufficient') {
    const w = evidence.wilsonLower;
    const tier: QualityTier =
      w >= 0.9 && evidence.samples >= 30
        ? 'frontier'
        : w >= 0.75
          ? 'advanced'
          : w >= 0.5
            ? 'standard'
            : 'basic';
    return {
      tier,
      evidence: evidence.source,
      note: `measured: ${evidence.successes}/${evidence.samples} (Wilson ≥ ${w.toFixed(2)})`,
    };
  }
  const c = model.capabilities;
  const ctx = c.contextTokens ?? 0;
  const outPrice = model.pricing?.outputPerMillion ?? 0;
  const tier: QualityTier =
    c.tools && ctx >= 100_000 && (c.reasoning || outPrice >= 2)
      ? 'advanced'
      : c.tools || ctx >= 32_000
        ? 'standard'
        : 'basic';
  return { tier, evidence: 'metadata', note: 'unverified prior from catalog metadata' };
};

/** 0..1 fit between a task and a model's declared capabilities. */
export const specialtyFit = (task: TaskProfile, model: ModelDefinition): number => {
  const c = model.capabilities;
  const ctx = c.contextTokens ?? 0;
  const wants: boolean[] = [];
  switch (task.kind) {
    case 'architecture':
    case 'security':
      wants.push(c.reasoning, ctx >= 100_000);
      break;
    case 'structured-output':
      wants.push(c.structuredOutput);
      break;
    case 'tool-use':
      wants.push(c.tools);
      break;
    case 'log-analysis':
    case 'research':
    case 'summarization':
      wants.push(ctx >= 64_000);
      break;
    case 'coding':
    case 'bugfix':
    case 'testing':
      wants.push(c.tools, ctx >= 32_000);
      break;
    default:
      wants.push(true);
  }
  return wants.filter(Boolean).length / wants.length;
};
