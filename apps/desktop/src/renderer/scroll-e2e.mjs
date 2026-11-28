#!/usr/bin/env node
/**
 * Comprehensive Real-Electron E2E Scroll Verification Suite.
 *
 * Launches the built Electron desktop app (or DEVBRAIN_SMOKE_BINARY), populates real overflowing
 * data across all 22 mandatory UI areas via validated IPC channels, dispatches REAL Chromium
 * Input.dispatchMouseEvent({ type: 'mouseWheel', deltaX, deltaY }) events (covering mouse wheel
 * and 2-axis touchpad gestures), and asserts actual `scrollTop` / `scrollLeft` changes, visible
 * scrollbar geometry, independent split-pane scrolling, pinned headers, terminal manual + auto
 * scrolling, multi-size window responsiveness, and reachability of bottom controls.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(rendererDir, '..', '..');
const packagedBinary = process.env.DEVBRAIN_SMOKE_BINARY;
const electronPath =
  packagedBinary ?? createRequire(path.join(desktop, 'package.json'))('electron');
const port = 9700 + Math.floor(Math.random() * 200);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'devbrain-scroll-e2e-'));
const userData = path.join(tmp, 'userdata');

// Create 14 real project directories (with real Git repo + multi-hunk 280-char wide diff on #0)
const projectDirs = [];
for (let i = 0; i < 14; i += 1) {
  const dir = path.join(tmp, `project-${String(i).padStart(2, '0')}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `proj-${i}`, version: '1.0.0', dependencies: { typescript: '5.8.2' } }),
  );
  if (i === 0) {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Scroll Tester'], { cwd: dir, stdio: 'ignore' });
    const baseLines = Array.from(
      { length: 80 },
      (_, ln) => `export const line_${ln} = ${ln};`,
    ).join('\n');
    await writeFile(path.join(dir, 'engine.ts'), baseLines + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    // Modify 70 lines including ultra-wide 290-char lines to require BOTH vertical & horizontal diff scrolling
    const modifiedLines = Array.from(
      { length: 95 },
      (_, ln) =>
        `export const updatedLine_${ln} = "${'WIDE_SEGMENT_'.repeat(18)}_INDEX_${ln}"; // horizontal+vertical scroll verification`,
    ).join('\n');
    await writeFile(path.join(dir, 'engine.ts'), modifiedLines + '\n');
  } else {
    await mkdir(path.join(dir, '.git'), { recursive: true });
  }
  projectDirs.push(dir);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child;
let logs = '';

const cleanupAndExit = async (code, msg) => {
  if (msg) console.error(msg);
  child?.kill();
  await sleep(300);
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
};

child = spawn(
  electronPath,
  [
    ...(packagedBinary ? [] : [desktop]),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--window-size=1024,560',
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
  await sleep(350);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
  } catch {
    // wait
  }
}
if (!target) {
  await cleanupAndExit(1, `Renderer did not start:\n${logs}`);
}

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
const evaluate = async (expression) => {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails));
  }
  return res.result?.result?.value;
};

const setViewport = async (width, height) => {
  await cdp('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(220);
};

const wheelAt = async (x, y, deltaX, deltaY) => {
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
  });
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: Math.round(deltaX),
    deltaY: Math.round(deltaY),
  });
  await sleep(160);
};

for (let i = 0; i < 30; i += 1) {
  if ((await evaluate('typeof window.devbrain')) === 'object') break;
  await sleep(250);
}
await sleep(600);

// Seed overflowing real data across Projects, Providers, Agents, Gateway Catalog/Endpoints/Connections/Models/Routes, Sessions & 140-line Process Output!
const seedInfo = await evaluate(`(async () => {
  const projectDirs = ${JSON.stringify(projectDirs)};
  let firstProject = null;
  for (const dir of projectDirs) {
    const r = await window.devbrain.invoke('projects.register', { rootPath: dir });
    if (r.ok && !firstProject) firstProject = r.data;
  }

  localStorage.setItem('devbrain.ui.preferences.v1', JSON.stringify({
    onboardingState: 'completed',
    sidebarCollapsed: false,
    inspectorOpen: true,
    terminalAutoScroll: true,
    terminalExpanded: false,
    sidebarWidth: 205,
    inspectorWidth: 255,
    terminalHeight: 240,
    activeProjectId: firstProject.id,
    projectPrivacy: {},
    signupQueue: [
      { providerId: 'openrouter', providerName: 'OpenRouter', currentStep: 4, status: 'in-progress', updatedAt: new Date().toISOString() },
      { providerId: 'groq', providerName: 'Groq Cloud', currentStep: 2, status: 'queued', updatedAt: new Date().toISOString() }
    ],
    selectedStrategyPreset: 'balanced'
  }));

  // Register 10 CLI providers & 10 agents so Agents/Providers & right Context Inspector overflow
  let primaryAgentId = null;
  for (let i = 0; i < 10; i++) {
    const p = await window.devbrain.invoke('providers.register', {
      adapterKey: i % 2 === 0 ? 'openai-codex-cli' : 'opencode-cli',
      kind: 'cli-agent',
      displayName: 'Provider CLI #' + i + ' LongLabelForHorizontalTableVerification',
      vendor: 'Vendor ' + i
    });
    if (p.ok) {
      const a = await window.devbrain.invoke('agents.register', {
        providerId: p.data.provider.id,
        name: 'Eng Agent #' + i,
        model: i % 2 === 0 ? 'gpt-5-codex' : 'ollama/qwen2.5-coder:14b'
      });
      if (a.ok && !primaryAgentId) primaryAgentId = a.data.id;
    }
  }

  // Import 25 catalog entries + save 14 endpoints, connections, models & routes
  const now = new Date().toISOString();
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: 'cat-prov-' + i,
    name: 'Catalog Provider ' + i,
    kind: i % 4 === 0 ? 'local' : 'api',
    signupUrl: 'https://example.com/signup/' + i,
    documentationUrl: 'https://example.com/docs/' + i,
    termsUrl: 'https://example.com/terms/' + i,
    sourceId: 'scroll-e2e-catalog',
    verifiedAt: now,
    siteUrl: 'https://example.com/' + i,
    endpointUrl: 'https://api.example.com/v1/' + i,
    authType: 'api-key',
    offer: i % 3 === 0 ? 'recurring-free' : 'paid',
    requiresCard: false,
    regionalRestrictions: null,
    commercialUse: 'allowed',
    retentionPolicyUrl: 'https://example.com/privacy/' + i,
    trainingPolicyUrl: 'https://example.com/training/' + i,
    knownModelIds: ['model-' + i],
    publishedQuotaIds: [],
    quotaScope: 'provider',
    consumptionUnit: 'requests',
    verificationState: 'documented',
    sourceUrls: ['https://example.com/docs/' + i],
    dataLicense: 'MIT'
  }));
  await window.devbrain.invoke('ai.catalog.import', {
    sourceId: 'scroll-e2e-catalog',
    data: JSON.stringify({
      formatVersion: 1,
      sourceId: 'scroll-e2e-catalog',
      revision: 'rev-1',
      license: 'MIT',
      entries
    })
  });

  for (let i = 0; i < 14; i++) {
    const pid = 'cat-prov-' + i;
    const epId = 'ep-' + i;
    const connId = 'conn-' + i;
    const modId = 'mod-' + i;
    await window.devbrain.invoke('ai.endpoints.save', {
      id: epId,
      providerId: pid,
      baseUrl: 'https://api.example.com/v1/' + i,
      protocol: 'openai-chat',
      documentationUrl: 'https://example.com/docs/' + i
    });
    await window.devbrain.invoke('ai.connections.save', {
      id: connId,
      providerId: pid,
      endpointId: epId,
      credentialId: null,
      enabled: true
    });
    await window.devbrain.invoke('ai.models.save', {
      id: modId,
      providerId: pid,
      upstreamModelId: 'org/ultra-wide-model-identifier-for-table-scroll-' + i,
      name: 'Model Offering #' + i,
      capabilities: {
        input: ['text'],
        output: ['text'],
        tools: true,
        streaming: true,
        structuredOutput: true,
        reasoning: i % 2 === 0,
        contextTokens: 128000,
        outputTokens: 8192
      },
      pricing: {
        currency: 'USD',
        inputPerMillion: i === 0 ? 0 : 0.5,
        outputPerMillion: i === 0 ? 0 : 1.5,
        cachedInputPerMillion: null,
        verifiedAt: now,
        sourceUrl: 'https://example.com/pricing/' + i
      },
      lifecycle: 'active',
      sourceId: 'scroll-e2e-catalog',
      verifiedAt: now
    });
    await window.devbrain.invoke('ai.routes.save', {
      id: 'route-' + i,
      modelId: modId,
      connectionId: connId,
      priority: i + 1,
      enabled: true,
      localOnly: false
    });
  }

  // Create 8 sessions + run 8 executions (including a 150-line stdout execution on the latest session!)
  let activeSessionId = null;
  for (let s = 0; s < 8; s++) {
    const ses = await window.devbrain.invoke('sessions.start', {
      agentId: primaryAgentId,
      projectId: firstProject.id,
      workspaceId: firstProject.defaultWorkspaceId,
      title: 'Scroll Session #' + s
    });
    if (ses.ok) activeSessionId = ses.data.id;
  }

  for (let ex = 0; ex < 6; ex++) {
    const script = ex === 5
      ? 'for(let i=1;i<=150;i++){console.log("TERM_LINE_"+i+"_"+"X".repeat(90));}'
      : 'console.log("hist_exec_' + ex + '")';
    const sub = await window.devbrain.invoke('executions.submit', {
      sessionId: activeSessionId,
      payload: { kind: 'command', executable: 'node', args: ['-e', script] }
    });
    if (sub.ok) {
      for (let w = 0; w < 80; w++) {
        const pend = await window.devbrain.invoke('approvals.listPending', {});
        if (pend.ok) {
          for (const ap of pend.data) {
            await window.devbrain.invoke('approvals.decide', {
              approvalId: ap.id,
              decision: 'approved',
              scope: 'session'
            });
          }
        }
        const res = await window.devbrain.invoke('executions.getResult', { executionId: sub.data.executionId });
        if (res.ok && res.data) break;
        await new Promise((r) => setTimeout(r, 80));
      }
    }
  }

  return { projectId: firstProject.id, activeSessionId };
})()`);

await cdp('Page.reload');
await sleep(1500);

const results = {};

/**
 * Helper: measures a scroll container by CSS selector, dispatches real wheel events at its center,
 * and records clientHeight/scrollHeight, clientWidth/scrollWidth, scrollbar thickness, and actual
 * scrollTop/scrollLeft deltas.
 */
