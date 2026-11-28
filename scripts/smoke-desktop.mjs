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
import { createServer } from 'node:http';
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
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
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
  return { cdp, evaluate, ws };
};

const SECRET = `smoke-secret-${crypto.randomUUID()}`;
const controlledProvider = createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${SECRET}`;
  res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      !authorized
        ? { error: { message: 'invalid key' } }
        : req.url?.endsWith('/key')
          ? { data: { label: 'controlled-key' } }
          : {
              data: [
                {
                  id: 'coder-free',
                  context_window: 32768,
                  supported_parameters: ['tools'],
                  pricing: { prompt: '0', completion: '0' },
                },
                {
                  id: 'coder-paid',
                  context_window: 131072,
                  supported_parameters: ['tools'],
                  pricing: { prompt: '0.000001', completion: '0.000002' },
                },
              ],
            },
    ),
  );
});
await new Promise((resolve) => controlledProvider.listen(0, '127.0.0.1', resolve));
const controlledAddress = controlledProvider.address();
if (!controlledAddress || typeof controlledAddress === 'string')
  throw new Error('No controlled provider');
const controlledUrl = `http://127.0.0.1:${controlledAddress.port}/v1`;
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
  r.projectId = reg.ok ? reg.data.id : null;
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

// Real Electron IPC against a controlled local provider; no user credentials or external APIs.
const onboardingCheck = await evaluate(
  `(async () => {
    const key = await window.devbrain.invoke('credentials.store', { storage: 'os-encrypted', label: 'Controlled Groq', secret: __KEY__ });
    const invalid = await window.devbrain.invoke('credentials.store', { storage: 'os-encrypted', label: 'Controlled invalid', secret: 'invalid-local-test' });
    const endpoint = await window.devbrain.invoke('ai.endpoints.save', { id: 'ep-controlled-groq', providerId: 'groq', baseUrl: __URL__, protocol: 'openai-chat', documentationUrl: null });
    const connection = await window.devbrain.invoke('ai.connections.save', { id: 'conn-controlled-groq', providerId: 'groq', endpointId: 'ep-controlled-groq', credentialId: key.data.id, enabled: true, status: 'unknown', lastVerifiedAt: null });
    const discovered = await window.devbrain.invoke('ai.connections.discover', { id: 'conn-controlled-groq' });
    const model = await window.devbrain.invoke('ai.models.save', { id: 'model-controlled-free', providerId: 'groq', upstreamModelId: 'coder-free', name: 'Coder Free', capabilities: { input: ['text'], output: ['text'], tools: false, streaming: true, structuredOutput: false, reasoning: false, contextTokens: 32768, outputTokens: null }, pricing: null, lifecycle: 'unknown', sourceId: 'provider-api', verifiedAt: null });
    await window.devbrain.invoke('ai.endpoints.save', { id: 'ep-remote-groq', providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-chat', documentationUrl: null });
    await window.devbrain.invoke('ai.connections.save', { id: 'conn-remote-groq', providerId: 'groq', endpointId: 'ep-remote-groq', credentialId: key.data.id, enabled: true, status: 'unknown', lastVerifiedAt: null });
    const route = await window.devbrain.invoke('ai.routes.save', { id: 'route-remote-spoof', modelId: 'model-controlled-free', connectionId: 'conn-remote-groq', priority: 10, enabled: true, localOnly: true });
    // A remote endpoint cannot be disguised as local.
    const validRoute = await window.devbrain.invoke('ai.routes.save', { id: 'route-controlled-free', modelId: 'model-controlled-free', connectionId: 'conn-controlled-groq', priority: 10, enabled: true, localOnly: false });
    const policySaved = await window.devbrain.invoke('ai.projectPolicy.save', { projectId: __PROJECT__, privacyClass: 'restricted' });
    const policyRead = await window.devbrain.invoke('ai.projectPolicy.get', { projectId: __PROJECT__ });
    await window.devbrain.invoke('ai.connections.save', { id: 'conn-controlled-invalid', providerId: 'groq', endpointId: 'ep-controlled-groq', credentialId: invalid.data.id, enabled: true, status: 'unknown', lastVerifiedAt: null });
    const rejected = await window.devbrain.invoke('ai.connections.discover', { id: 'conn-controlled-invalid' });
    const listed = await Promise.all([
      window.devbrain.invoke('ai.connections.list', {}),
      window.devbrain.invoke('ai.models.list', {}),
      window.devbrain.invoke('ai.routes.list', {}),
    ]);
    return {
      controlledAuth: discovered.ok && discovered.data.authenticated,
      multipleModels: discovered.ok && discovered.data.models.length === 2,
      invalidCredentialRejected: !rejected.ok && rejected.error.code === 'CREDENTIAL_UNAVAILABLE',
      modelPersisted: model.ok && listed[1].ok && listed[1].data.some((item) => item.id === model.data.id),
      routePersisted: validRoute.ok && listed[2].ok && listed[2].data.some((item) => item.id === validRoute.data.id),
      localSpoofRejected: !route.ok,
      connectionPersisted: connection.ok && listed[0].ok && listed[0].data.some((item) => item.id === connection.data.id && item.status === 'ready'),
      projectPrivacyPersisted: policySaved.ok && policyRead.ok && policyRead.data.privacyClass === 'restricted',
    };
  })()`
    .replace('__KEY__', JSON.stringify(SECRET))
    .replace('__URL__', JSON.stringify(controlledUrl))
    .replaceAll('__PROJECT__', JSON.stringify(checks.projectId)),
);
Object.assign(checks, onboardingCheck);

