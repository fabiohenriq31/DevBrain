import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { basename, delimiter, extname, isAbsolute, join, relative } from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import {
  DevBrainError,
  EXECUTION_TRANSITIONS,
  SubmitExecutionInputSchema,
  newId,
  nowTimestamp,
  parseOrThrow,
  type AgentDiscoveryService,
  type ExecutionEvent,
  type ExecutionEventListener,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionService,
  type ExecutionStatus,
  type InterruptInput,
  type SubmitExecutionInput,
} from '@devbrain/contracts';
import type { CoreServices } from '@devbrain/core';
import { isWithinRoot, redactString } from '@devbrain/security';
import { createBuiltinRegistry, type ProviderRegistry } from '@devbrain/provider-sdk';
import { LocalGitService } from '@devbrain/git-engine';

const executableName = (name: string): string =>
  name.toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
const allowedExecutable = (name: string): boolean =>
  !/[\0\r\n]/.test(name) &&
  !['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wscript', 'cscript'].includes(
    executableName(basename(name)),
  );
const envFor = (names: readonly string[]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of new Set([
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    ...names,
  ])) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
};
export const findExecutable = async (name: string): Promise<string | null> => {
  if (!allowedExecutable(name)) return null;
  const candidates = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .flatMap((dir) =>
          process.platform === 'win32'
            ? [join(dir, name + '.exe'), join(dir, name)]
            : [join(dir, name)],
        );
  for (const candidate of candidates) {
    try {
      if (process.platform === 'win32' && extname(candidate).toLowerCase() !== '.exe') continue;
      if ((await stat(candidate)).isFile()) {
        await access(candidate);
        return await realpath(candidate);
      }
    } catch {
      /* try next PATH entry */
    }
  }
  return null;
};
const killTree = async (child: ChildProcess, force: boolean): Promise<void> => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { shell: false, windowsHide: true },
    );
    await once(killer, 'exit').catch(() => undefined);
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }
};
/**
 * Command line for a prompt to a supported agent CLI, from each vendor's official CLI docs
 * (see the adapter descriptors' `documentationUrl`).
 *
 * The prompt is untrusted text: it is always passed so the CLI cannot read it as a flag
 * (after `--`, or as the `=`-bound value of the prompt flag). Permission modes follow the
 * authorized plan; auto-approve / bypass modes are never used.
 */
export const buildAgentCommand = (
  adapterKey: string,
  prompt: string,
  options: { readOnly: boolean; workingDirectory: string; timeoutMs: number },
): { executable: string; args: string[] } => {
  switch (adapterKey) {
    case 'openai-codex-cli':
      return {
        executable: 'codex',
        args: [
          'exec',
          '--json',
          '--sandbox',
          options.readOnly ? 'read-only' : 'workspace-write',
          '-C',
          options.workingDirectory,
          '--',
          prompt,
        ],
      };
    case 'claude-code-cli':
      return {
        executable: 'claude',
        args: [
          '-p',
          '--output-format',
          'stream-json',
          // stream-json in print mode requires --verbose.
          '--verbose',
          '--permission-mode',
          options.readOnly ? 'plan' : 'acceptEdits',
          '--',
          prompt,
        ],
      };
    case 'google-antigravity-cli':
      return {
        executable: 'agy',
        args: [
          '--output-format',
          'json',
          // Headless agy defaults to `auto` mode where available; pin an explicit mode.
          '--mode',
          options.readOnly ? 'plan' : 'accept-edits',
          '--print-timeout',
          `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`,
          `--print=${prompt}`,
        ],
      };
    case 'opencode-cli':
      return {
        executable: 'opencode',
        args: [
          'run',
          '--standalone',
          '--format',
          'json',
          '--agent',
          options.readOnly ? 'plan' : 'build',
          // A safe prefix prevents an untrusted prompt beginning with `--` from becoming a flag.
          `User request:\n${prompt}`,
        ],
      };
    default:
      throw new DevBrainError('UNSUPPORTED', 'Adapter does not support prompt execution');
  }
};
type Active = {
  status: ExecutionStatus;
  child: ChildProcess | null;
  abort: AbortController;
  result: Promise<ExecutionResult>;
};

