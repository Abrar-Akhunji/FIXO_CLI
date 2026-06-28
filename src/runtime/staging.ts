/**
 * Atomic Workspace Shadow Staging — Pillar 2 of the Phase 2 safety
 * refactor. The problem: a direct `fs.writeFileSync` to a user's
 * source file is a non-atomic, non-rollbackable operation. If the
 * process is killed mid-write, the user is left with a partially
 * truncated file. If a downstream validation step fails, the
 * user is left with a corrupted file. Both outcomes are
 * unacceptable for a tool that markets itself as "enterprise
 * safe".
 *
 * The fix: route every file write through a `.fixo/staging/`
 * shadow directory, validate it (Pillar 3 LSP gate will plug in
 * here), and only then perform an atomic `fs.renameSync` swap.
 * If anything goes wrong, restore the original from a sibling
 * `.pending.bak` file and the user is none the wiser.
 *
 * Layout under `cwd`:
 *
 *   .fixo/staging/<run-id>/
 *     <sha256(targetPath)>.pending       # staged content
 *     <sha256(targetPath)>.meta.json     # { targetPath, mode, createdAt }
 *
 *   <targetPath>.pending.bak             # temporary backup, only
 *                                        # present during commit()
 *
 * The staging directory is created with mode `0o700`. Pending
 * files and their metadata are written with mode `0o600`.
 *
 * The manager is synchronous (writes are small, no streaming),
 * safe to construct at the start of a run, and thread-agnostic —
 * the run-id is the only thing that disambiguates concurrent
 * runs against the same workspace.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceGuard } from "../workspace-guard.js";
import { getRunInventory } from "./run-inventory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link AtomicStagingManager}. */
export interface AtomicStagingOptions {
  /** Maximum age of a staged write before it is eligible for GC (ms). */
  ttlMs?: number;
  /**
   * If supplied, the callback runs immediately before the rename
   * swap inside `commit()`. If it throws, the staged write is
   * rolled back and the original target is preserved. Pillar 3
   * (LSP pre-save gate) wires in here.
   */
  preCommitHook?: (entry: StagedWrite) => Promise<void> | void;
  /**
   * Pillar 5 / Protection 3 — structural syntax health check.
   *
   * If supplied, the callback runs *after* `preCommitHook` and
   * *before* the rename swap. It receives the staged content and
   * the target path, and should throw a {@link StructuralSyntaxError}
   * (or any `Error`) if the content is unparseable. Pillar 5 wires
   * in a JavaScript / TypeScript parser here so that catastrophic
   * syntax damage (e.g. the LLM pasting code into the wrong
   * function) is caught before it lands on disk.
   */
  syntaxHealthCheck?: (
    entry: StagedWrite,
    content: string,
  ) => Promise<void> | void;
  /**
   * If false, the manager operates in "dry-run" mode: stage()
   * writes to the shadow dir but commit() refuses to swap. Useful
   * for tests and for users who want the staging guarantees
   * without the actual file replacement. Defaults to true.
   */
  enabled?: boolean;
}

/** A staged write, returned by {@link AtomicStagingManager.stage}. */
export interface StagedWrite {
  /** Opaque identifier — sha256 of the target path. */
  readonly id: string;
  /** Absolute path of the file that will be replaced at commit. */
  readonly targetPath: string;
  /** Absolute path of the pending staged file. */
  readonly pendingPath: string;
  /** Absolute path of the sidecar metadata file. */
  readonly metaPath: string;
  /** When the stage was created (ms since epoch). */
  readonly createdAt: number;
  /** Mode the file will have on disk after commit. */
  readonly mode: number;
}

