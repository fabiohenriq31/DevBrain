import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type DevBrainDatabase } from '@devbrain/database';
import type {
  InferenceRequest,
  ModelDefinition,
  ProviderEndpoint,
  ToolDefinition,
} from '@devbrain/contracts';
import { AiGateway } from './gateway.js';
import { ProtocolTransport, type GenerationPart } from './protocols.js';
import { LocalGatewayServer, translateOpenAiChat } from './server.js';

const databases: DevBrainDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;
const upstream = async (handler: Handler) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      bodies.push(body);
      handler(body, req, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
const json = (res: ServerResponse, data: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const sse = (res: ServerResponse, events: unknown[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
};

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a workspace file',
  parameters: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};
const ep = (url: string, protocol: ProviderEndpoint['protocol']): ProviderEndpoint => ({
  id: 'endpoint-a',
  providerId: 'provider-a',
  baseUrl: protocol === 'anthropic-messages' || protocol === 'ollama' ? url : `${url}/v1`,
  protocol,
  documentationUrl: null,
});
/** Second turn: the model already called read_file and got a result back. */
const req = (stream = false): InferenceRequest => ({
  id: `request-${crypto.randomUUID()}`,
  sessionId: null,
  modelId: null,
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Fix the bug' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' }],
    },
    { role: 'tool', content: 'module.exports = 1', toolCallId: 'call_1', name: 'read_file' },
  ],
  maxOutputTokens: 100,
  temperature: null,
  stream,
  routingPolicyId: 'default-policy',
  idempotencyKey: null,
  tools: [readTool],
  toolChoice: 'auto',
});

const collect = async (parts: AsyncIterable<GenerationPart>) => {
  const out: GenerationPart[] = [];
  for await (const part of parts) out.push(part);
  return out;
};

describe('OpenAI Chat Completions tool calling', () => {
  it('serializes tools, history and parses parallel calls', async () => {
    const server = await upstream((_b, _r, res) =>
      json(res, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"x"}' },
                },
                {
                  id: 'c2',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"y"}' },
                },
                { id: 'bad', type: 'function', function: { name: 'has spaces', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    try {
      const result = await new ProtocolTransport().generate(
        ep(server.url, 'openai-chat'),
        req(),
        'm',
        null,
      );
      expect(result.finishReason).toBe('tool-call');
      expect(result.toolCalls).toEqual([
        { id: 'c1', name: 'read_file', arguments: '{"path":"x"}' },
        { id: 'c2', name: 'read_file', arguments: '{"path":"y"}' },
      ]);
      const body = server.bodies[0]!;
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: readTool.description,
            parameters: readTool.parameters,
          },
        },
      ]);
      expect(body.tool_choice).toBe('auto');
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[2]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.js"}' },
          },
        ],
      });
      expect(messages[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'module.exports = 1',
      });
    } finally {
      await server.close();
    }
  });

  it('accumulates streamed argument fragments by index', async () => {
    const server = await upstream((_b, _r, res) =>
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }],
        },
        {
          choices: [{ finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        },
      ]),
    );
    try {
      const parts = await collect(
        new ProtocolTransport().stream(ep(server.url, 'openai-chat'), req(true), 'm', null),
      );
      expect(parts.filter((p) => p.type === 'tool-call-delta')).toHaveLength(3);
      expect(parts.at(-1)).toMatchObject({
        type: 'done',
        generation: {
          finishReason: 'tool-call',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe('Anthropic Messages tool calling', () => {
  it('maps tool_use / tool_result blocks and tool_choice', async () => {
    const server = await upstream((_b, _r, res) =>
      json(res, {
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'b.js' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
    );
    try {
      const input = { ...req(), toolChoice: 'required' as const, parallelToolCalls: false };
      input.messages = [
        ...input.messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' },
            { id: 'call_3', name: 'read_file', arguments: '{"path":"c"}' },
          ],
        },
        { role: 'tool', content: 'B', toolCallId: 'call_2', name: 'read_file' },
        {
          role: 'tool',
          content: 'missing',
          toolCallId: 'call_3',
          name: 'read_file',
          isError: true,
        },
      ];
      const result = await new ProtocolTransport().generate(
        ep(server.url, 'anthropic-messages'),
        input,
        'claude',
        null,
      );
      expect(result.content).toBe('Reading.');
      expect(result.toolCalls).toEqual([
        { id: 'toolu_1', name: 'read_file', arguments: '{"path":"b.js"}' },
      ]);
      const body = server.bodies[0]!;
      expect(body.tools).toEqual([
        { name: 'read_file', description: readTool.description, input_schema: readTool.parameters },
      ]);
      expect(body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
      const messages = body.messages as { role: string; content: unknown }[];
      expect(messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(messages[1]!.content).toEqual([
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.js' } },
      ]);
      // Two consecutive results merge into ONE user message, errors flagged.
      expect(messages[4]!.content).toEqual([
        { type: 'tool_result', tool_use_id: 'call_2', content: 'B' },
        { type: 'tool_result', tool_use_id: 'call_3', content: 'missing', is_error: true },
      ]);
    } finally {
      await server.close();
    }
  });

  it('streams input_json_delta into a structured call', async () => {
    const server = await upstream((_b, _r, res) =>
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"z"}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      ]),
    );
    try {
      const parts = await collect(
        new ProtocolTransport().stream(
          ep(server.url, 'anthropic-messages'),
          req(true),
          'claude',
          null,
        ),
      );
      expect(parts.at(-1)).toMatchObject({
        type: 'done',
        generation: {
          finishReason: 'tool-call',
          toolCalls: [{ id: 'toolu_9', name: 'read_file', arguments: '{"path":"z"}' }],
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe('Gemini tool calling', () => {
  it('uses functionDeclarations with a sanitized schema and functionResponse history', async () => {
    const server = await upstream((_b, _r, res) =>
      json(res, {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'q.js' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      }),
    );
    try {
      const result = await new ProtocolTransport().generate(
        ep(server.url, 'google-gemini'),
        { ...req(), toolChoice: { name: 'read_file' } },
        'gemini-x',
        null,
      );
      expect(result.finishReason).toBe('tool-call');
      expect(result.toolCalls?.[0]).toMatchObject({
        name: 'read_file',
        arguments: '{"path":"q.js"}',
      });
      expect(result.toolCalls?.[0]?.id).toBeTruthy();
      const body = server.bodies[0]!;
      expect(body.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: readTool.description,
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          ],
        },
      ]);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] },
      });
      const contents = body.contents as { role: string; parts: unknown[] }[];
      expect(contents[1]).toEqual({
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: { path: 'a.js' } } }],
      });
      expect(contents[2]).toEqual({
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { result: 'module.exports = 1' } } },
        ],
      });
    } finally {
      await server.close();
    }
  });
});

