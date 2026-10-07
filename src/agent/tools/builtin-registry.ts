/**
 * Every built-in tool registers here. executeTool looks the name up
 * and does not keep its own switch.
 */
import path from "node:path";
import * as p from "@clack/prompts";
import { colors } from "../../ui/colors.js";
import { WorkspaceGuard } from "../../workspace-guard.js";
import {
  estimateReadCost,
  shouldDeferRead,
  formatPredictiveGateDirective,
  DEFAULT_PREDICTIVE_BUDGET_PCT,
} from "../predictive-gate.js";
import { registerTool } from "./registry.js";
import type { ToolDispatchResult, ToolExecutionContext } from "./types.js";
import {
  executeReadFile,
  executeExtractSymbols,
  executeExtractImports,
  executeWriteFile,
  executeDeleteFile,
  executeApplyPatch,
  executeReplaceRange,
  executeInsertAfter,
  executeRenameFile,
  executeSearchCode,
  executeListDir,
  executeStrReplace,
  executeGlobFiles,
  type StrReplaceArgs,
  type GlobArgs,
} from "./fs-tools.js";
import {
  FOREGROUND_COMMAND_MS,
  executeRunCommand,
  executeRunCommandAsync,
  executePollCommandStatus,
  executeKillCommand,
  executeGetCommandOutput,
  type RunCommandAsyncArgs,
  type PollCommandStatusArgs,
  type KillCommandArgs,
} from "./command-tools.js";
import {
  executeCreateBranch,
  executeCommitChanges,
  executePushBranch,
  executeCreatePullRequest,
} from "./git-tools.js";
import {
  executeLspGotoDefinition,
  executeLspFindReferences,
  executeLspHover,
} from "./lsp-tools.js";
import { executeWebFetch, executeWebSearch } from "./web-tools.js";
import {
  executeTodoRead,
  executeTodoWrite,
  executeEnterPlanMode,
  executeExitPlanMode,
  type TodoWriteArgs,
} from "./plan-tools.js";

const schema = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
};

function define(
  name: string,
  execute: (
    args: Record<string, string>,
    ctx: ToolExecutionContext,
  ) => Promise<string | ToolDispatchResult>,
): void {
  registerTool({
    name,
    description: name,
    parameters: schema,
    execute,
  });
}

function spin(
  ctx: ToolExecutionContext,
  kind: string,
  name: string,
  detail: string,
): void {
  ctx.spinner?.({ kind, name, detail });
}

function shortenPath(filePath: string, cwd: string): string {
  try {
    const guard = new WorkspaceGuard(cwd);
    return guard.relative(guard.resolve(filePath, "path", false));
  } catch {
    return filePath;
  }
}

function clip(text: string | undefined | null, maxLen: number): string {
  if (!text) return "";
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function targetFile(
  cwd: string,
  ctx: ToolExecutionContext,
  file: string,
): string {
  return new WorkspaceGuard(cwd, ctx.options.allowedOutsidePaths).resolve(
    file,
    "file",
  );
}

function wrote(result: string, affectedPath?: string): ToolDispatchResult {
  return { result, isWrite: true, affectedPath };
}

async function askUnsafeCommandPermission(
  command: string,
  reason: string,
  allowWithoutPrompt?: boolean,
): Promise<boolean> {
  if (allowWithoutPrompt) {
    console.log(
      `\n${colors.yellow}⚠ Security Warning: Executing potentially unsafe command: ${colors.bold}${command}${colors.reset}\nReason: ${reason}`,
    );
    return true;
  }
  console.log(
    `\n${colors.red}${colors.bold}⚠ SECURITY WARNING:${colors.reset}`,
  );
  console.log(
    `The agent is attempting to execute a command that violates safety sandboxing:`,
  );
  console.log(`- Command: ${colors.yellow}${command}${colors.reset}`);
  console.log(`- Danger: ${colors.red}${reason}${colors.reset}\n`);
  const confirmed = await p.confirm({
    message: `Do you want to bypass this warning and allow execution?`,
    initialValue: false,
  });
  return !p.isCancel(confirmed) && confirmed;
}

function stringListArg(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [];
    }
  }
  return [];
}

function flagArg(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return false;
}