/** Result of {@link AtomicStagingManager.commit}. */
export interface CommitResult {
  /** True if the swap succeeded and the file is on disk. */
  readonly committed: boolean;
  /** Path that was committed. */
  readonly targetPath: string;
  /** Whether a backup of the original was created and cleared. */
  readonly backupCreated: boolean;
  /** Number of bytes written to the target. */
  readonly bytesWritten: number;
  /** ISO timestamp of the commit. */
  readonly committedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a requested staged write does not exist. */
export class StagedWriteNotFoundError extends Error {
  public readonly id: string;
  constructor(id: string) {
    super(`No staged write with id ${id}`);
    this.name = "StagedWriteNotFoundError";
    this.id = id;
  }
}

/** Thrown when commit() rolls back due to a pre-commit hook failure. */
export class PreCommitHookRejectedError extends Error {
  public readonly id: string;
  public readonly cause: unknown;
  constructor(id: string, cause: unknown) {
    super(
      `Write rejected by pre-commit hook. Reason: ${String(cause)}. (Staged write id: ${id})`,
    );
    this.name = "PreCommitHookRejectedError";
    this.id = id;
    this.cause = cause;
  }
}

/** Thrown when a target path escapes the workspace root. */
export class StagingPathEscapeError extends Error {
  public readonly attempted: string;
  constructor(attempted: string) {
    super(`Staging refused: path escapes workspace root: ${attempted}`);
    this.name = "StagingPathEscapeError";
    this.attempted = attempted;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const STAGING_DIR_NAME = "staging";
const META_SUFFIX = ".meta.json";
const PENDING_SUFFIX = ".pending";
const BACKUP_SUFFIX = ".pending.bak";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256 = (input: string): string =>
  crypto.createHash("sha256").update(input, "utf-8").digest("hex");

/** Try to chmod; ignore on platforms that don't support it. */
const chmodSafe = (filePath: string, mode: number): void => {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // ignore
  }
};

/** Best-effort deletion that does not throw. */
const rmSafe = (target: string): void => {
  try {
    fs.unlinkSync(target);
  } catch {
    // ignore
  }
};

// ---------------------------------------------------------------------------
// AtomicStagingManager
// ---------------------------------------------------------------------------

export class AtomicStagingManager {
  public readonly cwd: string;
  public readonly runId: string;
  public readonly options: Required<
    Pick<AtomicStagingOptions, "ttlMs" | "enabled">
  > &
    Pick<AtomicStagingOptions, "preCommitHook" | "syntaxHealthCheck">;
  /** Absolute path of the staging directory for this run. */
  public readonly stagingDir: string;

  constructor(cwd: string, runId: string, options: AtomicStagingOptions = {}) {
    if (!runId || !/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new Error(
        `runId must match [A-Za-z0-9._-]+ (got: ${JSON.stringify(runId)})`,
      );
    }
    this.cwd = path.resolve(cwd);
    this.runId = runId;
    this.options = {
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      enabled: options.enabled ?? true,
      preCommitHook: options.preCommitHook,
      syntaxHealthCheck: options.syntaxHealthCheck,
    };
    this.stagingDir = path.join(
      this.cwd,
      ".fixo",
      STAGING_DIR_NAME,
      this.runId,
    );
  }

  /** Ensure the staging directory exists with mode 0o700. */
  private ensureStagingDir(): void {
    fs.mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    chmodSafe(this.stagingDir, 0o700);
  }

  /** Reject paths that escape the workspace root. */
  private resolveTarget(relativeOrAbsolute: string): string {
    const guard = new WorkspaceGuard(this.cwd);
    try {
      return guard.resolve(relativeOrAbsolute, "file", true);
    } catch {
      throw new StagingPathEscapeError(relativeOrAbsolute);
    }
  }