// ---- simulated crash (kill without clean shutdown) + restart ----
// First-run Electron safeStorage key material is written to Local State asynchronously.
await sleep(12_000);
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
  const aiProbe = await window.devbrain.invoke('ai.catalog.list', {});
  r.aiChannelContractValid = aiProbe.ok || aiProbe.error.code === 'UNSUPPORTED';
  const navItems = document.querySelectorAll('.db-nav-item');
  if (navItems[2]) navItems[2].click();
  for (let i = 0; i < 20 && document.querySelectorAll('[role="tab"]').length < 11; i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  r.uiAiCenterMounted = document.querySelectorAll('[role="tab"]').length === 11;
  const marketplaceTab = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes('Marketplace'));
  marketplaceTab?.click();
  for (let i = 0; i < 20 && ![...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Cadastro assistido')); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Cadastro assistido'))?.click();
  for (let i = 0; i < 20 && !document.querySelector('[role="dialog"]'); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  const onboardingDialog = document.querySelector('[role="dialog"]');
  r.wizardPreventsFalseCompletion = !!onboardingDialog && !onboardingDialog.textContent?.includes('Concluir cadastro') && onboardingDialog.textContent?.includes('Escolher credencial');
  r.wizardScrollEnabled = !!onboardingDialog && getComputedStyle(onboardingDialog.children[1]).overflowY === 'auto';
  onboardingDialog?.querySelector('button[aria-label="Fechar"]')?.click();
  if (navItems[0]) navItems[0].click();
  for (let i = 0; i < 20 && !document.querySelector('[data-testid="workspace-composer-scroll"]'); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  const composer = document.querySelector('[data-testid="workspace-composer-scroll"]');
  r.workspaceScrollEnabled = !!composer && getComputedStyle(composer).overflowY === 'auto';
  for (let i = 0; i < 30 && !document.querySelector('select option[value="model-controlled-free"]'); i += 1) {
    await new Promise((res) => setTimeout(res, 100));
  }
  r.gatewayModelSelectorMounted = !!document.querySelector('select option[value="model-controlled-free"]');
  return r;
})()`.replaceAll('__SID__', checks?.sessionId ?? ''),
);
Object.assign(checks, after);
const wizardUi = await second.evaluate(
  `(async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
    const dialog = () => document.querySelector('[role="dialog"]');
    const button = (label) => [...(dialog()?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.includes(label));
    const wait = async (label) => {
      for (let i = 0; i < 40; i += 1) {
        const found = button(label);
        if (found && !found.disabled) return found;
        await pause();
      }
      throw new Error('Wizard button unavailable: ' + label + ' / ' + dialog()?.textContent?.slice(-450));
    };
    const set = (element, value) => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    try {
      document.querySelectorAll('.db-nav-item')[2]?.click();
      await pause();
      [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes('Marketplace'))?.click();
      await pause();
      [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Cadastro assistido'))?.click();
      await pause();
      set(dialog().querySelector('input'), 'openrouter');
      await pause();
      (await wait('Escolher credencial')).click();
      await pause();
      const mode = dialog().querySelector('select');
      set(mode, 'existing');
      await pause();
      const existing = [...dialog().querySelectorAll('select')].find((item) => [...item.options].some((option) => option.textContent?.startsWith('smoke (')));
      const existingOption = [...existing.options].find((option) => option.textContent?.startsWith('smoke ('));
      set(existing, existingOption.value);
      (await wait('Armazenar credencial')).click();
      const register = await wait('Registrar conexão no Gateway');
      const base = [...dialog().querySelectorAll('input')].find((item) => item.value.includes('openrouter.ai'));
      set(base, __URL__);
      register.click();
      (await wait('Executar validação de autenticação')).click();
      const saveModel = await wait('Registrar modelo e avançar');
      const models = [...dialog().querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === 'coder-free'));
      set(models, 'coder-free');
      saveModel.click();
      (await wait('Salvar rota e configurar política')).click();
      const finish = await wait('Concluir cadastro');
      const privacy = [...dialog().querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === 'personal-private'));
      set(privacy, 'personal-private');
      const approval = [...dialog().querySelectorAll('input[type="checkbox"]')].find((item) => item.closest('label')?.textContent?.includes('Aprovo este provedor'));
      approval?.click();
      finish.click();
      await wait('Fechar');
      const [connections, modelsSaved, routes] = await Promise.all([
        window.devbrain.invoke('ai.connections.list', {}),
        window.devbrain.invoke('ai.models.list', {}),
        window.devbrain.invoke('ai.routes.list', {}),
      ]);
      return {
        wizardUiComplete: dialog()?.textContent?.includes('Configuração persistida') === true,
        wizardUiPersisted: connections.ok && modelsSaved.ok && routes.ok &&
          connections.data.some((c) => c.providerId === 'openrouter' && c.status === 'ready') &&
          modelsSaved.data.some((m) => m.id === 'openrouter-coder-free' && m.pricing?.inputPerMillion === 0 && m.capabilities.tools) &&
          routes.data.some((r) => r.modelId === 'openrouter-coder-free' && connections.data.some((c) => c.id === r.connectionId && c.providerId === 'openrouter')),
      };
    } catch (error) {
      return { wizardUiComplete: false, wizardUiPersisted: false, wizardUiError: String(error?.stack ?? error), wizardUiText: dialog()?.textContent?.slice(-500) };
    } finally {
      dialog()?.querySelector('button[aria-label="Fechar"]')?.click();
    }
  })()`.replace('__URL__', JSON.stringify(controlledUrl)),
);
Object.assign(checks, wizardUi);
await second.evaluate(`(() => {
  document.querySelectorAll('.db-nav-item')[2]?.click();
})()`);
await sleep(150);
await second.evaluate(`(() => {
  [...document.querySelectorAll('[role="tab"]')].find((tab) =>
    tab.textContent?.includes('Visão geral') || tab.textContent?.includes('Overview'))?.click();
})()`);
await second.cdp('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 460,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(200);
const scrollTarget = await second.evaluate(`(() => {
  const el = document.querySelector('[data-scroll-region="ai-center-overview"]');
  if (!el) return null;
  el.scrollTop = 0;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, sh: el.scrollHeight, ch: el.clientHeight };
})()`);
if (scrollTarget && scrollTarget.sh > scrollTarget.ch) {
  await second.cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(scrollTarget.x),
    y: Math.round(scrollTarget.y),
  });
  await second.cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(scrollTarget.x),
    y: Math.round(scrollTarget.y),
    deltaX: 0,
    deltaY: 420,
  });
  await sleep(180);
}
checks.uiRealWheelScrollOk = Boolean(
  await second.evaluate(
    `(document.querySelector('[data-scroll-region="ai-center-overview"]')?.scrollTop ?? 0) > 0`,
  ),
);
delete checks.sessionId;
delete checks.projectId;
const ws = second.ws;

ws.close();
child.kill();
await exited();
await sleep(500);
await rm(tmp, { recursive: true, force: true }).catch(() => {});
await new Promise((resolve) => controlledProvider.close(() => resolve()));

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
  health: 'ok:v5',
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
  aiChannelContractValid: true,
  uiAiCenterMounted: true,
  workspaceScrollEnabled: true,
  gatewayModelSelectorMounted: true,
  wizardPreventsFalseCompletion: true,
  wizardScrollEnabled: true,
  wizardUiComplete: true,
  wizardUiPersisted: true,
  controlledAuth: true,
  multipleModels: true,
  invalidCredentialRejected: true,
  modelPersisted: true,
  routePersisted: true,
  localSpoofRejected: true,
  connectionPersisted: true,
  projectPrivacyPersisted: true,
  uiRealWheelScrollOk: true,
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
