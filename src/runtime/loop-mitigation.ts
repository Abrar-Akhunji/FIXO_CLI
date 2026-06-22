/**
 * loop-mitigation.ts — Active mitigation for the semantic loop trap.
 *
 * The semantic detector in {@link loop-trap.ts} fires a `warn` verdict
 * the first time a target path is read 3 times within the window, and
 * a `hard-abort` only at a much higher count. The middle band (warn
 * fires N times, never escalates to abort) is the failure mode seen in
 * Test 2 of the log: the model keeps re-reading the same file 4×, 5×
 * with no behavioural change.
 *
 * This module provides:
 *   1. A per-session counter of `warn` verdicts per target.
 *   2. A "blocked target" set: once a target has produced 2 warns in
 *      this session, the next attempted read on that path is rejected
 *      by the executor with a tool-error message instructing the model
 *      to pivot.
 *   3. A helper to recognise read-shaped tools so non-read calls
 *      (e.g. `run_command`) are never rejected here.
 *
 * Hard-abort is left untouched — the detector still raises
 * SemanticLoopAbortedError at its existing threshold.
 *
 * ── Phase 1b (Sliding Window) ──────────────────────────────────────
 *
 * The original tracker stored warn counts permanently for the lifetime
 * of the session and never decayed them. Once a file accumulated 2
 * warns it became "immortal" — every subsequent read was rejected and,
 * because `task-session.canMutate()` requires a fresh read before any
 * write, the file also became un-modifiable. This deadlock was
 * observed in the June 22, 2026 log session on `style.css`,
 * `portfolio.css`, and `script.js`.
 *
 * Phase 1b adds an optional sliding-window mode. When enabled, each
 * warn carries the `currentTurn` it occurred on, and `isBlocked()`
 * only considers warns within the last N turns. Default N is 10. The
 * legacy session-lifetime behavior is preserved as the default
 * (toggled by `preferences.agent.loopGuard.useSlidingWindow`) until
 * Phase 7 flips the flag after soak.
 */

/** Number of `warn` verdicts on the same target before reads are blocked. */
export const REPEAT_WARN_BLOCK_THRESHOLD = 2;

/** Default sliding-window size in tool calls (used when sliding is enabled). */
export const DEFAULT_BLOCK_WINDOW_TURNS = 10;

/** Tool names that count as "reading" the target path. */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'extract_symbols',
  'extract_imports',
]);

export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}

/**
 * Construction-time options for the tracker. All fields optional.
 * When `useSlidingWindow` is false (default), behavior is identical
 * to the pre-Phase-1b implementation: warns accumulate for the entire
 * session, and the block flips on at the threshold and stays on.
 */
export interface LoopMitigationOptions {
  /** When true, warns decay outside `blockWindowTurns`. Default false. */
  useSlidingWindow?: boolean;
  /** Sliding-window size in tool calls. Default {@link DEFAULT_BLOCK_WINDOW_TURNS}. */
  blockWindowTurns?: number;
}

export class LoopMitigationTracker {
  /** Legacy-mode running count of warns per target. */
  private readonly warnCounts = new Map<string, number>();
  /** Legacy-mode set of targets that have flipped to blocked. */
  private readonly blockedTargets = new Set<string>();
  /** Sliding-mode timestamps (tool-call counts) of warns per target. */
  private readonly warnTimestamps = new Map<string, number[]>();

  private readonly useSlidingWindow: boolean;
  private readonly blockWindowTurns: number;
  /**
   * Monotonic fallback counter used when sliding mode is enabled but
   * the caller didn't pass a `currentTurn`. Ensures the sliding-window
   * path stays consistent (both recordWarn and isBlocked operate on
   * the same datastructure) even for legacy callers.
   */
  private fallbackTurn = 0;

  constructor(options: LoopMitigationOptions = {}) {
    this.useSlidingWindow = options.useSlidingWindow === true;
    this.blockWindowTurns = options.blockWindowTurns ?? DEFAULT_BLOCK_WINDOW_TURNS;
  }

