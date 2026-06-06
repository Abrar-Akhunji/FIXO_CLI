/**
 * Redaction & credential-scrubbing utilities.
 *
 * Pillar 4 of the Phase 2 safety refactor expanded the pattern
 * catalogue to cover every major LLM provider's credential
 * shape. The new public API is {@link scrubForLlm} — used by
 * the {@link ProviderKeyVault} and by every tool that pipes
 * external output (command results, HTTP responses, file
 * contents) back into a model prompt.
 *
 * The legacy {@link redactSecrets} and {@link redactedEnv}
 * functions are preserved as thin wrappers that delegate to the
 * new implementation, so existing callers keep working and
 * automatically inherit the expanded pattern set.
 */

const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Replace every ANSI escape sequence with its printable form so
 * the bytes survive a log write / telemetry upload without
 * accidentally injecting terminal control codes downstream.
 *
 * Use this in places where the *content* matters (file paths,
 * error messages) and the colour information is incidental. The
 * default `stripAnsi` is the right choice when the consumer is
 * another tool that doesn't care about colour.
 */
export function redactAnsi(value: string): string {
  return value.replace(/\x1b/g, '\\x1b');
}

/* ──────────────────────── Pattern catalogue ──────────────────────── */

/**
 * Comprehensive secret-detection pattern catalogue, covering
 * OpenAI, Anthropic, OpenRouter, GitHub, Google, AWS, JWT-style
 * tokens, and generic env-style assignments.
 *
 * Each pattern is `RegExp` with the `g` flag. They are
 * deliberately conservative — they err on the side of false
 * positives (a Base64-looking blob gets redacted) over false
 * negatives (a real key leaks through). The downstream cost of
 * a false positive is a string of `[REDACTED]` in a tool
 * result; the downstream cost of a false negative is a leaked
 * credential.
 */
export const SCRUB_PATTERNS: ReadonlyArray<RegExp> = [
  // ── OpenAI ──────────────────────────────────────────────────
  // sk-... (legacy), sk-proj-... (project keys), sk-svcacct-... (service accounts)
  /sk-[A-Za-z0-9._-]{16,}/g,
  /sk-proj-[A-Za-z0-9._-]{16,}/g,
  /sk-svcacct-[A-Za-z0-9._-]{16,}/g,

  // ── Anthropic ───────────────────────────────────────────────
  // sk-ant-api03-... and legacy sk-ant-...
  /sk-ant-api03-[A-Za-z0-9._-]{16,}/g,
  /sk-ant-[A-Za-z0-9._-]{16,}/g,

  // ── OpenRouter ──────────────────────────────────────────────
  // sk-or-v1-... and sk-or-...
  /sk-or-v1-[A-Za-z0-9._-]{16,}/g,
  /sk-or-[A-Za-z0-9._-]{16,}/g,

  // ── Google (AI Studio, GCP service accounts) ────────────────
  // AIzaSy... (Gemini/AI Studio)
  /AIza[A-Za-z0-9_-]{35}/g,
  // GCP service account private_key
  /"private_key"\s*:\s*"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,

  // ── AWS ─────────────────────────────────────────────────────
  // Access key ID: 20 chars, all-caps alphanumeric
  /AKIA[0-9A-Z]{16}/g,
  // ASIA prefix (temporary STS credentials)
  /ASIA[0-9A-Z]{16}/g,
  // Secret access key in env/ini/json form
  /(?:aws_secret_access_key|aws_session_token|secret_access_key)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,

  // ── GitHub ──────────────────────────────────────────────────
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghr_[A-Za-z0-9]{20,}/g,

  // ── Slack ───────────────────────────────────────────────────
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,

  // ── Stripe ──────────────────────────────────────────────────
  /sk_live_[A-Za-z0-9]{20,}/g,
  /rk_live_[A-Za-z0-9]{20,}/g,

  // ── Generic JWT (header.payload.signature) ─────────────────
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,

  // ── Bearer token in Authorization header ────────────────────
  /(?:Bearer|Token)\s+([A-Za-z0-9._~+/=-]{20,})/g,

  // ── freellmapi proxy keys ──────────────────────────────────
  /freellmapi-[A-Za-z0-9._-]{16,}/g,

  // ── Generic env-style assignments (covers any provider's
  //    *_KEY / *_SECRET / *_TOKEN env var serialised to text).
  //    Look-behind is supported in Node 24's V8 build, so we use
  //    a non-anchored form for max compatibility.
  /(?<=(api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*["':=]{1,3}\s*)[A-Za-z0-9._/+=-]{16,}/gi,
];

/* ──────────────────────── Public API ──────────────────────── */

/**
 * Scrub a string of every recognised secret pattern. Used by
 * the credential vault and by every tool that pipes external
 * output into a model prompt. Strips ANSI escapes first so a
 * colourised `Bearer <token>` cannot dodge the redaction.
 */
export function scrubForLlm(value: string): string {
  let scrubbed = stripAnsi(value);
  for (const pattern of SCRUB_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  }
  return scrubbed;
}

/**
 * Legacy alias for {@link scrubForLlm}. Kept for backward
 * compatibility with the 163 tests that exercise this API.
 * New code should call `scrubForLlm` directly.
 *
 * @deprecated Use {@link scrubForLlm} for clarity. This alias
 * remains in place so existing callers automatically inherit
 * the expanded pattern catalogue.
 */
export function redactSecrets(value: string): string {
  return scrubForLlm(value);
}

/**
 * Return a copy of `source` with secret-bearing environment
 * variables removed. Used by `executeRunCommand` so child
 * processes (npm install, test runners) never inherit a leaked
 * key.
 */
export function redactedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = [
    /^freellmapi_/i,
    /^fixo_/i,
    /^opencode_/i,
    /_secret$/i,
    /_key$/i,
    /_password$/i,
    /_token$/i,
    /^api_key$/i,
    /^anthropic_/i,
    /^openai_/i,
    /^google_/i,
    /^aws_/i,
    /^openrouter_/i,
    /^github_/i,
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (blocked.some(pattern => pattern.test(key))) continue;
    env[key] = value;
  }
  return env;
}
