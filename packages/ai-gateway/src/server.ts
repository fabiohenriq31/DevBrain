import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DevBrainError, InferenceRequestSchema } from '@devbrain/contracts';
import type { AiGateway } from './gateway.js';

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 1_000_000) throw new DevBrainError('VALIDATION_FAILED', 'Request too large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DevBrainError('VALIDATION_FAILED', 'Invalid JSON');
  }
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};

/** OpenAI content may be a string, null, or an array of parts; only text parts are accepted. */
const contentText = (content: unknown): string => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content))
    throw new DevBrainError('VALIDATION_FAILED', 'Unsupported message content');
  return content
    .map((part) => {
      const item = obj(part);
      if (item.type !== 'text' || typeof item.text !== 'string')
        throw new DevBrainError('UNSUPPORTED', 'Only text content parts are supported');
      return item.text;
    })
    .join('');
};

/**
 * Translates OpenAI Chat Completions tool fields into the gateway contract. The bridge only
 * TRANSPORTS calls and results; it never executes a tool. Results are correlated by call id
 * and the tool name is recovered from the assistant turn that proposed the call.
 */
export const translateOpenAiChat = (input: Json) => {
  if (input.functions !== undefined || input.function_call !== undefined)
    throw new DevBrainError('UNSUPPORTED', 'Legacy function calling is not supported; use tools');
  const names = new Map<string, string>();
  const messages = (input.messages as unknown[]).map((raw) => {
    const m = obj(raw);
    if (m.function_call !== undefined)
      throw new DevBrainError('UNSUPPORTED', 'Legacy function calling is not supported; use tools');
    const role = m.role;
    if (role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      if (!id) throw new DevBrainError('VALIDATION_FAILED', 'Tool message needs tool_call_id');
      const name = names.get(id);
      return { role, content: contentText(m.content), toolCallId: id, ...(name ? { name } : {}) };
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const toolCalls = m.tool_calls.map((rawCall) => {
        const call = obj(rawCall);
        const fn = obj(call.function);
        if (call.type !== undefined && call.type !== 'function')
          throw new DevBrainError('UNSUPPORTED', 'Only function tool calls are supported');
        const id = typeof call.id === 'string' ? call.id : '';
        const name = typeof fn.name === 'string' ? fn.name : '';
        names.set(id, name);
        return { id, name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}' };
      });
      return { role, content: contentText(m.content), toolCalls };
    }
    return { role, content: contentText(m.content) };
  });
  const tools = Array.isArray(input.tools)
    ? input.tools.map((raw) => {
        const tool = obj(raw);
        if (tool.type !== 'function')
          throw new DevBrainError('UNSUPPORTED', 'Only function tools are supported');
        const fn = obj(tool.function);
        return {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: fn.parameters ?? { type: 'object', properties: {} },
        };
      })
    : [];
  const choice = input.tool_choice;
  const toolChoice =
    choice === undefined
      ? undefined
      : typeof choice === 'string'
        ? choice
        : { name: obj(obj(choice).function).name };
  return {
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(typeof input.parallel_tool_calls === 'boolean'
      ? { parallelToolCalls: input.parallel_tool_calls }
      : {}),
  };
};

const FINISH: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  'tool-call': 'tool_calls',
  'content-filter': 'content_filter',
  unknown: 'stop',
};

const chunk = (id: string, delta: unknown, finish: string | null): string =>
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const send = (response: ServerResponse, status: number, data: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
};

/** Optional, ephemeral loopback adapter for OpenAI-compatible coding clients. */
export class LocalGatewayServer {
  private server: Server | null = null;
  private readonly secret = randomBytes(32).toString('hex');
  private port = 0;

  /**
   * `context` binds this server instance (and its token) to one project/session, so that
   * project privacy and budget policies apply to everything an external client sends.
   */
  constructor(
    private readonly gateway: AiGateway,
    private readonly routingPolicyId: string,
    private readonly context: { projectId?: string; sessionId?: string } = {},
  ) {}