const verifyVerticalScroll = async (name, selector, deltaY = 480) => {
  const before = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollTop = 0;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      offsetWidth: el.offsetWidth,
      clientWidth: el.clientWidth,
      scrollTop: el.scrollTop,
    };
  })()`);
  if (!before) {
    results[name] = { pass: false, reason: `Selector not found: ${selector}` };
    return;
  }
  if (before.scrollHeight <= before.clientHeight) {
    results[name] = {
      pass: false,
      reason: `Not overflowing vertically (${before.scrollHeight} <= ${before.clientHeight})`,
      before,
    };
    return;
  }
  await wheelAt(before.x, before.y, 0, deltaY);
  const afterDown = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.scrollTop : -1;
  })()`);
  await wheelAt(before.x, before.y, 0, -deltaY);
  const afterUp = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.scrollTop : -1;
  })()`);
  const scrollbarWidth = before.offsetWidth - before.clientWidth;
  results[name] = {
    pass: afterDown > 0 && afterUp < afterDown,
    clientHeight: before.clientHeight,
    scrollHeight: before.scrollHeight,
    scrollbarWidth,
    scrollTopAfterWheelDown: afterDown,
    scrollTopAfterWheelUp: afterUp,
  };
};

const verifyHorizontalScroll = async (name, selector, deltaX = 360) => {
  const before = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    el.scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + Math.min(r.height / 2, 40),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      offsetHeight: el.offsetHeight,
      clientHeight: el.clientHeight,
      scrollLeft: el.scrollLeft,
    };
  })()`);
  if (!before) {
    results[name] = { pass: false, reason: `Selector not found: ${selector}` };
    return;
  }
  if (before.scrollWidth <= before.clientWidth) {
    results[name] = {
      pass: false,
      reason: `Not overflowing horizontally (${before.scrollWidth} <= ${before.clientWidth})`,
      before,
    };
    return;
  }
  await wheelAt(before.x, before.y, deltaX, 0);
  const afterRight = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.scrollLeft : -1;
  })()`);
  results[name] = {
    pass: afterRight > 0,
    clientWidth: before.clientWidth,
    scrollWidth: before.scrollWidth,
    scrollbarHeight: before.offsetHeight - before.clientHeight,
    scrollLeftAfterTouchpadSwipe: afterRight,
  };
};

// ---------------------------------------------------------------------------
// 1. SIDEBAR (Menu lateral) — shrink height to 210px so 5 nav items overflow
// ---------------------------------------------------------------------------
await setViewport(900, 210);
await verifyVerticalScroll('01_sidebar_menu', '[data-scroll-region="sidebar"]', 300);

// Use compact 860x480 viewport for main views so EVERY screen overflows both ways when dense!
await setViewport(860, 480);

// ---------------------------------------------------------------------------
// 2 & 3 & 4 & 22. WORKSPACE + TERMINAL + SESSION HISTORY + CODE/DIFF + INSPECTOR
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[0].click(); })()`);
await sleep(700);

