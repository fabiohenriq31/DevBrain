import { app, session, shell, type WebContents } from 'electron';

/**
 * Process-wide Electron hardening (docs/SECURITY.md §Electron).
 * Must be called before `app.whenReady()` resolves where noted.
 */
export const applyProcessHardening = (): void => {
  // Sandbox every renderer, including any created by third-party code.
  app.enableSandbox();
};

/** Origins the renderer is allowed to be served from. */
export const isTrustedRendererUrl = (url: string, devServerUrl: string | undefined): boolean => {
  try {
    const parsed = new URL(url);
    if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
    return parsed.protocol === 'file:';
  } catch {
    return false;
  }
};

export const hardenSession = (): void => {
  const ses = session.defaultSession;
  // Deny camera, microphone, notifications, geolocation, etc. Nothing is requested today.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // No downloads initiated by renderer content.
  ses.on('will-download', (event) => event.preventDefault());
};

/** Applied to every WebContents created by the app. */
export const hardenWebContents = (
  contents: WebContents,
  devServerUrl: string | undefined,
): void => {
  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, devServerUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, devServerUrl)) event.preventDefault();
  });

  // Never open new Electron windows from content. HTTPS links go to the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {
      // ignore malformed URLs
    }
    return { action: 'deny' };
  });
};
