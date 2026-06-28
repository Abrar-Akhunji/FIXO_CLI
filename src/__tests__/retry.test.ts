import assert from "node:assert/strict";
import test from "node:test";
import {
  withRetry,
  parseRetryAfter,
  computeBackoffMs,
  abortableSleep,
  defaultIsRetryable,
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETRYABLE_STATUS_CODES,
} from "../agent/retry.js";
import { HttpError } from "../agent/agent-client.js";

// ─── parseRetryAfter ──────────────────────────────────────────────

test("parseRetryAfter parses delta-seconds form", () => {
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("1"), 1_000);
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("0.5"), 500);
});

test("parseRetryAfter parses HTTP-date form", () => {
  const future = Date.now() + 30_000;
  const httpDate = new Date(future).toUTCString();
  const ms = parseRetryAfter(httpDate);
  assert.ok(ms !== null);
  // Allow ±1s clock skew.
  assert.ok(Math.abs((ms ?? 0) - 30_000) < 1_000);
});

test("parseRetryAfter clamps to 24h and returns null for malformed values", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("not a number"), null);
  // 7 days is clamped to 24h.
  const sevenDays = 7 * 24 * 60 * 60;
  assert.equal(parseRetryAfter(String(sevenDays)), 24 * 60 * 60 * 1_000);
});

test("parseRetryAfter returns 0 for a past HTTP-date", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(parseRetryAfter(past), 0);
});

// ─── computeBackoffMs ─────────────────────────────────────────────

test("computeBackoffMs respects the cap", () => {
  const out = computeBackoffMs(20, 1_500, 30_000, "none");
  assert.equal(out, 30_000);
});

test("computeBackoffMs with no jitter is deterministic", () => {
  const a = computeBackoffMs(2, 1_500, 30_000, "none");
  const b = computeBackoffMs(2, 1_500, 30_000, "none");
  assert.equal(a, b);
  assert.equal(a, 6_000); // 1500 * 2^2
});

test("computeBackoffMs with full jitter stays within bounds", () => {
  for (let i = 0; i < 200; i++) {
    const ms = computeBackoffMs(2, 1_500, 30_000, "full");
    assert.ok(ms >= 0 && ms <= 6_000, `out of range: ${ms}`);
  }
});

test("computeBackoffMs with equal jitter stays within the upper half", () => {
  for (let i = 0; i < 200; i++) {
    const ms = computeBackoffMs(2, 1_500, 30_000, "equal");
    assert.ok(ms >= 3_000 && ms <= 6_000, `out of range: ${ms}`);
  }
});

test("computeBackoffMs lets a Retry-After value win when supplied", () => {
  const ms = computeBackoffMs(0, 1_500, 30_000, "none", 5_000);
  assert.equal(ms, 5_000);
});

// ─── defaultIsRetryable ───────────────────────────────────────────

test("defaultIsRetryable recognises the standard retryable statuses", () => {
  for (const status of DEFAULT_RETRYABLE_STATUS_CODES) {
    assert.equal(
      defaultIsRetryable(new HttpError(status, "x")),
      true,
      `status ${status}`,
    );
  }
  assert.equal(defaultIsRetryable(new HttpError(404, "x")), false);
  assert.equal(defaultIsRetryable(new HttpError(400, "x")), false);
});

test("defaultIsRetryable recognises network-layer error messages", () => {
  for (const msg of [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "fetch failed",
  ]) {
    assert.equal(defaultIsRetryable(new Error(msg)), true, `msg ${msg}`);
  }
});

test("defaultIsRetryable refuses to retry AbortError", () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  assert.equal(defaultIsRetryable(err), false);
});

test("defaultIsRetryable returns false for non-Error values", () => {
  assert.equal(defaultIsRetryable("string"), false);
  assert.equal(defaultIsRetryable(null), false);
  assert.equal(defaultIsRetryable(undefined), false);
});

// ─── abortableSleep ───────────────────────────────────────────────

test("abortableSleep resolves after the requested ms when no signal fires", async () => {
  const start = Date.now();
  await abortableSleep(50);
  assert.ok(Date.now() - start >= 45);
});

test("abortableSleep rejects with AbortError when the signal aborts", async () => {
  const controller = new AbortController();
  const p = abortableSleep(10_000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

test("abortableSleep rejects immediately if the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortableSleep(10_000, controller.signal), /Aborted/);
});

// ─── withRetry ────────────────────────────────────────────────────

test("withRetry returns the function result on first success", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries until the policy is exhausted, then throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new HttpError(500, "always 500");
      },
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitter: "none",
      },
    ),
    (err: unknown) =>
      err instanceof HttpError && (err as HttpError).status === 500,
  );
  assert.equal(calls, 3);
});

test("withRetry does not retry when isRetryable returns false", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new HttpError(400, "no retry");
      },
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitter: "none",
        isRetryable: () => false,
      },
    ),
  );
  assert.equal(calls, 1);
});

test("withRetry calls the onRetry hook with the correct fields", async () => {
  const events: Array<{
    attempt: number;
    retryAfterMs: number | null;
    delayMs: number;
  }> = [];
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new HttpError(500, "boom");
      },
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitter: "none",
        onRetry: (info) => {
          events.push({
            attempt: info.attempt,
            retryAfterMs: info.retryAfterMs,
            delayMs: info.delayMs,
          });
        },
      },
    ),
  );
  assert.equal(calls, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.attempt, 0);
  assert.equal(events[0]?.delayMs, 1);
  assert.equal(events[1]?.attempt, 1);
});

test("withRetry surfaces Retry-After from the error headers property", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        const err = new HttpError(429, "rate limited") as HttpError & {
          headers?: Record<string, string>;
        };
        err.headers = { "Retry-After": "0" };
        throw err;
      },
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 2,
        baseDelayMs: 100_000,
        maxDelayMs: 100_000,
        jitter: "none",
      },
    ),
  );
  assert.equal(calls, 2);
});

test("withRetry aborts immediately when the external signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        return "never";
      },
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitter: "none",
      },
      controller.signal,
    ),
    /Aborted/,
  );
  assert.equal(calls, 0);
});

test("withRetry swallows a misbehaving onRetry hook so the chain continues", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return "ok";
    },
    {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitter: "none",
      onRetry: () => {
        throw new Error("telemetry is on fire");
      },
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry throws on invalid maxAttempts", async () => {
  await assert.rejects(
    withRetry(async () => "x", { ...DEFAULT_RETRY_POLICY, maxAttempts: 0 }),
    /maxAttempts/,
  );
});