define("read_file", async (args, ctx) => {
  if (ctx.options.signal?.aborted) {
    return { result: "Error: Task cancelled by user." };
  }
  const resolved = targetFile(ctx.cwd, ctx, args.path);
  spin(ctx, "read", "Read", shortenPath(args.path, ctx.cwd));
  const budgetPct =
    ctx.options.safety?.predictiveBudgetPct ?? DEFAULT_PREDICTIVE_BUDGET_PCT;
  if (budgetPct < 1 && ctx.options.model) {
    const estimate = estimateReadCost(resolved, ctx.options.model);
    const convoTokens = ctx.options.getConversationTokens?.() ?? 0;
    const deferDecision = shouldDeferRead(
      estimate,
      convoTokens,
      ctx.options.model,
      budgetPct,
    );
    if (deferDecision.defer) {
      spin(
        ctx,
        "read",
        "Read",
        `${shortenPath(args.path, ctx.cwd)} (deferred — predictive gate)`,
      );
      ctx.options.session?.record("predictive_gate_fired", {
        path: args.path,
        projectedTokens: estimate.projectedTokens,
        projectedTotal: deferDecision.projectedTotal,
        hardCap: deferDecision.hardCap,
      });
      return {
        result: formatPredictiveGateDirective(args.path, estimate, deferDecision),
        affectedPath: resolved,
      };
    }
  }
  return {
    result: executeReadFile(
      args.path,
      ctx.cwd,
      ctx.options.session,
      ctx.options.safety?.largeFileGateBytes,
      ctx.options.safety?.largeFileGateLines,
    ),
    affectedPath: resolved,
  };
});

define("extract_symbols", async (args, ctx) => {
  spin(ctx, "read", "Symbols", shortenPath(args.path, ctx.cwd));
  return {
    result: await executeExtractSymbols(args.path, ctx.cwd, ctx.options.session),
    affectedPath: targetFile(ctx.cwd, ctx, args.path),
  };
});

define("extract_imports", async (args, ctx) => {
  spin(ctx, "read", "Imports", shortenPath(args.path, ctx.cwd));
  return {
    result: await executeExtractImports(args.path, ctx.cwd, ctx.options.session),
    affectedPath: targetFile(ctx.cwd, ctx, args.path),
  };
});

define("write_file", async (args, ctx) => {
  spin(ctx, "write", "Write", shortenPath(args.path, ctx.cwd));
  return wrote(
    await executeWriteFile(args.path, args.content, ctx.cwd, ctx.options),
    targetFile(ctx.cwd, ctx, args.path),
  );
});

define("run_command", async (args, ctx) => {
  spin(ctx, "bash", "Run", clip(args.command, 60));
  let safetyResult = { safe: true, reason: "" };
  try {
    const { isCommandSafe } = await import("../command-parser.js");
    const safety = await isCommandSafe(args.command, ctx.cwd);
    if (!safety.safe) {
      safetyResult = {
        safe: false,
        reason: safety.reason || "Unsafe command detected",
      };
    }
  } catch (err: any) {
    if (ctx.verbose) {
      console.error(
        "Failed to run AST command safety check, failing closed for security:",
        err.message,
      );
    }
    safetyResult = {
      safe: false,
      reason: `Error: AST command safety check failed and regex fallback is disabled for security reasons: ${err.message}`,
    };
  }
  if (!safetyResult.safe) {
    const allowed = await askUnsafeCommandPermission(
      args.command,
      safetyResult.reason,
      ctx.options.allowWithoutPrompt,
    );
    if (!allowed) {
      return {
        result: `Error: Security block - Execution denied for unsafe command: ${safetyResult.reason}`,
      };
    }
  }
  const isBg = args.background === "true" || (args as { background?: boolean }).background === true;
  return {
    result: await executeRunCommand(
      args.command,
      args.cwd || ctx.cwd,
      ctx.cwd,
      ctx.options.session,
      ctx.options.safety?.sandboxMode,
      FOREGROUND_COMMAND_MS,
      isBg,
    ),
  };
});

