import type { DevBrainBridge } from '@devbrain/contracts';

declare global {
  interface Window {
    readonly devbrain: DevBrainBridge;
  }
}

export {};