describe('Ollama and unsupported protocols', () => {
  it('parses Ollama object arguments', async () => {
    const server = await upstream((_b, _r, res) =>
      json(res, {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'o' } } }],
        },
        done_reason: 'stop',
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    );
    try {
      const result = await new ProtocolTransport().generate(
        ep(server.url, 'ollama'),
        req(),
        'llama',
        null,
      );
      expect(result.toolCalls).toEqual([
        { id: 'call_0', name: 'read_file', arguments: '{"path":"o"}' },
      ]);
      expect((server.bodies[0]!.tools as unknown[]).length).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('refuses tools on the Responses protocol instead of faking support', async () => {
    await expect(
      new ProtocolTransport().generate(
        ep('http://127.0.0.1:9', 'openai-responses'),
        req(),
        'm',
        null,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

const capable = (id: string, tools: boolean): ModelDefinition => ({
  id,
  providerId: 'provider-a',
  upstreamModelId: id,
  name: id,
  capabilities: {
    input: ['text'],
    output: ['text'],
    tools,
    streaming: true,
    structuredOutput: false,
    reasoning: false,
    contextTokens: null,
    outputTokens: null,
  },
  pricing: {
    currency: 'USD',
    inputPerMillion: 0,
    outputPerMillion: 0,
    cachedInputPerMillion: null,
    verifiedAt: '2026-11-27T00:00:00.000Z',
    sourceUrl: null,
  },
  lifecycle: 'active',
  sourceId: 'manual',
  verifiedAt: null,
});

const gatewayWith = (url: string) => {
  const database = createDatabase({ location: ':memory:' });
  databases.push(database);
  const gateway = new AiGateway(database.driver, async () => '');
  gateway.configurePolicy({
    policy: {
      id: 'default-policy',
      strategy: 'priority',
      billingPolicyId: 'billing',
      privacyPolicyId: 'privacy',
      maxAttempts: 2,
      requireTools: false,
    },
    billing: {
      id: 'billing',
      allowPaid: false,
      allowUnknownCost: false,
      maxCostPerRequest: null,
      maxCostPerDay: null,
      currency: 'USD',
    },
    privacy: {
      id: 'privacy',
      mode: 'any-configured',
      allowedProviderIds: [],
      allowPromptLogging: false,
    },
  });
  gateway.saveEndpoint(ep(url, 'openai-chat'));
  gateway.saveConnection({
    id: 'connection-a',
    endpointId: 'endpoint-a',
    providerId: 'provider-a',
    credentialId: null,
    enabled: true,
    status: 'ready',
    lastVerifiedAt: null,
  });
  // Higher priority model has NO tool capability: it must be excluded, not tried.
  gateway.saveModel(capable('text-only', false));
  gateway.saveModel(capable('tool-model', true));
  gateway.saveRoute({
    id: 'route-text',
    modelId: 'text-only',
    connectionId: 'connection-a',
    priority: 0,
    enabled: true,
    localOnly: false,
  });
  gateway.saveRoute({
    id: 'route-tools',
    modelId: 'tool-model',
    connectionId: 'connection-a',
    priority: 1,
    enabled: true,
    localOnly: false,
  });
  return gateway;
};

describe('gateway tool routing', () => {
  it('routes tool requests only to tool-capable models and returns structured calls', async () => {
    const server = await upstream((body, _r, res) =>
      json(res, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: body.model,
      }),
    );
    try {
      const gateway = gatewayWith(server.url);
      const result = await gateway.infer(req());
      expect(result.modelId).toBe('tool-model');
      expect(result.toolCalls).toEqual([
        { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
      ]);
      expect(server.bodies.map((b) => b.model)).toEqual(['tool-model']);
      // Persisted metadata never keeps model-produced arguments.
      expect(gateway.result(result.requestId)?.toolCalls?.[0]?.arguments).toBe('');
    } finally {
      await server.close();
    }
  });
});

describe('loopback OpenAI bridge with tools', () => {
  it('transports tool calls without executing them, streamed and not', async () => {
    let streamed = false;
    const server = await upstream((body, _r, res) => {
      if (body.stream) {
        streamed = true;
        sse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c7',
                      function: { name: 'read_file', arguments: '{"path":"s"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ finish_reason: 'tool_calls' }] },
        ]);
      } else
        json(res, {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
    });
    const bridge = new LocalGatewayServer(gatewayWith(server.url), 'default-policy');
    await bridge.start();
    const call = (payload: unknown) =>
      fetch(`${bridge.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const payload = {
      model: 'tool-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c0',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"p"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c0', content: 'data' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'r', parameters: { type: 'object' } },
        },
      ],
    };
    try {
      const plain = await call(payload);
      expect(plain.status).toBe(200);
      const data = (await plain.json()) as {
        choices: { message: Record<string, unknown>; finish_reason: string }[];
      };
      expect(data.choices[0]!.finish_reason).toBe('tool_calls');
      expect(data.choices[0]!.message).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      });
      const forwarded = server.bodies[0]!.messages as Record<string, unknown>[];
      expect(forwarded[2]).toEqual({
        role: 'tool',
        tool_call_id: 'c0',
        content: '<untrusted-data source="tool">\ndata\n</untrusted-data>',
      });

      const stream = await call({ ...payload, stream: true });
      const text = await stream.text();
      expect(streamed).toBe(true);
      expect(text).toContain('"tool_calls":[{"index":0,"id":"c7","type":"function"');
      expect(text).toContain('"finish_reason":"tool_calls"');

      const legacy = await call({ ...payload, functions: [{ name: 'x' }] });
      expect(legacy.status).toBe(501);
    } finally {
      await bridge.close();
      await server.close();
    }
  });

  it('recovers tool names for results from the proposing assistant turn', () => {
    const out = translateOpenAiChat({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'k', type: 'function', function: { name: 'git_diff', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'k', content: 'diff' },
      ],
      tool_choice: { type: 'function', function: { name: 'git_diff' } },
      parallel_tool_calls: false,
    });
    expect(out.messages[1]).toEqual({
      role: 'tool',
      content: 'diff',
      toolCallId: 'k',
      name: 'git_diff',
    });
    expect(out.toolChoice).toEqual({ name: 'git_diff' });
    expect(out.parallelToolCalls).toBe(false);
  });
});
