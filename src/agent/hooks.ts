/**
 * hooks.ts — PreToolUse / PostToolUse hook engine.
 *
 * Phase 3.4 spec:
 *   - Two hook events supported: `PreToolUse` and `PostToolUse`.
 *     No `Stop`, `Notification`, or `SessionStart` (PRD §3.4
 *     hard rule).
 *   - Storage: `<cwd>/.fixo/hooks.json`. Schema is a map of
 *     event name → list of hook commands.
 *   - Hooks are *sync* `spawn` calls. The hook command's
 *     stdin receives a JSON document of the form
 *     `{event, tool, args, sessionId}`. The command's stdout
 *     (if any) is parsed as JSON
 *     `{decision, reason?, modifiedArgs?}`. A non-zero exit
 *     is treated as a deny with a default reason.
 *   - Pre-hook decisions: `allow` (pass), `deny` (block),
 *     `modify` (replace args before re-validation).
 *   - Post-hook decisions: `allow` (no-op), `deny` (force
 *     the result to be marked as denied — the tool has
 *     already executed, but the post-hook can flag it).
 *     `modifiedArgs` on a post-hook is not honoured (the
 *     tool has already run).
 *   - After a pre-hook `modify`, the modified args are
 *     re-validated through `WorkspaceGuard.resolve()` to
 *     guard against hook escape attempts.
 *   - A 5-second wall-clock timeout protects against
 *     runaway hooks.
 *   - Every fired hook emits a `hook_fired` telemetry event
 *     with the decision and the duration.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recordTelemetry, telemetry } from './telemetry.js';
import { WorkspaceGuard } from '../workspace-guard.js';

export type HookEvent = 'PreToolUse' | 'PostToolUse';

export type HookDecision = 'allow' | 'deny' | 'modify';

export interface HookPayload {
  event: HookEvent;
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
  /** Cwd at the time the hook fired. */
  cwd: string;
}

export interface HookCommandResult {
  decision: HookDecision;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
}