export class OperationalExecutionService implements ExecutionService, AgentDiscoveryService {
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Set<ExecutionEventListener>();
  private readonly git = new LocalGitService();
  constructor(
    private readonly core: CoreServices,
    private readonly registry: ProviderRegistry = createBuiltinRegistry(),
  ) {}

  async listAdapters() {
    return this.registry.list();
  }
  async checkDependencies(adapterKey: string) {
    return this.registry.get(adapterKey).checkDependencies();
  }
  async getCapabilities(adapterKey: string) {
    return this.registry.get(adapterKey).getCapabilities();
  }
  subscribe(listener: ExecutionEventListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async getResult(executionId: string) {
    return this.core.db.executions.getResult(executionId);
  }

  async submit(input: SubmitExecutionInput): Promise<ExecutionHandle> {
    const parsed = parseOrThrow(SubmitExecutionInputSchema, input);
    const session = await this.core.sessions.get(parsed.sessionId);
    const workspace = this.core.db.workspaces.findById(session.workspaceId);
    if (!workspace) throw new DevBrainError('NOT_FOUND', 'Workspace not found');
    const cwd = parsed.workingDirectory ?? workspace.rootPath;
    const request = await this.core.sessions.recordInstruction({
      id: newId('execution'),
      sessionId: session.id,
      payload: parsed.payload,
      workingDirectory: cwd,
      timeoutMs: parsed.timeoutMs ?? (await this.core.settings.get()).execution.defaultTimeoutMs,
      envAllowlist: [],
      idempotencyKey: parsed.idempotencyKey ?? null,
      createdAt: nowTimestamp(),
    });
    if (this.active.has(request.id))
      return { executionId: request.id, status: this.active.get(request.id)!.status };
    const previous = await this.core.db.executions.getResult(request.id);
    if (previous) return { executionId: request.id, status: previous.status };
    const abort = new AbortController();
    const active: Active = {
      status: 'queued',
      child: null,
      abort,
      result: Promise.resolve(null as never),
    };
    this.active.set(request.id, active);
    active.result = this.run(request, active).finally(() => this.active.delete(request.id));
    return { executionId: request.id, status: active.status };
  }

  private async run(
    request: Awaited<ReturnType<CoreServices['sessions']['recordInstruction']>>,
    active: Active,
  ): Promise<ExecutionResult> {
    let seq = 0,
      startedAt: string | null = null,
      exitCode: number | null = null,
      outputBytes = 0,
      outputTruncated = false;
    let release: (() => void) | null = null;
    let timedOut = false,
      terminalSignal: 'success' | 'failure' | null = null;
    // Antigravity prints one (possibly multi-line) JSON document; parsed once at exit.
    let documentOutput = '';
    let reportedUsage: ExecutionResult['usage'] = null;
    const emit = async (data: Record<string, unknown>) => {
      const event = {
        ...data,
        id: newId('event'),
        executionId: request.id,
        sessionId: request.sessionId,
        seq: seq++,
        timestamp: nowTimestamp(),
      } as ExecutionEvent;
      const outcome = await this.core.sessions.recordEvent(event);
      if (outcome.truncated) outputTruncated = true;
      if (outcome.stored) {
        for (const listener of this.listeners) listener(event);
        this.core.events.emit('execution.event', event);
      }
    };
    const transition = async (next: ExecutionStatus) => {
      if (!EXECUTION_TRANSITIONS[active.status].includes(next))
        throw new DevBrainError(
          'CONFLICT',
          `Invalid execution transition ${active.status} -> ${next}`,
        );
      active.status = next;
      await emit({ type: 'status', status: next });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await emit({ type: 'status', status: 'queued' });
      const session = await this.core.sessions.get(request.sessionId);
      const agent = this.core.db.agents.findById(session.agentId);
      if (!agent) throw new DevBrainError('NOT_FOUND', 'Agent not found');
      const provider = this.core.db.providers.findById(agent.providerId)?.provider;
      if (!provider) throw new DevBrainError('NOT_FOUND', 'Provider not found');
      if (request.payload.kind === 'prompt') {
        const adapter = this.registry.get(provider.adapterKey);
        const dependency = await adapter.checkDependencies();
        await this.core.providers.recordEvidence({
          providerId: provider.id,
          aspect: 'installed',
          state: dependency.status === 'available' ? 'yes' : 'no',
          detail: dependency.checks[0]?.version ?? 'Executable unavailable',
          capabilities: await adapter.getCapabilities(),
        });
        if (dependency.status !== 'available')
          throw new DevBrainError('DEPENDENCY_MISSING', 'Agent CLI unavailable');
      }
      const auth = await this.core.authorization.authorizeExecution(
        {
          sessionId: session.id,
          workingDirectory: request.workingDirectory,
          costBearing: request.payload.kind === 'prompt',
        },
        { signal: active.abort.signal },
      );
      release = await this.core.authorization.acquireSlot(agent.id, active.abort.signal);
      if (active.abort.signal.aborted)
        throw new DevBrainError('CANCELLED', 'Cancelled while queued');
      const { executable, args } =
        request.payload.kind === 'prompt'
          ? buildAgentCommand(provider.adapterKey, request.payload.prompt, {
              readOnly: auth.plan.sandboxMode === 'read-only',
              workingDirectory: auth.workingDirectory,
              timeoutMs: Math.min(request.timeoutMs, auth.limits.maxExecutionMs),
            })
          : { executable: request.payload.executable, args: request.payload.args };
      if (request.payload.kind === 'command')
        await this.core.authorization.authorizeCommand(
          {
            agentId: agent.id,
            workspaceId: session.workspaceId,
            sessionId: session.id,
            executable,
            args,
            cwd: auth.workingDirectory,
          },
          { signal: active.abort.signal, executionId: request.id },
        );
      const resolved = await findExecutable(executable);
      if (!resolved)
        throw new DevBrainError('DEPENDENCY_MISSING', `Executable unavailable: ${executable}`);
      startedAt = nowTimestamp();
      await transition('running');
      if (active.abort.signal.aborted) throw new DevBrainError('CANCELLED', 'Execution cancelled');
      const before = await this.git.status(auth.workingDirectory).catch(() => null);
      if (active.abort.signal.aborted) throw new DevBrainError('CANCELLED', 'Execution cancelled');
      const child = spawn(resolved, args, {
        cwd: auth.workingDirectory,
        env: envFor(request.envAllowlist),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      active.child = child;
      if (active.abort.signal.aborted) await killTree(child, true);
      const maxOutput = Math.min(
        auth.limits.maxOutputBytes,
        (await this.core.settings.get()).retention.maxStoredOutputBytesPerExecution,
      );
      const structuredLine = async (line: string) => {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (
          value.type === 'turn.completed' ||
          (value.type === 'result' && value.is_error === false)
        )
          terminalSignal = 'success';
        if (value.type === 'turn.failed' || (value.type === 'result' && value.is_error === true))
          terminalSignal = 'failure';
        if (provider.adapterKey === 'opencode-cli') {
          if (value.type === 'error') terminalSignal = 'failure';
          const part =
            value.part && typeof value.part === 'object'
              ? (value.part as Record<string, unknown>)
              : null;
          if (part?.type === 'text' && typeof part.text === 'string')
            await emit({
              type: 'message',
              role: 'assistant',
              text: redactString(part.text).slice(0, 1_048_576),
            });
        }
        const item =
          value.item && typeof value.item === 'object'
            ? (value.item as Record<string, unknown>)
            : null;
        if (
          value.type === 'item.completed' &&
          item?.type === 'file_change' &&
          Array.isArray(item.changes)
        ) {
          for (const change of item.changes) {
            if (!change || typeof change !== 'object') continue;
            const data = change as Record<string, unknown>;
            if (typeof data.path !== 'string' || !isWithinRoot(auth.workingDirectory, data.path))
              continue;
            await emit({
              type: 'file-change',
              path: relative(auth.workingDirectory, data.path),
              change:
                data.kind === 'create'
                  ? 'created'
                  : data.kind === 'delete'
                    ? 'deleted'
                    : data.kind === 'move'
                      ? 'renamed'
                      : 'modified',
            });
          }
        }
        if (
          value.type === 'item.completed' &&
          item?.type === 'agent_message' &&
          typeof item.text === 'string'
        )
          await emit({
            type: 'message',
            role: 'assistant',
            text: redactString(item.text).slice(0, 1_048_576),
          });
        // Claude Code stream-json: assistant text blocks and the final result's token usage.
        // Its `total_cost_usd` is not recorded: under a subscription it is not a charge, so the
        // cost stays unknown rather than invented.
        if (value.type === 'assistant' && value.message && typeof value.message === 'object') {
          const content = (value.message as Record<string, unknown>).content;
          if (Array.isArray(content))
            for (const block of content) {
              if (
                block &&
                typeof block === 'object' &&
                (block as Record<string, unknown>).type === 'text' &&
                typeof (block as Record<string, unknown>).text === 'string'
              )
                await emit({
                  type: 'message',
                  role: 'assistant',
                  text: redactString((block as { text: string }).text).slice(0, 1_048_576),
                });
            }
        }
        if (
          (value.type === 'result' || typeof value.status === 'string') &&
          value.usage &&
          typeof value.usage === 'object' &&
          reportedUsage === null
        ) {
          const usage = value.usage as Record<string, unknown>;
          reportedUsage = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
            costAmount: null,
            costCurrency: null,
          };
          await emit({ type: 'usage', usage: reportedUsage });
        }
        // Antigravity `--output-format json`: one object with `status` and `response`.
        if (provider.adapterKey === 'google-antigravity-cli' && typeof value.status === 'string') {
          terminalSignal = value.status === 'SUCCESS' ? 'success' : 'failure';
          if (typeof value.response === 'string')
            await emit({
              type: 'message',
              role: 'assistant',
              text: redactString(value.response).slice(0, 1_048_576),
            });
        }
        if (value.type === 'turn.completed' && value.usage && typeof value.usage === 'object') {
          const usage = value.usage as Record<string, unknown>;
          reportedUsage = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
            costAmount: null,
            costCurrency: null,
          };
          await emit({
            type: 'usage',
            usage: reportedUsage,
          });
        }
      };
      const consume = async (stream: NodeJS.ReadableStream, label: 'stdout' | 'stderr') => {
        let pending = '';
        for await (const chunk of stream) {
          const raw = String(chunk);
          if (
            label === 'stdout' &&
            request.payload.kind === 'prompt' &&
            provider.adapterKey === 'google-antigravity-cli'
          ) {
            if (documentOutput.length < 8 * 1024 * 1024) documentOutput += raw;
          } else if (label === 'stdout' && request.payload.kind === 'prompt') {
            pending += raw;
            for (;;) {
              const index = pending.indexOf('\n');
              if (index < 0) break;
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              await structuredLine(line);
            }
          }
          const left = Math.max(0, maxOutput - outputBytes);
          const text = redactString(raw.slice(0, left));
          outputBytes += Buffer.byteLength(raw);
          if (text) await emit({ type: 'output', stream: label, chunk: text });
          if (outputBytes > maxOutput) outputTruncated = true;
        }
        // A final structured line without a trailing newline.
        if (pending.trim() && label === 'stdout' && request.payload.kind === 'prompt')
          await structuredLine(pending);
      };
      timer = setTimeout(
        () => {
          timedOut = true;
          void killTree(child, true);
        },
        Math.min(request.timeoutMs, auth.limits.maxExecutionMs),
      );
      const streams = Promise.all([
        consume(child.stdout, 'stdout'),
        consume(child.stderr, 'stderr'),
      ]);
      const [code] = (await once(child, 'close')) as [number | null];
      exitCode = code;
      await streams;
      if (documentOutput.trim()) await structuredLine(documentOutput.trim());
      const after = await this.git.status(auth.workingDirectory).catch(() => null);
      if (after)
        for (const file of after.files) {
          if (
            !before?.files.some(
              (prior) =>
                prior.path === file.path &&
                prior.index === file.index &&
                prior.workTree === file.workTree,
            )
          )
            await emit({
              type: 'file-change',
              path: file.path,
              change:
                file.workTree === 'deleted'
                  ? 'deleted'
                  : file.workTree === 'untracked'
                    ? 'created'
                    : 'modified',
            });
        }
      const validSuccess =
        request.payload.kind === 'command' ||
        terminalSignal === 'success' ||
        (provider.adapterKey === 'opencode-cli' && terminalSignal !== 'failure');
      const status: ExecutionStatus = timedOut
        ? 'timed-out'
        : active.abort.signal.aborted
          ? 'cancelled'
          : exitCode === 0 && validSuccess && terminalSignal !== 'failure'
            ? 'completed'
            : 'failed';
      if (active.status === 'queued' && status === 'failed') await transition('running');
      if (active.status === 'running' && status === 'cancelled') await transition('interrupting');
      await transition(status);
      const result: ExecutionResult = {
        executionId: request.id,
        sessionId: request.sessionId,
        status: status as ExecutionResult['status'],
        exitCode,
        startedAt,
        finishedAt: nowTimestamp(),
        summary: status,
        usage: reportedUsage,
        error:
          status === 'failed'
            ? new DevBrainError('PROVIDER_UNAVAILABLE', 'Agent process failed').toPayload()
            : null,
        outputTruncated,
      };
      await this.core.sessions.recordResult(result);
      await this.core.sessions
        .saveCheckpoint({
          sessionId: session.id,
          label: `Execution ${status}`,
          gitCommit:
            (await this.git.detect(auth.workingDirectory).catch(() => null))?.headCommit ?? null,
          state: {
            version: 1,
            task:
              request.payload.kind === 'prompt' ? request.payload.prompt.slice(0, 20_000) : null,
            plan: [],
            summary: status,
            filesTouched: after?.files.map((file) => file.path).slice(0, 5000) ?? [],
            nextSteps: [],
            providerRef: null,
            lastExecutionId: request.id,
          },
        })
        .catch(() => undefined);
      if (status === 'completed' && request.payload.kind === 'prompt') {
        await this.core.providers
          .recordEvidence({
            providerId: provider.id,
            aspect: 'operational',
            state: 'yes',
            detail: 'Completed CLI execution',
          })
          .catch(() => undefined);
      }
      return result;
    } catch (error) {
      const status = active.abort.signal.aborted ? 'cancelled' : 'failed';
      if (active.status === 'queued' && status === 'failed') await transition('running');
      if (active.status === 'running' && status === 'cancelled') await transition('interrupting');
      if (!['completed', 'failed', 'cancelled', 'timed-out'].includes(active.status))
        await transition(status);
      const failure =
        error instanceof DevBrainError ? error : new DevBrainError('INTERNAL', 'Execution failed');
      const result: ExecutionResult = {
        executionId: request.id,
        sessionId: request.sessionId,
        status,
        exitCode,
        startedAt,
        finishedAt: nowTimestamp(),
        summary: redactString(failure.message),
        usage: null,
        error: failure.toPayload(),
        outputTruncated,
      };
      await this.core.sessions.recordResult(result);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
    }
  }
  async interrupt(input: InterruptInput): Promise<ExecutionHandle> {
    const active = this.active.get(input.executionId);
    if (!active) {
      const result = await this.getResult(input.executionId);
      if (result) return { executionId: input.executionId, status: result.status };
      throw new DevBrainError('NOT_FOUND', 'Execution not found');
    }
    active.abort.abort();
    if (active.child) {
      await killTree(active.child, input.mode === 'force');
      if (input.mode === 'graceful') {
        const child = active.child;
        const fallback = setTimeout(() => {
          void killTree(child, true);
        }, 3000);
        fallback.unref?.();
        void active.result.finally(() => clearTimeout(fallback));
      }
    }
    return { executionId: input.executionId, status: active.status };
  }
  async wait(executionId: string): Promise<ExecutionResult> {
    const active = this.active.get(executionId);
    if (active) return active.result;
    const result = await this.getResult(executionId);
    if (!result) throw new DevBrainError('NOT_FOUND', 'Execution not found');
    return result;
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map(async (run) => {
        run.abort.abort();
        if (run.child) await killTree(run.child, true);
      }),
    );
    await Promise.all([...this.active.values()].map((run) => run.result));
  }
}
export const EXECUTION_ENGINE_IMPLEMENTED = true as const;
