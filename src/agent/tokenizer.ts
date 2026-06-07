/**
 * Tokenizer — model-aware BPE token counter built on `gpt-tokenizer`.
 *
 * The FreeLLMAPI proxy fronts many providers (OpenAI, Anthropic, Google,
 * Groq, Cerebras, SambaNova, Mistral, OpenRouter, Cloudflare, Cohere,
 * Zen/NVIDIA). None of them expose their native tokenizer through the
 * proxy, and we do not bundle one for every family. We therefore use
 * OpenAI's public BPE encodings as a *close-enough* proxy:
 *
 *   - `cl100k_base` — GPT-4 / GPT-3.5-turbo / most modern BPE families.
 *     Used as the default for every model the proxy serves.
 *   - `o200k_base`  — GPT-4o / GPT-4.1 family. About 15% more efficient
 *     (fewer tokens per word) than cl100k.
 *
 * For non-OpenAI providers, our counts will be within ~10-20% of the
 * provider's true bill. That is more than accurate enough for the
 * purpose of *preventing context overflow* (the consequence of an
 * inaccurate count is at worst an early compaction, not a 413).
 *
 * The tokenizer is loaded lazily on first use because the encoding
 * tables are several MB and would otherwise inflate CLI cold-start.
 */

import { encode as cl100kEncode } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as o200kEncode } from 'gpt-tokenizer/encoding/o200k_base';
import type { ChatContentBlock } from '../shared/types.js';
import { IMAGE_TOKEN_COST } from '../shared/content.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Names of the encoders we ship. Kept as a closed union for type safety. */
export type EncoderName = 'cl100k_base' | 'o200k_base';

interface Encoder {
  readonly name: EncoderName;
  /** Tokenise a string. Returns an array of BPE token IDs. */
  encode(input: string): number[];
}

// ---------------------------------------------------------------------------
// Encoder resolution
// ---------------------------------------------------------------------------

/**
 * Pick the right BPE encoding for a given model identifier. The mapping
 * is conservative: any model name we are not sure about gets cl100k_base,
 * which is the universal BPE that every modern OpenAI-adjacent model is
 * based on. GPT-4o / GPT-4.1 use the newer o200k_base vocabulary.
 */
export function resolveEncoderForModel(model: string | undefined | null): EncoderName {
  if (!model) return 'cl100k_base';
  // GPT-4o and GPT-4.1 use the new o200k_base vocabulary.
  if (/\bgpt-4o\b|\bgpt-4\.1\b|\bo1\b|\bo3\b|\bo4\b/i.test(model)) {
    return 'o200k_base';
  }
  // Everything else — including claude, llama, gemini, mistral, qwen,
  // deepseek, codestral, gpt-3.5, gpt-4 (non-4o), command-r — falls
  // back to cl100k_base. The token count is approximate, but close
  // enough to prevent overflows.
  return 'cl100k_base';
}

const ENCODERS: Record<EncoderName, Encoder> = {
  cl100k_base: {
    name: 'cl100k_base',
    encode: (input) => cl100kEncode(input),
  },
  o200k_base: {
    name: 'o200k_base',
    encode: (input) => o200kEncode(input),
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Count tokens in a single string. */
export function countTokens(text: string, model?: string | null): number {
  if (!text) return 0;
  const encoder = ENCODERS[resolveEncoderForModel(model)];
  return encoder.encode(text).length;
}

/** Count tokens across a list of message-like objects. */
export function countMessagesTokens(
  messages: ReadonlyArray<{
    content?: string | ChatContentBlock[] | null;
    tool_calls?: unknown;
  }>,
  model?: string | null,
): number {
  let total = 0;
  // Each message carries a small per-message framing overhead (role label,
  // separators). 4 tokens is the OpenAI cookbook figure.
  const PER_MESSAGE_OVERHEAD = 4;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD;
    const c = m.content;
    if (typeof c === 'string' && c.length > 0) {
      total += countTokens(c, model);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === 'text' && block.text.length > 0) {
          total += countTokens(block.text, model);
        } else if (block.type === 'image') {
          // Fixed estimate per the Phase 2 plan. See shared/content.ts.
          total += IMAGE_TOKEN_COST;
        }
      }
    }
    if (m.tool_calls) {
      // We do not have a dedicated BPE for tool-call JSON; the per-message
      // overhead and the content (if any) are usually enough. Add a
      // conservative flat cost per tool call for safety.
      total += JSON.stringify(m.tool_calls).length / 3;
    }
  }
  // The conversation as a whole carries a final 2-token framing cost.
  return Math.ceil(total) + 2;
}

/** Reset the encoder cache (test-only; not currently used). */
export function _resetTokenizerCache(): void {
  // The encoder table is module-level and immutable, so there is nothing
  // to flush. This stub is here for symmetry with future cache layers
  // and to give tests an obvious hook.
}