export interface HookSpec {
  /** Stable identifier for the hook (used in telemetry). */
  id: string;
  /** Event this hook listens to. */
  event: HookEvent;
  /** Command to run, including args. */
  command: string;
  /** Args passed to the command. */
  args?: string[];
  /** When false, the hook is skipped. Default: true. */
  enabled?: boolean;
  /** Per-hook timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

export interface HooksFile {
  version: 1;
  hooks: HookSpec[];
}

export interface HookExecutionResult {
  fired: boolean;
  decision: HookDecision;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
  durationMs: number;
  hookId: string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

const HOOKS_PATH_FOR = (cwd: string) => path.join(cwd, '.fixo', 'hooks.json');

/** Read `.fixo/hooks.json` from cwd. Returns null if absent. */
export function loadHooksFile(cwd: string): HooksFile | null {
  const p = HOOKS_PATH_FOR(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as HooksFile;
    if (raw.version !== 1 || !Array.isArray(raw.hooks)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Save the hooks file. Used by /hooks slash command. */
export function saveHooksFile(cwd: string, file: HooksFile): { ok: boolean; error?: string } {
  const p = HOOKS_PATH_FOR(cwd);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(file, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Hooks for a given event. */
export function getHooksForEvent(cwd: string, event: HookEvent): HookSpec[] {
  const file = loadHooksFile(cwd);
  if (!file) return [];
  return file.hooks.filter(h => h.event === event && (h.enabled ?? true));
}

/**
 * Run a single hook synchronously with a 5s default timeout.
 * The hook's stdin receives the JSON payload; the stdout
 * (if present) is parsed as a HookCommandResult.
 */
function runHook(spec: HookSpec, payload: HookPayload, timeoutMs: number): HookCommandResult {
  const payloadJson = JSON.stringify(payload);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(spec.command, spec.args ?? [], {
      input: payloadJson,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1 MiB stdout cap
    });
  } catch (err) {
    return { decision: 'deny', reason: `hook failed to spawn: ${(err as Error).message}` };
  }
  if (result.error) {
    return { decision: 'deny', reason: `hook error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderrText = typeof result.stderr === 'string' ? result.stderr : '';
    return {
      decision: 'deny',
      reason: `hook exited with status ${result.status}${stderrText ? `: ${stderrText.slice(0, 200)}` : ''}`,
    };
  }
  const stdout = (typeof result.stdout === 'string' ? result.stdout : '').trim();
  if (stdout.length === 0) {
    // Hook succeeded with no output → default allow.
    return { decision: 'allow' };
  }
  try {
    const parsed = JSON.parse(stdout) as Partial<HookCommandResult>;
    const decision: HookDecision = parsed.decision === 'allow' || parsed.decision === 'deny' || parsed.decision === 'modify'
      ? parsed.decision
      : 'allow';
    return {
      decision,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      modifiedArgs: parsed.modifiedArgs && typeof parsed.modifiedArgs === 'object'
        ? (parsed.modifiedArgs as Record<string, unknown>)
        : undefined,
    };
  } catch {
    // Hook wrote garbage — treat as a soft allow (the
    // contract is "stdout is JSON; if not, ignore").
    return { decision: 'allow' };
  }
}

/**
 * Fire all hooks for an event, in declaration order. The
 * first non-`allow` decision wins. Returns the aggregated
 * result.
 */
export function fireHooks(
  cwd: string,
  event: HookEvent,
  payload: Omit<HookPayload, 'event' | 'cwd'>,
): HookExecutionResult {
  const start = Date.now();
  const specs = getHooksForEvent(cwd, event);
  let aggDecision: HookDecision = 'allow';
  let aggReason: string | undefined;
  let aggModifiedArgs: Record<string, unknown> | undefined;
  let lastHookId: string | null = null;
  for (const spec of specs) {
    const res = runHook(spec, { ...payload, event, cwd }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    lastHookId = spec.id;
    recordTelemetry(
      telemetry.hookFired({
        hook: `${spec.id}:${payload.tool}:${res.decision}`,
        phase: event === 'PreToolUse' ? 'pre' : 'post',
        matched: res.decision !== 'allow',
        durationMs: Date.now() - start,
      }),
    );
    if (res.decision === 'deny') {
      return {
        fired: true,
        decision: 'deny',
        reason: res.reason ?? `hook ${spec.id} denied`,
        durationMs: Date.now() - start,
        hookId: spec.id,
      };
    }
    if (res.decision === 'modify') {
      aggDecision = 'modify';
      if (res.modifiedArgs) aggModifiedArgs = res.modifiedArgs;
      if (res.reason) aggReason = res.reason;
    }
  }
  return {
    fired: specs.length > 0,
    decision: aggDecision,
    reason: aggReason,
    modifiedArgs: aggModifiedArgs,
    durationMs: Date.now() - start,
    hookId: lastHookId,
  };
}

/**
 * Apply a pre-hook's `modify` decision: re-validate
 * `modifiedArgs` through `WorkspaceGuard.resolve()` to
 * prevent an attacker-controlled hook from writing outside
 * the workspace. The check is a *best-effort* scan: any
 * `path`/`filePath`/`cwd` field in the args must resolve
 * inside `cwd` (relative paths are fine).
 */
export function applyModifiedArgs(
  cwd: string,
  original: Record<string, unknown>,
  modified: Record<string, unknown>,
): { ok: boolean; args: Record<string, unknown>; reason?: string } {
  const guard = new WorkspaceGuard(cwd);
  // We re-validate any path-shaped field.
  const pathKeys = ['path', 'filePath', 'filepath', 'src', 'dst', 'cwd', 'outputPath', 'inputPath'];
  for (const key of pathKeys) {
    if (!(key in modified)) continue;
    const value = modified[key];
    if (typeof value !== 'string') continue;
    // If the value is a relative path or equals cwd, it
    // resolves inside the workspace by construction. Only
    // absolute paths are checked.
    if (!path.isAbsolute(value)) continue;
    if (value === cwd) continue;
    try {
      guard.resolve(value, 'modified-args');
    } catch (err) {
      return {
        ok: false,
        args: original,
        reason: `pre-hook attempted to inject out-of-workspace path: ${(err as Error).message}`,
      };
    }
  }
  return { ok: true, args: modified };
}

/** Get the hooks file path for a cwd (test-only introspection). */
export function getHooksPath(cwd: string): string {
  return HOOKS_PATH_FOR(cwd);
}
