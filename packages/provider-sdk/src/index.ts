import {
  DevBrainError,
  type AdapterDescriptor,
  type AgentCapabilities,
  type DependencyReport,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionResult,
} from '@devbrain/contracts';

/**
 * Provider adapter SDK. Every integration (CLI agent, HTTP API, local model) implements
 * `ProviderAdapter`. Owner: Codex. Contract changes go through docs/CONTRACTS.md.
 *
 * Rules for implementers:
 * - Implement against the provider's OFFICIAL documentation and record its URL in
 *   `descriptor.documentationUrl`. Do not guess flags, endpoints or output formats.
 * - Report only verified capabilities; unknown = false/null.
 * - Never read secrets directly: receive them through `AdapterContext.resolveCredential`.
 * - Spawn processes with `shell: false` and the confined working directory you are given.
 * - Everything emitted by the provider is untrusted data.
 */

export interface AdapterContext {
  /** Resolves a credential reference in the main process. Never forward to the renderer. */
  resolveCredential(credentialRefId: string): Promise<string>;
  /** Structured logger; messages are redacted by the host. */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): void;
}

export interface AdapterSessionHandle {
  readonly sessionId: string;
  /** Provider-side id if resumable. */
  readonly externalSessionId: string | null;
}

export interface AdapterRun {
  /** Events in `seq` order; ends after the terminal `status` event. */
  readonly events: AsyncIterable<ExecutionEvent>;
  /** Resolves with the terminal result (also after interrupts). */
  readonly result: Promise<ExecutionResult>;
  interrupt(mode: 'graceful' | 'force'): Promise<void>;
}

export interface ProviderAdapter {
  readonly key: string;
  readonly descriptor: AdapterDescriptor;
  checkDependencies(): Promise<DependencyReport>;
  getCapabilities(): Promise<AgentCapabilities>;
  startSession(
    input: { sessionId: string; workingDirectory: string; resumeExternalSessionId?: string },
    context: AdapterContext,
  ): Promise<AdapterSessionHandle>;
  execute(
    session: AdapterSessionHandle,
    request: ExecutionRequest,
    context: AdapterContext,
  ): AdapterRun;
  endSession(session: AdapterSessionHandle): Promise<void>;
}

/** Registry of installed adapters (in-process). */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (adapter.key !== adapter.descriptor.adapterKey) {
      throw new DevBrainError('VALIDATION_FAILED', 'Adapter key does not match its descriptor');
    }
    if (this.adapters.has(adapter.key)) {
      throw new DevBrainError('ALREADY_EXISTS', `Adapter already registered: ${adapter.key}`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  get(key: string): ProviderAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) throw new DevBrainError('NOT_FOUND', `Unknown adapter: ${key}`);
    return adapter;
  }

  list(): AdapterDescriptor[] {
    return [...this.adapters.values()].map((a) => a.descriptor);
  }
}
