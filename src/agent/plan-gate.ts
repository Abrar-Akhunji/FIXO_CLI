/**
 * PLAN mode write gate.
 *
 * The model may update `.fixo/last-plan.json` and may run commands
 * that do not write. Every other mutation fails with the same
 * message, including when `--yes` is set. Shell writes are checked
 * here because a prompt-only "please don't write" rule is not a gate.
 */
import path from "node:path";
import {
  extractWriteTargets,
  isCommandSafe,
  parseShellCommand,
} from "./command-parser.js";

export const PLAN_FILE_RELATIVE = path.join(".fixo", "last-plan.json");

const MUTATING_BINS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "dd",
  "ln",
  "rmdir",
  "tee",
  "truncate",
]);

const GIT_MUTATING = new Set([
  "add",
  "commit",
  "push",
  "reset",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "clean",
  "stash",
  "am",
  "cherry-pick",
  "revert",
  "tag",
  "init",
  "rm",
  "mv",
]);

const PACKAGE_MUTATING = new Set([
  "install",
  "i",
  "add",
  "remove",
  "publish",
  "unlink",
  "link",
  "update",
  "ci",
]);

export function planModeError(tool: string): string {
  return `Error: ${tool} is blocked in PLAN mode. The only writable path is ${PLAN_FILE_RELATIVE}. Switch to BUILD after the plan is approved.`;
}

export function isPlanFilePath(cwd: string, target: string): boolean {
  const resolved = path.resolve(cwd, target);
  const plan = path.resolve(cwd, PLAN_FILE_RELATIVE);
  return resolved === plan;
}

function basenameOf(binary: string): string {
  const cleaned = binary.trim().replace(/^['"]|['"]$/g, "");
  return path.basename(cleaned).toLowerCase();
}

function firstPositional(args: string[]): string {
  const found = args.find((arg) => arg.length > 0 && !arg.startsWith("-"));
  return (found ?? "").toLowerCase();
}

export async function planModeCommandBlock(
  command: string,
  cwd: string,
): Promise<string | null> {
  const safety = await isCommandSafe(command, cwd);
  if (!safety.safe) {
    return `Error: ${safety.reason ?? "command blocked"}`;
  }
  if (extractWriteTargets(command).length > 0) {
    return planModeError("run_command");
  }

  const parsed = await parseShellCommand(command);
  const commands =
    parsed.length > 0
      ? parsed.map((cmd) => ({
          bin: basenameOf(cmd.binary),
          args: cmd.arguments,
        }))
      : [
          {
            bin: basenameOf(command.trim().split(/\s+/)[0] ?? ""),
            args: command.trim().split(/\s+/).slice(1),
          },
        ];

  for (const cmd of commands) {
    if (!cmd.bin) continue;
    if (MUTATING_BINS.has(cmd.bin)) return planModeError("run_command");
    if (cmd.bin === "git" && GIT_MUTATING.has(firstPositional(cmd.args))) {
      return planModeError("run_command");
    }
    if (
      (cmd.bin === "npm" ||
        cmd.bin === "pnpm" ||
        cmd.bin === "yarn" ||
        cmd.bin === "bun") &&
      PACKAGE_MUTATING.has(firstPositional(cmd.args))
    ) {
      return planModeError("run_command");
    }
  }
  return null;
}

/**
 * Returns an error string when `name` must not run in PLAN mode.
 * Returns null when the call is allowed.
 */
export async function planModeBlock(
  name: string,
  args: Record<string, string>,
  cwd: string,
): Promise<string | null> {
  if (name === "write_file" || name === "str_replace") {
    const target = args.path;
    if (typeof target === "string" && isPlanFilePath(cwd, target)) return null;
    return planModeError(name);
  }
  if (name === "run_command") {
    return planModeCommandBlock(args.command ?? "", cwd);
  }
  if (
    name === "apply_patch" ||
    name === "replace_range" ||
    name === "insert_after" ||
    name === "rename_file" ||
    name === "delete_file" ||
    name === "create_branch" ||
    name === "commit_changes" ||
    name === "push_branch" ||
    name === "create_pull_request" ||
    name === "todo_write" ||
    name === "run_command_async" ||
    name === "spawn_subagent"
  ) {
    return planModeError(name);
  }
  return null;
}