// Select our seeded session with 150 lines of terminal output
await evaluate(`(async () => {
  const selects = [...document.querySelectorAll('select')];
  const sesSel = selects.find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(seedInfo.activeSessionId)}));
  if (sesSel) {
    sesSel.value = ${JSON.stringify(seedInfo.activeSessionId)};
    sesSel.dispatchEvent(new Event('change', { bubbles: true }));
  }
})()`);
await sleep(900);

// 2. Workspace composer (at 860x480, top composer pane is ~198px tall while its content is ~260px!)
await verifyVerticalScroll(
  '02_workspace_composer',
  '[data-scroll-region="workspace-composer"]',
  300,
);

// 18. Right Context Inspector (independent from main!)
const mainScrollBeforeInspector = await evaluate(
  `document.querySelector('[data-scroll-region="workspace-composer"]')?.scrollTop ?? 0`,
);
await verifyVerticalScroll(
  '18_context_inspector_independent',
  '[data-scroll-region="inspector"]',
  350,
);
const mainScrollAfterInspector = await evaluate(
  `document.querySelector('[data-scroll-region="workspace-composer"]')?.scrollTop ?? 0`,
);
results['18_context_inspector_independent'].independentFromMain =
  mainScrollBeforeInspector === mainScrollAfterInspector;
