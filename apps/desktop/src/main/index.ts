import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, Menu, app } from 'electron';
import { ipcEventName } from '@devbrain/contracts';
import { OllamaRuntime, OpenAiLocalRuntime, ProviderCatalog } from '@devbrain/ai-gateway';
import { OperationalExecutionService } from '@devbrain/execution-engine';
import { startCore, type StartedCore } from './core.js';
import { createGatewayForCore } from './gateway.js';
import { registerIpc } from './ipc.js';
import { applyProcessHardening, hardenSession, hardenWebContents } from './security.js';

const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
let started: StartedCore | null = null;
let engine: OperationalExecutionService | null = null;
let closing = false;

applyProcessHardening();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const createWindow = (): BrowserWindow => {
  const iconCandidate = join(__dirname, '../../../resources/icon.png');
  const window = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'DevBrain AI',
    autoHideMenuBar: true,
    backgroundColor: '#0d1016',
    ...(existsSync(iconCandidate) ? { icon: iconCandidate } : {}),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0d1016',
            symbolColor: '#9aa3b2',
            height: 38,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
};

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, devServerUrl));

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

void app.whenReady().then(() => {
  app.setAppUserModelId('ai.devbrain.desktop');
  Menu.setApplicationMenu(null);
  hardenSession();
  started = startCore();
  const core = started.core;
  const gateway = core ? createGatewayForCore(core) : null;
  // The native DevBrain agent runs its model calls through this same gateway instance.
  engine = core ? new OperationalExecutionService(core, undefined, gateway) : null;
  engine?.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipcEventName('execution.event'), event);
    }
  });
  const catalog = core ? new ProviderCatalog(core.db.driver) : null;
  registerIpc({
    core,
    engine,
    gateway,
    catalog,
    localRuntime: new OllamaRuntime(),
    localRuntimes: [
      new OpenAiLocalRuntime('custom', 'http://127.0.0.1:1234/v1'),
      new OpenAiLocalRuntime('llama-cpp', 'http://127.0.0.1:9931/v1'),
    ],
    devServerUrl,
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void (async () => {
    try {
      await engine?.close();
    } finally {
      started?.core?.close();
      started = null;
      engine = null;
      app.quit();
    }
  })();
});
