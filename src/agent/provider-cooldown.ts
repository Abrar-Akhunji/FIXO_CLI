/**
 * provider-cooldown.ts — Per-provider rate-limit and failure tracker.
 *
 * Tracks a per-provider failure history with a backoff schedule that
 * grows exponentially on repeated 4xx/5xx errors and resets to zero on
 * the next successful response. Used by `agent-client.ts` to:
 *
 *   1. Short-circuit new requests while a provider is in cooldown.
 *   2. Surface cooldown state to higher layers so they can pick an
 *      alternative model/provider without re-trying the same doomed
 *      endpoint.
 *
 * All state is process-local and in-memory. Cooldowns are reset on
 * process restart; this is intentional — there is no value in
 * persisting transient rate-limit state across CLI invocations.
 *
 * Backoff schedule:
 *   - 429 / 402 / 403 (rate-limit family) → 30s, 60s, 120s, 240s, 300s cap
 *   - 5xx                                  → 10s, 20s, 40s,  80s,  120s cap
 *   - Other retryable status               → 15s, 30s, 60s,  120s, 180s cap
 *   - Non-retryable (4xx other)            → no cooldown, just record
 */

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;

/** Buckets that share a backoff schedule. */
type BackoffFamily = 'rate_limit' | 'server_error' | 'other_retryable' | 'none';

/** Status code → backoff family. Exported for testability. */
export function classifyStatus(status: number): BackoffFamily {
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status < 600) return 'server_error';
  if (status === 408 || status === 425 || status === 502 || status === 503 || status === 504) {
    return 'server_error';
  }
  if (status >= 400 && status < 500) {
    // Other 4xx — treated as a hard failure, no cooldown.
    return 'none';
  }
  // Network-layer errors surface with status=0; treat as retryable-but-mild.
  if (status === 0) return 'other_retryable';
  return 'none';
}

/** Per-family backoff schedule, in milliseconds. Index = consecutive failure count. */
const BACKOFF_SCHEDULES: Readonly<Record<Exclude<BackoffFamily, 'none'>, number[]>> = {
  rate_limit:       [30_000, 60_000, 120_000, 240_000, 300_000],
  server_error:     [10_000,  20_000,  40_000,  80_000, 120_000],
  other_retryable:  [15_000,  30_000,  60_000, 120_000, 180_000],
};

const MAX_COOLDOWN_MS = 5 * ONE_MINUTE_MS;

/** Public cooldown state for a single provider. */
export interface ProviderCooldownEntry {
  providerId: string;
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil: number;       // epoch ms; 0 = not in cooldown
  lastErrorStatus: number | null;
  lastErrorMessage?: string;
  totalRequests: number;
  totalFailures: number;
  totalRateLimited: number;
  /** Rolling success rate over the last `successWindowSize` requests, 0..1. */
  successRate: number;
}

/** Result of a `suggestNext` lookup. */
export interface NextCandidate<T> {
  id: string;
  available: boolean;
  cooldownMs: number;
  payload: T;
}

export class ProviderInCooldownError extends Error {
  readonly providerId: string;
  readonly cooldownMs: number;
  readonly until: number;
  constructor(providerId: string, cooldownMs: number, until: number) {
    super(
      `Provider '${providerId}' is in cooldown for ${cooldownMs}ms ` +
        `(until ${new Date(until).toISOString()})`,
    );
    this.name = 'ProviderInCooldownError';
    this.providerId = providerId;
    this.cooldownMs = cooldownMs;
    this.until = until;
  }
}

interface InternalEntry {
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil: number;
  lastErrorStatus: number | null;
  lastErrorMessage?: string;
  totalRequests: number;
  totalFailures: number;
  totalRateLimited: number;
  /** Ring buffer of 1 (success) and 0 (failure) for the success-rate window. */
  recent: number[];
  /** Per-provider quality signal. Empty until {@link ProviderCooldownManager.recordQuality} is called. */
  quality: {
    samples: number;
    avgDurationMs: number;
    avgResultCount: number;
    lastUpdatedAt: number;
  };
}

const SUCCESS_WINDOW = 100;