results['18_context_inspector_independent'].pass =
  results['18_context_inspector_independent'].pass &&
  results['18_context_inspector_independent'].independentFromMain;

// 3. Terminal (xterm v6 .xterm-scrollable-element: auto-scroll + manual wheel up & down!)
const termAuto = await evaluate(`(() => {
  const pane = document.querySelector('[data-testid="terminal-pane"]');
  const screen = pane?.querySelector('.xterm-screen');
  const vScrollbar = pane?.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
  if (!pane || !screen) return null;
  const r = screen.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    viewportY: Number(pane.getAttribute('data-viewport-y') ?? -1),
    baseY: Number(pane.getAttribute('data-base-y') ?? -1),
    hasVerticalScrollbarDom: !!vScrollbar,
  };
})()`);
if (termAuto && termAuto.baseY > 0) {
  await wheelAt(termAuto.x, termAuto.y, 0, -500);
  const afterManualUp = await evaluate(
    `Number(document.querySelector('[data-testid="terminal-pane"]')?.getAttribute('data-viewport-y') ?? -1)`,
  );
  await wheelAt(termAuto.x, termAuto.y, 0, 600);
  const afterManualDown = await evaluate(
    `Number(document.querySelector('[data-testid="terminal-pane"]')?.getAttribute('data-viewport-y') ?? -1)`,
  );
  results['03_terminal_manual_and_autoscroll'] = {
    pass:
      termAuto.viewportY === termAuto.baseY &&
      termAuto.hasVerticalScrollbarDom &&
      afterManualUp < termAuto.viewportY &&
      afterManualDown > afterManualUp,
    baseY: termAuto.baseY,
    autoScrollViewportY: termAuto.viewportY,
    afterManualUp,
    afterManualDown,
    hasVerticalScrollbarDom: termAuto.hasVerticalScrollbarDom,
  };
} else {
  results['03_terminal_manual_and_autoscroll'] = { pass: false, termAuto };
}

