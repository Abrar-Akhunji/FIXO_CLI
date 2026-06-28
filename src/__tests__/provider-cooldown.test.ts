import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCooldownManager,
  ProviderInCooldownError,
  classifyStatus,
} from "../agent/provider-cooldown.js";

test("classifyStatus maps codes to the correct backoff family", () => {
  assert.equal(classifyStatus(429), "rate_limit");
  assert.equal(classifyStatus(500), "server_error");
  assert.equal(classifyStatus(502), "server_error");
  assert.equal(classifyStatus(503), "server_error");
  assert.equal(classifyStatus(504), "server_error");
  assert.equal(classifyStatus(408), "server_error");
  assert.equal(classifyStatus(0), "other_retryable");
  assert.equal(classifyStatus(400), "none");
  assert.equal(classifyStatus(401), "none");
  assert.equal(classifyStatus(404), "none");
});

test("recordSuccess resets consecutive failure count and cooldown", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  m.recordFailure("groq", 429, "rate limited", t0);
  assert.equal(m.isAvailable("groq", t0 + 100), false);
  m.recordSuccess("groq", t0 + 200);
  assert.equal(m.isAvailable("groq", t0 + 300), true);
  const entry = m.getEntry("groq");
  assert.ok(entry);
  assert.equal(entry?.consecutiveFailures, 0);
  assert.equal(entry?.cooldownUntil, 0);
  assert.equal(entry?.totalRequests, 2);
  assert.equal(entry?.totalFailures, 1);
});

test("429 backoff grows exponentially and caps at 5 minutes", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  const first = m.recordFailure("groq", 429, "", t0);
  assert.equal(first, 30_000);
  const second = m.recordFailure("groq", 429, "", t0);
  assert.equal(second, 60_000);
  const third = m.recordFailure("groq", 429, "", t0);
  assert.equal(third, 120_000);
  const fourth = m.recordFailure("groq", 429, "", t0);
  assert.equal(fourth, 240_000);
  const fifth = m.recordFailure("groq", 429, "", t0);
  assert.equal(fifth, 300_000);
  // After the cap, additional failures do not grow further.
  const sixth = m.recordFailure("groq", 429, "", t0);
  assert.equal(sixth, 300_000);
});

test("5xx backoff caps at 2 minutes", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 10_000);
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 20_000);
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 40_000);
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 80_000);
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 120_000);
  // Cap.
  assert.equal(m.recordFailure("cerebras", 500, "", t0), 120_000);
});

test("non-retryable 4xx records stats but does not set a cooldown", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  const cooldown = m.recordFailure("openai", 400, "bad request", t0);
  assert.equal(cooldown, 0);
  assert.equal(m.isAvailable("openai", t0 + 1), true);
  const entry = m.getEntry("openai");
  assert.equal(entry?.consecutiveFailures, 0);
  assert.equal(entry?.totalFailures, 1);
});

test("isAvailable and getCooldownMs respect the wall clock", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  m.recordFailure("groq", 429, "", t0);
  assert.equal(m.getCooldownMs("groq", t0), 30_000);
  assert.equal(m.getCooldownMs("groq", t0 + 29_999), 1);
  assert.equal(m.getCooldownMs("groq", t0 + 30_000), 0);
  assert.equal(m.isAvailable("groq", t0 + 30_000), true);
  assert.equal(m.isAvailable("groq", t0 - 1), false);
});

test("assertAvailable throws ProviderInCooldownError with structured fields", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  m.recordFailure("gemini", 429, "", t0);
  assert.throws(
    () => m.assertAvailable("gemini", t0 + 100),
    (err: unknown) => {
      assert.ok(err instanceof ProviderInCooldownError);
      const e = err as ProviderInCooldownError;
      assert.equal(e.providerId, "gemini");
      assert.equal(e.cooldownMs, 29_900);
      assert.equal(e.until, t0 + 30_000);
      return true;
    },
  );
  // A provider that has never been used must not throw.
  assert.doesNotThrow(() => m.assertAvailable("unknown", t0));
});