  /**
   * Stage a file for atomic write. Writes the content to
   * `<staging>/<sha256(target)>.pending` and a sidecar
   * `<staging>/<sha256(target)>.meta.json` containing the target
   * path, mode, and timestamp. Returns the staged write metadata.
   */
  public stage(target: string, content: string, mode = 0o644): StagedWrite {
    const resolved = this.resolveTarget(target);
    const id = sha256(resolved);
    this.ensureStagingDir();

    const pendingPath = path.join(this.stagingDir, `${id}${PENDING_SUFFIX}`);
    const metaPath = path.join(this.stagingDir, `${id}${META_SUFFIX}`);

    // Write pending content (atomic: write to temp + rename).
    const tmpPath = `${pendingPath}.tmp`;
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    chmodSafe(tmpPath, 0o600);
    fs.renameSync(tmpPath, pendingPath);

    // Write meta sidecar.
    const meta = {
      targetPath: resolved,
      mode,
      createdAt: Date.now(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta), {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSafe(metaPath, 0o600);

    return {
      id,
      targetPath: resolved,
      pendingPath,
      metaPath,
      createdAt: meta.createdAt,
      mode,
    };
  }

  /** Read a staged write's content (lazy — only read on demand). */
  public read(id: string): string {
    const entry = this.readEntry(id);
    return fs.readFileSync(entry.pendingPath, "utf-8");
  }

  /** Look up a staged write by id without touching the file system further. */
  public readEntry(id: string): StagedWrite {
    const pendingPath = path.join(this.stagingDir, `${id}${PENDING_SUFFIX}`);
    const metaPath = path.join(this.stagingDir, `${id}${META_SUFFIX}`);
    if (!fs.existsSync(pendingPath) || !fs.existsSync(metaPath)) {
      throw new StagedWriteNotFoundError(id);
    }
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
      targetPath: string;
      mode: number;
      createdAt: number;
    };
    return {
      id,
      targetPath: raw.targetPath,
      pendingPath,
      metaPath,
      createdAt: raw.createdAt,
      mode: raw.mode,
    };
  }

  /** List all staged writes for this run. */
  public list(): StagedWrite[] {
    if (!fs.existsSync(this.stagingDir)) return [];
    const names = fs.readdirSync(this.stagingDir);
    const entries: StagedWrite[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const id = name.slice(0, -META_SUFFIX.length);
      try {
        entries.push(this.readEntry(id));
      } catch {
        // Stale meta without a pending counterpart — skip.
      }
    }
    return entries;
  }

  /**
   * Remove a staged write without touching the target. Used by the
   * LSP pre-save gate when it rejects a write.
   */
  public discard(id: string): void {
    const entry = this.readEntry(id);
    rmSafe(entry.pendingPath);
    rmSafe(entry.metaPath);
  }

  /**
   * Commit a staged write to its target path. The flow is:
   *
   *   1. Run the optional pre-commit hook (Pillar 3 plugs in here).
   *   2. Ensure the parent directory of the target exists.
   *   3. If the target exists, rename it to `<target>.pending.bak`.
   *   4. Rename the pending file to the target.
   *   5. Delete the backup.
   *
   * If any step fails, the backup (if any) is restored to the
   * target and the backup itself is removed. The pending and
   * metadata files are always cleaned up on success.
   */
  public async commit(id: string): Promise<CommitResult> {
    const entry = this.readEntry(id);
    const target = entry.targetPath;
    const backup = `${target}${BACKUP_SUFFIX}`;
    const existed = fs.existsSync(target);

    // 1. Pre-commit hook (Pillar 3 plugs in here).
    if (this.options.preCommitHook) {
      try {
        await this.options.preCommitHook(entry);
      } catch (cause) {
        // Hook rejected — discard the staged write but do NOT
        // touch the target.
        this.discard(id);
        throw new PreCommitHookRejectedError(id, cause);
      }
    }

    // 1.5 Pillar 5 / Protection 3 — structural syntax health
    // check. Runs *after* the LSP gate and *before* the rename
    // swap. If the staged content is syntactically broken the
    // write is rejected and discarded; the target is preserved.
    if (this.options.syntaxHealthCheck) {
      const content = fs.readFileSync(entry.pendingPath, "utf-8");
      try {
        await this.options.syntaxHealthCheck(entry, content);
      } catch (cause) {
        this.discard(id);
        throw new PreCommitHookRejectedError(id, cause);
      }
    }

    if (!this.options.enabled) {
      // Dry-run mode: leave the staged write in place.
      const bytes = Buffer.byteLength(
        fs.readFileSync(entry.pendingPath),
        "utf-8",
      );
      return {
        committed: false,
        targetPath: target,
        backupCreated: false,
        bytesWritten: bytes,
        committedAt: new Date().toISOString(),
      };
    }

    // 2. Ensure parent directory exists.
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });

