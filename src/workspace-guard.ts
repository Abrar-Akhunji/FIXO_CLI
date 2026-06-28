import fs from "fs";
import path from "path";

/**
 * Workspace boundary guard.
 *
 * Pillar 5 (Self-Protection) — the WorkspaceGuard also enforces
 * a System Path Lock: paths that resolve inside the platform's
 * own runtime (`src/**`, `package.json`, `tsconfig.json`, and
 * the lockfile) are **immutable** from any active agent loop.
 * This stops an autonomous agent from corrupting its own host
 * (the failure mode that produced the
 * `src/agent/tool-executor.ts:983: Unexpected "catch"` incident
 * during the Phase 2 release).
 */
export class WorkspaceGuard {
  constructor(
    public readonly root: string,
    private readonly allowedOutsidePaths?: Set<string>,
  ) {
    try {
      this.root = fs.realpathSync(path.resolve(root));
    } catch {
      this.root = path.resolve(root);
    }
  }

  private safeRealPath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        const parent = path.dirname(p);
        if (parent === p) return p;
        return path.join(this.safeRealPath(parent), path.basename(p));
      }
      throw err;
    }
  }

  resolve(input: string | undefined, label = "path", strict = false): string {
    const raw = input?.trim() || ".";
    const resolved = path.resolve(this.root, raw);
    if (strict && !this.isInside(resolved)) {
      if (!this.allowedOutsidePaths?.has(resolved)) {
        throw new Error(`${label} escapes workspace: ${input ?? "."}`);
      }
    }
    return resolved;
  }

  isInside(target: string): boolean {
    const resolvedTarget = this.safeRealPath(path.resolve(target));
    const relative = path.relative(this.root, resolvedTarget);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  relative(target: string): string {
    return path.relative(this.root, path.resolve(target)) || ".";
  }

  ensureFile(target: string): string {
    const resolved = this.resolve(target, "file", true);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${target}`);
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        throw new Error(`File does not exist: ${target}`);
      }
      throw err;
    }
    return resolved;
  }

  isBinaryFile(target: string, sampleBytes = 4096): boolean {
    const fd = fs.openSync(target, "r");
    try {
      const buffer = Buffer.alloc(sampleBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, sampleBytes, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  }

  /* ──────────────────── System Path Lock (Pillar 5) ──────────────────── */

  /**
   * File-system entries that make up the Fixo CLI platform
   * itself. The agent runtime is **never** allowed to mutate
   * these from an active task cycle, regardless of which
   * workspace the user is operating in.
   *
   * The list is intentionally narrow (the platform's own
   * source tree and root-level build manifests) so the lock
   * does not interfere with the user's own code in
   * sub-directories.
   */
  private static readonly PLATFORM_PATH_PATTERNS: ReadonlyArray<RegExp> = [
    /(^|\/)src\/.+/,
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)tsconfig(\..+)?\.json$/,
    /(^|\/)dist\/.+/,
    /(^|\/)node_modules\/.+/,
  ];

  /**
   * Return true if the relative path matches a platform-locked
   * pattern. The check is case-insensitive on the extension
   * because Windows and macOS Finder both silently rename
   * `package.json` to `Package.json` if the user double-clicks.
   */
  public isPlatformPath(relativePath: string): boolean {
    return WorkspaceGuard.isPlatformPathStatic(relativePath);
  }

  /**
   * Static form of {@link isPlatformPath}. Useful in tests and
   * in places where a WorkspaceGuard instance is not yet
   * available.
   */
  public static isPlatformPath(relativePath: string): boolean {
    return WorkspaceGuard.isPlatformPathStatic(relativePath);
  }

  private static isPlatformPathStatic(relativePath: string): boolean {
    const normalised = relativePath.replace(/\\/g, "/").toLowerCase();
    for (const pattern of WorkspaceGuard.PLATFORM_PATH_PATTERNS) {
      if (pattern.test(normalised)) return true;
    }
    return false;
  }

  /**
   * Throws {@link PlatformPathLockedError} if `target` resolves
   * to a path inside the platform's own runtime. This is the
   * one method every mutation tool in the executor must call
   * before staging a write.
   */
  public assertNotPlatformPath(target: string): void {
    // Only enforce platform path lock if the workspace itself IS the platform (Fixo CLI codebase).
    // Otherwise, we block the user from editing their own src/ and package.json!
    const isFixoRepo =
      fs.existsSync(path.join(this.root, "src", "workspace-guard.ts")) &&
      fs.existsSync(path.join(this.root, "package.json"));

    if (!isFixoRepo) {
      return; // Not running inside the Fixo CLI source code, so no system paths to lock.
    }

    // Resolve to an absolute path so symlinks and `..` tricks
    // cannot escape the check.
    const resolved = this.resolve(target, "platform path");
    const relative = this.relative(resolved);
    if (this.isPlatformPath(relative)) {
      throw new PlatformPathLockedError(resolved, relative);
    }
  }
}

/**
 * Thrown when an agent loop attempts to mutate a path inside
 * the platform's own runtime. Caught by the executor's switch
 * statement and surfaced as a plain string error to the LLM,
 * so the model sees the rejection in its next-turn tool result.
 */
export class PlatformPathLockedError extends Error {
  public readonly resolved: string;
  public readonly relative: string;
  constructor(resolved: string, relative: string) {
    super(
      `Error: STOP TRYING TO EDIT THIS FILE. IT IS SYSTEM PROTECTED. MOVE ON TO OTHER TASKS. (target: ${relative})`,
    );
    this.name = "PlatformPathLockedError";
    this.resolved = resolved;
    this.relative = relative;
  }
}
