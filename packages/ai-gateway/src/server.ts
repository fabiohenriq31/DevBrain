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

  constructor(
    private readonly gateway: AiGateway,
    private readonly routingPolicyId: string,
  ) {}

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
    const parsed = InferenceRequestSchema.safeParse({
      id: `inf_${randomUUID()}`,
      sessionId: null,
      modelId: input.model,
      messages: input.messages,
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
            response.write(
              `data: ${JSON.stringify({ id: parsed.data.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] })}\n\n`,
            );
          if (event.type === 'completed')
            response.write(
              `data: ${JSON.stringify({ id: parsed.data.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: event.result.finishReason }] })}\n\n`,
            );
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
          message: { role: 'assistant', content: result.content },
          finish_reason: result.finishReason,
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
        const status = DevBrainError.is(error) && error.code === 'VALIDATION_FAILED' ? 400 : 503;
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