  /**
   * DNS-rebinding / browser defence: only loopback Host headers for our port, and no browser
   * Origin at all (coding clients are not browsers).
   */
  private trustedOrigin(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (request.headers.origin !== undefined) return false;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  get baseUrl(): string {
    if (!this.server) throw new DevBrainError('NOT_FOUND', 'Gateway server is not running');
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Keep this token in main-process memory; pass to an authorized child via its environment. */
  get token(): string {
    return this.secret;
  }

  private authenticated(request: IncomingMessage): boolean {
    const supplied = request.headers.authorization;
    if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
    const actual = Buffer.from(supplied.slice(7));
    const expected = Buffer.from(this.secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.trustedOrigin(request)) {
      send(response, 403, { error: { message: 'Forbidden host', type: 'forbidden' } });
      return;
    }
    if (!this.authenticated(request)) {
      send(response, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      send(response, 200, {
        object: 'list',
        data: this.gateway
          .models()
          .map((model) => ({ id: model.id, object: 'model', owned_by: model.providerId })),
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      send(response, 404, { error: { message: 'Unsupported path', type: 'not_found' } });
      return;
    }
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid completion request');
    const input = body as Record<string, unknown>;
    if (typeof input.model !== 'string' || !Array.isArray(input.messages))
      throw new DevBrainError('VALIDATION_FAILED', 'Model and messages are required');
    const translated = translateOpenAiChat(input);
    const parsed = InferenceRequestSchema.safeParse({
      id: `inf_${randomUUID()}`,
      sessionId: this.context.sessionId ?? null,
      ...(this.context.projectId ? { projectId: this.context.projectId } : {}),
      modelId: input.model,
      ...translated,
      maxOutputTokens: typeof input.max_tokens === 'number' ? input.max_tokens : null,
      temperature: typeof input.temperature === 'number' ? input.temperature : null,
      stream: input.stream === true,
      routingPolicyId: this.routingPolicyId,
      idempotencyKey: null,
    });
    if (!parsed.success) throw new DevBrainError('VALIDATION_FAILED', 'Invalid completion request');
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    if (parsed.data.stream) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      try {
        for await (const event of this.gateway.stream(parsed.data, controller.signal)) {
          if (event.type === 'delta')
            response.write(chunk(parsed.data.id, { content: event.text }, null));
          if (event.type === 'tool-call-delta')
            response.write(
              chunk(
                parsed.data.id,
                {
                  tool_calls: [
                    {
                      index: event.index,
                      ...(event.id ? { id: event.id, type: 'function' } : {}),
                      function: {
                        ...(event.name ? { name: event.name } : {}),
                        arguments: event.argumentsDelta,
                      },
                    },
                  ],
                },
                null,
              ),
            );
          if (event.type === 'completed')
            response.write(chunk(parsed.data.id, {}, FINISH[event.result.finishReason] ?? 'stop'));
        }
        response.end('data: [DONE]\n\n');
      } catch (error) {
        const message = DevBrainError.is(error) ? error.message : 'Inference failed';
        response.end(`data: ${JSON.stringify({ error: { message, type: 'gateway_error' } })}\n\n`);
      }
      return;
    }
    const result = await this.gateway.infer(parsed.data, controller.signal);
    send(response, 200, {
      id: result.requestId,
      object: 'chat.completion',
      model: result.modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.toolCalls?.length && !result.content ? null : result.content,
            ...(result.toolCalls?.length
              ? {
                  tool_calls: result.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          },
          finish_reason: FINISH[result.finishReason] ?? 'stop',
        },
      ],
      usage:
        result.usage && result.usage.inputTokens !== null && result.usage.outputTokens !== null
          ? {
              prompt_tokens: result.usage.inputTokens,
              completion_tokens: result.usage.outputTokens,
              total_tokens: result.usage.inputTokens + result.usage.outputTokens,
            }
          : undefined,
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = DevBrainError.is(error)
          ? error.code === 'VALIDATION_FAILED'
            ? 400
            : error.code === 'UNSUPPORTED'
              ? 501
              : 503
          : 503;
        send(response, status, {
          error: {
            message: DevBrainError.is(error) ? error.message : 'Gateway unavailable',
            type: 'gateway_error',
          },
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback port');
      this.port = address.port;
      this.server = server;
    } catch (error) {
      server.close();
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Could not start loopback gateway', {
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
