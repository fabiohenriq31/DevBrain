import {
  DevBrainError,
  DiscoveredProviderModelSchema,
  type DiscoveredProviderModel,
  type InferenceRequest,
  type ProviderEndpoint,
} from '@devbrain/contracts';
import { SafeHttpTransport } from './transport.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positiveInt = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
};
const tokenPrice = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^(?:\d+)(?:\.\d+)?$/.test(value)) return null;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

export interface Generation {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: 'stop' | 'length' | 'tool-call' | 'content-filter' | 'unknown';
  /** Only non-secret, recognized rate-limit headers; no arbitrary response metadata. */
  quotaHeaders?: Record<string, string>;
}
export type GenerationPart =
  { type: 'delta'; text: string } | { type: 'done'; generation: Generation };

const apiError = (status: number, data: unknown, retryAfter?: string | string[]): DevBrainError => {
  const error = object(object(data).error);
  const code = text(error.code) || text(error.type);
  const retry = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = retry ? Number(retry) : NaN;
  const millis =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : retry
        ? Date.parse(retry) - Date.now()
        : NaN;
  const details =
    Number.isFinite(millis) && millis >= 0
      ? { retryAfterMs: Math.min(millis, 86_400_000) }
      : undefined;
  if (status === 401 || status === 403)
    return new DevBrainError('CREDENTIAL_UNAVAILABLE', 'Provider rejected credentials');
  if (status === 429 || /rate.limit/i.test(code))
    return new DevBrainError('RATE_LIMITED', 'Provider rate limit reached', {
      ...(details ? { details } : {}),
    });
  if (/quota|credit|billing/i.test(code))
    return new DevBrainError('QUOTA_EXCEEDED', 'Provider quota or credit exhausted');
  if (status >= 500)
    return new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider server unavailable');
  return new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider rejected inference request');
};

const finish = (value: unknown): Generation['finishReason'] => {
  const reason = text(value).toLowerCase();
  if (['stop', 'end_turn', 'stop_sequence'].includes(reason)) return 'stop';
  if (['length', 'max_tokens'].includes(reason)) return 'length';
  if (reason.includes('tool')) return 'tool-call';
  if (reason.includes('filter') || reason.includes('safety')) return 'content-filter';
  return 'unknown';
};

const quotaHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const name of ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens']) {
    const value = headers[name];
    if (typeof value === 'string' && /^\d{1,15}$/.test(value)) result[name] = value;
  }
  return result;
};

const normalized = (protocol: ProviderEndpoint['protocol'], data: unknown): Generation => {
  const root = object(data);
  if (root.error) throw apiError(200, root);
  if (protocol === 'openai-chat' || protocol === 'custom') {
    const choice = object(array(root.choices)[0]);
    const usage = object(root.usage);
    const content = text(object(choice.message).content);
    if (!choice.message)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed chat completion');
    return {
      content,
      inputTokens: number(usage.prompt_tokens),
      outputTokens: number(usage.completion_tokens),
      finishReason: finish(choice.finish_reason),
    };
  }
  if (protocol === 'openai-responses') {
    const outputs = array(root.output);
    const content =
      text(root.output_text) ||
      outputs
        .flatMap((item) => array(object(item).content).map((part) => text(object(part).text)))
        .join('');
    if (!root.output && !root.output_text)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Responses payload');
    const usage = object(root.usage);
    return {
      content,
      inputTokens: number(usage.input_tokens),
      outputTokens: number(usage.output_tokens),
      finishReason: root.status === 'completed' ? 'stop' : 'unknown',
    };
  }
  if (protocol === 'anthropic-messages') {
    if (!root.content)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Messages payload');
    const usage = object(root.usage);
    return {
      content: array(root.content)
        .map((part) => text(object(part).text))
        .join(''),
      inputTokens: number(usage.input_tokens),
      outputTokens: number(usage.output_tokens),
      finishReason: finish(root.stop_reason),
    };
  }
  if (protocol === 'google-gemini') {
    const candidate = object(array(root.candidates)[0]);
    if (!root.candidates)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Gemini payload');
    const usage = object(root.usageMetadata);
    return {
      content: array(object(candidate.content).parts)
        .map((part) => text(object(part).text))
        .join(''),
      inputTokens: number(usage.promptTokenCount),
      outputTokens: number(usage.candidatesTokenCount),
      finishReason: finish(candidate.finishReason),
    };
  }
  if (!root.message) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Ollama payload');
  return {
    content: text(object(root.message).content),
    inputTokens: number(root.prompt_eval_count),
    outputTokens: number(root.eval_count),
    finishReason: finish(root.done_reason),
  };
};

