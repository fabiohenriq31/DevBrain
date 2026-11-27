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
 *  5. the production CSP meta tag is present;
 *  6. Phase 01 core: storage health, provider readiness without evidence (`configured`),
 *     agents with a default policy, OS-encrypted credentials (no plaintext in the DB file),
 *     sessions, real-path permission evaluation (outside scope, `.env`, inside);
 *  7. crash recovery: the app is killed with a live session and restarted — the session must
 *     come back `interrupted` and the unclean shutdown must be reported.
 *
 * Usage: pnpm --filter @devbrain/desktop build && node scripts/smoke-desktop.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const packagedBinary = process.env.DEVBRAIN_SMOKE_BINARY;
const electronPath =
  packagedBinary ?? createRequire(path.join(desktop, 'package.json'))('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'devbrain-smoke-'));
const projectDir = path.join(tmp, 'sample-project');
await mkdir(path.join(projectDir, '.git'), { recursive: true });

const userData = path.join(tmp, 'userdata');
let child;
let logs = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = async (message) => {
  console.error(`SMOKE FAIL: ${message}\n--- electron output ---\n${logs.slice(-4000)}`);
  child?.kill();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
};
const exited = () =>
  new Promise((r) =>
    child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r),
  );

/** Starts the app and returns an `evaluate(expression)` bound to its renderer. */
const launch = async () => {
  child = spawn(
    electronPath,
    [
      ...(packagedBinary ? [] : [desktop]),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', ELECTRON_ENABLE_LOGGING: '0' },
    },
  );
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
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
  for (let i = 0; i < 20; i += 1) {
    if ((await evaluate('typeof window.devbrain')) === 'object') break;
    await sleep(250);
  }
  return { evaluate, ws };
};

const SECRET = `smoke-secret-${crypto.randomUUID()}`;
const first = await launch();
const evaluate = first.evaluate;

const checks = JSON.parse(
  await evaluate(
    `(async () => {
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
  if (!reg.ok) r.registerError = JSON.stringify(reg.error);
  const dup = await window.devbrain.invoke('projects.register', { rootPath: ${JSON.stringify(projectDir)} });
  r.duplicateRejected = !dup.ok && dup.error.code === 'ALREADY_EXISTS';
  const list = await window.devbrain.invoke('projects.list', {});
  r.listCount = list.ok ? list.data.length : -1;
  const bad = await window.devbrain.invoke('projects.register', { rootPath: 'relative\\\\x' });
  r.invalidRejected = !bad.ok && bad.error.code === 'VALIDATION_FAILED';
  const unknown = await window.devbrain.invoke('fs.readAnything', {});
  r.unknownRejected = !unknown.ok && unknown.error.code === 'PERMISSION_DENIED';
  const adapters = await window.devbrain.invoke('providers.listAdapters', {});
  r.adaptersKnown = adapters.ok && adapters.data.some((item) => item.adapterKey === 'openai-codex-cli');
  const settings = await window.devbrain.invoke('settings.get', {});
  r.settingsOk = settings.ok && settings.data.telemetry === false;

  // ---- Phase 01 core ----
  const health = await window.devbrain.invoke('system.storageHealth', {});
  r.health = health.ok ? health.data.integrity + ':v' + health.data.schemaVersion : JSON.stringify(health.error);
  const prv = await window.devbrain.invoke('providers.register', { adapterKey: 'smoke-cli', kind: 'cli-agent', displayName: 'Smoke' });
  r.providerReadiness = prv.ok ? prv.data.readiness : JSON.stringify(prv.error);
  const agent = await window.devbrain.invoke('agents.register', { providerId: prv.data.provider.id, name: 'Smoke agent' });
  r.agentOk = agent.ok && agent.data.permissionPolicyId.startsWith('pol_');
  const cred = await window.devbrain.invoke('credentials.store', { storage: 'os-encrypted', label: 'smoke', secret: '__SECRET__' });
  r.credentialStored = cred.ok ? cred.data.storage : JSON.stringify(cred.error);
  const creds = await window.devbrain.invoke('credentials.list', {});
  r.credentialListHasNoSecret = creds.ok && !JSON.stringify(creds.data).includes('__SECRET__');
  if (!reg.ok) return r;
  const ws0 = reg.data.defaultWorkspaceId;
  const ses = await window.devbrain.invoke('sessions.start', { agentId: agent.data.id, projectId: reg.data.id, workspaceId: ws0, title: 'smoke' });
  r.sessionStatus = ses.ok ? ses.data.status : JSON.stringify(ses.error);
  const outside = await window.devbrain.invoke('permissions.evaluate', { agentId: agent.data.id, workspaceId: ws0, action: 'fs.read', path: __TMP__ });
  r.outsideNotAllowed = outside.ok && outside.data.decision !== 'allow';
  const secretFile = await window.devbrain.invoke('permissions.evaluate', { agentId: agent.data.id, workspaceId: ws0, action: 'fs.read', path: '.env' });
  r.envDenied = secretFile.ok && secretFile.data.decision === 'deny';
  const inside = await window.devbrain.invoke('permissions.evaluate', { agentId: agent.data.id, workspaceId: ws0, action: 'fs.read', path: 'src/index.ts' });
  r.insideAllowed = inside.ok && inside.data.decision === 'allow';
  const pending = await window.devbrain.invoke('approvals.listPending', {});
  r.approvalsOk = pending.ok && Array.isArray(pending.data);
  const gitStatus = await window.devbrain.invoke('git.status', { workspaceId: ws0 });
  r.gitStatusChannelOk = gitStatus.ok;
  const gitDiff = await window.devbrain.invoke('git.diff', { workspaceId: ws0 });
  r.gitDiffChannelOk = gitDiff.ok && typeof gitDiff.data.diff === 'string';
  for (let i = 0; i < 30 && !document.querySelector('.db-titlebar'); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  r.uiShellMounted = !!document.querySelector('.db-titlebar') && document.querySelectorAll('.db-nav-item').length === 5;
  r.uiThemeApplied = ['dark', 'light'].includes(document.documentElement.getAttribute('data-theme') ?? '');
  r.sessionId = ses.ok ? ses.data.id : null;
  return r;
})().then((r) => JSON.stringify(r), (e) => JSON.stringify({ error: String(e && e.stack || e) }))`
      .replaceAll('__SECRET__', SECRET)
      .replaceAll('__TMP__', JSON.stringify(tmp)),
  ),
);

