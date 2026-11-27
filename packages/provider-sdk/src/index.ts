import {
  DevBrainError,
  type AdapterDescriptor,
  type AgentCapabilities,
  type DependencyReport,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionResult,
  nowTimestamp,
} from '@devbrain/contracts';
import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

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
  /**
   * In-process execution for adapters that implement their own transport. The built-in CLI
   * adapters do NOT implement it (they throw `UNSUPPORTED`): CLI agents run only through
   * `OperationalExecutionService`, which applies Core authorization, approvals, budget,
   * concurrency, persistence and cancellation. Callers must not treat `execute` as a
   * supported path for those adapters.
   */
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

const locate = async (name: string): Promise<string | null> => {
  const dirs = isAbsolute(name) ? [''] : (process.env.PATH ?? '').split(delimiter);
  for (const dir of dirs) {
    const candidate = dir ? join(dir, process.platform === 'win32' ? `${name}.exe` : name) : name;
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate);
        return await realpath(candidate);
      }
    } catch {
      /* next */
    }
  }
  return null;
};

type CliKind = 'codex' | 'claude' | 'antigravity' | 'opencode';
/**
 * Presence probe. `agy` documents `--help` but not `--version`; for it the version stays
 * unknown (null) and a successful `--help` proves the executable runs.
 */
const PROBE_ARGS: Record<CliKind, string[]> = {
  codex: ['--version'],
  claude: ['--version'],
  antigravity: ['--help'],
  opencode: ['--version'],
};
const specs = {
  codex: {
    key: 'openai-codex-cli',
    name: 'OpenAI Codex',
    executable: 'codex',
    url: 'https://developers.openai.com/blog/codex-as-a-platform',
    capabilities: {
      streaming: true,
      interrupt: true,
      resumeSession: false,
      toolUse: true,
      fileEdits: true,
      shellCommands: true,
      mcp: true,
      structuredOutput: true,
      maxConcurrentSessions: null,
      contextWindowTokens: null,
      costModel: 'unknown' as const,
      enforcement: process.platform === 'win32' ? ('none' as const) : ('adapter-sandbox' as const),
    },
  },
  claude: {
    key: 'claude-code-cli',
    name: 'Claude Code',
    executable: 'claude',
    url: 'https://code.claude.com/docs/en/cli-reference',
    capabilities: {
      streaming: true,
      interrupt: true,
      resumeSession: false,
      toolUse: true,
      fileEdits: true,
      shellCommands: true,
      mcp: true,
      structuredOutput: true,
      maxConcurrentSessions: null,
      contextWindowTokens: null,
      costModel: 'unknown' as const,
      enforcement: 'none' as const,
    },
  },
  antigravity: {
    key: 'google-antigravity-cli',
    name: 'Google Antigravity CLI',
    executable: 'agy',
    url: 'https://antigravity.google/docs/cli/headless/',
    capabilities: {
      streaming: false,
      interrupt: true,
      resumeSession: false,
      toolUse: true,
      fileEdits: true,
      shellCommands: true,
      mcp: true,
      structuredOutput: true,
      maxConcurrentSessions: null,
      contextWindowTokens: null,
      costModel: 'unknown' as const,
      enforcement: 'none' as const,
    },
  },
  opencode: {
    key: 'opencode-cli',
    name: 'OpenCode',
    executable: 'opencode',
    url: 'https://opencode.ai/docs/cli/commands/',
    capabilities: {
      streaming: true,
      interrupt: true,
      resumeSession: false,
      toolUse: true,
      fileEdits: true,
      shellCommands: true,
      mcp: true,
      structuredOutput: true,
      maxConcurrentSessions: null,
      contextWindowTokens: null,
      costModel: 'unknown' as const,
      enforcement: 'none' as const,
    },
  },
} satisfies Record<
  CliKind,
  { key: string; name: string; executable: string; url: string; capabilities: AgentCapabilities }
>;

class CliAdapter implements ProviderAdapter {
  readonly key: string;
  readonly descriptor: AdapterDescriptor;
  constructor(private readonly kind: CliKind) {
    const spec = specs[kind];
    this.key = spec.key;
    this.descriptor = {
      adapterKey: spec.key,
      kind: 'cli-agent',
      displayName: spec.name,
      vendor:
        kind === 'codex'
          ? 'OpenAI'
          : kind === 'claude'
            ? 'Anthropic'
            : kind === 'opencode'
              ? 'Anomaly'
              : 'Google',
      documentationUrl: spec.url,
      capabilities: spec.capabilities,
    };
  }
  async checkDependencies(): Promise<DependencyReport> {
    const spec = specs[this.kind],
      resolvedPath = await locate(spec.executable);
    let version: string | null = null;
    let runs = false;
    if (resolvedPath) {
      version = await new Promise((resolve) => {
        const child = spawn(resolvedPath, PROBE_ARGS[this.kind], {
          shell: false,
          windowsHide: true,
        });
        let output = '';
        const timeout = setTimeout(() => child.kill(), 5000);
        child.stdout?.on('data', (data: Buffer) => {
          output += String(data).slice(0, 200);
        });
        child.once('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          runs = code === 0;
          resolve(code === 0 && this.kind !== 'antigravity' ? output.trim() : null);
        });
      });
    }
    return {
      adapterKey: spec.key,
      status: resolvedPath && runs ? 'available' : 'missing-dependency',
      checks: [
        {
          name: spec.executable,
          required: true,
          found: !!resolvedPath && runs,
          version,
          minimumVersion: null,
          resolvedPath,
          message: !resolvedPath
            ? 'Executable not found'
            : !runs
              ? 'Executable did not run'
              : version === null
                ? 'Version not reported by this CLI'
                : null,
        },
      ],
      checkedAt: nowTimestamp(),
    };
  }
  async getCapabilities(): Promise<AgentCapabilities> {
    return this.descriptor.capabilities;
  }
  async startSession(input: {
    sessionId: string;
    workingDirectory: string;
  }): Promise<AdapterSessionHandle> {
    return { sessionId: input.sessionId, externalSessionId: null };
  }
  execute(
    _session: AdapterSessionHandle,
    _request: ExecutionRequest,
    _context: AdapterContext,
  ): AdapterRun {
    throw new DevBrainError(
      'UNSUPPORTED',
      'Use OperationalExecutionService for authorized CLI execution',
    );
  }
  async endSession(): Promise<void> {}
}

export const createBuiltinRegistry = (): ProviderRegistry => {
  const registry = new ProviderRegistry();
  for (const kind of ['codex', 'claude', 'antigravity', 'opencode'] as const)
    registry.register(new CliAdapter(kind));
  return registry;
};
