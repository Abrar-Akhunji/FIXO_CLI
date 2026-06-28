/**
 * Telemetry — local NDJSON sink + on-demand failure diagnosis.
 *
 * The original `logTelemetry` shipped a remote-only HTTP poster to
 * the FreeLLMAPI server. Pillar 5 (Telemetry) replaces it with a
 * first-class, *local-first* event store:
 *
 *   - All events are appended to `~/.fixocli/telemetry.jsonl` in
 *     newline-delimited JSON. One event per line, easy to tail,
 *     grep, and post-process.
 *   - The legacy remote poster is preserved as an opt-in
 *     secondary sink (controlled by `preferences.telemetryRemote`).
 *   - The on-disk log is rotated at 1 MiB with a single `.1`
 *     backup, so disk usage is bounded.
 *   - `diagnoseFailures(windowMs)` reads the last N events and
 *     produces human-readable remediation hints — useful for
 *     `/diagnose` slash commands and for the post-mortem shown
 *     when a tool call exhausts its budget.
 *
 * The module is *side-effect free at import time*; the file is
 * opened lazily on first write so the CLI cold-start is unaffected.
 *
 * The previous public surface — `logTelemetry(payload)` and the
 * `TelemetryPayload` interface — is preserved so the 7 existing
 * callsites in `worker-agent.ts` and `agent-pool.ts` keep working
 * without modification. New code should prefer `TelemetrySink`
 * directly.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, getConfigDir } from "../config.js";
import { formatDuration } from "./duration.js";

// ---------------------------------------------------------------------------
// Public event types
// ---------------------------------------------------------------------------

/** Discriminated union of every event the system can emit. */
export type TelemetryEventType =
  | "tool_call"
  | "session_start"
  | "session_end"
  | "retry"
  | "cooldown"
  | "stream_resume"
  | "stream_resume_exhausted"
  | "context_budget"
  | "provider_error"
  | "tool_surgical_edit"
  | "tool_glob"
  | "tool_async_spawn"
  | "subagent_summary"
  | "fixo_md_loaded"
  | "todo_mutation"
  | "session_snapshot"
  | "hook_fired"
  | "permission_decision"
  | "pool_subtask_budget_exhausted"
  | "pool_subtask_partial_committed"
  | "loop_guard_lockout_blocked"
  | "sandbox_heuristic_false_positive"
  | "dag_write_set_conflict_avoided";