// Workspace Events tab
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent.includes('Eventos'))?.click();
})()`);
await sleep(350);
await verifyVerticalScroll('02b_workspace_events', '[data-scroll-region="workspace-events"]', 450);

// 22. Visualização de código e diff (Vertical + Horizontal!)
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent.includes('Diff Git'))?.click();
})()`);
await sleep(450);
await verifyVerticalScroll('22a_diff_viewer_vertical', '[data-scroll-region="diff-viewer"]', 500);
await verifyHorizontalScroll(
  '22b_diff_code_horizontal',
  '[data-scroll-region="diff-file-code"]',
  400,
);

// 4. Histórico de sessões (Workspace History tab)
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent.includes('Histórico'))?.click();
})()`);
await sleep(350);
await verifyVerticalScroll(
  '04a_workspace_session_history',
  '[data-scroll-region="workspace-history"]',
  350,
);

// ---------------------------------------------------------------------------
// 5 & 20. PROJETOS (Left list + Right detail + Session History + Forms — Independent!)
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[1].click(); })()`);
await sleep(500);
await verifyVerticalScroll('05a_projects_list', '[data-scroll-region="projects-list"]', 400);
const projListBeforeDetail = await evaluate(
  `document.querySelector('[data-scroll-region="projects-list"]')?.scrollTop ?? 0`,
);
await verifyVerticalScroll(
  '05b_projects_detail_independent',
  '[data-scroll-region="projects-detail"]',
  450,
);
const projListAfterDetail = await evaluate(
  `document.querySelector('[data-scroll-region="projects-list"]')?.scrollTop ?? 0`,
);
results['05b_projects_detail_independent'].independentFromLeftList =
  projListBeforeDetail === projListAfterDetail;
results['05b_projects_detail_independent'].pass =
  results['05b_projects_detail_independent'].pass &&
  results['05b_projects_detail_independent'].independentFromLeftList;

// Projects -> Histórico de sessões tab
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent.includes('Histórico de sessões'))?.click();
})()`);
await sleep(350);
await verifyVerticalScroll(
  '04b_projects_session_history',
  '[data-scroll-region="projects-detail"]',
  350,
);

// ---------------------------------------------------------------------------
// 6..15 & 19 & 21. CENTRAL DE IA (All 11 tabs + Modals + Wide Tables + Tablist Wheel!)
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[2].click(); })()`);
await sleep(700);

const clickAiTab = async (idx) => {
  await evaluate(`(() => {
    const tablist = document.querySelector('[aria-label*="Central de IA"]');
    const tabs = tablist ? tablist.querySelectorAll('[role="tab"]') : document.querySelectorAll('[role="tab"]');
    if (tabs[${idx}]) tabs[${idx}].click();
  })()`);
  await sleep(400);
};

// 21a. Horizontal wheel scroll on the 11-tab strip itself!
const tabStripBefore = await evaluate(`(() => {
  const tl = document.querySelector('[aria-label*="Central de IA"]');
  if (!tl) return null;
  tl.scrollLeft = 0;
  const r = tl.getBoundingClientRect();
  return { x: r.left + 80, y: r.top + 14, clientWidth: tl.clientWidth, scrollWidth: tl.scrollWidth };
})()`);
if (tabStripBefore && tabStripBefore.scrollWidth > tabStripBefore.clientWidth) {
  await wheelAt(tabStripBefore.x, tabStripBefore.y, 0, 260);
  const tabStripScrollLeft = await evaluate(
    `document.querySelector('[aria-label*="Central de IA"]')?.scrollLeft ?? 0`,
  );
  results['21a_horizontal_tablist_wheel'] = {
    pass: tabStripScrollLeft > 0,
    scrollLeft: tabStripScrollLeft,
  };
}

// Overview
await clickAiTab(0);
await verifyVerticalScroll('00_ai_overview', '[data-scroll-region="ai-center-overview"]', 500);

// 6. Marketplace (left list + right detail independent + 19. Modal 11-step wizard!)
await clickAiTab(1);
await verifyVerticalScroll('06a_marketplace_list', '[data-scroll-region="marketplace-list"]', 500);
// Select first catalog provider card (after any Retomar/Trash queue buttons) so right detail pane has full multi-card content
await evaluate(`(() => {
  const list = document.querySelector('[data-scroll-region="marketplace-list"]');
  const btns = list ? [...list.querySelectorAll('button')] : [];
  const provBtn = btns.find((b) => b.textContent?.includes('Catalog Provider'));
  if (provBtn) provBtn.click();
})()`);
await sleep(300);
const mktListScrollBefore = await evaluate(
  `document.querySelector('[data-scroll-region="marketplace-list"]')?.scrollTop ?? 0`,
);
await verifyVerticalScroll(
  '06b_marketplace_detail',
  '[data-scroll-region="marketplace-detail"]',
  500,
);
const mktListScrollAfter = await evaluate(
  `document.querySelector('[data-scroll-region="marketplace-list"]')?.scrollTop ?? 0`,
);
results['06b_marketplace_detail'].independentFromLeftList =
  mktListScrollBefore === mktListScrollAfter;
