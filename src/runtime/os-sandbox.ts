/**
 * os-sandbox.ts — Phase 1.2 OS-level sandbox wrapper for `run_command`.
 *
 * The CLI already enforces a regex-based command-parser layer and
 * a WorkspaceGuard path-boundary check before any shell command runs.
 * That stops the obvious cases (`> /etc/passwd`, `sed -i ../foo`) but
 * is not a complete defence against a confused or prompt-injected
 * model — a regex blocklist is a speed bump, not a wall.
 *
 * This module adds an OS-enforced second layer that the model has no
 * way around: `sandbox-exec` on macOS, `bwrap` on Linux. Both use the
 * same OS primitives Apple's own `xcrun` and Flatpak rely on, so the
 * deny semantics are exactly the kernel's, not a JavaScript regex.
 *
 * Design choices, deliberate:
 *
 *  - Default is OFF (config `safety.sandboxMode === 'guard'`). Turning
 *    it on changes runtime behaviour and we want users to opt in
 *    explicitly, not be surprised by a build that suddenly fails
 *    because their `npm test` script writes to `~/.npm/_cacache`.
 *
 *  - When ON and the platform binary is missing, we surface a clear
 *    structured error instead of silently downgrading. A user who
 *    opted into `os-sandbox` and got the regex layer would have the
 *    worst of both worlds — false safety.
 *
 *  - Network is allowed by default — most legitimate build/test
 *    commands need it (npm install, cargo fetch, pip). Callers that
 *    want strict isolation can pass `allowNetwork: false`.
 *
 *  - Reads are unrestricted. The agent legitimately needs to inspect
 *    the system to plan its work. Writes are the dangerous side.
 *
 *  - The macOS profile is generated at runtime into the OS temp dir
 *    from a template (no static `.sb` file shipped) so allow-write
 *    paths can be parameterised per-invocation without macros.
 *    `sandbox-exec` is technically deprecated by Apple but still
 *    ships and works on darwin 25; what's available today wins.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SandboxPlatform = "darwin" | "linux";

export interface SandboxOpts {
  /** Directory the shell runs in. Must be readable. */
  cwd: string;
  /**
   * Roots the sandboxed process may write to. Reads are not
   * restricted — only writes. Always includes the OS temp dir
   * regardless of what the caller passes, because nearly every
   * build tool writes there.
   */
  allowedWritePaths: string[];
  /**
   * Whether the sandboxed process may open network sockets. Most
   * legitimate `run_command` calls need this (npm install,
   * cargo fetch), so the caller usually wants `true`.
   */
  allowNetwork: boolean;
  /** Wall-clock timeout in ms. Defaults to 60s. */
  timeout?: number;
  /** Max captured stdout/stderr bytes. Defaults to 1 MiB. */
  maxBuffer?: number;
  /** Environment for the child process. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Why a sandboxed `run_command` couldn't actually be wrapped in an
 * OS sandbox. Distinct from a *command-failed-inside-the-sandbox*
 * error, which surfaces through {@link SpawnSyncReturns.status} as
 * usual.
 */
export class SandboxUnavailableError extends Error {
  constructor(
    public platform: NodeJS.Platform,
    public reason: string,
  ) {
    super(`OS sandbox unavailable on ${platform}: ${reason}`);
    this.name = "SandboxUnavailableError";
  }
}

/* ──────────────────────── Public entry point ──────────────────────── */

/**
 * Run a shell command inside an OS-enforced sandbox.
 *
 * Throws {@link SandboxUnavailableError} if the current platform has
 * no supported wrapper or the required binary is not on `$PATH`.
 * Otherwise returns the same {@link SpawnSyncReturns} shape the
 * caller would get from a plain `spawnSync(command, { shell: true })`
 * call — so the call site only differs by routing decision, not by
 * result handling.
 */
export function runSandboxed(
  command: string,
  opts: SandboxOpts,
): SpawnSyncReturns<string> {
  const platform = process.platform;
  if (platform === "darwin") {
    return runSandboxedMacos(command, opts);
  }
  if (platform === "linux") {
    return runSandboxedLinux(command, opts);
  }
  throw new SandboxUnavailableError(
    platform,
    "no supported OS sandbox wrapper for this platform",
  );
}

/**
 * Best-effort probe: would {@link runSandboxed} succeed on this
 * machine without actually running a command? Used by the CLI's
 * startup sanity check so we can warn at boot rather than at the
 * first command. Returns `null` on success, a structured reason on
 * failure.
 */
export function probeSandbox(): { ok: true } | { ok: false; reason: string } {
  const platform = process.platform;
  if (platform === "darwin") {
    const which = whichBinary("sandbox-exec");
    return which
      ? { ok: true }
      : {
          ok: false,
          reason: "`sandbox-exec` not on $PATH (macOS system tool)",
        };
  }
  if (platform === "linux") {
    const which = whichBinary("bwrap");
    if (which) return { ok: true };
    return {
      ok: false,
      reason:
        "`bwrap` (bubblewrap) not installed. Install with: apt install bubblewrap | dnf install bubblewrap | apk add bubblewrap",
    };
  }
  return { ok: false, reason: `unsupported platform: ${platform}` };
}

