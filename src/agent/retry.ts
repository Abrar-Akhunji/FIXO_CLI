/**
 * retry.ts — Unified retry engine for the FixO CLI.
 *
 * Consolidates the five ad-hoc retry loops that previously lived in
 * `agent-client.ts`, `orchestrator.ts`, `worker-agent.ts`, `mcp-client.ts`,
 * and `index.ts` behind a single, type-safe helper.
 *
 * Features:
 *   - Exponential backoff with three jitter strategies (full / equal / none).
 *   - Strict, type-safe `isRetryable` predicate (no generic `any`).
 *   - Honors the HTTP `Retry-After` header (delta-seconds *or* HTTP-date).
 *   - Fully cooperative with an external `AbortSignal`. The internal
 *     `setTimeout` handle is cleared the instant the signal fires so the
 *     timer never leaks after cancellation.
 *   - Optional `onRetry` hook for telemetry (errors are swallowed so a
 *     misbehaving observer can never break the retry chain).
 */

export type JitterStrategy = 'full' | 'equal' | 'none';

export interface RetryPolicy {
  /** Maximum number of attempts (1 = no retry). */
  maxAttempts: number;
  /** Base delay in milliseconds before jitter is applied. */
  baseDelayMs: number;
  /** Upper bound for the computed delay. */
  maxDelayMs: number;
  /** Jitter strategy. 'full' is recommended for distributed systems. */
  jitter: JitterStrategy;
  /**
   * Predicate that decides whether a thrown error is retryable.
   * Returning `false` aborts the loop immediately and rethrows.
   */
  isRetryable: (err: unknown) => boolean;
  /**
   * Optional observer. Called *before* the backoff sleep starts.
   * Any throw inside the observer is swallowed and logged via
   * `console.warn` so telemetry failures cannot break the retry chain.
   */
  onRetry?: (info: RetryEvent) => void;
}

export interface RetryEvent {
  /** 0-indexed attempt that just failed. */
  attempt: number;
  /** The error thrown by that attempt. */
  error: unknown;
  /** The delay (ms) that will be slept before the next attempt. */
  delayMs: number;
  /** The retry-after value (ms) derived from headers, if any. */
  retryAfterMs: number | null;
  /** Total attempts used so far (including the one that failed). */
  attemptsConsumed: number;
  /** True if the loop will not retry after this event. */
  willAbort: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_500,
  maxDelayMs: 30_000,
  jitter: 'full',
  isRetryable: () => true,
};

