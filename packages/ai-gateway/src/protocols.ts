import {
  DevBrainError,
  type InferenceRequest,
  type ProviderEndpoint,
  type ToolCall,
} from '@devbrain/contracts';
import { SafeHttpTransport } from './transport.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface Generation {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: 'stop' | 'length' | 'tool-call' | 'content-filter' | 'unknown';
  /** Only non-secret, recognized rate-limit headers; no arbitrary response metadata. */
  quotaHeaders?: Record<string, string>;
  /** Structured calls proposed by the model. Transported, never executed here. */
  toolCalls?: ToolCall[];
}
export type GenerationPart =
  | { type: 'delta'; text: string }
  | {
      type: 'tool-call-delta';
      index: number;
      id: string | null;
      name: string | null;
      argumentsDelta: string;
    }
  | { type: 'done'; generation: Generation };

type Message = InferenceRequest['messages'][number];
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_CALLS = 64;

/** Parses model-produced argument JSON into an object; never throws (invalid → {}). */
const argsObject = (raw: string): JsonObject => {
  try {
    return object(JSON.parse(raw || '{}'));
  } catch {
    return {};
  }
};

/** Builds validated calls; malformed entries are dropped, never guessed. */
const toolCall = (id: unknown, name: unknown, args: unknown, index: number): ToolCall | null => {
  const callName = text(name);
  if (!TOOL_NAME.test(callName)) return null;
  const callId = (text(id) || `call_${index}`).slice(0, 200);
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return raw.length > 400_000 ? null : { id: callId, name: callName, arguments: raw };
};
const compact = (calls: (ToolCall | null)[]): ToolCall[] =>
  calls.filter((c): c is ToolCall => c !== null).slice(0, MAX_TOOL_CALLS);

/** Gemini accepts an OpenAPI subset: keep only the portable JSON Schema keywords. */
const GEMINI_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'format',
  'nullable',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'anyOf',
]);
const geminiSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema as JsonObject)) {
    if (!GEMINI_KEYS.has(key)) continue;
    if (key === 'properties') {
      const props: JsonObject = {};
      for (const [name, sub] of Object.entries(object(value))) props[name] = geminiSchema(sub);
      out.properties = props;
    } else out[key] = key === 'items' || key === 'anyOf' ? geminiSchema(value) : value;
  }
  return out;
};

const hasTools = (request: InferenceRequest): boolean =>
  !!request.tools?.length ||
  request.messages.some((m) => m.role === 'tool' || !!m.toolCalls?.length);

const openAiMessages = (messages: readonly Message[]) =>
  messages.map((m) => {
    if (m.role === 'tool')
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length)
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    return { role: m.role, content: m.content };
  });

const anthropicMessages = (messages: readonly Message[]) => {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      // Consecutive tool results answer one assistant turn: one user message, many blocks.
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        (last.content as JsonObject[])[0]?.type === 'tool_result'
      )
        (last.content as unknown[]).push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: argsObject(c.arguments),
          })),
        ],
      });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
};

const geminiContents = (messages: readonly Message[]) => {
  const out: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: m.name ?? '',
          response: m.isError ? { error: m.content } : { result: m.content },
        },
      };
      const last = out.at(-1);
      if (last?.role === 'user' && object(last.parts[0]).functionResponse) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'model',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            functionCall: { name: c.name, args: argsObject(c.arguments) },
          })),
        ],
      });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  return out;
};