/* ──────────────────────── macOS: sandbox-exec ──────────────────────── */

function runSandboxedMacos(
  command: string,
  opts: SandboxOpts,
): SpawnSyncReturns<string> {
  if (!whichBinary("sandbox-exec")) {
    throw new SandboxUnavailableError("darwin", "`sandbox-exec` not on $PATH");
  }

  const profile = buildMacosProfile({
    allowedWritePaths: dedupeAndResolve([
      ...opts.allowedWritePaths,
      os.tmpdir(),
    ]),
    allowNetwork: opts.allowNetwork,
  });

  // Write the profile to a temp file. sandbox-exec will read it
  // before exec; we delete it immediately after the child returns.
  const profilePath = path.join(
    os.tmpdir(),
    `fixo-sandbox-${process.pid}-${Date.now()}.sb`,
  );
  fs.writeFileSync(profilePath, profile, { encoding: "utf-8", mode: 0o600 });

  try {
    return spawnSync(
      "sandbox-exec",
      ["-f", profilePath, "/bin/sh", "-c", command],
      {
        cwd: opts.cwd,
        encoding: "utf-8",
        timeout: opts.timeout ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        env: opts.env ?? process.env,
      },
    );
  } finally {
    try {
      fs.unlinkSync(profilePath);
    } catch {
      /* safe: best-effort cleanup of tmp profile */
    }
  }
}

function buildMacosProfile(opts: {
  allowedWritePaths: string[];
  allowNetwork: boolean;
}): string {
  // Quote each allow-write path in TinyScheme-style string literal
  // form. sandbox-exec uses backslash-escaped double-quoted strings.
  const writeRoots = opts.allowedWritePaths
    .map((p) => `  (subpath ${quoteSb(p)})`)
    .join("\n");

  const networkRule = opts.allowNetwork
    ? "(allow network*)"
    : "(deny network*)";

  // Inspired by Apple's own /System/Library/Sandbox/Profiles seed
  // profiles. `allow file-read*` is total because the agent must be
  // able to read the system to do useful work; writes are the side
  // we lock down. The auxiliary `allow` rules (sysctl, mach-lookup,
  // process-fork, ipc-posix-shm) are the bare minimum a `/bin/sh`
  // exec of a typical build command needs to not crash.
  return `(version 1)
(deny default)

; Reads: unrestricted. The agent needs to inspect the system.
(allow file-read*)

; Writes: only inside the explicitly-allowed roots.
(allow file-write*
${writeRoots})

; Process / sysctl / IPC: required for /bin/sh to execute a command.
(allow process-fork)
(allow process-exec*)
(allow sysctl-read)
(allow mach-lookup)
(allow file-ioctl)
(allow ipc-posix-shm)
(allow signal (target self))

; Network rule (gated by caller).
${networkRule}
`;
}

function quoteSb(s: string): string {
  // sandbox-exec strings use double-quotes with backslash escaping.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* ──────────────────────── Linux: bubblewrap ──────────────────────── */

function runSandboxedLinux(
  command: string,
  opts: SandboxOpts,
): SpawnSyncReturns<string> {
  if (!whichBinary("bwrap")) {
    throw new SandboxUnavailableError(
      "linux",
      "`bwrap` (bubblewrap) not installed. Install with: apt install bubblewrap | dnf install bubblewrap | apk add bubblewrap",
    );
  }

  const writeRoots = dedupeAndResolve([...opts.allowedWritePaths, os.tmpdir()]);

  const args: string[] = [
    // Read-only mount the standard system tree. /usr is the
    // important one — that's where /bin/sh, coreutils, etc. live.
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/sbin",
    "/sbin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    // Procfs + devtmpfs: needed by virtually every binary.
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // Tmpfs for /run and /var so the child can drop pidfiles.
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/var",
  ];

  for (const wr of writeRoots) {
    args.push("--bind", wr, wr);
  }

  if (!opts.allowNetwork) {
    args.push("--unshare-net");
  }

  // PID + user namespaces — cheap isolation that doesn't break
  // most build tools.
  args.push("--unshare-pid");
  args.push("--die-with-parent");
  args.push("--chdir", opts.cwd);
  args.push("/bin/sh", "-c", command);

  return spawnSync("bwrap", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    env: opts.env ?? process.env,
  });
}

/* ──────────────────────── Helpers ──────────────────────── */

function whichBinary(name: string): boolean {
  const which = spawnSync("which", [name], { encoding: "utf-8" });
  return which.status === 0 && which.stdout.trim().length > 0;
}

function dedupeAndResolve(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    // Canonicalize: on macOS `/var/folders/...` is actually
    // `/private/var/folders/...`; sandbox-exec matches on the
    // canonical path, so an allow rule written against the symlink
    // path silently denies. Same trap exists for `/tmp` →
    // `/private/tmp`. realpathSync resolves both. Fall back to the
    // resolved-but-uncanonicalized path if the directory does not
    // exist yet (callers may pass it before creation).
    let abs: string;
    try {
      abs = fs.realpathSync(path.resolve(p));
    } catch {
      abs = path.resolve(p);
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