    try {
      // 3. Back up the existing file (if any).
      if (existed) {
        // If a stale backup is present from a previous failed
        // commit, clear it first.
        rmSafe(backup);
        fs.renameSync(target, backup);
      }

      // 4. Swap pending into place.
      fs.renameSync(entry.pendingPath, target);

      // Apply mode.
      try {
        fs.chmodSync(target, entry.mode);
      } catch {
        // ignore
      }

      // 5. Clear the backup.
      if (existed) rmSafe(backup);

      const bytes = Buffer.byteLength(
        fs.readFileSync(target, "utf-8"),
        "utf-8",
      );
      // Tidy up the meta sidecar.
      rmSafe(entry.metaPath);
      getRunInventory(this.runId).invalidate(target);

      return {
        committed: true,
        targetPath: target,
        backupCreated: existed,
        bytesWritten: bytes,
        committedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Rollback: restore the backup, remove the .pending if any.
      try {
        if (existed && fs.existsSync(backup)) {
          if (fs.existsSync(target)) fs.unlinkSync(target);
          fs.renameSync(backup, target);
        } else if (!existed && fs.existsSync(target)) {
          // We created the file but the rename to target itself
          // succeeded — only reached if chmod fails. Target is
          // already correct; nothing to undo.
        }
      } catch {
        // Last-ditch: leave the backup in place so a human can
        // recover. The next GC pass will clean it up.
      }
      // Pending may have been consumed; if not, leave it.
      throw err;
    }
  }

