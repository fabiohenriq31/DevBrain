import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BenchmarkCaseResult,
  BenchmarkCategory,
  BenchmarkRun,
  InferenceRequest,
} from '@devbrain/contracts';

type Message = InferenceRequest['messages'][number];
export interface Grade {
  passed: boolean;
  detail: string;
}
export interface BenchmarkCase {
  id: string;
  category: BenchmarkCategory;
  messages: Message[];
  maxOutputTokens: number;
  grade(output: string): Promise<Grade> | Grade;
}
export interface BenchmarkSuite {
  id: string;
  version: string;
  cases: BenchmarkCase[];
}
export interface CaseExecution {
  content: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  attempts: number;
}

/** First fenced code block (any language tag), else the whole answer. */
export const extractCode = (text: string): string =>
  /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/.exec(text)?.[1] ?? text;

const extractJson = (text: string): unknown => JSON.parse(extractCode(text).trim());

/**
 * Runs untrusted model-written JavaScript for grading in a separate Node process with the
 * permission model enabled (no filesystem, child processes or workers), an empty environment,
 * a hard timeout and an output cap. Residual risk: Node's permission model does not block
 * network access — grading code is model output and must be treated as hostile; run the
 * benchmark only against routes you trust and never with secrets in the environment.
 */
export const runSandboxedJs = (
  code: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--permission', '-e', code], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const take = (chunk: Buffer) => {
      if (output.length < 8000) output += chunk.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ ok: exitCode === 0, output: output.slice(0, 2000) });
    });
  });

const user = (content: string): Message[] => [{ role: 'user', content }];

const NEEDLE_FILLER = Array.from(
  { length: 120 },
  (_, i) => `Note ${i}: the build system caches artifacts per workspace and per branch.`,
).join('\n');

