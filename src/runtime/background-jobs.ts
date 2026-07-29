/**
 * background-jobs.ts — Async command execution registry.
 *
 * Phase 3.1: lets the agent spawn long-running commands
 * (`run_command_async`) and poll their status without blocking
 * the REPL or the agent loop. Every job is keyed by a
 * `job_<short-uuid>` and stored in an in-memory `Map` so a
 * crashed CLI invocation can rebuild the tail buffers from the
 * on-disk JSON snapshot.
 *
 * Safety:
 *   - `spawn` reuses `isCommandSafe` from `command-parser.ts` so
 *     a workspace-escape or sensitive-file read is rejected
 *     before any process is started.
 *   - The `cwd` argument is resolved through `WorkspaceGuard`
 *     so the spawned process cannot chdir outside the workspace.
 *   - The 64 KiB per-stream cap matches the staging-manager
 *     contract — no unbounded buffer growth.
 *   - A 1-hour reaper (`setInterval` in `startReaper`) kills any
 *     job whose `pid` is no longer alive, even if the executor
 *     never received an `exit` event.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isCommandSafe } from "../agent/command-parser.js";
import { WorkspaceGuard } from "../workspace-guard.js";
import { getWorkspaceStateDir } from "../config.js";
import { recordTelemetry, telemetry } from "../agent/telemetry.js";

/* ──────────────────────── Constants ──────────────────────── */

const STREAM_CAP_BYTES = 64 * 1024;
const SNAPSHOT_FLUSH_MS = 5_000;
const REAPER_INTERVAL_MS = 60_000;
const REAPER_MAX_AGE_MS = 60 * 60 * 1_000; // 1 hour

/* ──────────────────────── Types ──────────────────────── */

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface BackgroundJob {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  pid?: number;
  status: JobStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  /** Truncated to STREAM_CAP_BYTES; use totalStdoutBytes for the full count. */
  stdout: string;
  /** Truncated to STREAM_CAP_BYTES. */
  stderr: string;
  /** Total bytes seen on stdout (pre-truncation). */
  totalStdoutBytes: number;
  /** Total bytes seen on stderr (pre-truncation). */
  totalStderrBytes: number;
  /** When true, stdout/stderr reached STREAM_CAP_BYTES. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Why a `failed` job failed (e.g. command-parser rejection). */
  failureReason?: string;
  /** Last error message captured from the child process. */
  lastError?: string;
}

export interface RegisterInput {
  cmd: string;
  args: string[];
  cwd: string;
}

export interface RegisterResult {
  ok: boolean;
  jobId?: string;
  pid?: number;
  error?: string;
}

export interface PollInput {
  jobId: string;
  tailLines?: number;
  sinceBytes?: number;
}

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  exitCode?: number;
  startedAt: string;
  exitedAt?: string;
  cmd: string;
  args: string[];
  cwd: string;
  /** Truncated to last `tailLines` lines if supplied. */
  stdout: string;
  stderr: string;
  /** The full pre-truncation byte counter — useful for `sinceBytes`. */
  totalStdoutBytes: number;
  totalStderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutDelta?: string;
  stderrDelta?: string;
}

export interface BackgroundJobRegistryOptions {
  /** Override the snapshot directory (default: `<cwd>/.fixo/jobs`). */
  snapshotDir?: string;
  /** Disable the 1-hour reaper. Test-only. */
  disableReaper?: boolean;
}

/* ──────────────────────── Helpers ──────────────────────── */

