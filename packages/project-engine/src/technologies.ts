import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Technology } from '@devbrain/contracts';

/**
 * Shallow, bounded technology detection from well-known manifest files. Not a repository
 * analysis (that is Phase 02): it reads at most a few small files, never follows symlinks
 * or junctions, and skips dependency/build folders.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  '.venv',
  'venv',
  'bin',
  'obj',
]);
const MAX_DEPTH = 2;
const MAX_ENTRIES = 2000;
const MAX_MANIFEST_BYTES = 1024 * 1024;

type Rule = { file: RegExp; tech: Omit<Technology, 'evidence'>[] };

const RULES: readonly Rule[] = [
  { file: /^package\.json$/, tech: [{ id: 'nodejs', name: 'Node.js', category: 'runtime' }] },
  {
    file: /^tsconfig(\..+)?\.json$/,
    tech: [{ id: 'typescript', name: 'TypeScript', category: 'language' }],
  },
  { file: /^pnpm-lock\.yaml$/, tech: [{ id: 'pnpm', name: 'pnpm', category: 'package-manager' }] },
  { file: /^yarn\.lock$/, tech: [{ id: 'yarn', name: 'Yarn', category: 'package-manager' }] },
  { file: /^package-lock\.json$/, tech: [{ id: 'npm', name: 'npm', category: 'package-manager' }] },
  { file: /^bun\.lockb?$/, tech: [{ id: 'bun', name: 'Bun', category: 'runtime' }] },
  { file: /^deno\.jsonc?$/, tech: [{ id: 'deno', name: 'Deno', category: 'runtime' }] },
  {
    file: /^(pyproject\.toml|requirements.*\.txt|setup\.py|Pipfile)$/,
    tech: [{ id: 'python', name: 'Python', category: 'language' }],
  },
  { file: /^poetry\.lock$/, tech: [{ id: 'poetry', name: 'Poetry', category: 'package-manager' }] },
  { file: /^uv\.lock$/, tech: [{ id: 'uv', name: 'uv', category: 'package-manager' }] },
  {
    file: /^Cargo\.toml$/,
    tech: [
      { id: 'rust', name: 'Rust', category: 'language' },
      { id: 'cargo', name: 'Cargo', category: 'build' },
    ],
  },
  { file: /^go\.mod$/, tech: [{ id: 'go', name: 'Go', category: 'language' }] },
  {
    file: /^pom\.xml$/,
    tech: [
      { id: 'java', name: 'Java', category: 'language' },
      { id: 'maven', name: 'Maven', category: 'build' },
    ],
  },
  { file: /^build\.gradle(\.kts)?$/, tech: [{ id: 'gradle', name: 'Gradle', category: 'build' }] },
  { file: /\.(csproj|fsproj|sln)$/, tech: [{ id: 'dotnet', name: '.NET', category: 'runtime' }] },
  { file: /^composer\.json$/, tech: [{ id: 'php', name: 'PHP', category: 'language' }] },
  { file: /^Gemfile$/, tech: [{ id: 'ruby', name: 'Ruby', category: 'language' }] },
  { file: /^pubspec\.yaml$/, tech: [{ id: 'dart', name: 'Dart', category: 'language' }] },
  { file: /^CMakeLists\.txt$/, tech: [{ id: 'cmake', name: 'CMake', category: 'build' }] },
  { file: /^Makefile$/, tech: [{ id: 'make', name: 'Make', category: 'build' }] },
  {
    file: /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/,
    tech: [{ id: 'docker', name: 'Docker', category: 'container' }],
  },
];

/** Frameworks/tools recognized from package.json dependencies. */
const NPM_DEPENDENCIES: Record<string, Omit<Technology, 'evidence'>> = {
  react: { id: 'react', name: 'React', category: 'framework' },
  next: { id: 'nextjs', name: 'Next.js', category: 'framework' },
  vue: { id: 'vue', name: 'Vue', category: 'framework' },
  nuxt: { id: 'nuxt', name: 'Nuxt', category: 'framework' },
  svelte: { id: 'svelte', name: 'Svelte', category: 'framework' },
  '@angular/core': { id: 'angular', name: 'Angular', category: 'framework' },
  electron: { id: 'electron', name: 'Electron', category: 'framework' },
  express: { id: 'express', name: 'Express', category: 'framework' },
  fastify: { id: 'fastify', name: 'Fastify', category: 'framework' },
  '@nestjs/core': { id: 'nestjs', name: 'NestJS', category: 'framework' },
  vite: { id: 'vite', name: 'Vite', category: 'build' },
  webpack: { id: 'webpack', name: 'webpack', category: 'build' },
  vitest: { id: 'vitest', name: 'Vitest', category: 'test' },
  jest: { id: 'jest', name: 'Jest', category: 'test' },
  '@playwright/test': { id: 'playwright', name: 'Playwright', category: 'test' },
  typescript: { id: 'typescript', name: 'TypeScript', category: 'language' },
  tailwindcss: { id: 'tailwindcss', name: 'Tailwind CSS', category: 'tooling' },
  eslint: { id: 'eslint', name: 'ESLint', category: 'tooling' },
};

const PYTHON_HINTS: Record<string, Omit<Technology, 'evidence'>> = {
  django: { id: 'django', name: 'Django', category: 'framework' },
  flask: { id: 'flask', name: 'Flask', category: 'framework' },
  fastapi: { id: 'fastapi', name: 'FastAPI', category: 'framework' },
  pytest: { id: 'pytest', name: 'pytest', category: 'test' },
};

const readSmall = async (file: string): Promise<string | null> => {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};

export const detectTechnologies = async (root: string): Promise<Technology[]> => {
  const found = new Map<string, Technology>();
  const add = (t: Omit<Technology, 'evidence'>, evidence: string) => {
    if (!found.has(t.id)) found.set(t.id, { ...t, evidence });
  };
  let seen = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      // Dirent from readdir does not follow links: symlinks/junctions are skipped.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(full, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      for (const rule of RULES)
        if (rule.file.test(entry.name)) rule.tech.forEach((t) => add(t, rel));

      if (entry.name === 'package.json') {
        const text = await readSmall(full);
        if (!text) continue;
        try {
          const pkg = JSON.parse(text) as Record<string, unknown>;
          const deps = {
            ...(pkg['dependencies'] as Record<string, unknown> | undefined),
            ...(pkg['devDependencies'] as Record<string, unknown> | undefined),
          };
          for (const name of Object.keys(deps)) {
            const t = NPM_DEPENDENCIES[name];
            if (t) add(t, rel);
          }
          if (!found.has('typescript'))
            add({ id: 'javascript', name: 'JavaScript', category: 'language' }, rel);
        } catch {
          // malformed manifest: keep the Node.js detection only
        }
      }
      if (/^(pyproject\.toml|requirements.*\.txt)$/.test(entry.name)) {
        const text = (await readSmall(full))?.toLowerCase() ?? '';
        for (const [hint, t] of Object.entries(PYTHON_HINTS)) {
          if (new RegExp(`(^|[\\s"'])${hint}([\\s<>=~!\\["']|$)`, 'm').test(text)) add(t, rel);
        }
      }
    }
  };

  await walk(root, 0);
  // JavaScript is implied only when TypeScript was not found anywhere.
  if (found.has('typescript')) found.delete('javascript');
  return [...found.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
  );
};
