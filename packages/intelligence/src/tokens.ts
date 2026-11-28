import type { InferenceRequest } from '@devbrain/contracts';

type Message = InferenceRequest['messages'][number];

/** A model-specific tokenizer, when one is available locally. */
export interface Tokenizer {
  count(text: string): number;
}

/**
 * Conservative upper bound when the model tokenizer is unknown. BPE tokenizers average ~4
 * characters per token in English prose and fewer for code, CJK or dense symbols; counting
 * every 3 UTF-8 bytes (or every non-ASCII code point) as one token over-estimates in practice,
 * which is the safe direction for context fit and budget reservations.
 */
export const conservativeTokens = (text: string): number => {
  let ascii = 0,
    other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
};

/** Per-message framing overhead (role markers, separators) across chat protocols. */
const MESSAGE_OVERHEAD = 8;

export interface TokenEstimate {
  tokens: number;
  tokenizer: 'exact' | 'conservative';
}

export const estimateMessages = (
  messages: readonly Pick<Message, 'role' | 'content'>[],
  tokenizer?: Tokenizer,
): TokenEstimate => {
  const count = tokenizer ? (t: string) => tokenizer.count(t) : conservativeTokens;
  const tokens = messages.reduce((sum, m) => sum + count(m.content) + MESSAGE_OVERHEAD, 3);
  return { tokens, tokenizer: tokenizer ? 'exact' : 'conservative' };
};

export const estimateText = (text: string, tokenizer?: Tokenizer): number =>
  tokenizer ? tokenizer.count(text) : conservativeTokens(text);