function appendCapped(
  buffer: { text: string; truncated: boolean; bytes: number },
  chunk: string,
): void {
  const next = buffer.text + chunk;
  const bytes = Buffer.byteLength(next, "utf-8");
  if (bytes > STREAM_CAP_BYTES) {
    // Slice from the END so the user always sees the most recent
    // output, not the oldest. The `totalStdoutBytes` counter
    // preserves the original length so `sinceBytes` can still
    // compute deltas.
    const overflow = bytes - STREAM_CAP_BYTES;
    let startIdx = 0;
    let acc = 0;
    // Walk forward until the cumulative byte count equals the
    // overflow, then slice from there. This is a character-safe
    // approach that avoids splitting a multi-byte UTF-8 char.
    for (let i = 0; i < next.length; i++) {
      acc += Buffer.byteLength(next[i]!, "utf-8");
      if (acc > overflow) {
        startIdx = i;
        break;
      }
    }
    buffer.text = next.slice(startIdx);
    buffer.truncated = true;
  } else {
    buffer.text = next;
  }
  buffer.bytes += Buffer.byteLength(chunk, "utf-8");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ──────────────────────── Registry ──────────────────────── */

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly cwd: string;
  private readonly snapshotDir: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string, opts: BackgroundJobRegistryOptions = {}) {
    this.cwd = cwd;
    this.snapshotDir =
      opts.snapshotDir ?? path.join(getWorkspaceStateDir(cwd), "jobs");
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    this.startSnapshotFlusher();
    if (!opts.disableReaper) this.startReaper();
  }

  /** Spawn a new background command. Reuses `isCommandSafe` for AST validation. */
  async register(input: RegisterInput): Promise<RegisterResult> {
    if (input.cmd.trim().length === 0) {
      return { ok: false, error: "cmd is empty" };
    }
    // Resolve the requested cwd through the workspace guard so the
    // child process cannot chdir outside the workspace root.
    const guard = new WorkspaceGuard(this.cwd);
    let resolvedCwd: string;
    try {
      resolvedCwd = guard.resolve(input.cwd, "background-job cwd", true);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const safety = await isCommandSafe(
      `${input.cmd} ${input.args.join(" ")}`.trim(),
      this.cwd,
    );
    if (!safety.safe) {
      return {
        ok: false,
        error: `command rejected by command-parser: ${safety.reason ?? "unsafe"}`,
      };
    }
    const id = `job_${randomUUID().slice(0, 8)}`;
    const job: BackgroundJob = {
      id,
      cmd: input.cmd,
      args: [...input.args],
      cwd: resolvedCwd,
      status: "running",
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      totalStdoutBytes: 0,
      totalStderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    let child: ChildProcess;
    try {
      child = spawn(input.cmd, input.args, {
        cwd: resolvedCwd,
        env: { ...process.env, FIXO_BACKGROUND_JOB: id },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      job.status = "failed";
      job.failureReason = "spawn threw";
      job.lastError = (err as Error).message;
      job.exitedAt = new Date().toISOString();
      this.jobs.set(id, job);
      return { ok: false, jobId: id, error: job.lastError };
    }
    job.pid = child.pid;
    this.jobs.set(id, job);
    this.processes.set(id, child);
    const stdoutBuf = { text: job.stdout, truncated: false, bytes: 0 };
    const stderrBuf = { text: job.stderr, truncated: false, bytes: 0 };
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      appendCapped(stdoutBuf, chunk);
      job.stdout = stdoutBuf.text;
      job.stdoutTruncated = stdoutBuf.truncated;
      job.totalStdoutBytes = stdoutBuf.bytes;
    });
    child.stderr?.on("data", (chunk: string) => {
      appendCapped(stderrBuf, chunk);
      job.stderr = stderrBuf.text;
      job.stderrTruncated = stderrBuf.truncated;
      job.totalStderrBytes = stderrBuf.bytes;
    });
    child.on("error", (err) => {
      job.lastError = err.message;
      // Spawn failures do not emit an `exit` event — flip the
      // status to `failed` here so pollers can detect the
      // terminal state without waiting forever.
      if (job.status === "running") {
        job.status = "failed";
        job.failureReason = err.message;
        job.exitedAt = new Date().toISOString();
        this.processes.delete(id);
      }
    });
    child.on("exit", (code, signal) => {
      job.exitedAt = new Date().toISOString();
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        job.status = "killed";
      } else if (code === 0) {
        job.status = "exited";
      } else {
        job.status = "failed";
        job.failureReason = job.lastError ?? `exit code ${String(code)}`;
      }
      job.exitCode = code ?? undefined;
      this.processes.delete(id);
      recordTelemetry(
        telemetry.asyncSpawn({
          jobId: id,
          cmd: input.cmd,
          pid: job.pid,
        }),
      );
    });
    recordTelemetry(
      telemetry.asyncSpawn({ jobId: id, cmd: input.cmd, pid: job.pid }),
    );
    return { ok: true, jobId: id, pid: job.pid };
  }

  /** Read a snapshot. Honours `tailLines` and `sinceBytes` for the streams. */
  poll(input: PollInput): JobSnapshot | null {
    const job = this.jobs.get(input.jobId);
    if (!job) return null;
    const tailLines = input.tailLines;
    const sinceBytes = input.sinceBytes ?? 0;
    const sliceTail = (text: string): string => {
      if (tailLines === undefined) return text;
      if (tailLines <= 0) return "";
      // Trim the trailing empty that comes from a terminal newline
      // so "tail 2" returns the last 2 *content* lines, not
      // "<last content>\n".
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
    };
    return {
      id: job.id,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      exitedAt: job.exitedAt,
      cmd: job.cmd,
      args: job.args,
      cwd: job.cwd,
      stdout: sliceTail(job.stdout),
      stderr: sliceTail(job.stderr),
      totalStdoutBytes: job.totalStdoutBytes,
      totalStderrBytes: job.totalStderrBytes,
      stdoutTruncated: job.stdoutTruncated,
      stderrTruncated: job.stderrTruncated,
      stdoutDelta:
        sinceBytes > 0 ? sliceTail(job.stdout.slice(sinceBytes)) : undefined,
      stderrDelta:
        sinceBytes > 0 ? sliceTail(job.stderr.slice(sinceBytes)) : undefined,
    };
  }

  /** Kill a running job. Returns false if the job was already terminal. */
  kill(jobId: string): { ok: boolean; error?: string } {
    const child = this.processes.get(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: "no such job" };
    if (!child)
      return { ok: false, error: `job is ${job.status}; nothing to kill` };
    try {
      child.kill("SIGTERM");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** List all jobs (newest first). */
  list(): BackgroundJob[] {
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }

  /** Read a job directly (no tail / sinceBytes shaping). */
  get(jobId: string): BackgroundJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** Stop timers and kill all running children. Called on CLI shutdown. */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    for (const child of this.processes.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    this.processes.clear();
  }

  /* ──────── internals ──────── */

  private startSnapshotFlusher(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushAllSnapshots();
    }, SNAPSHOT_FLUSH_MS);
    // The flusher is a per-process helper; if the event loop exits
    // (process exit), Node tears it down automatically. We still
    // call `.unref()` so a stuck flusher never holds the loop open.
    this.flushTimer.unref?.();
  }

  private flushAllSnapshots(): void {
    for (const job of this.jobs.values()) {
      const file = path.join(this.snapshotDir, `${job.id}.json`);
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(job, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        fs.renameSync(tmp, file);
      } catch {
        // best-effort
      }
    }
  }

  private startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, child] of this.processes.entries()) {
        const job = this.jobs.get(id);
        if (!job) continue;
        const ageMs = now - new Date(job.startedAt).getTime();
        const pidDead = job.pid !== undefined && !isPidAlive(job.pid);
        if (ageMs > REAPER_MAX_AGE_MS || pidDead) {
          try {
            child.kill("SIGKILL");
          } catch {
            // best-effort
          }
          job.status = pidDead ? "failed" : "killed";
          job.failureReason = pidDead
            ? "pid no longer alive"
            : "exceeded 1-hour reaper window";
          job.exitedAt = new Date().toISOString();
          this.processes.delete(id);
        }
      }
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }
}