const ollamaMessages = (messages: readonly Message[]) =>
  messages.map((m) =>
    m.role === 'assistant' && m.toolCalls?.length
      ? {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: argsObject(c.arguments) },
          })),
        }
      : m.role === 'tool'
        ? { role: 'tool', content: m.content, ...(m.name ? { tool_name: m.name } : {}) }
        : { role: m.role === 'developer' ? 'system' : m.role, content: m.content },
  );

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
    const message = object(choice.message);
    const content = text(message.content);
    if (!choice.message)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed chat completion');
    const toolCalls = compact(
      array(message.tool_calls).map((call, i) => {
        const fn = object(object(call).function);
        return toolCall(object(call).id, fn.name, text(fn.arguments), i);
      }),
    );
    return {
      content,
      inputTokens: number(usage.prompt_tokens),
      outputTokens: number(usage.completion_tokens),
      finishReason: toolCalls.length ? 'tool-call' : finish(choice.finish_reason),
      toolCalls,
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
    const blocks = array(root.content).map(object);
    const toolCalls = compact(
      blocks
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => toolCall(b.id, b.name, b.input ?? {}, i)),
    );
    return {
      content: blocks.map((part) => text(part.text)).join(''),
      inputTokens: number(usage.input_tokens),
      outputTokens: number(usage.output_tokens),
      finishReason: toolCalls.length ? 'tool-call' : finish(root.stop_reason),
      toolCalls,
    };
  }
  if (protocol === 'google-gemini') {
    const candidate = object(array(root.candidates)[0]);
    if (!root.candidates)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Gemini payload');
    const usage = object(root.usageMetadata);
    const parts = array(object(candidate.content).parts).map(object);
    const toolCalls = compact(
      parts
        .filter((part) => part.functionCall)
        .map((part, i) => {
          const call = object(part.functionCall);
          return toolCall(call.id, call.name, call.args ?? {}, i);
        }),
    );
    return {
      content: parts.map((part) => text(part.text)).join(''),
      inputTokens: number(usage.promptTokenCount),
      outputTokens: number(usage.candidatesTokenCount),
      finishReason: toolCalls.length ? 'tool-call' : finish(candidate.finishReason),
      toolCalls,
    };
  }
  if (!root.message) throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Malformed Ollama payload');
  const toolCalls = compact(
    array(object(root.message).tool_calls).map((call, i) => {
      const fn = object(object(call).function);
      return toolCall(object(call).id, fn.name, fn.arguments ?? {}, i);
    }),
  );
  return {
    content: text(object(root.message).content),
    inputTokens: number(root.prompt_eval_count),
    outputTokens: number(root.eval_count),
    finishReason: toolCalls.length ? 'tool-call' : finish(root.done_reason),
    toolCalls,
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
  const tools = request.tools ?? [];
  if (hasTools(request) && protocol === 'openai-responses')
    throw new DevBrainError(
      'UNSUPPORTED',
      'Tool calling is not implemented for the Responses protocol in this gateway',
    );
  const choice = request.toolChoice;
  const parallel = request.parallelToolCalls;
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
      messages: openAiMessages(messages),
      stream,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            ...(choice
              ? {
                  tool_choice:
                    typeof choice === 'string'
                      ? choice
                      : { type: 'function', function: { name: choice.name } },
                }
              : {}),
            ...(parallel !== undefined ? { parallel_tool_calls: parallel } : {}),
          }
        : {}),
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== null ? { temperature: request.temperature } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  } else if (protocol === 'openai-responses') {
    path = '/responses';
    body = {
      model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
  } else if (protocol === 'anthropic-messages') {
    path = '/v1/messages';
    const system = messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => m.content)
      .join('\n\n');
    const anthropicChoice =
      choice === undefined
        ? null
        : choice === 'none'
          ? { type: 'none' }
          : choice === 'required'
            ? { type: 'any' }
            : choice === 'auto'
              ? { type: 'auto' }
              : { type: 'tool', name: choice.name };
    body = {
      model,
      max_tokens: request.maxOutputTokens ?? 1024,
      messages: anthropicMessages(messages),
      stream,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            ...(anthropicChoice || parallel === false
              ? {
                  tool_choice: {
                    ...(anthropicChoice ?? { type: 'auto' }),
                    ...(parallel === false && anthropicChoice?.type !== 'none'
                      ? { disable_parallel_tool_use: true }
                      : {}),
                  },
                }
              : {}),
          }
        : {}),
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
      contents: geminiContents(messages),
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: geminiSchema(t.parameters),
                })),
              },
            ],
            ...(choice
              ? {
                  toolConfig: {
                    functionCallingConfig:
                      typeof choice === 'string'
                        ? { mode: choice === 'required' ? 'ANY' : choice.toUpperCase() }
                        : { mode: 'ANY', allowedFunctionNames: [choice.name] },
                  },
                }
              : {}),
          }
        : {}),
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
      messages: ollamaMessages(messages),
      stream,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(request.temperature !== null ? { options: { temperature: request.temperature } } : {}),
    };
  }
  return { url: base + path, headers, body: JSON.stringify(body) };
};

