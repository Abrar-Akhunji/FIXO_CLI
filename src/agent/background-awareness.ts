/**
 * background-awareness.ts — Phase 3: surface background-job state
 * into the agent loop every turn.
 *
 * The LLM happily spawns `run_command_async` jobs and then forgets
 * about them. This helper closes that gap by injecting a compact
 * `[Background Jobs]` directive ahead of each `chat()` call:
 *
 *   - newly-finished jobs (exited / killed / failed) are announced
 *     exactly once, including the exit code and a short stderr tail
 *     for failures;
 *   - still-running jobs are listed each turn as a reminder so the
 *     model is nudged to poll them.
 *
 * It is purely read-side: it never spawns, mutates, polls, or kills
 * jobs — that responsibility stays with the tool layer. State
 * tracking is in-memory (one instance per agent run); persistence
 * across runs is handled by the registry's on-disk snapshot already.
 */
import type { JobSnapshot, JobStatus } from '../runtime/background-jobs.js';
import { listAllBackgroundJobs } from './tool-executor.js';

/** Total directive size cap. Keeps token cost predictable on every turn. */
const MAX_DIRECTIVE_CHARS = 1500;
/** Per-failure stderr tail size. Just enough for an error line. */
const MAX_STDERR_TAIL_CHARS = 200;

export interface AwarenessSnapshot {
  /** Jobs currently in 'running' state. */
  running: JobSnapshot[];
  /** Jobs whose status flipped to a terminal state since the last call. */
  newlyFinished: JobSnapshot[];
  /** Total jobs known to the registry, including ones already announced. */
  totalJobs: number;
}

/**
 * Compress a long stderr down to the last `MAX_STDERR_TAIL_CHARS`
 * characters. The byte counter on the snapshot already covers the
 * "did anything overflow" case, so the tail is purely a hint.
 */
function tailStderr(raw: string): string {
  const trimmed = raw.replace(/\s+$/u, '');
  if (trimmed.length <= MAX_STDERR_TAIL_CHARS) return trimmed;
  return `…${trimmed.slice(-MAX_STDERR_TAIL_CHARS)}`;
}

function secondsSince(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

export class BackgroundAwareness {
  private readonly cwd: string;
  /** Last terminal status we surfaced for a given jobId. */
  private readonly announced = new Map<string, JobStatus>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Compute the delta between the registry's current state and
   * what we've already surfaced. Pure read — does not advance any
   * internal cursor; call {@link markAnnounced} once the directive
   * is actually injected.
   */
  snapshot(): AwarenessSnapshot {
    const all = listAllBackgroundJobs(this.cwd);
    const running: JobSnapshot[] = [];
    const newlyFinished: JobSnapshot[] = [];
    for (const job of all) {
      if (job.status === 'running') {
        running.push(job);
        continue;
      }
      // Terminal status. Announce only if we haven't surfaced the
      // current status yet. (`exited` → `exited` would mean the job
      // already appeared in a previous directive.)
      if (this.announced.get(job.id) !== job.status) {
        newlyFinished.push(job);
      }
    }
    return { running, newlyFinished, totalJobs: all.length };
  }

  /**
   * Render the snapshot into an injectable directive string, or
   * `null` if there is nothing worth surfacing. The format mirrors
   * the existing `[Safety Alert]` directive shape so the agent
   * model already knows how to parse it.
   */
  formatDirective(snap: AwarenessSnapshot): string | null {
    if (snap.running.length === 0 && snap.newlyFinished.length === 0) {
      return null;
    }
    const lines: string[] = ['[Background Jobs]'];

    if (snap.newlyFinished.length > 0) {
      lines.push('Newly finished (poll these or move on):');
      for (const job of snap.newlyFinished) {
        const head =
          `  • ${job.id} · ${job.cmd} · ${job.status}` +
          (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : '');
        lines.push(head);
        if (job.status === 'failed' || job.status === 'killed') {
          const tail = tailStderr(job.stderr);
          if (tail.length > 0) {
            lines.push(`    stderr: ${tail}`);
          }
        }
      }
    }

    if (snap.running.length > 0) {
      lines.push('Still running (call poll_command_status when ready):');
      for (const job of snap.running) {
        const age = secondsSince(job.startedAt);
        lines.push(
          `  • ${job.id} · ${job.cmd} · running ${age}s · stdout=${job.totalStdoutBytes}B`,
        );
      }
    }

    const joined = lines.join('\n');
    if (joined.length <= MAX_DIRECTIVE_CHARS) return joined;
    // Hard cap. We trim from the end so the header + newly-finished
    // section (the most actionable part) always survives.
    return `${joined.slice(0, MAX_DIRECTIVE_CHARS - 16)}\n…[truncated]`;
  }

  /**
   * After injecting a directive, advance the cursor so a job's
   * terminal status is never announced twice. Pass the snapshot
   * that was actually surfaced.
   */
  markAnnounced(snap: AwarenessSnapshot): void {
    for (const job of snap.newlyFinished) {
      this.announced.set(job.id, job.status);
    }
  }
}
