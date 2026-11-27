import type { DevBrainBridge } from '@devbrain/contracts';

declare module './styles.css' {}
declare module '@xterm/xterm/css/xterm.css' {}

declare global {
  interface Window {
    readonly devbrain: DevBrainBridge;
  }
}

export {};