export interface TelemetryEvent {
  /** ISO timestamp the event was recorded. */
  readonly ts: string;
  /** Discriminator — see {@link TelemetryEventType}. */
  readonly type: TelemetryEventType;
  /** Stable, anonymised machine id (not the user's hostname). */
  readonly sid: string;
  /** Free-form fields. The shape depends on `type`; see the
   *  per-type helpers below for ergonomic constructors. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Legacy payload shape preserved for `logTelemetry` compatibility. */
export interface TelemetryPayload {
  id: string;
  tool: string;
  arguments: unknown;
  status: "started" | "completed" | "failed";
  error?: string;
  originalContent?: string;
  newContent?: string;
}

// ---------------------------------------------------------------------------
// Per-type event constructors
// ---------------------------------------------------------------------------

function makeEvent(
  type: TelemetryEventType,
  fields: Record<string, unknown>,
): TelemetryEvent {
  return {
    ts: new Date().toISOString(),
    type,
    sid: getSessionId(),
    fields: Object.freeze({ ...fields }),
  };
}

export const telemetry = {
  toolCall(fields: {
    tool: string;
    status: "started" | "completed" | "failed";
    error?: string;
    durationMs?: number;
  }): TelemetryEvent {
    return makeEvent("tool_call", fields);
  },
  retry(fields: {
    fn: string;
    attempt: number;
    delayMs: number;
    error: string;
  }): TelemetryEvent {
    return makeEvent("retry", fields);
  },
  cooldown(fields: {
    providerId: string;
    status: number | string;
    cooldownMs: number;
    reason: string;
  }): TelemetryEvent {
    return makeEvent("cooldown", fields);
  },
  streamResume(fields: {
    resumeAttempt: number;
    partialTokens: number;
    ok: boolean;
    reason?: string;
  }): TelemetryEvent {
    return makeEvent(
      fields.ok ? "stream_resume" : "stream_resume_exhausted",
      fields,
    );
  },
  contextBudget(fields: {
    tokensBefore: number;
    tokensAfter: number;
    actions: string[];
    markedForCompaction: boolean;
  }): TelemetryEvent {
    return makeEvent("context_budget", fields);
  },
  providerError(fields: {
    providerId: string;
    status: number;
    message: string;
  }): TelemetryEvent {
    return makeEvent("provider_error", fields);
  },
  sessionStart(fields: { model: string; cwd: string }): TelemetryEvent {
    return makeEvent("session_start", fields);
  },
  sessionEnd(fields: {
    durationMs: number;
    toolCalls: number;
    totalTokens: number;
  }): TelemetryEvent {
    return makeEvent("session_end", fields);
  },
  surgicalEdit(fields: {
    path: string;
    occurrences: number;
    mode: string;
    bytes: number;
  }): TelemetryEvent {
    return makeEvent("tool_surgical_edit", fields);
  },
  glob(fields: {
    pattern: string;
    returned: number;
    truncated: boolean;
  }): TelemetryEvent {
    return makeEvent("tool_glob", fields);
  },
  fixoMdLoaded(fields: { source: string; bytes: number }): TelemetryEvent {
    return makeEvent("fixo_md_loaded", fields);
  },
  todoMutation(fields: {
    op: string;
    items: number;
    id?: string;
  }): TelemetryEvent {
    return makeEvent("todo_mutation", fields);
  },
  sessionSnapshot(fields: {
    id: string;
    op: "save" | "load";
    tokens: number;
    items: number;
  }): TelemetryEvent {
    return makeEvent("session_snapshot", fields);
  },
  asyncSpawn(fields: {
    jobId: string;
    cmd: string;
    pid?: number;
  }): TelemetryEvent {
    return makeEvent("tool_async_spawn", fields);
  },
  subagentSummary(fields: {
    taskType: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }): TelemetryEvent {
    return makeEvent("subagent_summary", fields);
  },
  hookFired(fields: {
    hook: string;
    phase: "pre" | "post";
    matched: boolean;
    durationMs: number;
  }): TelemetryEvent {
    return makeEvent("hook_fired", fields);
  },
  permissionDecision(fields: {
    tool: string;
    pattern: string;
    decision: string;
  }): TelemetryEvent {
    return makeEvent("permission_decision", fields);
  },
  // ── Phase 5 remediation counters ────────────────────────────────────────
  poolSubtaskBudgetExhausted(fields: {
    subtaskId: string;
    persona: string;
    budget: number;
    toolCalls: number;
  }): TelemetryEvent {
    return makeEvent("pool_subtask_budget_exhausted", fields);
  },
  poolSubtaskPartialCommitted(fields: {
    runId: string;
    succeeded: number;
    failed: number;
    filesCommitted: number;
  }): TelemetryEvent {
    return makeEvent("pool_subtask_partial_committed", fields);
  },
  loopGuardLockoutBlocked(fields: {
    target: string;
    warns: number;
    tool: string;
    slidingWindow: boolean;
  }): TelemetryEvent {
    return makeEvent("loop_guard_lockout_blocked", fields);
  },
  sandboxHeuristicFalsePositive(fields: {
    binary: string;
    rejectedArg: string;
    commandLine: string;
  }): TelemetryEvent {
    return makeEvent("sandbox_heuristic_false_positive", fields);
  },
  dagWriteSetConflictAvoided(fields: {
    runId: string;
    file: string;
    serializedSubtasks: string[];
  }): TelemetryEvent {
    return makeEvent("dag_write_set_conflict_avoided", fields);
  },
};

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

let _sessionId: string | null = null;
function getSessionId(): string {
  if (_sessionId) return _sessionId;
  // 12 chars of randomness, hex-encoded bytes. Stable for the lifetime of
  // the process but not personally identifying.
  _sessionId = randomBytes(6).toString("hex").slice(0, 12);
  return _sessionId;
}

// ---------------------------------------------------------------------------
// Filesystem paths
// ---------------------------------------------------------------------------

/** Path to the local NDJSON sink. Exposed for tests and the
 *  `/diagnose` slash command. */
export function getTelemetryPath(): string {
  return path.join(getConfigDir(), "telemetry.jsonl");
}

const MAX_BYTES = 1_048_576; // 1 MiB

function ensureDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function rotateIfNeeded(): void {
  const file = getTelemetryPath();
  if (!fs.existsSync(file)) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size < MAX_BYTES) return;
  const backup = file + ".1";
  try {
    fs.renameSync(file, backup);
  } catch {
    // Best-effort rotation; if rename fails, the next append will
    // just keep extending the file past MAX_BYTES.
  }
}