test("suggestNext picks the least-bad fallback when first candidate is worse", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  // Record two failures for 'a' so its cooldown grows (20s for 5xx second
  // failure), while 'c' is a single 500 failure (10s). 'c' is less-bad.
  m.recordFailure("a", 500, "", t0);
  m.recordFailure("a", 500, "", t0);
  m.recordFailure("c", 500, "", t0);
  m.recordFailure("b", 429, "", t0);

  const candidates = [
    { id: "a", label: "alpha" },
    { id: "b", label: "beta" },
    { id: "c", label: "gamma" },
  ];

  const result = m.suggestNext(candidates, t0 + 50);
  assert.ok(result);
  assert.equal(result?.id, "c");
  assert.equal(result?.available, false);
  // 50ms have elapsed since the 10s cooldown was set, so the remaining
  // is just under 10s — assert the bound, not the exact value.
  assert.ok(result && result.cooldownMs > 0 && result.cooldownMs <= 10_000);
});

test("suggestNext picks the first available candidate, else the least-bad", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  m.recordFailure("b", 429, "", t0); // 30s cooldown
  m.recordFailure("c", 500, "", t0); // 10s cooldown

  const candidates = [
    { id: "a", label: "alpha" },
    { id: "b", label: "beta" },
    { id: "c", label: "gamma" },
  ];

  const next = m.suggestNext(candidates, t0 + 100);
  assert.ok(next);
  assert.equal(next?.id, "a");
  assert.equal(next?.available, true);
  assert.equal((next?.payload as { label: string }).label, "alpha");

  // If `a` is in cooldown too with the SAME remaining as `c`,
  // iteration order wins (a comes first).
  m.recordFailure("a", 500, "", t0); // 10s cooldown, same as c
  const fallback = m.suggestNext(candidates, t0 + 50);
  assert.ok(fallback);
  assert.equal(fallback?.id, "a");
  assert.equal(fallback?.available, false);
  assert.ok(
    fallback && fallback.cooldownMs > 0 && fallback.cooldownMs <= 10_000,
  );
});

test("suggestNext returns null only for an empty candidate list", () => {
  const m = new ProviderCooldownManager();
  assert.equal(m.suggestNext([]), null);
});

test("success rate rolls over a fixed-size window", () => {
  const m = new ProviderCooldownManager(4);
  m.recordSuccess("p");
  m.recordSuccess("p");
  m.recordFailure("p", 429);
  m.recordSuccess("p");
  let entry = m.getEntry("p");
  assert.equal(entry?.successRate, 0.75);

  // Push one more failure — the oldest success (rate=0.75) drops out.
  m.recordFailure("p", 429);
  entry = m.getEntry("p");
  // 2 successes, 2 failures → 0.5
  assert.equal(entry?.successRate, 0.5);
});

test("reset clears state for one provider or all", () => {
  const m = new ProviderCooldownManager();
  m.recordFailure("a", 429);
  m.recordFailure("b", 500);
  assert.equal(m.getAll().length, 2);
  m.reset("a");
  assert.equal(m.getEntry("a"), undefined);
  assert.ok(m.getEntry("b"));
  m.reset();
  assert.equal(m.getAll().length, 0);
});

test("getAll returns entries sorted by request volume", () => {
  const m = new ProviderCooldownManager();
  m.recordFailure("low", 429);
  m.recordFailure("high", 429);
  m.recordFailure("high", 429);
  m.recordSuccess("high");
  const all = m.getAll();
  assert.equal(all[0]?.providerId, "high");
  assert.equal(all[1]?.providerId, "low");
});

test("totalRequests increments for both success and failure", () => {
  const m = new ProviderCooldownManager();
  m.recordSuccess("p");
  m.recordSuccess("p");
  m.recordFailure("p", 500);
  const entry = m.getEntry("p");
  assert.equal(entry?.totalRequests, 3);
  assert.equal(entry?.totalFailures, 1);
  assert.equal(entry?.totalRateLimited, 0);
});

test("totalRateLimited only counts 429s", () => {
  const m = new ProviderCooldownManager();
  m.recordFailure("p", 429);
  m.recordFailure("p", 500);
  m.recordFailure("p", 502);
  m.recordFailure("p", 429);
  const entry = m.getEntry("p");
  assert.equal(entry?.totalRateLimited, 2);
});

test("cooldownUntil timestamp equals now + cooldownMs", () => {
  const m = new ProviderCooldownManager();
  const t0 = 1_000_000;
  const cooldownMs = m.recordFailure("p", 429, "", t0);
  const entry = m.getEntry("p");
  assert.equal(entry?.cooldownUntil, t0 + cooldownMs);
});
