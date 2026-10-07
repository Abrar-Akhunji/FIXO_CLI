import { spawn, type ChildProcess } from "node:child_process";
import { WorkspaceGuard } from "../../workspace-guard.js";
import type { TaskSession } from "../../runtime/task-session.js";
import { redactedEnv, redactSecrets } from "../../runtime/redaction.js";
import {
  runSandboxed,
  SandboxUnavailableError,
  resolveSandboxProfile,
  type SandboxProfileName,
} from "../../runtime/os-sandbox.js";
import { TruncationManager } from "../../runtime/truncation-manager.js";
import {
  waitForChildExit,
  getBackgroundJobRegistry,
  setBackgroundJobRegistry,
} from "../../runtime/background-jobs.js";
import type { ToolExecutionOptions } from "./types.js";

export { getBackgroundJobRegistry, setBackgroundJobRegistry };

export const FOREGROUND_COMMAND_MS = 60_000;

interface ActiveForegroundCommand {
  command: string;
  commandCwd: string;
  workspaceRoot: string;
  child: ChildProcess;
  getOutput: () => { stdout: string; stderr: string };
  triggerDetach: (jobId: string) => void;
}

let currentForegroundCommand: ActiveForegroundCommand | null = null;

export function detachCurrentForegroundCommand(): {
  ok: boolean;
  jobId?: string;
  command?: string;
  message?: string;
} {
  if (!currentForegroundCommand) {
    return { ok: false, message: "No active foreground command to background" };
  }
  const { command, commandCwd, workspaceRoot, child, getOutput, triggerDetach } =
    currentForegroundCommand;
  const { stdout, stderr } = getOutput();
  const attached = getBackgroundJobRegistry(workspaceRoot).attach({
    cmd: command,
    args: [],
    cwd: commandCwd,
    child,
    stdout,
    stderr,
  });
  triggerDetach(attached.jobId);
  currentForegroundCommand = null;
  return { ok: true, jobId: attached.jobId, command };
}