// ---------------------------------------------------------------------------
// Public sink API
// ---------------------------------------------------------------------------

/**
 * Append an event to the local NDJSON sink. The file is opened in
 * append mode for every write — the cost of an open/close cycle
 * is negligible compared to the JSON.stringify call.
 *
 * Returns true on success, false on any error. Errors are swallowed
 * because telemetry must never break the calling code.
 */
export function recordTelemetry(event: TelemetryEvent): boolean {
  if (!isLocalEnabled()) return false;
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(getTelemetryPath(), JSON.stringify(event) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/** Read the last N events (most recent last). Safe to call when the
 *  file is missing or empty — returns []. */
export function readRecentEvents(limit: number = 200): TelemetryEvent[] {
  const file = getTelemetryPath();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const slice = lines.slice(Math.max(0, lines.length - limit));
    const out: TelemetryEvent[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as TelemetryEvent);
      } catch {
        // Skip malformed lines (rotated half-write etc.).
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Clear the local sink. Test-only; not exposed in the UI. */
export function clearTelemetry(): void {
  try {
    const file = getTelemetryPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// diagnoseFailures — read the recent window and emit hints
// ---------------------------------------------------------------------------

export interface DiagnosisHint {
  /** Short, human-readable summary. */
  readonly summary: string;
  /** Severity: info | warn | error. */
  readonly severity: "info" | "warn" | "error";
  /** Number of matching events in the window. */
  readonly count: number;
  /** Suggested action for the user. */
  readonly suggestion: string;
}

/**
 * Scan the recent event window and return a prioritised list of
 * remediation hints. Pure function — does not modify state.
 *
 * Rules implemented:
 *   - 3+ retries in the window       → "Flaky network or rate-limit" (warn)
 *   - 1+ cooldown event              → "Provider X is rate-limited" (warn)
 *   - 1+ stream_resume_exhausted     → "Stream cuts not recovering" (error)
 *   - 1+ context_budget with compact → "Context is filling up" (info)
 *   - 3+ tool_call failures of same tool → "Tool X keeps failing" (warn)
 *   - 5+ provider_error in window    → "Provider outage" (error)
 */
export function diagnoseFailures(
  windowMs: number = 60 * 60_000,
): DiagnosisHint[] {
  const events = readRecentEvents(2_000);
  if (events.length === 0) return [];

  const cutoff = Date.now() - windowMs;
  const recent = events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (recent.length === 0) return [];

  const hints: DiagnosisHint[] = [];

  // Retry storm
  const retries = recent.filter((e) => e.type === "retry");
  if (retries.length >= 3) {
    hints.push({
      summary: `${retries.length} retries in the last ${Math.round(windowMs / 60_000)} min`,
      severity: "warn",
      count: retries.length,
      suggestion:
        "This often indicates a flaky network, a rate-limited provider, or a proxy timeout. " +
        "If the trend persists, switch providers with /model.",
    });
  }

  // Provider cooldowns
  const cooldowns = recent.filter((e) => e.type === "cooldown");
  if (cooldowns.length > 0) {
    const providers = new Set(
      cooldowns.map((e) => String(e.fields.providerId ?? "?")),
    );
    const maxCooldownMs = cooldowns.reduce(
      (acc, e) => Math.max(acc, Number(e.fields.cooldownMs ?? 0)),
      0,
    );
    const durationTag =
      maxCooldownMs > 0 ? ` (up to ${formatDuration(maxCooldownMs)})` : "";
    hints.push({
      summary: `Provider cooldown: ${[...providers].join(", ")}${durationTag}`,
      severity: "warn",
      count: cooldowns.length,
      suggestion:
        "One or more providers are rate-limiting requests. The cooldown manager will " +
        "prefer other providers automatically. Add more API keys at the FreeLLMAPI dashboard.",
    });
  }

  // Stream resume exhausted
  const exhausted = recent.filter((e) => e.type === "stream_resume_exhausted");
  if (exhausted.length > 0) {
    hints.push({
      summary: `${exhausted.length} stream(s) failed to recover after ${exhausted.length} resume attempts`,
      severity: "error",
      count: exhausted.length,
      suggestion:
        "Mid-stream cuts are exceeding the resume budget. Check your network stability, " +
        "or raise `preferences.resilience.maxResumeAttempts` in the config.",
    });
  }

  // Context budget compaction
  const compactions = recent.filter((e) => {
    if (e.type !== "context_budget") return false;
    return e.fields.markedForCompaction === true;
  });
  if (compactions.length > 0) {
    hints.push({
      summary: `Context window filling up (${compactions.length} compaction(s) requested)`,
      severity: "info",
      count: compactions.length,
      suggestion:
        "The agent is summarising old turns to stay within the model window. This is normal " +
        "for long sessions; consider /clear between unrelated tasks.",
    });
  }

  // Tool-call failure clustering
  const toolFailures = new Map<string, number>();
  for (const e of recent) {
    if (e.type !== "tool_call") continue;
    if (e.fields.status !== "failed") continue;
    const tool = String(e.fields.tool ?? "?");
    toolFailures.set(tool, (toolFailures.get(tool) ?? 0) + 1);
  }
  for (const [tool, count] of toolFailures) {
    if (count >= 3) {
      hints.push({
        summary: `Tool "${tool}" failed ${count} times in the window`,
        severity: "warn",
        count,
        suggestion:
          `The ${tool} tool keeps failing. Check its inputs (paths, arguments) and ` +
          "consider whether the workspace permissions allow the operation.",
      });
    }
  }

  // Provider outage
  const providerErrors = recent.filter((e) => e.type === "provider_error");
  if (providerErrors.length >= 5) {
    hints.push({
      summary: `${providerErrors.length} provider errors in the window`,
      severity: "error",
      count: providerErrors.length,
      suggestion:
        "A provider is likely experiencing an outage. The agent will try to fall back to " +
        "other providers, but the session may be slow until the issue clears.",
    });
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLocalEnabled(): boolean {
  try {
    const config = loadConfig();
    if (config.preferences?.telemetry === false) return false;
    // Default ON when telemetry is on. The `telemetryLocal` flag
    // gives the user a per-sink opt-out.
    if (config.preferences?.telemetryLocal === false) return false;
    return true;
  } catch {
    return false;
  }
}

function isRemoteEnabled(): boolean {
  try {
    const config = loadConfig();
    if (config.preferences?.telemetry === false) return false;
    if (config.preferences?.telemetryRemote === true) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Legacy public surface — preserved for the 7 existing callsites
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer the typed helpers on the `telemetry` object and
 * `recordTelemetry()` directly. This wrapper maps a `TelemetryPayload`
 * to a `tool_call` event.
 */
export async function logTelemetry(payload: TelemetryPayload): Promise<void> {
  // Respect user opt-out
  if (!isLocalEnabled() && !isRemoteEnabled()) return;

  // Prevent async activity errors in tests
  if (
    process.env.NODE_ENV === "test" ||
    process.argv.some(
      (arg) =>
        arg.includes("jest") || arg.includes("vitest") || arg.includes("mocha"),
    )
  ) {
    return;
  }

  const event = telemetry.toolCall({
    tool: payload.tool,
    status: payload.status,
    error: payload.error,
  });
  recordTelemetry(event);

  if (!isRemoteEnabled()) return;

  try {
    const config = loadConfig();
    const baseUrl = config.apiUrl || "https://api.free-llm.com/v1";
    let logUrl = "https://api.free-llm.com/api/mcp/log";
    try {
      const url = new URL(baseUrl);
      if (
        url.protocol === "http:" &&
        url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1"
      ) {
        url.protocol = "https:"; // force HTTPS for telemetry
      }
      logUrl = `${url.protocol}//${url.host}/api/mcp/log`;
    } catch (err) {
      if (
        process.env.DEBUG ||
        process.env.VERBOSE ||
        process.argv.includes("--verbose")
      ) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Debug Warning] Telemetry failed to parse baseUrl ${baseUrl}: ${msg}`,
        );
      }
    }

    await fetch(logUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (
      process.env.DEBUG ||
      process.env.VERBOSE ||
      process.argv.includes("--verbose")
    ) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Debug Warning] Telemetry submission failed: ${msg}`);
    }
  }
}
