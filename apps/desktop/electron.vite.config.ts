import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** Workspace packages are bundled into main/preload; third-party deps stay external in main. */
const WORKSPACE = [
  '@devbrain/contracts',
  '@devbrain/security',
  '@devbrain/database',
  '@devbrain/project-engine',
  '@devbrain/ui',
];

/**
 * Strict Content-Security-Policy injected only in production builds. In dev, Vite's HMR
 * needs inline scripts and websockets, so the dev server runs without this meta tag.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'devbrain-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
    ),
});

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: [...WORKSPACE, 'zod'] },
      rolldownOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot `require` npm packages: bundle everything into one CJS file.
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspPlugin()],
    build: {
      rolldownOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
