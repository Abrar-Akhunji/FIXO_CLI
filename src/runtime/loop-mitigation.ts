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
 */

/** Number of `warn` verdicts on the same target before reads are blocked. */
export const REPEAT_WARN_BLOCK_THRESHOLD = 2;

/** Tool names that count as "reading" the target path. */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'extract_symbols',
  'extract_imports',
]);

export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}

export class LoopMitigationTracker {
  private readonly warnCounts = new Map<string, number>();
  private readonly blockedTargets = new Set<string>();

  /**
   * Record a `warn` verdict for `target`. Returns true if this verdict
   * pushed `target` over the block threshold (caller may choose to
   * surface a one-time "now blocking" message).
   */
  recordWarn(target: string): boolean {
    const prev = this.warnCounts.get(target) ?? 0;
    const next = prev + 1;
    this.warnCounts.set(target, next);
    if (next >= REPEAT_WARN_BLOCK_THRESHOLD && !this.blockedTargets.has(target)) {
      this.blockedTargets.add(target);
      return true;
    }
    return false;
  }

  /** True if the target has been blocked from further reads. */
  isBlocked(target: string): boolean {
    return this.blockedTargets.has(target);
  }

  /** Number of warns recorded for the target (for diagnostics). */
  warnsFor(target: string): number {
    return this.warnCounts.get(target) ?? 0;
  }

  /** Reset all state (used between sessions or in tests). */
  reset(): void {
    this.warnCounts.clear();
    this.blockedTargets.clear();
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