export class ProviderCooldownManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly windowSize: number;

  constructor(windowSize: number = SUCCESS_WINDOW) {
    this.windowSize = Math.max(1, windowSize);
  }

  /** Records a successful response from `providerId`. Resets failure state. */
  recordSuccess(providerId: string, now: number = Date.now()): void {
    const entry = this.getOrCreate(providerId);
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
    entry.lastErrorStatus = null;
    entry.lastErrorMessage = undefined;
    entry.totalRequests += 1;
    this.pushRecent(entry, 1);
    void now; // accepted for symmetry / testability
  }

  /**
   * Records a failure. `status = 0` represents a network-layer error
   * that did not produce an HTTP response. Returns the cooldown
   * duration (ms) that the entry will be unavailable for, or 0 if
   * the family is non-retryable.
   */
  recordFailure(
    providerId: string,
    status: number,
    message?: string,
    now: number = Date.now(),
  ): number {
    const entry = this.getOrCreate(providerId);
    entry.totalRequests += 1;
    entry.totalFailures += 1;
    entry.lastFailureAt = now;
    entry.lastErrorStatus = status;
    entry.lastErrorMessage = message;
    this.pushRecent(entry, 0);

    const family = classifyStatus(status);
    if (family === 'none') {
      // Hard failure: reset the consecutive counter so a future
      // retryable error starts from zero.
      entry.consecutiveFailures = 0;
      entry.cooldownUntil = 0;
      return 0;
    }

    entry.consecutiveFailures += 1;
    if (status === 429) entry.totalRateLimited += 1;
    const cooldownMs = this.computeCooldownMs(family, entry.consecutiveFailures);
    entry.cooldownUntil = now + cooldownMs;
    return cooldownMs;
  }

  /**
   * Returns true if the provider is not currently cooling down.
   * Does not throw; callers that want strict "wait or fail" behaviour
   * should use `assertAvailable` instead.
   */
  isAvailable(providerId: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(providerId);
    if (!entry) return true;
    if (entry.cooldownUntil === 0) return true;
    return entry.cooldownUntil <= now;
  }

  /** Returns the remaining cooldown in ms; 0 if available. */
  getCooldownMs(providerId: string, now: number = Date.now()): number {
    const entry = this.entries.get(providerId);
    if (!entry || entry.cooldownUntil === 0) return 0;
    const remaining = entry.cooldownUntil - now;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Throws a `ProviderInCooldownError` if the provider is currently
   * unavailable; returns silently otherwise.
   */
  assertAvailable(providerId: string, now: number = Date.now()): void {
    const ms = this.getCooldownMs(providerId, now);
    if (ms > 0) {
      const until = now + ms;
      throw new ProviderInCooldownError(providerId, ms, until);
    }
  }

  /**
   * Returns a snapshot of the public cooldown state for `providerId`,
   * or `undefined` if no requests have been recorded yet.
   */
  getEntry(providerId: string): ProviderCooldownEntry | undefined {
    const entry = this.entries.get(providerId);
    if (!entry) return undefined;
    return this.toPublic(providerId, entry);
  }

  /** Returns snapshots for every tracked provider. */
  getAll(): ProviderCooldownEntry[] {
    return Array.from(this.entries.entries())
      .map(([id, entry]) => this.toPublic(id, entry))
      .sort((a, b) => b.totalRequests - a.totalRequests);
  }

  /**
   * Picks the first available provider from `candidates`. If none is
   * available, returns the one with the smallest remaining cooldown
   * (the "least-bad" fallback so the caller can surface an informative
   * error to the user). Returns `null` only when `candidates` is empty.
   */
  suggestNext<T>(
    candidates: ReadonlyArray<{ id: string } & T>,
    now: number = Date.now(),
  ): NextCandidate<T> | null {
    if (candidates.length === 0) return null;
    let leastBad: NextCandidate<T> | null = null;
    for (const c of candidates) {
      const cooldownMs = this.getCooldownMs(c.id, now);
      if (cooldownMs === 0) {
        return { id: c.id, available: true, cooldownMs: 0, payload: c };
      }
      if (!leastBad || cooldownMs < leastBad.cooldownMs) {
        leastBad = { id: c.id, available: false, cooldownMs, payload: c };
      }
    }
    return leastBad;
  }

  /** Clears state for one provider (or all providers if omitted). */
  reset(providerId?: string): void {
    if (providerId === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(providerId);
    }
  }

  /**
   * Record a per-provider quality signal. The signal is a tuple of
   * `(durationMs, resultCount)` — the search provider chain uses
   * this to bias its next pick toward whichever provider is
   * currently responding fastest *and* returning the most results.
   *
   * The implementation is deliberately minimal: a rolling
   * per-provider EMA of `durationMs` and `resultCount`, exposed
   * via {@link getQuality}. Future work can fold this into the
   * `suggestNext` candidate ordering.
   */
  recordQuality(
    providerId: string,
    durationMs: number,
    resultCount: number,
    now: number = Date.now(),
  ): void {
    const entry = this.getOrCreate(providerId);
    const prev = entry.quality;
    const alpha = 0.4; // smoothing factor
    const dur = Math.max(0, durationMs);
    const count = Math.max(0, resultCount);
    entry.quality = {
      samples: prev.samples + 1,
      avgDurationMs: prev.samples === 0
        ? dur
        : prev.avgDurationMs * (1 - alpha) + dur * alpha,
      avgResultCount: prev.samples === 0
        ? count
        : prev.avgResultCount * (1 - alpha) + count * alpha,
      lastUpdatedAt: now,
    };
  }

  /** Read the per-provider quality snapshot, or null when no
   *  samples have been recorded. */
  getQuality(providerId: string): {
    samples: number;
    avgDurationMs: number;
    avgResultCount: number;
    lastUpdatedAt: number;
  } | null {
    const entry = this.entries.get(providerId);
    if (!entry || entry.quality.samples === 0) return null;
    return { ...entry.quality };
  }

  // ──── internals ────────────────────────────────────────────────

  private getOrCreate(providerId: string): InternalEntry {
    let entry = this.entries.get(providerId);
    if (!entry) {
      entry = {
        consecutiveFailures: 0,
        lastFailureAt: 0,
        cooldownUntil: 0,
        lastErrorStatus: null,
        lastErrorMessage: undefined,
        totalRequests: 0,
        totalFailures: 0,
        totalRateLimited: 0,
        recent: [],
        quality: { samples: 0, avgDurationMs: 0, avgResultCount: 0, lastUpdatedAt: 0 },
      };
      this.entries.set(providerId, entry);
    }
    return entry;
  }

  private computeCooldownMs(family: BackoffFamily, consecutive: number): number {
    if (family === 'none') return 0;
    const schedule = BACKOFF_SCHEDULES[family];
    const idx = Math.min(consecutive - 1, schedule.length - 1);
    if (idx < 0) return 0;
    return Math.min(schedule[idx], MAX_COOLDOWN_MS);
  }

  private pushRecent(entry: InternalEntry, value: 0 | 1): void {
    entry.recent.push(value);
    if (entry.recent.length > this.windowSize) {
      entry.recent.shift();
    }
  }

  private toPublic(providerId: string, entry: InternalEntry): ProviderCooldownEntry {
    const successes = entry.recent.reduce((acc, v) => acc + v, 0);
    const successRate = entry.recent.length === 0 ? 1 : successes / entry.recent.length;
    return {
      providerId,
      consecutiveFailures: entry.consecutiveFailures,
      lastFailureAt: entry.lastFailureAt,
      cooldownUntil: entry.cooldownUntil,
      lastErrorStatus: entry.lastErrorStatus,
      lastErrorMessage: entry.lastErrorMessage,
      totalRequests: entry.totalRequests,
      totalFailures: entry.totalFailures,
      totalRateLimited: entry.totalRateLimited,
      successRate,
    };
  }
}

/**
 * Process-wide singleton used by `AgentClient`. Importing this rather
 * than constructing a new instance ensures that all retry loops share
 * the same provider health view across the lifetime of a single CLI
 * invocation.
 */
export const providerCooldown = new ProviderCooldownManager();

/**
 * Module-level helper used by the search chain. Routes a
 * non-2xx response into the cooldown manager so the
 * future picks avoid this provider until the cooldown
 * expires.
 */
export function recordProviderError(
  providerId: string,
  status: number,
  message: string,
): void {
  providerCooldown.recordFailure(providerId, status, message);
}

/**
 * Module-level helper for the search chain. Records a
 * `(durationMs, resultCount)` sample; the manager maintains
 * a rolling EMA and exposes it via `providerCooldown.getQuality`.
 */
export function recordProviderQuality(
  providerId: string,
  durationMs: number,
  resultCount: number,
): void {
  providerCooldown.recordQuality(providerId, durationMs, resultCount);
}