/** One protocol normalization point; no tools or side effects are granted to model output. */
export class ProtocolTransport {
  constructor(private readonly http: SafeHttpTransport = new SafeHttpTransport()) {}

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
    // Tool calls accumulate by provider index; fragments are also forwarded as deltas.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const pending: GenerationPart[] = [];
    const fragment = (index: number, id: unknown, name: unknown, args: string) => {
      if (index < 0 || index >= MAX_TOOL_CALLS) return;
      const call = calls.get(index) ?? { id: '', name: '', args: '' };
      if (text(id)) call.id = text(id);
      if (text(name)) call.name = text(name);
      call.args += args;
      if (call.args.length > 400_000)
        throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Tool call arguments exceed size limit');
      calls.set(index, call);
      pending.push({
        type: 'tool-call-delta',
        index,
        id: text(id) || null,
        name: text(name) || null,
        argumentsDelta: args,
      });
    };
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
        for (const raw of array(object(choice.delta).tool_calls)) {
          const call = object(raw);
          const fn = object(call.function);
          fragment(number(call.index) ?? 0, call.id, fn.name, text(fn.arguments));
        }
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
        if (data.type === 'content_block_start' && object(data.content_block).type === 'tool_use') {
          const block = object(data.content_block);
          fragment(number(data.index) ?? 0, block.id, block.name, '');
        }
        if (
          data.type === 'content_block_delta' &&
          object(data.delta).type === 'input_json_delta' &&
          calls.has(number(data.index) ?? -1)
        )
          fragment(number(data.index) ?? 0, null, null, text(object(data.delta).partial_json));
        if (data.type === 'message_delta') reason = finish(object(data.delta).stop_reason);
        const usage = object(data.usage ?? object(data.message).usage);
        inputTokens = number(usage.input_tokens) ?? inputTokens;
        outputTokens = number(usage.output_tokens) ?? outputTokens;
      } else if (endpoint.protocol === 'google-gemini') {
        const candidate = object(array(data.candidates)[0]);
        const parts = array(object(candidate.content).parts).map(object);
        delta = parts.map((p) => text(p.text)).join('');
        for (const p of parts.filter((x) => x.functionCall)) {
          const call = object(p.functionCall);
          fragment(calls.size, call.id, call.name, JSON.stringify(call.args ?? {}));
        }
        const usage = object(data.usageMetadata);
        inputTokens = number(usage.promptTokenCount) ?? inputTokens;
        outputTokens = number(usage.candidatesTokenCount) ?? outputTokens;
        if (candidate.finishReason) reason = finish(candidate.finishReason);
      } else {
        delta = text(object(data.message).content);
        for (const raw of array(object(data.message).tool_calls)) {
          const fn = object(object(raw).function);
          fragment(calls.size, object(raw).id, fn.name, JSON.stringify(fn.arguments ?? {}));
        }
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
        yield* pending.splice(0);
        if (part) yield part;
      }
    }
    if (buffer.trim()) {
      const part = consume(buffer.trim());
      yield* pending.splice(0);
      if (part) yield part;
    }
    const toolCalls = compact(
      [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => toolCall(call.id, call.name, call.args || '{}', index)),
    );
    if (!content && !toolCalls.length && reason === 'unknown')
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider stream ended without output');
    yield {
      type: 'done',
      generation: {
        content,
        inputTokens,
        outputTokens,
        finishReason: toolCalls.length ? 'tool-call' : reason,
        quotaHeaders: quotaHeaders(response.headers),
        toolCalls,
      },
    };
  }
}
