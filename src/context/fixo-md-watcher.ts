/**
 * fixo-md-watcher.ts — Phase 4: per-turn re-injection of FIXO.md
 * changes.
 *
 * The system prompt bakes the FIXO.md content in at run start, so
 * a long-running agent loop normally never sees later edits. This
 * watcher closes that gap by stat-checking the active FIXO.md
 * before each `chat()` call and emitting a delta when the file is
 * created, updated, or removed mid-run.
 *
 * Why a delta model instead of always re-injecting? The full
 * contents already live in the system prompt; re-sending them on
 * every turn would double the token cost without any new signal.
 * The watcher injects only when the on-disk file no longer matches
 * what the prompt currently reflects.
 *
 * Pure read: stats, optional read, and an in-memory cursor. No
 * `fs.watch`, no subprocesses, no globals.
 */
import fs from "node:fs";
import {
  buildProjectInstructionsBlock,
  findFixoMdPath,
  loadProjectInstructions,
  type FixoMdLoadResult,
  type FixoMdSource,
} from "./fixo-md.js";

/** A point-in-time fingerprint of the active FIXO.md file. */
interface FileFingerprint {
  /** Absolute path of the file that was active. */
  path: string;
  /** Lookup-chain source for that path. */
  source: FixoMdSource;
  /** mtime in ms since epoch. */
  mtimeMs: number;
  /** Size on disk in bytes. */
  bytes: number;
}

export type FixoMdWatchResult =
  | { kind: "unchanged" }
  | { kind: "created"; block: string; result: FixoMdLoadResult }
  | { kind: "updated"; block: string; result: FixoMdLoadResult }
  | { kind: "deleted"; previousPath: string };

/* ──────────────────────── helpers ──────────────────────── */

function fingerprint(cwd: string): FileFingerprint | null {
  const found = findFixoMdPath(cwd);
  if (found.path === null) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(found.path);
  } catch {
    return null;
  }
  return {
    path: found.path,
    source: found.source,
    mtimeMs: stat.mtimeMs,
    bytes: stat.size,
  };
}

function fingerprintsEqual(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.path === b.path &&
    a.source === b.source &&
    a.mtimeMs === b.mtimeMs &&
    a.bytes === b.bytes
  );
}

/* ──────────────────────── watcher ──────────────────────── */

export class FixoMdWatcher {
  private readonly cwd: string;
  /** The fingerprint we last surfaced (or captured at construction). */
  private lastSeen: FileFingerprint | null;

  constructor(cwd: string) {
    this.cwd = cwd;
    // Snapshot the baseline so the very first `check()` after the
    // agent loop starts returns 'unchanged' for files that were
    // already present. Those files are already baked into the
    // system prompt by `buildSystemPrompt`.
    this.lastSeen = fingerprint(cwd);
  }

  /**
   * Compare the current on-disk state to the last surfaced
   * fingerprint and return the delta. Internal state advances on
   * non-`unchanged` results so a single change is announced once.
   */
  check(): FixoMdWatchResult {
    const current = fingerprint(this.cwd);
    const previous = this.lastSeen;

    // Both null → nothing on disk now or before. Quiet path.
    if (current === null && previous === null) {
      return { kind: "unchanged" };
    }

    // File appeared (or moved into the chain) mid-run.
    if (current !== null && previous === null) {
      const { block, result } = buildProjectInstructionsBlock(this.cwd);
      this.lastSeen = current;
      return { kind: "created", block, result };
    }

    // File disappeared mid-run.
    if (current === null && previous !== null) {
      const previousPath = previous.path;
      this.lastSeen = null;
      return { kind: "deleted", previousPath };
    }

    // Both non-null. If fingerprint matches we're done.
    if (
      current !== null &&
      previous !== null &&
      fingerprintsEqual(current, previous)
    ) {
      return { kind: "unchanged" };
    }

    // Otherwise: content (or path / source) changed.
    const { block, result } = buildProjectInstructionsBlock(this.cwd);
    this.lastSeen = current;
    return { kind: "updated", block, result };
  }

  /**
   * Render a watch result into an injectable directive, or null
   * when nothing should be surfaced. Matches the directive shape
   * used by the safety alert and background-jobs awareness so the
   * agent model already knows how to parse it.
   */
  formatDirective(watch: FixoMdWatchResult): string | null {
    if (watch.kind === "unchanged") return null;
    if (watch.kind === "deleted") {
      return (
        `[Project Instructions]\n` +
        `The FIXO.md previously loaded from \`${watch.previousPath}\` was ` +
        `removed mid-run. Stop relying on its rules until a new one appears.`
      );
    }
    // Created or updated — surface the block verbatim under a
    // labelled header so the LLM sees this is a refresh, not a
    // duplicate of what's in the system prompt.
    const verb = watch.kind === "created" ? "now available" : "updated mid-run";
    const sourceLine = watch.result.path ?? "(unknown path)";
    return (
      `[Project Instructions]\n` +
      `FIXO.md is ${verb}. Source: ${sourceLine}.\n` +
      `Latest content:\n${watch.block.trim()}`
    );
  }
}

/**
 * Convenience wrapper for tests + callers that don't need the
 * persistent watcher state.
 *
 * @internal
 */
export function readFixoMd(cwd: string): FixoMdLoadResult {
  return loadProjectInstructions(cwd);
}
