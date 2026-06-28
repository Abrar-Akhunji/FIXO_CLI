/**
 * content.ts — helpers for the `ChatMessage.content` union.
 *
 * The historical shape was `string | null`. As of Phase 2 it widens
 * to `string | ChatContentBlock[] | null` so user messages can carry
 * inline images alongside text. The helpers in this module exist so
 * call sites that *expect* a string (e.g. legacy diff renderers,
 * loop-trap fingerprinting, tail extraction) can keep working
 * without each one re-implementing the union walk.
 *
 * Design rules:
 *   - Pure functions. No I/O. No global state.
 *   - Zero `any`. Strict discriminated-union narrowing.
 *   - The "image token cost" estimate is deliberately fixed at 1500
 *     tokens. This matches Anthropic's stated price-tag and is close
 *     enough to GPT-4o that the context-budget enforcer will never
 *     under-count for safety.
 */
import type { ChatContentBlock, ChatMessage } from "./types.js";

/**
 * Fixed per-image token estimate. Matches Anthropic's documented
 * "~1.6 KB ≈ 1500 tokens" baseline. Used by the context-budget
 * enforcer and the predictive read gate so that adding a screenshot
 * to a conversation correctly tightens the headroom calculation.
 */
export const IMAGE_TOKEN_COST = 1500;

/**
 * Flatten a `ChatMessage.content` value to a plain string. Image
 * blocks are rendered as a short placeholder so downstream string
 * consumers (telemetry, fingerprinting, tail buffers) never see a
 * 7 MiB base64 payload by accident.
 */
export function extractTextFromContent(
  content: string | ChatContentBlock[] | null | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      // Deliberately terse — the base64 payload must never leak
      // into log lines, telemetry, or loop-trap fingerprints.
      const tag =
        block.source.kind === "base64"
          ? `[image:${block.source.mediaType}]`
          : `[image:url]`;
      parts.push(tag);
    }
  }
  return parts.join("\n");
}

/** True if the content carries at least one image block. */
export function hasImageContent(
  content: string | ChatContentBlock[] | null | undefined,
): boolean {
  if (content == null || typeof content === "string") return false;
  return content.some((b) => b.type === "image");
}

/**
 * Count images embedded in a content value. Used by the token
 * estimator and by the multi-modal regression tests.
 */
export function countImageBlocks(
  content: string | ChatContentBlock[] | null | undefined,
): number {
  if (content == null || typeof content === "string") return 0;
  let n = 0;
  for (const b of content) if (b.type === "image") n++;
  return n;
}

/** Convenience: total images across a list of messages. */
export function countImagesInMessages(
  messages: ReadonlyArray<ChatMessage>,
): number {
  let n = 0;
  for (const m of messages) n += countImageBlocks(m.content);
  return n;
}