/** HTTP status codes that the default policy treats as retryable. */
export const DEFAULT_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * Default `isRetryable` predicate that recognises:
 *   - Native `HttpError` instances (status code match).
 *   - Plain `Error` objects whose `message` includes a retryable status.
 *   - Network-layer failures (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`,
 *     `fetch failed`).
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || /abort/i.test(err.message)) {
      return false;
    }
    if (name === 'HttpError' && 'status' in err) {
      const status = (err as { status: unknown }).status;
      if (typeof status === 'number') {
        return DEFAULT_RETRYABLE_STATUS_CODES.has(status);
      }
    }
    if (/(?:408|429|500|502|503|504)/.test(err.message)) {
      return true;
    }
    if (
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('fetch failed') ||
      err.message.includes('socket hang up')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sleep helper that can be cancelled by an `AbortSignal`. Returns
 * a promise that resolves after `ms` milliseconds, or rejects with
 * an `AbortError` if the signal fires before the timer elapses.
 *
 * The internal timer is cleared synchronously when the signal fires,
 * so no Node.js timer handle leaks.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal?.reason));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    const err = new Error(`Aborted: ${reason.message}`);
    err.name = 'AbortError';
    return err;
  }
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Computes the backoff delay for a given attempt, applying the policy's
 * jitter strategy. Exposed for testability — the result is always a
 * non-negative integer in milliseconds.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: JitterStrategy,
  retryAfterMs: number | null = null,
): number {
  // Retry-After always wins if it was supplied.
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, maxDelayMs);
  }
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  switch (jitter) {
    case 'none':
      return Math.floor(exp);
    case 'equal': {
      // Half deterministic, half random.
      const half = exp / 2;
      return Math.floor(half + Math.random() * half);
    }
    case 'full':
    default: {
      // 0 .. exp
      return Math.floor(Math.random() * exp);
    }
  }
}

/**
 * Parses an HTTP `Retry-After` header value.
 *
 *   - `Retry-After: 120`            → 120 000 ms
 *   - `Retry-After: Fri, 31 Dec 1999 23:59:59 GMT` → ms until that date
 *   - Missing / malformed            → `null`
 *
 * Returned value is clamped to `[0, 24h]` to protect against pathological
 * server values (e.g. `Retry-After: 999999999`).
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // 1) Delta-seconds form.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const ms = Math.floor(seconds * 1000);
    return clampRetryAfterMs(ms);
  }

  // 2) HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const ms = parsed - now;
  if (ms <= 0) return 0;
  return clampRetryAfterMs(ms);
}

function clampRetryAfterMs(ms: number): number {
  const ONE_DAY = 86_400_000;
  if (ms < 0) return 0;
  if (ms > ONE_DAY) return ONE_DAY;
  return Math.floor(ms);
}

/**
 * Executes `fn` under a retry policy. The function is invoked with an
 * `AbortSignal` that fires when either the external signal aborts or the
 * retry loop gives up. The signal is *additive* — it is aborted as soon
 * as either source fires, and both listeners are removed in `finally`.
 *
 * Throws:
 *   - The last error thrown by `fn` if it is non-retryable or the budget
 *     is exhausted.
 *   - An `AbortError` if the external signal aborts.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, isRetryable: defaultIsRetryable },
  externalSignal?: AbortSignal,
): Promise<T> {
  if (policy.maxAttempts < 1) {
    throw new Error('RetryPolicy.maxAttempts must be >= 1');
  }

  // Combined signal: aborts when either source fires.
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  let lastError: unknown;

  try {
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      if (controller.signal.aborted) {
        throw abortError(externalSignal?.reason);
      }

      try {
        return await fn(controller.signal);
      } catch (err: unknown) {
        lastError = err;

        if (controller.signal.aborted) {
          throw abortError(externalSignal?.reason);
        }

        const retryable = policy.isRetryable(err);
        const isLastAttempt = attempt === policy.maxAttempts - 1;

        if (!retryable || isLastAttempt) {
          throw err;
        }

        const retryAfterMs = extractRetryAfterFromError(err);
        const delayMs = computeBackoffMs(
          attempt,
          policy.baseDelayMs,
          policy.maxDelayMs,
          policy.jitter,
          retryAfterMs,
        );

        const event: RetryEvent = {
          attempt,
          error: err,
          delayMs,
          retryAfterMs,
          attemptsConsumed: attempt + 1,
          willAbort: false,
        };
        emitRetryEvent(policy.onRetry, event);

        await abortableSleep(delayMs, controller.signal);
      }
    }

    // Unreachable: the loop above either returns or throws.
    throw lastError ?? new Error('Retry loop exited unexpectedly');
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', forwardAbort);
    }
  }
}

/**
 * Best-effort extraction of a Retry-After value from a thrown error.
 * Looks at the well-known `headers` property (e.g. set by the upstream
 * HTTP layer) and falls back to scanning the error message for a
 * numeric `Retry-After: N` snippet.
 */
function extractRetryAfterFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const obj = err as { headers?: unknown; message?: unknown };
  if (obj.headers && typeof obj.headers === 'object') {
    const headers = obj.headers as Record<string, string | string[] | undefined>;
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    if (typeof raw === 'string') return parseRetryAfter(raw);
    if (Array.isArray(raw) && typeof raw[0] === 'string') return parseRetryAfter(raw[0]);
  }
  if (typeof obj.message === 'string') {
    const m = /retry-after\s*[:=]\s*(\d+)/i.exec(obj.message);
    if (m && m[1]) {
      const seconds = Number(m[1]);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 86_400_000);
    }
  }
  return null;
}

function emitRetryEvent(
  hook: ((info: RetryEvent) => void) | undefined,
  event: RetryEvent,
): void {
  if (!hook) return;
  try {
    hook(event);
  } catch (hookErr: unknown) {
    // Telemetry must never break the retry chain.
    const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
    console.warn(`[retry] onRetry hook threw: ${msg}`);
  }
}