const build = (
  endpoint: ProviderEndpoint,
  request: InferenceRequest,
  model: string,
  credential: string | null,
  stream: boolean,
) => {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const protocol = endpoint.protocol;
  const messages = request.messages;
  if (messages.some((m) => m.role === 'tool'))
    throw new DevBrainError('UNSUPPORTED', 'Tool results require an explicit tool-capable adapter');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream
      ? 'text/event-stream, application/x-ndjson, application/json'
      : 'application/json',
  };
  if (credential) {
    if (protocol === 'anthropic-messages') {
      headers['x-api-key'] = credential;
      headers['anthropic-version'] = '2023-06-01';
    } else if (protocol === 'google-gemini') headers['x-goog-api-key'] = credential;
    else headers.authorization = `Bearer ${credential}`;
  }
  let path: string;
  let body: JsonObject;
  if (protocol === 'openai-chat' || protocol === 'custom') {
    path = '/chat/completions';
    body = {
      model,
      messages,
      stream,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== null ? { temperature: request.temperature } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  } else if (protocol === 'openai-responses') {
    path = '/responses';
    body = {
      model,
      input: messages,
      stream,
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
  } else if (protocol === 'anthropic-messages') {
    path = '/v1/messages';
    const system = messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => m.content)
      .join('\n\n');
    body = {
      model,
      max_tokens: request.maxOutputTokens ?? 1024,
      messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
      stream,
      ...(system ? { system } : {}),
      ...(request.temperature !== null ? { temperature: request.temperature } : {}),
    };
  } else if (protocol === 'google-gemini') {
    path = `/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const system = messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => m.content)
      .join('\n\n');
    body = {
      contents: messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== null ? { temperature: request.temperature } : {}),
      },
    };
  } else {
    path = '/api/chat';
    body = {
      model,
      messages,
      stream,
      ...(request.temperature !== null ? { options: { temperature: request.temperature } } : {}),
    };
  }
  return { url: base + path, headers, body: JSON.stringify(body) };
};

/** One protocol normalization point; no tools or side effects are granted to model output. */
export class ProtocolTransport {
  constructor(private readonly http: SafeHttpTransport = new SafeHttpTransport()) {}

  /** Authenticated discovery only. A public model catalog never proves a private key. */
  async discoverModels(
    endpoint: ProviderEndpoint,
    providerId: string,
    credential: string | null,
  ): Promise<DiscoveredProviderModel[]> {
    const supported = [
      'openrouter',
      'groq',
      'google',
      'openai',
      'anthropic',
      'ollama',
      'lmstudio',
      'llama-cpp',
    ];
    if (!supported.includes(providerId))
      throw new DevBrainError('UNSUPPORTED', 'Authenticated model discovery is unavailable');
    const local = ['ollama', 'lmstudio', 'llama-cpp'].includes(providerId);
    if (!credential && !local)
      throw new DevBrainError('CREDENTIAL_UNAVAILABLE', 'Credential required');
    const base = endpoint.baseUrl.replace(/\/+$/, '');
    const allowLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (providerId === 'google' && credential) headers['x-goog-api-key'] = credential;
    else if (providerId === 'anthropic' && credential) {
      headers['x-api-key'] = credential;
      headers['anthropic-version'] = '2023-06-01';
    } else if (credential && !local) headers.authorization = `Bearer ${credential}`;
    // OpenRouter's models endpoint is public. Authenticate against the key endpoint first.
    if (providerId === 'openrouter') {
      const auth = await this.http.json({
        url: `${base}/key`,
        method: 'GET',
        headers,
        allowLoopback,
        timeoutMs: 10_000,
      });
      if (auth.status !== 200 || object(auth.data).error) throw apiError(auth.status, auth.data);
    }
    const sourceUrl = `${base}${providerId === 'anthropic' ? '/v1/models' : providerId === 'ollama' ? '/api/tags' : '/models'}`;
    const observedAt = new Date().toISOString();
    const entries: DiscoveredProviderModel[] = [];
    let nextPage: string | null = null;
    for (let page = 0; page < (providerId === 'google' ? 10 : 1); page++) {
      const url = new URL(sourceUrl);
      if (providerId === 'google') {
        url.searchParams.set('pageSize', '100');
        if (nextPage) url.searchParams.set('pageToken', nextPage);
      }
      const response = await this.http.json({
        url: url.toString(),
        method: 'GET',
        headers,
        allowLoopback,
        timeoutMs: 15_000,
      });
      if (response.status !== 200 || object(response.data).error)
        throw apiError(response.status, response.data);
      const root = object(response.data);
      const list = array(
        providerId === 'google' || providerId === 'ollama' ? root.models : root.data,
      );
      for (const item of list) {
        if (entries.length >= 1000) break;
        const raw = object(item);
        const id = text(raw.id) || text(raw.name);
        if (!id || id.length > 300) continue;
        const params = array(raw.supported_parameters).filter(
          (p): p is string => typeof p === 'string',
        );
        const rawPrice = object(raw.pricing);
        const input = providerId === 'openrouter' ? tokenPrice(rawPrice.prompt) : null;
        const output = providerId === 'openrouter' ? tokenPrice(rawPrice.completion) : null;
        const pricing =
          input !== null && output !== null
            ? {
                currency: 'USD',
                inputPerMillion: input,
                outputPerMillion: output,
                cachedInputPerMillion: null,
                verifiedAt: observedAt,
                sourceUrl,
              }
            : null;
        const model = DiscoveredProviderModelSchema.parse({
          upstreamModelId: id.replace(/^models\//, providerId === 'google' ? '' : 'models/'),
          name: text(raw.displayName) || text(raw.name) || id,
          tools:
            providerId === 'openrouter' && Array.isArray(raw.supported_parameters)
              ? params.includes('tools')
              : null,
          contextTokens:
            positiveInt(raw.context_length) ??
            positiveInt(raw.context_window) ??
            positiveInt(raw.inputTokenLimit),
          outputTokens:
            positiveInt(object(raw.top_provider).max_completion_tokens) ??
            positiveInt(raw.outputTokenLimit),
          pricing,
          sourceUrl,
          observedAt,
        });
        entries.push(model);
      }
      nextPage = providerId === 'google' ? text(root.nextPageToken) || null : null;
      if (!nextPage || entries.length >= 1000) break;
    }
    return entries;
  }

  /** Read-only credential and model probe. Never performs billable inference. */
  async probeModel(
    endpoint: ProviderEndpoint,
    upstreamModelId: string,
    credential: string | null,
  ): Promise<'available' | 'unavailable' | 'unknown'> {
    const protocol = endpoint.protocol;
    const base = endpoint.baseUrl.replace(/\/+$/, '');
    const path =
      protocol === 'ollama'
        ? '/api/tags'
        : protocol === 'anthropic-messages'
          ? '/v1/models'
          : '/models';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (credential) {
      if (protocol === 'anthropic-messages') {
        headers['x-api-key'] = credential;
        headers['anthropic-version'] = '2023-06-01';
      } else if (protocol === 'google-gemini') headers['x-goog-api-key'] = credential;
      else headers.authorization = `Bearer ${credential}`;
    }
    const response = await this.http.json({
      url: base + path,
      method: 'GET',
      headers,
      allowLoopback: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname),
      timeoutMs: 10_000,
    });
    if (response.status === 401 || response.status === 403)
      throw new DevBrainError('CREDENTIAL_UNAVAILABLE', 'Provider rejected credentials');
    if (response.status !== 200) return 'unknown';
    const root = object(response.data);
    if (root.error) throw apiError(200, root);
    const items =
      protocol === 'ollama' || protocol === 'google-gemini' ? array(root.models) : array(root.data);
    if (!items.length) return 'unknown';
    const ids = items.map((item) => text(object(item).id) || text(object(item).name));
    return ids.some((id) => id === upstreamModelId || id === `models/${upstreamModelId}`)
      ? 'available'
      : 'unavailable';
  }

  async generate(
    endpoint: ProviderEndpoint,
    request: InferenceRequest,
    model: string,
    credential: string | null,
    signal?: AbortSignal,
  ): Promise<Generation> {
    const call = build(endpoint, request, model, credential, false);
    const response = await this.http.json({
      ...call,
      method: 'POST',
      allowLoopback: ['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(endpoint.baseUrl).hostname,
      ),
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 400 || object(response.data).error)
      throw apiError(response.status, response.data, response.headers['retry-after']);
    return {
      ...normalized(endpoint.protocol, response.data),
      quotaHeaders: quotaHeaders(response.headers),
    };
  }

  async *stream(
    endpoint: ProviderEndpoint,
    request: InferenceRequest,
    model: string,
    credential: string | null,
    signal?: AbortSignal,
  ): AsyncIterable<GenerationPart> {
    const call = build(endpoint, request, model, credential, true);
    const response = await this.http.open({
      ...call,
      method: 'POST',
      allowLoopback: ['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(endpoint.baseUrl).hostname,
      ),
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 400) {
      let message = '';
      for await (const bytes of response.body) {
        message += Buffer.from(bytes as Uint8Array).toString('utf8');
        if (message.length > 16_384) break;
      }
      let data: unknown;
      try {
        data = JSON.parse(message);
      } catch {
        data = {};
      }
      throw apiError(response.status, data, response.headers['retry-after']);
    }
    let buffer = '',
      content = '',
      inputTokens: number | null = null,
      outputTokens: number | null = null;
    let reason: Generation['finishReason'] = 'unknown';
    let total = 0;
    const consume = (line: string): GenerationPart | null => {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
      if (!payload || payload === '[DONE]' || line.startsWith(':') || line.startsWith('event:'))
        return null;
      let data: JsonObject;
      try {
        data = object(JSON.parse(payload));
      } catch {
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed provider stream');
      }
      if (data.error) throw apiError(200, data);
      let delta = '';
      if (endpoint.protocol === 'openai-chat' || endpoint.protocol === 'custom') {
        const choice = object(array(data.choices)[0]);
        delta = text(object(choice.delta).content);
        if (choice.finish_reason) reason = finish(choice.finish_reason);
        inputTokens = number(object(data.usage).prompt_tokens) ?? inputTokens;
        outputTokens = number(object(data.usage).completion_tokens) ?? outputTokens;
      } else if (endpoint.protocol === 'openai-responses') {
        if (data.type === 'response.output_text.delta') delta = text(data.delta);
        if (data.type === 'response.completed') {
          const usage = object(object(data.response).usage);
          inputTokens = number(usage.input_tokens);
          outputTokens = number(usage.output_tokens);
          reason = 'stop';
        }
      } else if (endpoint.protocol === 'anthropic-messages') {
        if (data.type === 'content_block_delta') delta = text(object(data.delta).text);
        if (data.type === 'message_delta') reason = finish(object(data.delta).stop_reason);
        const usage = object(data.usage ?? object(data.message).usage);
        inputTokens = number(usage.input_tokens) ?? inputTokens;
        outputTokens = number(usage.output_tokens) ?? outputTokens;
      } else if (endpoint.protocol === 'google-gemini') {
        const candidate = object(array(data.candidates)[0]);
        const part = object(array(object(candidate.content).parts)[0]);
        delta = text(part.text);
        const usage = object(data.usageMetadata);
        inputTokens = number(usage.promptTokenCount) ?? inputTokens;
        outputTokens = number(usage.candidatesTokenCount) ?? outputTokens;
        if (candidate.finishReason) reason = finish(candidate.finishReason);
      } else {
        delta = text(object(data.message).content);
        inputTokens = number(data.prompt_eval_count) ?? inputTokens;
        outputTokens = number(data.eval_count) ?? outputTokens;
        if (data.done) reason = finish(data.done_reason);
      }
      if (!delta) return null;
      content += delta;
      return { type: 'delta', text: delta };
    };
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > 8_000_000) {
        response.body.destroy();
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider stream exceeds size limit');
      }
      buffer += bytes.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const part = consume(line);
        if (part) yield part;
      }
    }
    if (buffer.trim()) {
      const part = consume(buffer.trim());
      if (part) yield part;
    }
    if (!content && reason === 'unknown')
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider stream ended without output');
    yield {
      type: 'done',
      generation: {
        content,
        inputTokens,
        outputTokens,
        finishReason: reason,
        quotaHeaders: quotaHeaders(response.headers),
      },
    };
  }
}