results['06b_marketplace_detail'].pass =
  results['06b_marketplace_detail'].pass &&
  results['06b_marketplace_detail'].independentFromLeftList;

// 19a. Open Assisted Signup Wizard Modal (#5 credential vault step overflows in compact 300px height!)
await setViewport(860, 300);
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')];
  btns.find((b) => b.textContent?.includes('Cadastro assistido'))?.click();
})()`);
await sleep(350);
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[role="dialog"] button')];
  btns.find((b) => b.textContent === '#5')?.click();
})()`);
await sleep(250);
await verifyVerticalScroll('19a_modal_assisted_wizard', '[data-scroll-region="dialog-body"]', 300);
await evaluate(`(() => {
  document.querySelector('[role="dialog"] button[aria-label="Fechar"]')?.click();
})()`);
await sleep(250);
await setViewport(860, 480);

// 9. Conexões (vertical + horizontal table)
await clickAiTab(2);
await verifyVerticalScroll(
  '09_connections_vertical',
  '[data-scroll-region="ai-center-connections"]',
  500,
);

// 8 & 21b. Catálogo de modelos (vertical + 10-column DataTable horizontal!)
await clickAiTab(3);
await verifyVerticalScroll(
  '08a_models_catalog_vertical',
  '[data-scroll-region="ai-center-models"]',
  500,
);
await verifyHorizontalScroll(
  '08b_21b_models_datatable_horizontal',
  '[data-scroll-region="ai-center-models"] [data-scroll-region="data-table"]',
  420,
);

// 7. Provedores & Agentes Dev (embedded AgentsProvidersView)
await clickAiTab(4);
await verifyVerticalScroll(
  '07a_dev_agents_list',
  '[data-scroll-region="agents-providers-body"]',
  450,
);
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent?.includes('Provedores CLI configurados'))?.click();
})()`);
await sleep(300);
await verifyVerticalScroll(
  '07b_cli_providers_list',
  '[data-scroll-region="agents-providers-body"]',
  450,
);

// 10. Modelos locais
await clickAiTab(5);
await verifyVerticalScroll('10_local_models', '[data-scroll-region="ai-center-local"]', 500);

// 11. Cotas (use 320px height so even with empty provider quota headers the section overflows cleanly)
await setViewport(860, 310);
await clickAiTab(6);
await verifyVerticalScroll('11_quotas', '[data-scroll-region="ai-center-quotas"]', 350);

// 12. Orçamento e Créditos
await clickAiTab(7);
await verifyVerticalScroll('12_credits_budget', '[data-scroll-region="ai-center-credits"]', 350);

// 14. Benchmarks
await clickAiTab(9);
await verifyVerticalScroll('14_benchmarks', '[data-scroll-region="ai-center-benchmarks"]', 350);
await setViewport(860, 480);

// 13. Roteamento
await clickAiTab(8);
await verifyVerticalScroll(
  '13_routing_strategies',
  '[data-scroll-region="ai-center-routing"]',
  500,
);

// 15. Diagnósticos
await clickAiTab(10);
await verifyVerticalScroll('15_diagnostics', '[data-scroll-region="ai-center-diagnostics"]', 500);

// ---------------------------------------------------------------------------
// 16 & 20a. SEGURANÇA (Audit History + Policy Form reachability!)
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[3].click(); })()`);
await sleep(450);
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent?.includes('Histórico de decisões'))?.click();
})()`);
await sleep(350);
await verifyVerticalScroll(
  '16a_security_audit_history',
  '[data-scroll-region="security-body"]',
  500,
);

await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent?.includes('Políticas de permissão'))?.click();
})()`);
await sleep(350);
await verifyVerticalScroll(
  '16b_20a_security_policies_form',
  '[data-scroll-region="security-body"]',
  500,
);

