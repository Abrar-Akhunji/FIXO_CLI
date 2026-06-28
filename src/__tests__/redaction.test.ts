import assert from "node:assert/strict";
import test from "node:test";
import {
  scrubForLlm,
  redactSecrets,
  redactedEnv,
  stripAnsi,
  redactAnsi,
  SCRUB_PATTERNS,
} from "../runtime/redaction.js";

/* ------------------------------------------------------------------ */
/* scrubForLlm — provider-specific credentials                          */
/* ------------------------------------------------------------------ */

test("scrubForLlm — redacts Anthropic keys", () => {
  const text =
    "Authorization: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCD";
  const out = scrubForLlm(text);
  assert.equal(out.includes("sk-ant-api03-"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("scrubForLlm — redacts OpenRouter keys", () => {
  const text = "OPENROUTER_KEY=sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz";
  const out = scrubForLlm(text);
  assert.equal(out.includes("sk-or-v1-"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("scrubForLlm — redacts AWS access key IDs and secret keys", () => {
  const text =
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const out = scrubForLlm(text);
  assert.equal(out.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(out.includes("wJalrXUtnFEMI"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("scrubForLlm — redacts Google AI Studio keys", () => {
  const text = "GEMINI_API_KEY=AIzaSyD-1234567890abcdefghijklmnopqrstuvwx";
  const out = scrubForLlm(text);
  assert.equal(out.includes("AIzaSyD-"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("scrubForLlm — redacts JWTs", () => {
  const text =
    "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const out = scrubForLlm(text);
  assert.equal(out.includes("eyJhbGciOiJ"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("scrubForLlm — redacts openai project keys", () => {
  const text = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
  const out = scrubForLlm(text);
  assert.equal(out.includes("sk-proj-"), false);
});

test("scrubForLlm — strips ANSI before scanning", () => {
  // Colourised token to defeat naive string match.
  const text =
    "\x1b[31msk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCD\x1b[0m";
  const out = scrubForLlm(text);
  assert.equal(out.includes("sk-ant-api03-"), false);
});

test("scrubForLlm — leaves ordinary prose untouched", () => {
  const text =
    "The quick brown fox jumps over the lazy dog. 1234567890 is just a number.";
  assert.equal(scrubForLlm(text), text);
});

/* ------------------------------------------------------------------ */
/* backward compat                                                     */
/* ------------------------------------------------------------------ */

test("redactSecrets — alias still works and inherits the new patterns", () => {
  const text = "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz";
  const out = redactSecrets(text);
  assert.equal(out.includes("sk-or-v1-"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});

test("SCRUB_PATTERNS — exported and iterable", () => {
  assert.ok(Array.isArray(SCRUB_PATTERNS));
  assert.ok(SCRUB_PATTERNS.length > 5);
  for (const p of SCRUB_PATTERNS) {
    assert.ok(p instanceof RegExp);
    assert.equal(p.global, true);
  }
});

/* ------------------------------------------------------------------ */
/* redactedEnv                                                         */
/* ------------------------------------------------------------------ */

test("redactedEnv — strips all secret-bearing env vars", () => {
  const src: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-XYZ",
    OPENAI_API_KEY: "sk-XYZ",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI",
    FIXO_PROXY_TOKEN: "tk-XYZ",
    GH_TOKEN: "ghp_XYZ",
    FOO: "bar",
  };
  const out = redactedEnv(src);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/home/user");
  assert.equal(out.FOO, "bar");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.OPENAI_API_KEY, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.FIXO_PROXY_TOKEN, undefined);
  assert.equal(out.GH_TOKEN, undefined);
});

/* ------------------------------------------------------------------ */
/* stripAnsi / redactAnsi                                              */
/* ------------------------------------------------------------------ */

test("stripAnsi removes colour escapes entirely", () => {
  const input = "\x1b[31mred\x1b[0m text";
  assert.equal(stripAnsi(input), "red text");
});

test("redactAnsi preserves content but escapes the control bytes", () => {
  const input = "\x1b[31mred\x1b[0m text";
  const out = redactAnsi(input);
  assert.equal(out, "\\x1b[31mred\\x1b[0m text");
  // No raw ESC bytes survive the redact.
  assert.equal(out.includes("\x1b"), false);
});

test("scrubForLlm strips colour before scrubbing secrets", () => {
  // Colourised Bearer token must not dodge redaction.
  const input =
    "\x1b[32mAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\x1b[0m";
  const out = scrubForLlm(input);
  assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(out.includes("[REDACTED]"), true);
});
