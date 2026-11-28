import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DevBrainError,
  BenchmarkResultSchema,
  HardwareProfileSchema,
  LocalModelSchema,
  LocalRuntimeSchema,
  type HardwareProfile,
  type BenchmarkResult,
  type LocalModel,
  type LocalRuntime,
} from '@devbrain/contracts';
import { SafeHttpTransport } from './transport.js';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

/** Ollama native API. Other local OpenAI-compatible runtimes use ProtocolTransport. */
export class OllamaRuntime {
  readonly id: string;
  constructor(
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly transport = new SafeHttpTransport(),
  ) {
    const url = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new DevBrainError('PERMISSION_DENIED', 'Ollama runtime must be on loopback');
    this.id = `loc_${randomUUID()}`;
  }

  async inspect(): Promise<LocalRuntime> {
    try {
      const response = await this.transport.json({
        url: `${this.baseUrl}/api/version`,
        method: 'GET',
        allowLoopback: true,
        timeoutMs: 3000,
      });
      return LocalRuntimeSchema.parse({
        id: this.id,
        kind: 'ollama',
        endpoint: this.baseUrl,
        status: response.status === 200 ? 'available' : 'unavailable',
        version: typeof obj(response.data).version === 'string' ? obj(response.data).version : null,
      });
    } catch {
      return LocalRuntimeSchema.parse({
        id: this.id,
        kind: 'ollama',
        endpoint: this.baseUrl,
        status: 'unavailable',
        version: null,
      });
    }
  }

  async models(): Promise<LocalModel[]> {
    const response = await this.transport.json({
      url: `${this.baseUrl}/api/tags`,
      method: 'GET',
      allowLoopback: true,
    });
    if (response.status !== 200 || !Array.isArray(obj(response.data).models))
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama model list unavailable');
    return (obj(response.data).models as unknown[]).map((raw) => {
      const model = obj(raw);
      return LocalModelSchema.parse({
        id: `mdl_${String(model.name).replace(/[^a-zA-Z0-9._:-]/g, '-')}`,
        runtimeId: this.id,
        modelId: String(model.name),
        sizeBytes: typeof model.size === 'number' ? model.size : null,
        digest: typeof model.digest === 'string' ? model.digest : null,
        installedAt:
          typeof model.modified_at === 'string' ? new Date(model.modified_at).toISOString() : null,
      });
    });
  }

  /** Measures an installed model with Ollama's own token and duration counters. */
  async benchmark(modelId: string): Promise<BenchmarkResult> {
    const installed = await this.models();
    if (!installed.some((model) => model.modelId === modelId))
      throw new DevBrainError('NOT_FOUND', 'Ollama model is not installed');
    const response = await this.transport.json({
      url: `${this.baseUrl}/api/generate`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        prompt: 'Reply with one short sentence about software testing.',
        stream: false,
        options: { num_predict: 32 },
      }),
      allowLoopback: true,
      timeoutMs: 120_000,
    });
    const data = obj(response.data);
    if (response.status !== 200 || data.error || data.done !== true)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama benchmark failed');
    const count = data.eval_count;
    const duration = data.eval_duration;
    const tokensPerSecond =
      typeof count === 'number' &&
      Number.isFinite(count) &&
      count > 0 &&
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0
        ? (count * 1_000_000_000) / duration
        : null;
    return BenchmarkResultSchema.parse({
      id: `bench_${randomUUID()}`,
      runtimeId: this.id,
      modelId,
      hardware: inspectHardware(),
      tokensPerSecond,
      timeToFirstTokenMs: null,
      success: true,
      measuredAt: new Date().toISOString(),
    });
  }

  async *pull(
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<{ completed: number; total: number | null }> {
    if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid Ollama model name');
    const response = await this.transport.open({
      url: `${this.baseUrl}/api/pull`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      allowLoopback: true,
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama pull failed');
    let buffer = '',
      totalBytes = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      totalBytes += bytes.length;
      if (totalBytes > 10_000_000)
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama pull response exceeded limit');
      buffer += bytes.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const data = obj(JSON.parse(line));
        if (data.error) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama pull error');
        yield {
          completed: typeof data.completed === 'number' ? data.completed : 0,
          total: typeof data.total === 'number' ? data.total : null,
        };
      }
    }
  }

  async remove(model: string): Promise<void> {
    if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid Ollama model name');
    const response = await this.transport.open({
      url: `${this.baseUrl}/api/delete`,
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      allowLoopback: true,
    });
    response.body.resume();
    if (response.status !== 200)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Ollama model removal failed');
  }
}

/** Read-only discovery for LM Studio, llama.cpp and other explicitly local OAI endpoints. */
export class OpenAiLocalRuntime {
  readonly id: string;
  constructor(
    readonly kind: 'llama-cpp' | 'custom',
    readonly baseUrl: string,
    private readonly transport = new SafeHttpTransport(),
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new DevBrainError('PERMISSION_DENIED', 'Local runtime must use loopback HTTP');
    this.id = kind === 'llama-cpp' ? 'loc_llama_cpp' : 'loc_lm_studio';
  }

  private async list(): Promise<unknown[]> {
    const response = await this.transport.json({
      url: `${this.baseUrl.replace(/\/+$/, '')}/models`,
      method: 'GET',
      allowLoopback: true,
      timeoutMs: 3000,
    });
    if (response.status !== 200 || !Array.isArray(obj(response.data).data))
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Local model list unavailable');
    return obj(response.data).data as unknown[];
  }

  async inspect(): Promise<LocalRuntime> {
    let available = false;
    try {
      await this.list();
      available = true;
    } catch {
      /* runtime absent */
    }
    return LocalRuntimeSchema.parse({
      id: this.id,
      kind: this.kind,
      endpoint: this.baseUrl,
      status: available ? 'available' : 'unavailable',
      version: null,
    });
  }

  async models(): Promise<LocalModel[]> {
    const models = await this.list();
    return models.map((raw, index) => {
      const source = obj(raw);
      if (typeof source.id !== 'string' || !source.id || source.id.length > 300)
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Invalid local model identifier');
      return LocalModelSchema.parse({
        id: `mdl_${this.id}_${index}`,
        runtimeId: this.id,
        modelId: source.id,
        sizeBytes: null,
        digest: null,
        installedAt: null,
      });
    });
  }
}

export const inspectHardware = (): HardwareProfile =>
  HardwareProfileSchema.parse({
    platform: process.platform,
    cpuCores: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    gpuName: null,
    gpuMemoryBytes: null,
    measuredAt: new Date().toISOString(),
  });
