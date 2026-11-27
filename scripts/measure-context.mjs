// Reproducible context-optimization measurement on fixed synthetic fixtures.
// Usage: pnpm exec tsc -b packages/intelligence && node scripts/measure-context.mjs
// Measures TOKEN reduction with the conservative estimator only — not answer quality.
import { ContextOptimizer, ReferenceCache } from '../packages/intelligence/dist/index.js';

const system = {
  role: 'system',
  content: 'You are DevBrain. Follow project rules. Never run destructive commands.',
};
const buildLog = Array.from({ length: 400 }, (_, i) =>
  i === 250
    ? 'ERROR TS2322: Type string is not assignable to number (src/a.ts:12)'
    : `[build] compiling module ${i % 3}`,
).join('\n');
const file = (n) =>
  Array.from({ length: 600 }, (_, i) => `export const v${n}_${i} = ${i}; // generated helper`).join(
    '\n',
  );
const chat = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `Turn ${i}: discussion about module ${i} ${'details and rationale '.repeat(25)}`,
}));

const fixtures = [
  {
    name: 'F1 failing build (log repeated twice)',
    budget: 100_000,
    messages: [
      system,
      { role: 'tool', content: buildLog },
      { role: 'tool', content: buildLog },
      { role: 'user', content: 'Why does the build fail?' },
    ],
  },
  {
    name: 'F2 long chat history (40 turns)',
    budget: 4_000,
    messages: [system, ...chat, { role: 'user', content: 'Now write tests for module 39.' }],
  },
  {
    name: 'F3 three large files attached',
    budget: 3_000,
    cache: true,
    messages: [
      system,
      { role: 'tool', content: file(1) },
      { role: 'tool', content: file(2) },
      { role: 'tool', content: file(3) },
      { role: 'user', content: 'Explain v2_10.' },
    ],
  },
  {
    name: 'F4 small, no waste (baseline)',
    budget: 100_000,
    messages: [system, { role: 'user', content: 'Rename foo to bar in src/a.ts.' }],
  },
];

const optimizer = new ContextOptimizer();
const cache = new ReferenceCache();
console.log(
  '| fixture | original | optimized | saved | budget | critical kept | over budget | actions |',
);
console.log('|---|---:|---:|---:|---:|---|---|---|');
for (const f of fixtures) {
  const { messages, report } = optimizer.optimize(f.messages, {
    budgetTokens: f.budget,
    ...(f.cache ? { cache: { store: cache, projectId: 'fixture', userId: 'fixture' } } : {}),
  });
  const kept =
    messages[0].content === system.content && messages.at(-1).content === f.messages.at(-1).content;
  const pct = ((1 - report.optimizedTokens / report.originalTokens) * 100).toFixed(1);
  const kinds = [...new Set(report.actions.map((a) => a.kind))].join(', ') || '—';
  console.log(
    `| ${f.name} | ${report.originalTokens} | ${report.optimizedTokens} | ${pct}% | ${f.budget} | ${kept ? 'yes' : 'NO'} | ${report.overBudget} | ${kinds} |`,
  );
}
