import { describe, expect, it } from 'vitest';
import {
  AiResourceSafeUrlSchema,
  InferenceRequestSchema,
  PricingDefinitionSchema,
} from './entities/ai-resource.js';
import { IPC_CHANNELS, IPC_EVENTS } from './ipc.js';

describe('AI resource contracts', () => {
  it('rejects credential-bearing and private remote endpoints', () => {
    expect(AiResourceSafeUrlSchema.safeParse('https://user:secret@example.com/v1').success).toBe(
      false,
    );
    expect(AiResourceSafeUrlSchema.safeParse('http://example.com/v1').success).toBe(false);
    expect(AiResourceSafeUrlSchema.safeParse('http://localhost:11434').success).toBe(true);
  });

  it('keeps unknown price distinct from free', () => {
    const price = PricingDefinitionSchema.parse({
      currency: 'USD',
      inputPerMillion: null,
      outputPerMillion: null,
      cachedInputPerMillion: null,
      verifiedAt: null,
      sourceUrl: null,
    });
    expect(price.inputPerMillion).toBeNull();
  });

  it('requires a routing policy and nonempty messages', () => {
    expect(InferenceRequestSchema.safeParse({ id: 'req_1', messages: [] }).success).toBe(false);
    expect(IPC_CHANNELS['ai.inference.submit']).toBeDefined();
    expect(IPC_EVENTS['ai.inference.event']).toBeDefined();
  });
});