function truncate(text: string | undefined | null, maxLen: number): string {
  if (!text) return "";
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

export async function executeRunCommand(
  command: string,
  requestedCwd: string,
  workspaceRoot: string,
  session?: TaskSession,
  sandboxMode?: import("../../config.js").SandboxMode,
  waitMs: number = FOREGROUND_COMMAND_MS,
  background?: boolean,
): Promise<string> {
  const guard = new WorkspaceGuard(workspaceRoot);
  const commandCwd = guard.resolve(requestedCwd, "command cwd", false);
  try {
    let result;
    const isNamedProfile = ["strict", "devbox", "read-only"].includes(
      sandboxMode as string,
    );
    const isOsSandbox = sandboxMode === "os-sandbox" || isNamedProfile;
    if (isOsSandbox) {
      try {
        const profileName: SandboxProfileName = isNamedProfile
          ? (sandboxMode as SandboxProfileName)
          : "devbox";
        const sandboxOpts = resolveSandboxProfile(workspaceRoot, profileName, {
          cwd: commandCwd,
          env: redactedEnv(),
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
        result = runSandboxed(command, sandboxOpts);
      } catch (sandboxErr: unknown) {
        if (sandboxErr instanceof SandboxUnavailableError) {
          return `Error: OS sandbox mode is enabled but cannot be applied — ${sandboxErr.message}. Either install the platform binary or set preferences.safety.sandboxMode to 'guard'.`;
        }
        throw sandboxErr;
      }
    } else {
      const child = spawn(command, {
        shell: true,
        cwd: commandCwd,
        env: redactedEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      if (background) {
        const attached = getBackgroundJobRegistry(workspaceRoot).attach({
          cmd: command,
          args: [],
          cwd: commandCwd,
          child,
          stdout,
          stderr,
        });
        session?.record("command_finished", {
          command,
          cwd: guard.relative(commandCwd),
          status: "background",
          output: `Command started in background as ${attached.jobId}`,
        });
        return `Command started in background as ${attached.jobId}. Read its output with get_command_output or poll_command_status.`;
      }

      let detachResolver: ((jobId: string) => void) | null = null;
      const detachPromise = new Promise<string>((resolve) => {
        detachResolver = resolve;
      });

      currentForegroundCommand = {
        command,
        commandCwd,
        workspaceRoot,
        child,
        getOutput: () => ({ stdout, stderr }),
        triggerDetach: (jobId) => detachResolver?.(jobId),
      };

      try {
        const raceResult = await Promise.race([
          waitForChildExit(child, waitMs).then((outcome) => ({
            type: "exit" as const,
            outcome,
          })),
          detachPromise.then((jobId) => ({
            type: "detached" as const,
            jobId,
          })),
        ]);

        if (raceResult.type === "detached") {
          const output = redactSecrets(
            [stdout, stderr].filter(Boolean).join("\n"),
          );
          session?.record("command_finished", {
            command,
            cwd: guard.relative(commandCwd),
            status: "background",
            output: truncate(output, 4000),
          });
          return `Command moved to background as ${raceResult.jobId} via Ctrl+B. It is still running. Read it with get_command_output or poll_command_status.\n\n${output}`.trim();
        }

        const outcome = raceResult.outcome;
        const output = redactSecrets(
          [stdout, stderr].filter(Boolean).join("\n"),
        );
        if (outcome.error) {
          return `Command execution failed: ${outcome.error.message}\n\n${output}`.trim();
        }
        if (outcome.timedOut) {
          const attached = getBackgroundJobRegistry(workspaceRoot).attach({
            cmd: command,
            args: [],
            cwd: commandCwd,
            child,
            stdout,
            stderr,
          });
          session?.record("command_finished", {
            command,
            cwd: guard.relative(commandCwd),
            status: "background",
            output: truncate(output, 4000),
          });
          return `Command moved to background as ${attached.jobId}. It is still running. Read it with get_command_output or poll_command_status. Do not sleep-poll.\n\n${output}`.trim();
        }
        const status = outcome.code ?? (outcome.signal ? -1 : 0);
        session?.record("command_finished", {
          command,
          cwd: guard.relative(commandCwd),
          status,
          output: truncate(output, 4000),
        });
        const truncatedOutput = TruncationManager.format(output, {
          cwd: workspaceRoot,
          toolName: "run_command",
          maxLines: 150,
          maxBytes: 15_000,
        });
        return status === 0
          ? truncatedOutput.content || "(no output)"
          : `Exit code ${status}\n${truncatedOutput.content}`.trim();
      } finally {
        currentForegroundCommand = null;
      }
    }

    const output = redactSecrets(
      [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n"),
    );
    session?.record("command_finished", {
      command,
      cwd: guard.relative(commandCwd),
      status: result.status,
      output: truncate(output, 4000),
    });
    const truncatedOutput = TruncationManager.format(output, {
      cwd: workspaceRoot,
      toolName: "run_command",
      maxLines: 150,
      maxBytes: 15_000,
    });
    return result.status === 0
      ? truncatedOutput.content || "(no output)"
      : `Exit code ${result.status}\n${truncatedOutput.content}`.trim();
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Command execution failed: ${err.message ?? String(error)}`;
  }
}

export interface RunCommandAsyncArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
}

export interface PollCommandStatusArgs {
  jobId: string;
  tailLines?: number;
  sinceBytes?: number;
}

export interface KillCommandArgs {
  jobId: string;
}

export class BackgroundCommandError extends Error {
  public readonly code:
    "plan_mode_rejected" | "invalid_args" | "spawn_failed" | "no_such_job";
  constructor(message: string, code: BackgroundCommandError["code"]) {
    super(message);
    this.name = "BackgroundCommandError";
    this.code = code;
  }
}

export async function executeRunCommandAsync(
  args: RunCommandAsyncArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (options.mode === "PLAN") {
    return `Error: run_command_async: rejected in PLAN mode.`;
  }
  if (typeof args.cmd !== "string" || args.cmd.trim().length === 0) {
    throw new BackgroundCommandError(
      'run_command_async: "cmd" is required',
      "invalid_args",
    );
  }
  const cmdArgs = Array.isArray(args.args)
    ? args.args.filter((a) => typeof a === "string")
    : [];
  const reg = getBackgroundJobRegistry(cwd);
  const result = await reg.register({
    cmd: args.cmd,
    args: cmdArgs,
    cwd: args.cwd ?? cwd,
  });
  if (!result.ok) {
    throw new BackgroundCommandError(
      `run_command_async: ${result.error ?? "unknown"}`,
      "spawn_failed",
    );
  }
  return JSON.stringify({
    ok: true,
    jobId: result.jobId,
    pid: result.pid,
    note: "poll_command_status to retrieve output; kill_command to terminate",
  });
}

export function executePollCommandStatus(
  args: PollCommandStatusArgs,
  cwd: string,
): string {
  if (typeof args.jobId !== "string" || args.jobId.length === 0) {
    throw new BackgroundCommandError(
      'poll_command_status: "jobId" is required',
      "invalid_args",
    );
  }
  const reg = getBackgroundJobRegistry(cwd);
  const snap = reg.poll({
    jobId: args.jobId,
    tailLines: args.tailLines,
    sinceBytes: args.sinceBytes,
  });
  if (!snap) {
    throw new BackgroundCommandError(
      `poll_command_status: no such job "${args.jobId}"`,
      "no_such_job",
    );
  }
  return JSON.stringify(snap, null, 2);
}

export function executeKillCommand(args: KillCommandArgs, cwd: string): string {
  if (typeof args.jobId !== "string" || args.jobId.length === 0) {
    throw new BackgroundCommandError(
      'kill_command: "jobId" is required',
      "invalid_args",
    );
  }
  const reg = getBackgroundJobRegistry(cwd);
  const out = reg.kill(args.jobId);
  if (!out.ok) {
    throw new BackgroundCommandError(
      `kill_command: ${out.error ?? "unknown"}`,
      "no_such_job",
    );
  }
  return JSON.stringify({ ok: true, jobId: args.jobId });
}

export async function executeGetCommandOutput(
  args: { task_ids?: string | string[]; jobId?: string | string[]; timeout_ms?: number | string },
  cwd: string,
): Promise<string> {
  const rawIds = args.task_ids ?? args.jobId;
  const taskIds: string[] = Array.isArray(rawIds)
    ? rawIds.map(String)
    : typeof rawIds === "string"
      ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const timeoutMs =
    typeof args.timeout_ms === "number"
      ? args.timeout_ms
      : typeof args.timeout_ms === "string"
        ? parseInt(args.timeout_ms, 10)
        : undefined;
  const reg = getBackgroundJobRegistry(cwd);
  const snapshots = await reg.waitForJobs(taskIds, timeoutMs);
  if (snapshots.length === 0) {
    return `No background jobs found matching: ${taskIds.join(", ")}`;
  }
  return snapshots
    .map((s) => {
      const out = [s.stdout, s.stderr].filter(Boolean).join("\n").trim();
      const exitInfo = s.exitCode !== undefined ? ` (exit code ${s.exitCode})` : "";
      return `--- Job ${s.id}: ${s.cmd} [${s.status}${exitInfo}] ---\n${out || "(no output yet)"}`;
    })
    .join("\n\n");
}