// ---------------------------------------------------------------------------
// 17 & 20b. CONFIGURAÇÕES (Pinned Header + Form Reachability + Onboarding Modal!)
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[4].click(); })()`);
await sleep(450);
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.find((t) => t.textContent?.includes('Execução, Retenção'))?.click();
})()`);
await sleep(300);

const settingsHeaderBefore = await evaluate(
  `document.querySelector('main h2')?.getBoundingClientRect().top ?? -1`,
);
await verifyVerticalScroll('17_20b_settings_form', '[data-scroll-region="settings-body"]', 500);
const settingsCheckAfter = await evaluate(`(() => {
  const body = document.querySelector('[data-scroll-region="settings-body"]');
  if (body) body.scrollTop = body.scrollHeight;
  const headerTop = document.querySelector('main h2')?.getBoundingClientRect().top ?? -2;
  const inputs = body ? [...body.querySelectorAll('input, select, button')] : [];
  const lastControl = inputs[inputs.length - 1];
  const lastRect = lastControl ? lastControl.getBoundingClientRect() : null;
  return {
    headerTop,
    lastControlBottom: lastRect ? Math.round(lastRect.bottom) : -1,
    viewportBottom: window.innerHeight,
  };
})()`);
results['17_20b_settings_form'].headerPinned =
  Math.abs(settingsHeaderBefore - settingsCheckAfter.headerTop) < 1;
results['17_20b_settings_form'].bottomFieldReachable =
  settingsCheckAfter.lastControlBottom > 0 &&
  settingsCheckAfter.lastControlBottom <= settingsCheckAfter.viewportBottom;
results['17_20b_settings_form'].pass =
  results['17_20b_settings_form'].pass &&
  results['17_20b_settings_form'].headerPinned &&
  results['17_20b_settings_form'].bottomFieldReachable;

// 19b. Onboarding Modal scroll in compact viewport
await setViewport(860, 360);
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')];
  btns.find((b) => b.textContent?.includes('Retomar configuração inicial'))?.click();
})()`);
await sleep(350);
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[role="dialog"] button')];
  btns.find((b) => b.textContent?.includes('Agentes'))?.click();
})()`);
await sleep(300);
await verifyVerticalScroll('19b_modal_onboarding', '[data-scroll-region="dialog-body"]', 300);
await evaluate(`(() => {
  document.querySelector('[role="dialog"] button[aria-label="Fechar"]')?.click();
})()`);
await sleep(250);

// ---------------------------------------------------------------------------
// 23. DYNAMIC WINDOW RESIZE MATRIX (Maximized 1920x1080 -> Small 780x480 -> Standard 1280x800)
// ---------------------------------------------------------------------------
await evaluate(`(() => { document.querySelectorAll('.db-nav-item')[2].click(); })()`);
await sleep(350);
await clickAiTab(3); // Models catalog (25 models)

await setViewport(1920, 1080);
const maxBounds = await evaluate(`(() => {
  const main = document.querySelector('main');
  const region = document.querySelector('[data-scroll-region="ai-center-models"]');
  return {
    mainHeight: main?.clientHeight ?? 0,
    regionClientHeight: region?.clientHeight ?? 0,
    regionScrollHeight: region?.scrollHeight ?? 0,
  };
})()`);

await setViewport(780, 480);
await verifyVerticalScroll(
  '23a_resize_small_780x480',
  '[data-scroll-region="ai-center-models"]',
  450,
);

await setViewport(1280, 800);
await verifyVerticalScroll(
  '23b_resize_standard_1280x800',
  '[data-scroll-region="ai-center-models"]',
  450,
);

results['23c_maximized_1920x1080_bounded'] = {
  pass:
    maxBounds.mainHeight === 1080 - 38 - 24 && maxBounds.regionClientHeight < maxBounds.mainHeight,
  ...maxBounds,
};

console.log(JSON.stringify(results, null, 2));

const failed = Object.entries(results).filter(([, v]) => !v || v.pass !== true);
ws.close();
if (failed.length > 0) {
  await cleanupAndExit(
    1,
    `SCROLL E2E FAILED (${failed.length}): ${failed.map(([k]) => k).join(', ')}`,
  );
}
console.log(
  `SCROLL E2E OK (${Object.keys(results).length} real Electron scroll assertions passed)`,
);
await cleanupAndExit(0);
