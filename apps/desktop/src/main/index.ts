import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import { registerIpc } from './ipc.js';
import { applyProcessHardening, hardenSession, hardenWebContents } from './security.js';

const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
let db: DevBrainDatabase | null = null;

applyProcessHardening();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const openDatabase = (): DevBrainDatabase | null => {
  try {
    // userData lives outside the repository (%APPDATA%\DevBrain AI on Windows).
    return createDatabase({ location: join(app.getPath('userData'), 'devbrain.db') });
  } catch (error) {
    console.error(
      '[devbrain] failed to open database:',
      error instanceof Error ? error.message : 'unknown',
    );
    return null;
  }
};

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
  db = openDatabase();
  registerIpc({ db, devServerUrl });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  db?.close();
  db = null;
});
