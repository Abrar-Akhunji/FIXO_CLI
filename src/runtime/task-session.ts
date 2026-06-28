import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { WorkspaceGuard } from "../workspace-guard.js";
import { redactSecrets } from "./redaction.js";
import type { PolicyProfile } from "./policy.js";

export interface TaskEvent {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface TaskSessionSummary {
  id: string;
  task: string;
  model: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "success" | "error";
  modifiedFiles: string[];
  verification: string[];
  response?: string;
}

export interface ChangeRecord {
  file: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeExists: boolean;
  afterExists: boolean;
  beforeSnapshot?: string;
}

export class TaskSession {
  readonly id: string;
  readonly cwd: string;
  readonly guard: WorkspaceGuard;
  readonly policy: PolicyProfile;
  readonly runDir: string;
  readonly startedAt: string;
  readonly readFiles = new Map<string, string | null>();
  readonly changedFiles = new Map<string, ChangeRecord>();
  /**
   * Tracks which files the agent has done a *structural* pre-scan on
   * (via `extract_symbols` / `extract_imports`). The map is read by
   * Pillar 3 (Context-Budget Guard) to verify that a large file the
   * LLM wants to read was first reduced to its declarations. The
   * `noteStructuralMap` and `hasStructuralMap` helpers below are
   * intentionally side-effect-free for tests.
   */
  readonly structuralMaps = new Map<
    string,
    { symbols: boolean; imports: boolean }
  >();
  private summary: TaskSessionSummary;

  constructor(opts: {
    cwd: string;
    task: string;
    model: string;
    policy?: PolicyProfile;
  }) {
    this.id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
    this.cwd = path.resolve(opts.cwd);
    this.guard = new WorkspaceGuard(this.cwd);
    this.policy = opts.policy ?? "shell-confirm";
    this.startedAt = new Date().toISOString();
    this.runDir = path.join(this.cwd, ".fixo", "runs", this.id);
    fs.mkdirSync(this.runDir, { recursive: true });
    fs.mkdirSync(path.join(this.runDir, "snapshots"), { recursive: true });
    this.summary = {
      id: this.id,
      task: opts.task,
      model: opts.model,
      cwd: this.cwd,
      startedAt: this.startedAt,
      status: "running",
      modifiedFiles: [],
      verification: [],
    };
    this.writeSummary();
    this.record("run_started", {
      task: opts.task,
      model: opts.model,
      policy: this.policy,
    });
    gcRuns(this.cwd, 50);
  }

  record(type: string, data: Record<string, unknown> = {}): void {
    const event = redactSecrets(
      JSON.stringify({ type, timestamp: new Date().toISOString(), ...data }),
    );
    fs.appendFileSync(
      path.join(this.runDir, "events.jsonl"),
      `${event}\n`,
      "utf-8",
    );
  }

  noteRead(file: string): void {
    const resolved = this.guard.resolve(file, "file");
    this.readFiles.set(resolved, hashFile(resolved));
    this.record("file_read", {
      file: this.guard.relative(resolved),
      hash: this.readFiles.get(resolved),
    });
  }

  /**
   * Mark a file as having been pre-scanned structurally. The
   * `flags` object records which dimensions were extracted so
   * Pillar 3 can decide whether the LLM is still missing
   * information when it later calls `read_file` on the same path.
   */
  noteStructuralMap(
    file: string,
    flags: { symbols: boolean; imports: boolean },
  ): void {
    const resolved = this.guard.resolve(file, "file");
    const existing = this.structuralMaps.get(resolved) ?? {
      symbols: false,
      imports: false,
    };
    this.structuralMaps.set(resolved, {
      symbols: existing.symbols || flags.symbols,
      imports: existing.imports || flags.imports,
    });
    this.record("structural_map", {
      file: this.guard.relative(resolved),
      ...flags,
    });
  }

