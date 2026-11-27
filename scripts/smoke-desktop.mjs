#!/usr/bin/env node
/**
 * Desktop smoke test (no extra dependencies).
 *
 * Launches the BUILT app (`apps/desktop/out`) with an isolated temporary user-data dir and a
 * local-only DevTools port, then — from inside the sandboxed renderer — verifies that:
 *  1. Node/Electron globals are NOT reachable (contextIsolation + sandbox + no nodeIntegration);
 *  2. `window.devbrain` is the only bridge and it is frozen;
 *  3. real IPC round-trips work (system.getInfo, projects.register/list, settings.get);
 *  4. invalid payloads and unknown channels are rejected;
 *  5. the production CSP meta tag is present.
 *
 * Usage: pnpm --filter @devbrain/desktop build && node scripts/smoke-desktop.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const electronPath = createRequire(path.join(desktop, 'package.json'))('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'devbrain-smoke-'));
const projectDir = path.join(tmp, 'sample-project');
await mkdir(path.join(projectDir, '.git'), { recursive: true });

const child = spawn(
  electronPath,
  [desktop, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'userdata')}`],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', ELECTRON_ENABLE_LOGGING: '0' },
  },
);
let logs = '';
child.stdout.on('data', (d) => (logs += d));
child.stderr.on('data', (d) => (logs += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = async (message) => {
  console.error(`SMOKE FAIL: ${message}\n--- electron output ---\n${logs.slice(-4000)}`);
  child.kill();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
};

let target;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
  } catch {
    /* not up yet */
  }
}
if (!target) await fail('renderer page did not appear');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};
const evaluate = (expression) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (data) =>
      resolve(data.result?.result?.value ?? data.result?.exceptionDetails ?? data),
    );
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });

// Wait for the preload bridge.
for (let i = 0; i < 20; i += 1) {
  if ((await evaluate('typeof window.devbrain')) === 'object') break;
  await sleep(250);
}

const checks = await evaluate(`(async () => {
  const r = {};
  r.noRequire = typeof require === 'undefined';
  r.noProcess = typeof process === 'undefined';
  r.noModule = typeof module === 'undefined';
  r.bridgeFrozen = Object.isFrozen(window.devbrain);
  r.bridgeKeys = Object.keys(window.devbrain).sort().join(',');
  r.csp = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const info = await window.devbrain.invoke('system.getInfo', {});
  r.infoOk = info.ok && info.data.dataDirectoryConfigured === true;
  r.electron = info.ok ? info.data.electronVersion : null;
  const reg = await window.devbrain.invoke('projects.register', { rootPath: ${JSON.stringify(projectDir)} });
  r.registerOk = reg.ok && reg.data.isGitRepository === true;
  const dup = await window.devbrain.invoke('projects.register', { rootPath: ${JSON.stringify(projectDir)} });
  r.duplicateRejected = !dup.ok && dup.error.code === 'ALREADY_EXISTS';
  const list = await window.devbrain.invoke('projects.list', {});
  r.listCount = list.ok ? list.data.length : -1;
  const bad = await window.devbrain.invoke('projects.register', { rootPath: 'relative\\\\x' });
  r.invalidRejected = !bad.ok && bad.error.code === 'VALIDATION_FAILED';
  const unknown = await window.devbrain.invoke('fs.readAnything', {});
  r.unknownRejected = !unknown.ok && unknown.error.code === 'PERMISSION_DENIED';
  const unimpl = await window.devbrain.invoke('approvals.listPending', {});
  r.unimplementedHonest = !unimpl.ok && unimpl.error.code === 'UNSUPPORTED';
  const settings = await window.devbrain.invoke('settings.get', {});
  r.settingsOk = settings.ok && settings.data.telemetry === false;
  return r;
})()`);

ws.close();
child.kill();
await sleep(500);
await rm(tmp, { recursive: true, force: true }).catch(() => {});

console.log(JSON.stringify(checks, null, 2));
const expected = {
  noRequire: true,
  noProcess: true,
  noModule: true,
  bridgeFrozen: true,
  bridgeKeys: 'contractsVersion,invoke,subscribe',
  csp: true,
  infoOk: true,
  registerOk: true,
  duplicateRejected: true,
  listCount: 1,
  invalidRejected: true,
  unknownRejected: true,
  unimplementedHonest: true,
  settingsOk: true,
};
const failures = Object.entries(expected).filter(([k, v]) => checks?.[k] !== v);
if (failures.length) {
  console.error(
    'SMOKE FAIL:',
    failures.map(([k, v]) => `${k} expected ${v} got ${checks?.[k]}`).join('; '),
  );
  console.error(logs.slice(-4000));
  process.exit(1);
}
console.log('SMOKE OK');