  /**
   * Record a `warn` verdict for `target`. Returns true if this verdict
   * pushed `target` over the block threshold (caller may choose to
   * surface a one-time "now blocking" message).
   *
   * `currentTurn` is required when the tracker was constructed with
   * `useSlidingWindow: true` — it's the tool-call count at the moment
   * of the warn, used to compare against the sliding window. In
   * legacy mode the parameter is accepted but ignored, preserving
   * backward-compatible callers.
   */
  recordWarn(target: string, currentTurn?: number): boolean {
    if (this.useSlidingWindow) {
      // Sliding mode: append a timestamp and re-evaluate block state.
      // If the caller didn't pass currentTurn, use a monotonic fallback
      // so the sliding path remains the single source of truth (rather
      // than splitting state across legacy + sliding stores).
      const turn = currentTurn ?? ++this.fallbackTurn;
      if (currentTurn !== undefined) {
        // Keep fallback ahead of explicit turns so a later mixed call
        // never re-uses an earlier turn id.
        if (currentTurn > this.fallbackTurn) this.fallbackTurn = currentTurn;
      }
      const arr = this.warnTimestamps.get(target) ?? [];
      arr.push(turn);
      // Prune anything outside the current window so the array doesn't
      // grow unboundedly across long sessions.
      const cutoff = turn - this.blockWindowTurns;
      const pruned = arr.filter((t) => t >= cutoff);
      this.warnTimestamps.set(target, pruned);
      const wasBlocked = pruned.length - 1 >= REPEAT_WARN_BLOCK_THRESHOLD; // prior state (before this push, but pruned)
      const isNowBlocked = pruned.length >= REPEAT_WARN_BLOCK_THRESHOLD;
      return !wasBlocked && isNowBlocked;
    }
    return this.recordWarnLegacy(target);
  }

  private recordWarnLegacy(target: string): boolean {
    const prev = this.warnCounts.get(target) ?? 0;
    const next = prev + 1;
    this.warnCounts.set(target, next);
    if (next >= REPEAT_WARN_BLOCK_THRESHOLD && !this.blockedTargets.has(target)) {
      this.blockedTargets.add(target);
      return true;
    }
    return false;
  }

  /**
   * True if the target has been blocked from further reads.
   *
   * In sliding-window mode, `currentTurn` should be passed so the
   * window can be evaluated against the present moment. Without it
   * the method evaluates against the most recent warn timestamp,
   * which is usually correct but may keep a target blocked for one
   * extra turn after the window would have decayed.
   */
  isBlocked(target: string, currentTurn?: number): boolean {
    if (this.useSlidingWindow) {
      const arr = this.warnTimestamps.get(target);
      if (!arr || arr.length === 0) return false;
      const ref = currentTurn ?? arr[arr.length - 1];
      const cutoff = ref - this.blockWindowTurns;
      const live = arr.filter((t) => t >= cutoff);
      return live.length >= REPEAT_WARN_BLOCK_THRESHOLD;
    }
    return this.blockedTargets.has(target);
  }

  /**
   * Number of warns recorded for the target (for diagnostics).
   * In sliding mode this returns warns within the current window
   * rather than the cumulative session count.
   */
  warnsFor(target: string, currentTurn?: number): number {
    if (this.useSlidingWindow) {
      const arr = this.warnTimestamps.get(target);
      if (!arr) return 0;
      if (currentTurn === undefined) return arr.length;
      const cutoff = currentTurn - this.blockWindowTurns;
      return arr.filter((t) => t >= cutoff).length;
    }
    return this.warnCounts.get(target) ?? 0;
  }

  /**
   * Reset all tracker state. Used between sessions, in tests, and
   * (Phase 1b) optionally between orchestrator subtasks so one stuck
   * subtask cannot poison the rest of the run.
   *
   * Passing a target resets state for just that path; passing nothing
   * clears everything.
   */
  reset(target?: string): void {
    if (target === undefined) {
      this.warnCounts.clear();
      this.blockedTargets.clear();
      this.warnTimestamps.clear();
      this.fallbackTurn = 0;
      return;
    }
    this.warnCounts.delete(target);
    this.blockedTargets.delete(target);
    this.warnTimestamps.delete(target);
  }
}

/**
 * Build the synthetic tool-result that replaces a blocked read.
 * Talks to the model in the same shape as a real read_file failure so
 * the next-turn reasoning has a clear pivot signal.
 */
export function buildLoopBlockedReadResult(target: string, warns: number): string {
  return (
    `Error: read_file refused. The loop-trap detector has flagged '${target}' ` +
    `with ${warns} consecutive warnings — repeatedly reading this file is ` +
    `not producing progress. Do NOT request this path again. Instead:\n` +
    `  • Search for the related symbol or string with search_code.\n` +
    `  • Look at this file's dependencies via extract_imports on a different file.\n` +
    `  • Reason from the context you already have, or ask the user a clarifying question.`
  );
}