// Exercise the real IPC -> Core authorization -> child process -> persisted event path.
const executionCheck = await evaluate(
  `(async () => {
    const submitted = await window.devbrain.invoke('executions.submit', {
      sessionId: __SID__,
      payload: { kind: 'command', executable: 'node', args: ['-e', 'process.stdout.write("smoke-exec")'] }
    });
    if (!submitted.ok) return { executionError: submitted.error.code };
    let result = null;
    for (let attempt = 0; attempt < 150; attempt++) {
      const pending = await window.devbrain.invoke('approvals.listPending', {});
      if (pending.ok) for (const approval of pending.data) {
        await window.devbrain.invoke('approvals.decide', {
          approvalId: approval.id, decision: 'approved', scope: 'session'
        });
      }
      const response = await window.devbrain.invoke('executions.getResult', { executionId: submitted.data.executionId });
      if (response.ok && response.data) { result = response.data; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const history = await window.devbrain.invoke('executions.listEvents', { executionId: submitted.data.executionId });
    return {
      executionStatus: result?.status ?? 'missing',
      executionStreamed: history.ok && history.data.some((event) => event.type === 'output' && event.chunk.includes('smoke-exec')),
      executionOrdered: history.ok && history.data.every((event, index) => event.seq === index)
    };
  })()`.replace('__SID__', JSON.stringify(checks.sessionId)),
);
Object.assign(checks, executionCheck);

// ---- simulated crash (kill without clean shutdown) + restart ----
first.ws.close();
child.kill('SIGKILL');
await exited();
await sleep(500);
const dbBytes = await readFile(path.join(userData, 'devbrain.db')).catch(() => Buffer.alloc(0));
const walBytes = await readFile(path.join(userData, 'devbrain.db-wal')).catch(() =>
  Buffer.alloc(0),
);
checks.noPlaintextSecretInDb =
  dbBytes.length > 0 && !dbBytes.includes(SECRET) && !walBytes.includes(SECRET);
const second = await launch();
const after = await second.evaluate(
  `(async () => {
  const r = {};
  const health = await window.devbrain.invoke('system.storageHealth', {});
  r.uncleanDetected = health.ok && health.data.uncleanShutdownDetected === true;
  r.recoveredSessions = health.ok ? health.data.recoveredSessions : -1;
  const s = await window.devbrain.invoke('sessions.get', { sessionId: '__SID__' });
  r.sessionAfterCrash = s.ok ? s.data.status : JSON.stringify(s.error);
  for (let i = 0; i < 30 && !document.querySelector('[data-testid="terminal-pane"]'); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  r.uiTerminalMounted = !!document.querySelector('[data-testid="terminal-pane"] .xterm');
  return r;
})()`.replaceAll('__SID__', checks?.sessionId ?? ''),
);
Object.assign(checks, after);
delete checks.sessionId;
const ws = second.ws;

ws.close();
child.kill();
await exited();
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
  adaptersKnown: true,
  settingsOk: true,
  health: 'ok:v2',
  providerReadiness: 'configured',
  agentOk: true,
  credentialStored: 'os-encrypted',
  credentialListHasNoSecret: true,
  sessionStatus: 'active',
  outsideNotAllowed: true,
  envDenied: true,
  insideAllowed: true,
  approvalsOk: true,
  gitStatusChannelOk: true,
  gitDiffChannelOk: true,
  uiShellMounted: true,
  uiThemeApplied: true,
  executionStatus: 'completed',
  executionStreamed: true,
  executionOrdered: true,
  noPlaintextSecretInDb: true,
  uncleanDetected: true,
  recoveredSessions: 1,
  sessionAfterCrash: 'interrupted',
  uiTerminalMounted: true,
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
