import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@devbrain/contracts': pkg('contracts'),
      '@devbrain/security': pkg('security'),
      '@devbrain/database': pkg('database'),
      '@devbrain/project-engine': pkg('project-engine'),
      '@devbrain/core': pkg('core'),
      '@devbrain/provider-sdk': pkg('provider-sdk'),
      '@devbrain/execution-engine': pkg('execution-engine'),
      '@devbrain/git-engine': pkg('git-engine'),
      '@devbrain/ui': pkg('ui'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