define("search_code", async (args, ctx) => {
  try {
    const query = args.query;
    if (query === undefined || query === null) {
      return { result: "No matches found for the given query." };
    }
    const queryStr = String(query);
    spin(ctx, "search", "Search", `"${clip(queryStr, 40)}" in ${args.path ?? "."}`);
    return {
      result: executeSearchCode(queryStr, args.path, args.file_pattern, ctx.cwd),
    };
  } catch (err: any) {
    return {
      result: `search_code error: ${err.message || String(err)}. Try a different query or use List/Read instead.`,
    };
  }
});

define("list_dir", async (args, ctx) => {
  spin(ctx, "read", "List", args.path ?? ".");
  return { result: executeListDir(args.path, ctx.cwd) };
});

define("delete_file", async (args, ctx) => {
  spin(ctx, "write", "Delete", shortenPath(args.path, ctx.cwd));
  return wrote(
    executeDeleteFile(args.path, ctx.cwd, ctx.options.session),
    targetFile(ctx.cwd, ctx, args.path),
  );
});

define("apply_patch", async (args, ctx) => {
  spin(ctx, "write", "Patch", "unified diff");
  return wrote(await executeApplyPatch(args.patch, ctx.cwd, ctx.options));
});

define("replace_range", async (args, ctx) => {
  spin(ctx, "write", "Replace", shortenPath(args.path, ctx.cwd));
  return wrote(
    await executeReplaceRange(
      args.path,
      Number(args.startLine),
      Number(args.endLine),
      args.content,
      ctx.cwd,
      ctx.options,
    ),
    targetFile(ctx.cwd, ctx, args.path),
  );
});

define("insert_after", async (args, ctx) => {
  spin(ctx, "write", "Insert", shortenPath(args.path, ctx.cwd));
  return wrote(
    await executeInsertAfter(args.path, args.anchor, args.content, ctx.cwd, ctx.options),
    targetFile(ctx.cwd, ctx, args.path),
  );
});

define("rename_file", async (args, ctx) => {
  spin(ctx, "write", "Rename", `${args.from} -> ${args.to}`);
  return wrote(
    await executeRenameFile(args.from, args.to, ctx.cwd, ctx.options),
    targetFile(ctx.cwd, ctx, args.to),
  );
});

define("create_branch", async (args, ctx) => {
  spin(ctx, "write", "Branch", args.branchName);
  return wrote(await executeCreateBranch(args as { branchName: string }, ctx.cwd));
});

define("commit_changes", async (args, ctx) => {
  spin(ctx, "write", "Commit", clip(args.message, 60));
  return wrote(await executeCommitChanges(args as { message: string }, ctx.cwd));
});

define("push_branch", async (args, ctx) => {
  spin(ctx, "write", "Push", args.remote || "origin");
  return wrote(await executePushBranch(args, ctx.cwd));
});

define("create_pull_request", async (args, ctx) => {
  spin(ctx, "write", "PR", `base: ${args.baseBranch || "main"}`);
  return wrote(
    await executeCreatePullRequest(args, ctx.cwd, ctx.options),
  );
});

define("lsp_goto_definition", async (args, ctx) => {
  const line = Number(args.line);
  const char = Number(args.character);
  spin(ctx, "read", "Definition", `${path.basename(args.path)}:${line}:${char}`);
  return { result: await executeLspGotoDefinition(args as never, ctx.cwd, ctx.options) };
});

define("lsp_find_references", async (args, ctx) => {
  const line = Number(args.line);
  const char = Number(args.character);
  spin(ctx, "read", "References", `${path.basename(args.path)}:${line}:${char}`);
  return { result: await executeLspFindReferences(args as never, ctx.cwd, ctx.options) };
});

define("lsp_hover", async (args, ctx) => {
  const line = Number(args.line);
  const char = Number(args.character);
  spin(ctx, "read", "Hover", `${path.basename(args.path)}:${line}:${char}`);
  return { result: await executeLspHover(args as never, ctx.cwd, ctx.options) };
});

define("web_fetch", async (args, ctx) => {
  spin(ctx, "search", "Fetch", args.url);
  return { result: await executeWebFetch(args as { url: string }) };
});

define("web_search", async (args, ctx) => {
  spin(ctx, "search", "Search", clip(args.query, 40));
  return { result: await executeWebSearch(args as { query: string }) };
});