  /**
   * Returns the structural pre-scan flags recorded for a file.
   * Returns `null` if the file has never been pre-scanned — the
   * caller should treat this as a hard-fail for the
   * Context-Budget Guard rule.
   */
  hasStructuralMap(
    file: string,
  ): { symbols: boolean; imports: boolean } | null {
    const resolved = this.guard.resolve(file, "file");
    return this.structuralMaps.get(resolved) ?? null;
  }

  captureBefore(file: string): void {
    const resolved = this.guard.resolve(file, "file");
    if (this.changedFiles.has(resolved)) return;
    const beforeHash = hashFile(resolved);
    const beforeExists = beforeHash !== null;
    let beforeSnapshot: string | undefined;
    if (beforeExists) {
      beforeSnapshot = path.join(
        "snapshots",
        `${crypto.randomBytes(6).toString("hex")}.before`,
      );
      fs.copyFileSync(resolved, path.join(this.runDir, beforeSnapshot));
    }
    const record: ChangeRecord = {
      file: this.guard.relative(resolved),
      beforeHash,
      afterHash: beforeHash,
      beforeExists,
      afterExists: beforeExists,
      beforeSnapshot,
    };
    this.changedFiles.set(resolved, record);
    this.writeChanges();
  }

  noteChange(file: string): void {
    const resolved = this.guard.resolve(file, "file");
    if (!this.changedFiles.has(resolved)) this.captureBefore(resolved);
    const existing = this.changedFiles.get(resolved)!;
    const after = hashFile(resolved);
    existing.afterHash = after;
    existing.afterExists = after !== null;
    this.changedFiles.set(resolved, existing);
    this.summary.modifiedFiles = Array.from(this.changedFiles.keys()).map((f) =>
      this.guard.relative(f),
    );
    this.writeChanges();
    this.writeSummary();
    this.record("file_changed", {
      file: this.guard.relative(resolved),
      before: existing.beforeHash,
      after,
    });
  }

  canMutate(file: string): { ok: boolean; reason?: string } {
    const resolved = this.guard.resolve(file, "file");
    if (!fs.existsSync(resolved)) return { ok: true };
    const readHash = this.readFiles.get(resolved);
    if (readHash === undefined) {
      return {
        ok: false,
        reason: `Refusing to modify unread file: ${this.guard.relative(resolved)}`,
      };
    }
    const currentHash = hashFile(resolved);
    if (readHash !== currentHash) {
      return {
        ok: false,
        reason: `Refusing stale edit; file changed since read: ${this.guard.relative(resolved)}`,
      };
    }
    return { ok: true };
  }

  /**
   * Phase 1b — escape valve for the loop-mitigation deadlock.
   *
   * When the loop-mitigation tracker (loop-mitigation.ts) has blocked
   * reads on a target, subsequent write/rename/delete attempts fail
   * because {@link canMutate} requires a prior read. This method
   * registers a fresh read hash for the file WITHOUT going through
   * the regular read tools — used by the agent loop when it has
   * decided to proceed with a mutation despite the loop block.
   *
   * Distinct from {@link noteRead} only in its audit-trail label so
   * the events.jsonl shows this was a recovery, not a normal read.
   */
  noteReadForMutation(file: string): void {
    const resolved = this.guard.resolve(file, "file");
    if (!fs.existsSync(resolved)) return;
    const hash = hashFile(resolved);
    if (hash !== null) this.readFiles.set(resolved, hash);
    this.record("file_read_forced", {
      file: this.guard.relative(resolved),
      hash,
      reason: "loop-mitigation-recovery",
    });
  }

  addVerification(message: string): void {
    this.summary.verification.push(redactSecrets(message));
    this.writeSummary();
    this.record("verification", { message });
  }

  finish(status: "success" | "error", response: string): void {
    this.summary.status = status;
    this.summary.endedAt = new Date().toISOString();
    this.summary.response = redactSecrets(response);
    this.writeSummary();
    this.record("run_finished", { status });
  }

