import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CONTRACTS_VERSION,
  ipcChannelName,
  ipcEventName,
  isIpcChannelKey,
  isIpcEventKey,
  type DevBrainBridge,
} from '@devbrain/contracts';

/**
 * The ONLY surface exposed to the renderer. No `ipcRenderer`, Node or Electron object is
 * exposed; only allowlisted channel keys are forwarded, wrapped in a versioned envelope.
 * Payload validation happens in main (the trust boundary), not here.
 */
const bridge: DevBrainBridge = {
  contractsVersion: CONTRACTS_VERSION,

  invoke: (key, input) => {
    if (!isIpcChannelKey(key)) {
      return Promise.resolve({
        ok: false,
        correlationId: 'rejected-by-preload',
        error: { code: 'PERMISSION_DENIED', message: 'Unknown channel', retryable: false },
      });
    }
    return ipcRenderer.invoke(ipcChannelName(key), {
      contractsVersion: CONTRACTS_VERSION,
      correlationId: crypto.randomUUID(),
      payload: input,
    });
  },

  subscribe: (event, listener) => {
    if (!isIpcEventKey(event)) throw new Error('Unknown event');
    const channel = ipcEventName(event);
    // Do not leak the IpcRendererEvent (it exposes `sender`) to the renderer.
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('devbrain', Object.freeze(bridge));