define("str_replace", async (args, ctx) => {
  spin(ctx, "write", "Surgical", shortenPath(args.path, ctx.cwd));
  return wrote(
    await executeStrReplace(args as unknown as StrReplaceArgs, ctx.cwd, ctx.options),
    targetFile(ctx.cwd, ctx, args.path),
  );
});

define("glob_files", async (args, ctx) => {
  spin(ctx, "search", "Glob", clip(args.pattern, 60));
  return {
    result: await executeGlobFiles(args as unknown as GlobArgs, ctx.cwd, ctx.options),
  };
});

define("todo_read", async (_args, ctx) => {
  spin(ctx, "search", "Todo", "read");
  return { result: executeTodoRead(ctx.cwd) };
});

define("todo_write", async (args, ctx) => {
  spin(ctx, "write", "Todo", String((args as { op?: string }).op ?? "add"));
  return wrote(
    await executeTodoWrite(args as unknown as TodoWriteArgs, ctx.cwd, ctx.options),
  );
});

define("run_command_async", async (args, ctx) => {
  spin(ctx, "bash", "Async", clip(args.cmd, 30));
  return {
    result: await executeRunCommandAsync(
      args as unknown as RunCommandAsyncArgs,
      ctx.cwd,
      ctx.options,
    ),
  };
});

define("poll_command_status", async (args, ctx) => {
  spin(ctx, "bash", "Poll", String((args as { jobId?: string }).jobId ?? "?"));
  return {
    result: executePollCommandStatus(
      args as unknown as PollCommandStatusArgs,
      ctx.cwd,
    ),
  };
});

define("get_command_output", async (args, ctx) => {
  const rawIds = (args as { task_ids?: unknown; jobId?: unknown }).task_ids ??
    (args as { jobId?: unknown }).jobId;
  const taskIds: string[] = Array.isArray(rawIds)
    ? rawIds.map(String)
    : typeof rawIds === "string"
      ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  spin(ctx, "bash", "BgOutput", taskIds.slice(0, 3).join(", ") || "?");
  return { result: await executeGetCommandOutput(args as never, ctx.cwd) };
});

define("kill_command", async (args, ctx) => {
  spin(ctx, "bash", "Kill", String((args as { jobId?: string }).jobId ?? "?"));
  return {
    result: executeKillCommand(args as unknown as KillCommandArgs, ctx.cwd),
  };
});

define("spawn_subagent", async (args, ctx) => {
  spin(ctx, "search", "Subagent", clip(args.task, 40));
  const { spawnSubagent } = await import("../subagent.js");
  const allowedTypes = [
    "general-purpose",
    "statusline-setup",
    "Explore",
    "Plan",
  ] as const;
  const requestedType = String(args.type ?? "");
  const type = allowedTypes.includes(requestedType as (typeof allowedTypes)[number])
    ? (requestedType as (typeof allowedTypes)[number])
    : "general-purpose";
  const res = await spawnSubagent(
    {
      task: args.task || "",
      type,
      contextFiles: stringListArg(args.contextFiles),
      runInBackground: flagArg(args.runInBackground),
    },
    {
      task: args.task || "",
      model: ctx.options.model ?? "auto",
      cwd: ctx.cwd,
      verbose: ctx.verbose,
      selectedFiles: [],
      policy: ctx.options.policy,
      yes: false,
      mode: ctx.options.mode,
      subagentDepth: ctx.options.subagentDepth,
      permissionRules: ctx.options.permissionRules,
    },
  );
  const summary =
    res.summary ||
    (res.success ? "Subagent completed successfully." : "Subagent failed.");
  return {
    result: res.success
      ? summary
      : summary.startsWith("Error:")
        ? summary
        : `Error: ${summary}`,
  };
});

define("enter_plan_mode", async (args, ctx) => {
  spin(ctx, "read", "PlanMode", "Switching to PLAN mode");
  return { result: await executeEnterPlanMode(args, ctx.cwd, ctx.options) };
});

define("exit_plan_mode", async (args, ctx) => {
  spin(ctx, "success", "PlanMode", "Exiting PLAN mode -> BUILD mode");
  return { result: await executeExitPlanMode(args, ctx.cwd, ctx.options) };
});