  private writeSummary(): void {
    fs.writeFileSync(
      path.join(this.runDir, "run.json"),
      JSON.stringify(this.summary, null, 2) + "\n",
      "utf-8",
    );
  }

  private writeChanges(): void {
    fs.writeFileSync(
      path.join(this.runDir, "changes.json"),
      JSON.stringify(Array.from(this.changedFiles.values()), null, 2) + "\n",
      "utf-8",
    );
  }
}

export function hashFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile()) return null;
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

export function gcRuns(cwd: string, keepLimit = 50): void {
  try {
    const root = path.join(cwd, ".fixo", "runs");
    if (!fs.existsSync(root)) return;
    const runs = fs.readdirSync(root).sort().reverse();
    if (runs.length <= keepLimit) return;
    const toDelete = runs.slice(keepLimit);
    for (const run of toDelete) {
      fs.rmSync(path.join(root, run), { recursive: true, force: true });
    }
  } catch (err) {
    console.error(
      "[TaskSession] Warning: failed to garbage collect old runs",
      err,
    );
  }
}

export function listRuns(cwd: string, limit = 10): TaskSessionSummary[] {
  const root = path.join(cwd, ".fixo", "runs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => {
      const file = path.join(root, id, "run.json");
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf-8")) as TaskSessionSummary;
    })
    .filter((run): run is TaskSessionSummary => run !== null);
}

export function showRun(cwd: string, id: string): string {
  const file = path.join(cwd, ".fixo", "runs", id, "run.json");
  if (!fs.existsSync(file)) return `Run not found: ${id}`;
  const run = JSON.parse(fs.readFileSync(file, "utf-8")) as TaskSessionSummary;
  return [
    `Run ${run.id}`,
    `Status: ${run.status}`,
    `Task: ${run.task}`,
    `Model: ${run.model}`,
    `Started: ${run.startedAt}`,
    `Ended: ${run.endedAt ?? "running"}`,
    `Files: ${run.modifiedFiles.length ? run.modifiedFiles.join(", ") : "(none)"}`,
    `Verification: ${run.verification.length ? run.verification.join(" | ") : "(none)"}`,
  ].join("\n");
}

export function undoRun(cwd: string, id: string): string {
  const file = path.join(cwd, ".fixo", "runs", id, "run.json");
  if (!fs.existsSync(file)) return `Run not found: ${id}`;
  const runDir = path.dirname(file);
  const changesFile = path.join(runDir, "changes.json");
  if (!fs.existsSync(changesFile))
    return `Undo refused: run ${id} has no change ledger.`;
  const guard = new WorkspaceGuard(cwd);
  const changes = JSON.parse(
    fs.readFileSync(changesFile, "utf-8"),
  ) as ChangeRecord[];
  const conflicts: string[] = [];
  for (const change of changes) {
    const target = guard.resolve(change.file, "rollback file");
    const currentHash = hashFile(target);
    if (currentHash !== change.afterHash) {
      conflicts.push(
        `${change.file} changed after run (expected ${change.afterHash ?? "missing"}, got ${currentHash ?? "missing"})`,
      );
    }
  }
  if (conflicts.length > 0) {
    return `Undo refused because files changed after the run:\n${conflicts.join("\n")}`;
  }
  for (const change of changes.slice().reverse()) {
    const target = guard.resolve(change.file, "rollback file");
    if (change.beforeExists) {
      if (!change.beforeSnapshot)
        return `Undo failed: missing snapshot for ${change.file}`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(runDir, change.beforeSnapshot), target);
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
  return `Undid ${changes.length} file change(s) from run ${id}.`;
}

export function revertAgentCommit(cwd: string): string {
  try {
    const message = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    if (!message.includes("[fixo-run:")) {
      return "Undo refused: last commit is not marked as a FixO-owned commit.";
    }
    execFileSync("git", ["revert", "--no-edit", "HEAD"], {
      cwd,
      encoding: "utf-8",
    });
    return "Performed a safe git revert of the last FixO-owned commit.";
  } catch (error) {
    return `Undo failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
