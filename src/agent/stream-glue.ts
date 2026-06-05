/**
 * stream-glue.ts — Mid-stream resume primitives for the FixO CLI.
 *
 * When an LLM stream cuts off (network drop, server timeout, 5xx after
 * the first chunk), the new `chatStreamWithResume` path in `AgentClient`
 * needs three primitives:
 *
 *   1. `reconstructPartialResponse` — glue the chunks that *did* make
 *      it through back into a single assistant message that the LLM
 *      can be asked to "continue from".
 *   2. `isMidStreamResumable`       — decide whether a given error
 *      class is worth retrying; user-initiated aborts and 4xx errors
 *      are explicitly non-resumable.
 *   3. `StreamResumeExhaustedError` — the typed error the agent loop
 *      sees when a resume was attempted but could not be completed
 *      (mid-tool-call cut, no partial content, or attempts exhausted).
 *
 * `NonRetryableError` is a tiny marker class that lets the migrated
 * `withRetry` loops in `agent-client.ts` distinguish user/config
 * problems (413, 404) from transient provider failures.
 */

import type { StreamChunk } from './agent-client.js';
import { HttpError } from './agent-client.js';

/**
 * Marker class. Wrap a thrown error in this to signal that the
 * `withRetry` engine must NOT retry, even if `isRetryable` would
 * otherwise return true.
 */
export class NonRetryableError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NonRetryableError';
    this.cause = cause;
  }
}

/**
 * Reconstructs the assistant's text from a sequence of streamed chunks.
 *
 * The reconstruction is *deliberately conservative*: tool calls are
 * atomic, so if the cut happens after a `tool_call_start` or
 * `tool_call_delta`, reconstruction stops at (but does not include)
 * the tool call. The caller can then decide to throw a
 * `StreamResumeExhaustedError` rather than ask the LLM to continue a
 * half-built tool invocation.
 *
 * `done` and `usage` chunks are ignored.
 */
export function reconstructPartialResponse(chunks: ReadonlyArray<StreamChunk>): string {
  let out = '';
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'content':
        out += chunk.content;
        break;
      case 'thinking':
        out += chunk.thinking ?? '';
        break;
      case 'tool_call_start':
      case 'tool_call_delta':
        // Cannot resume mid-tool-call. Caller decides what to do.
        return out;
      case 'done':
        break;
    }
  }
  return out;
}

/**
 * Returns true if an error caught *after* the first chunk has been
 * yielded is a candidate for a stream-reconnect attempt. The
 * classification mirrors the `withRetry` defaults for `isRetryable`
 * but is restricted to failures that are likely recoverable on a
 * fresh attempt with a "continue from here" payload.
 *
 * Non-resumable:
 *   - User-initiated aborts (`AbortError`).
 *   - 4xx (except 408/425): the server understood us and refused;
 *     retrying with the same body would just refuse again.
 *   - 413/404: the caller's request is the problem.
 *
 * Resumable:
 *   - Network-layer errors (ECONNRESET, ETIMEDOUT, fetch failed, …).
 *   - 5xx and 408/425/502/503/504 — the server may have crashed
 *     mid-stream but the partial response is still valid input.
 *   - Timeouts that fired *during* streaming (not before any chunk).
 */
export function isMidStreamResumable(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (err instanceof NonRetryableError) return false;
  if (err instanceof HttpError) {
    if (err.status === 408 || err.status === 425) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  if (err instanceof Error) {
    const m = err.message;
    if (
      m.includes('ECONNRESET') ||
      m.includes('ETIMEDOUT') ||
      m.includes('fetch failed') ||
      m.includes('socket hang up') ||
      m.includes('aborted due to timeout') ||
      err.name === 'TimeoutError'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Public diagnostic info returned alongside a `StreamResumeExhaustedError`.
 * The agent loop can use this to decide whether to retry the whole turn
 * (likely) or to surface a user-facing error (unrecoverable cut mid
 * tool-call is the canonical unrecoverable case).
 */
export interface StreamResumeExhaustedContext {
  /** Number of resume attempts that were actually issued. */
  resumeAttempt: number;
  /** The chunks that *did* arrive in the final attempt. */
  chunks: ReadonlyArray<StreamChunk>;
  /** Reconstruction of the partial assistant text, if any. */
  partial?: string;
  /** True when the cut happened inside a tool call. */
  cutDuringToolCall?: boolean;
}

export class StreamResumeExhaustedError extends Error {
  readonly context: StreamResumeExhaustedContext;
  constructor(message: string, context: StreamResumeExhaustedContext) {
    super(message);
    this.name = 'StreamResumeExhaustedError';
    this.context = context;
  }
}