  /**
   * Apply a surgical in-place edit to an existing file. The new
   * content is staged under the same `.fixo/staging/<runId>/<id>.pending`
   * layout and the commit step mirrors `commit()`: backup the
   * target, atomic rename, clear the backup, clear the meta.
   *
   * This is functionally `stage() + commit()` collapsed into a
   * single call, but the on-disk layout, backup semantics, and
   * rollback path are identical. Provided so `str_replace` (and
   * future surgical-edit tools) can route their edits through the
   * same atomic staging pipeline as `write_file` without touching
   * the existing `stage()` / `commit()` flow.
   *
   * The optional `meta` argument is recorded into `.meta.json` so
   * the audit trail records the originator of the edit (e.g. a
   * `str_replace` tool call vs. a `subagent`). The method never
   * weakens the Pillar 2 atomicity guarantee: if the rename
   * swap fails, the backup is restored and the original file is
   * preserved byte-for-byte.
   */
  public async applySurgicalReplace(
    target: string,
    newContent: string,
    meta: {
      runId: string;
      reason: "str_replace" | "todo_write" | "subagent";
      actorId: string;
    },
  ): Promise<{ ok: true; path: string; bytes: number }> {
    const resolved = this.resolveTarget(target);
    const id = sha256(resolved);
    this.ensureStagingDir();

    const pendingPath = path.join(this.stagingDir, `${id}${PENDING_SUFFIX}`);
    const metaPath = path.join(this.stagingDir, `${id}${META_SUFFIX}`);
    const backup = `${resolved}${BACKUP_SUFFIX}`;
    const existed = fs.existsSync(resolved);

    // 1. Write the new content to the .pending file (atomic via temp+rename).
    const tmpPath = `${pendingPath}.tmp`;
    fs.writeFileSync(tmpPath, newContent, { encoding: "utf-8", mode: 0o600 });
    chmodSafe(tmpPath, 0o600);
    fs.renameSync(tmpPath, pendingPath);

    // 2. Write the sidecar meta with audit trail.
    const metaPayload = {
      targetPath: resolved,
      mode: 0o644,
      createdAt: Date.now(),
      reason: meta.reason,
      actorId: meta.actorId,
      runId: meta.runId,
    };
    fs.writeFileSync(metaPath, JSON.stringify(metaPayload), {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSafe(metaPath, 0o600);

    // 3. Ensure parent dir exists.
    const parent = path.dirname(resolved);
    fs.mkdirSync(parent, { recursive: true });

    try {
      // 4. Back up the existing file (if any).
      if (existed) {
        // Clear any stale backup from a previous failed commit.
        rmSafe(backup);
        fs.renameSync(resolved, backup);
      }

      // 5. Atomic swap of the pending file into the target.
      fs.renameSync(pendingPath, resolved);

      // 6. Apply file mode (best-effort across platforms).
      try {
        fs.chmodSync(resolved, 0o644);
      } catch {
        // ignore
      }

      // 7. Clear backup and meta sidecar.
      if (existed) rmSafe(backup);
      rmSafe(metaPath);

      const bytes = Buffer.byteLength(
        fs.readFileSync(resolved, "utf-8"),
        "utf-8",
      );
      getRunInventory(this.runId).invalidate(resolved);
      return { ok: true, path: resolved, bytes };
    } catch (err) {
      // Rollback: restore the backup, clean up the .pending if any.
      try {
        if (existed && fs.existsSync(backup)) {
          if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
          fs.renameSync(backup, resolved);
        } else if (!existed && fs.existsSync(resolved)) {
          // We created the file but the rename to target itself
          // succeeded — only reached if chmod fails. Target is
          // already correct; nothing to undo.
        }
      } catch {
        // Last-ditch: leave the backup in place so a human can
        // recover. The next GC pass will clean it up.
      }
      // Pending may have been consumed; if not, leave it.
      throw err;
    }
  }

  /**
   * Remove any staged write older than `ttlMs`. Returns the number
   * of entries removed. Designed to be cheap at run start
   * (typically <2ms for a few hundred entries).
   */
  public gc(now: number = Date.now()): number {
    if (!fs.existsSync(this.stagingDir)) return 0;
    const cutoff = now - this.options.ttlMs;
    let removed = 0;
    for (const entry of this.list()) {
      if (entry.createdAt < cutoff) {
        this.discard(entry.id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Sweep every run-id directory under `<cwd>/.fixo/staging/`.
   * Returns the total number of expired entries removed. Called
   * automatically at the start of every streaming run and is also
   * exposed via the `/fixo gc` slash command.
   */
  public static garbageCollectAll(cwd: string, ttlMs?: number): number {
    const root = path.resolve(cwd);
    const stagingRoot = path.join(root, ".fixo", STAGING_DIR_NAME);
    if (!fs.existsSync(stagingRoot)) return 0;
    let removed = 0;
    let runDirs: string[];
    try {
      runDirs = fs.readdirSync(stagingRoot);
    } catch {
      return 0;
    }
    for (const runDir of runDirs) {
      const runPath = path.join(stagingRoot, runDir);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(runPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // Safe: runDir names are sanitised in the constructor.
      const mgr = new AtomicStagingManager(root, runDir, { ttlMs });
      removed += mgr.gc();
    }
    return removed;
  }

  /**
   * Discard every staged write for the given (cwd, runId) pair. Used
   * when an agent is force-killed (e.g. loop-trap hard-abort) so the
   * workspace is left in its pre-run state. Returns the number of
   * entries removed.
   *
   * Best-effort: a failure to remove a single entry is logged and
   * swallowed so the caller never sees an exception from cleanup.
   */
  public static rollbackAll(cwd: string, runId: string): number {
    const root = path.resolve(cwd);
    let removed = 0;
    let mgr: AtomicStagingManager;
    try {
      mgr = new AtomicStagingManager(root, runId);
    } catch {
      return 0;
    }
    if (!fs.existsSync(mgr.stagingDir)) return 0;
    const entries = mgr.list();
    for (const entry of entries) {
      try {
        mgr.discard(entry.id);
        removed += 1;
      } catch (err) {
        console.error(
          `[AtomicStagingManager.rollbackAll] failed to discard ${entry.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Best-effort: remove the now-empty run directory.
    try {
      fs.rmSync(mgr.stagingDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return removed;
  }
}