/** Small, versioned, reproducible core suite. Graders are objective (no model self-grading). */
export const CORE_SUITE: BenchmarkSuite = {
  id: 'devbrain-core',
  version: '1.0.0',
  cases: [
    {
      id: 'if-exact-word',
      category: 'instruction-following',
      messages: user('Reply with exactly the word ACK in uppercase and nothing else.'),
      maxOutputTokens: 16,
      grade: (o) => ({ passed: o.trim() === 'ACK', detail: `got ${JSON.stringify(o.trim().slice(0, 40))}` }),
    },
    {
      id: 'if-three-lines',
      category: 'instruction-following',
      messages: user('List exactly three colors, one per line, lowercase, no numbering, no punctuation, nothing else.'),
      maxOutputTokens: 40,
      grade: (o) => {
        const lines = o.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const ok = lines.length === 3 && lines.every((l) => /^[a-z]+( [a-z]+)?$/.test(l));
        return { passed: ok, detail: `${lines.length} line(s)` };
      },
    },
    {
      id: 'so-person',
      category: 'structured-output',
      messages: user(
        'Return only a JSON object with keys "name" (string "Ada"), "year" (number 1815) and "tags" (array with the strings "math" and "code"). No prose.',
      ),
      maxOutputTokens: 80,
      grade: (o) => {
        const schema = z.object({ name: z.literal('Ada'), year: z.literal(1815), tags: z.tuple([z.literal('math'), z.literal('code')]) }).strict();
        try {
          const r = schema.safeParse(extractJson(o));
          return { passed: r.success, detail: r.success ? 'schema ok' : r.error.issues[0]?.message ?? 'invalid' };
        } catch {
          return { passed: false, detail: 'not JSON' };
        }
      },
    },
    {
      id: 'tool-call-format',
      category: 'tool-calling',
      messages: user(
        'You can call the tool read_file(path: string). To read the file "src/index.ts", answer ONLY with JSON of the form {"tool":"read_file","arguments":{"path":"..."}}.',
      ),
      maxOutputTokens: 60,
      grade: (o) => {
        try {
          const r = z.object({ tool: z.literal('read_file'), arguments: z.object({ path: z.literal('src/index.ts') }).strict() }).strict().safeParse(extractJson(o));
          return { passed: r.success, detail: r.success ? 'textual tool call ok (not native tool API)' : 'wrong shape' };
        } catch {
          return { passed: false, detail: 'not JSON' };
        }
      },
    },
    {
      id: 'bugfix-sum',
      category: 'bugfix',
      messages: user(
        'Fix the bug. Return only the corrected JavaScript function in a code block.\n```js\nfunction sumRange(a, b) {\n  let total = 0;\n  for (let i = a; i < b; i++) total += i;\n  return total; // must include b\n}\n```',
      ),
      maxOutputTokens: 200,
      grade: async (o) => {
        const code = `${extractCode(o)}\nconst assert = require('node:assert');\nassert.strictEqual(sumRange(1, 3), 6);\nassert.strictEqual(sumRange(5, 5), 5);\nassert.strictEqual(sumRange(-2, 2), 0);`;
        const r = await runSandboxedJs(code);
        return { passed: r.ok, detail: r.ok ? 'tests passed' : r.output.split('\n')[0] ?? 'failed' };
      },
    },
    {
      id: 'testgen-isprime',
      category: 'test-generation',
      messages: user(
        'Write a JavaScript function `check(isPrime)` that throws if `isPrime` is incorrect (use plain `if` + `throw`). Cover 0, 1, 2, 9 and 13. Return only the function in a code block.',
      ),
      maxOutputTokens: 300,
      grade: async (o) => {
        const tests = extractCode(o);
        const good = 'const isPrime = (n) => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };';
        const mutant = 'const isPrime = (n) => n > 1 && n % 2 === 1;';
        const pass = await runSandboxedJs(`${tests}\n${good}\ncheck(isPrime);`);
        if (!pass.ok) return { passed: false, detail: 'tests reject the correct implementation' };
        const kill = await runSandboxedJs(`${tests}\n${mutant}\ncheck(isPrime);`);
        return { passed: !kill.ok, detail: kill.ok ? 'tests miss the mutant (9 / 2)' : 'catches mutant' };
      },
    },
    {
      id: 'preserve-rename',
      category: 'code-preservation',
      messages: user(
        'Rename the variable `cnt` to `count` and change NOTHING else (keep comments, spacing and order). Return only the code in a code block.\n```js\n// counter utilities\nexport function bump(cnt) {\n  // keep this comment\n  return cnt + 1; // +1\n}\nexport const ZERO = 0;\n```',
      ),
      maxOutputTokens: 200,
      grade: (o) => {
        const expected = '// counter utilities\nexport function bump(count) {\n  // keep this comment\n  return count + 1; // +1\n}\nexport const ZERO = 0;';
        const got = extractCode(o).replace(/\r\n/g, '\n').trim();
        return { passed: got === expected, detail: got === expected ? 'exact' : 'differs from expected' };
      },
    },
    {
      id: 'context-needle',
      category: 'context',
      messages: user(
        `${NEEDLE_FILLER.slice(0, NEEDLE_FILLER.length / 2)}\nThe deployment code word is VERMILLION-42.\n${NEEDLE_FILLER.slice(NEEDLE_FILLER.length / 2)}\n\nWhat is the deployment code word? Answer with the code word only.`,
      ),
      maxOutputTokens: 20,
      grade: (o) => ({ passed: o.trim().replace(/[.`'"]/g, '') === 'VERMILLION-42', detail: o.trim().slice(0, 40) }),
    },
  ],
};

export const SUITES: readonly BenchmarkSuite[] = [CORE_SUITE];

/**
 * BenchmarkEngine — executes a suite through a caller-provided runner (in the app: the
 * policy-enforcing gateway with the model pinned, so budget/privacy still apply) and grades
 * each answer objectively. Records sample size, suite version and upstream model id; the
 * evidence layer refuses confident scores below the minimum sample size.
 */
export class BenchmarkEngine {
  async run(
    suite: BenchmarkSuite,
    target: { routeId: string; modelId: string; upstreamModelId: string },
    execute: (c: BenchmarkCase) => Promise<CaseExecution>,
  ): Promise<BenchmarkRun> {
    const startedAt = new Date().toISOString();
    const results: BenchmarkCaseResult[] = [];
    for (const c of suite.cases) {
      try {
        const out = await execute(c);
        const grade = await c.grade(out.content);
        results.push({
          caseId: c.id,
          category: c.category,
          passed: grade.passed,
          detail: grade.detail.slice(0, 2000),
          latencyMs: out.latencyMs,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          costMicros: out.costMicros,
          attempts: out.attempts,
        });
      } catch (error) {
        results.push({
          caseId: c.id,
          category: c.category,
          passed: false,
          detail: `execution failed: ${error instanceof Error ? error.message : 'unknown'}`.slice(0, 2000),
          latencyMs: null,
          inputTokens: null,
          outputTokens: null,
          costMicros: null,
          attempts: 1,
        });
      }
    }
    return {
      id: `bench-${randomUUID()}`,
      suiteId: suite.id,
      suiteVersion: suite.version,
      routeId: target.routeId,
      modelId: target.modelId,
      upstreamModelId: target.upstreamModelId,
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
    };
  }
}
