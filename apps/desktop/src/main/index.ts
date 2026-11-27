import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { ipcEventName } from '@devbrain/contracts';
import { OperationalExecutionService } from '@devbrain/execution-engine';
import { startCore, type StartedCore } from './core.js';
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
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DevBrain AI',
    backgroundColor: '#0f1115',
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
  hardenSession();
  started = startCore();
  engine = started.core ? new OperationalExecutionService(started.core) : null;
  engine?.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipcEventName('execution.event'), event);
    }
  });
  registerIpc({ core: started.core, engine, devServerUrl });
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
