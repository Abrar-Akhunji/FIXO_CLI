/**
 * Tool definitions and executor facade for the single-agent tool-calling loop.
 * Modular architecture: domain operations are partitioned under ./tools/
 * with clean registry dispatch and 100% backward-compatible re-exports.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import type { ChatToolDefinition } from "../shared/types.js";
import { colors } from "../ui/colors.js";
import {
  renderToolCall,
  startInlineToolSpinner,
  type InlineSpinnerHandle,
  type ToolCallRender,
} from "../ui/render-primitives.js";
import { WorkspaceGuard } from "../workspace-guard.js";
import { loadConfig, saveConfig } from "../config.js";
import { GitManager } from "../git/git-manager.js";
import { McpManager } from "./mcp-manager.js";
import { McpBridgeManager } from "./mcp-bridge.js";
import { planModeBlock } from "./plan-gate.js";
import { answerAskUserQuestion } from "./ask-user.js";
import { applyModifiedArgs, fireHooks } from "./hooks.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";

// Domain tools & types
import type {
  ToolCallEvent,
  ToolExecutionOptions,
  ToolExecutionContext,
  ToolSpecification,
  GateAction,
} from "./tools/types.js";
import { evaluateToolGate } from "./tools/types.js";

import {
  registerTool,
  getToolSpecification,
  listRegisteredToolNames,
  runRegisteredTool,
} from "./tools/registry.js";
import "./tools/builtin-registry.js";

import {
  getOrCreateRunId,
  resetRunId,
  isSensitiveCredentialPath,
  applyAtomicWrite,
  countLines,
  buildContextBudgetGuardDirective,
  executeReadFile,
  executeExtractSymbols,
  executeExtractImports,
  executeWriteFile,
  executeDeleteFile,
  filesFromPatch,
  executeApplyPatch,
  executeReplaceRange,
  executeInsertAfter,
  executeRenameFile,
  executeSearchCode,
  executeListDir,
  executeStrReplace,
  executeGlobFiles,
  SurgicalReplaceError,
  GlobFilesError,
} from "./tools/fs-tools.js";

import {
  FOREGROUND_COMMAND_MS,
  detachCurrentForegroundCommand,
  executeRunCommand,
  executeRunCommandAsync,
  executePollCommandStatus,
  executeKillCommand,
  executeGetCommandOutput,
  getBackgroundJobRegistry,
  setBackgroundJobRegistry,
  BackgroundCommandError,
  type RunCommandAsyncArgs,
  type PollCommandStatusArgs,
  type KillCommandArgs,
} from "./tools/command-tools.js";

import {
  executeCreateBranch,
  executeCommitChanges,
  executePushBranch,
  executeCreatePullRequest,
} from "./tools/git-tools.js";

import {
  getLspManager,
  stopLspManager,
  getOrCreateLspGate,
  resetLspGate,
  executeLspGotoDefinition,
  executeLspFindReferences,
  executeLspHover,
} from "./tools/lsp-tools.js";

import { executeWebFetch, executeWebSearch } from "./tools/web-tools.js";

import {
  executeTodoRead,
  executeTodoWrite,
  executeEnterPlanMode,
  executeExitPlanMode,
  TodoWriteError,
  type TodoWriteArgs,
} from "./tools/plan-tools.js";

import {
  shutdownAllBackgroundRegistries,
  listAllBackgroundJobs,
} from "../runtime/background-jobs.js";

// Re-exports for 100% backward compatibility
export { TOOL_DEFINITIONS };
export {
  ToolCallEvent,
  ToolExecutionOptions,
  ToolExecutionContext,
  ToolSpecification,
  evaluateToolGate,
};
export { registerTool, getToolSpecification, listRegisteredToolNames };
export {
  getOrCreateRunId,
  resetRunId,
  isSensitiveCredentialPath,
  applyAtomicWrite,
  countLines,
  buildContextBudgetGuardDirective,
  executeReadFile,
  executeExtractSymbols,
  executeExtractImports,
  executeWriteFile,
  executeDeleteFile,
  filesFromPatch,
  executeApplyPatch,
  executeReplaceRange,
  executeInsertAfter,
  executeRenameFile,
  executeSearchCode,
  executeListDir,
  executeStrReplace,
  executeGlobFiles,
  SurgicalReplaceError,
  GlobFilesError,
};
export type { StrReplaceArgs, GlobArgs } from "./tools/fs-tools.js";
export {
  FOREGROUND_COMMAND_MS,
  detachCurrentForegroundCommand,
  executeRunCommand,
  executeRunCommandAsync,
  executePollCommandStatus,
  executeKillCommand,
  executeGetCommandOutput,
  getBackgroundJobRegistry,
  setBackgroundJobRegistry,
  BackgroundCommandError,
  RunCommandAsyncArgs,
  PollCommandStatusArgs,
  KillCommandArgs,
};
export {
  executeCreateBranch,
  executeCommitChanges,
  executePushBranch,
  executeCreatePullRequest,
};
export {
  getLspManager,
  stopLspManager,
  getOrCreateLspGate,
  resetLspGate,
  executeLspGotoDefinition,
  executeLspFindReferences,
  executeLspHover,
};
export { executeWebFetch, executeWebSearch };
export {
  executeTodoRead,
  executeTodoWrite,
  executeEnterPlanMode,
  executeExitPlanMode,
  TodoWriteError,
  TodoWriteArgs,
};
export { shutdownAllBackgroundRegistries, listAllBackgroundJobs };

export const mcpManager = new McpManager();
export const mcpBridgeManager = new McpBridgeManager();

/* ──────────────────────── Plugins Subsystem ──────────────────────── */

export interface LoadedPlugin {
  path: string;
  tools: ChatToolDefinition[];
  execute: (
    name: string,
    args: Record<string, any>,
    context: any,
  ) => Promise<string>;
}

export const loadedPlugins: LoadedPlugin[] = [];

export async function initializePlugins(
  cwd: string,
  projectConfig?: any,
): Promise<void> {
  if (
    !projectConfig ||
    !projectConfig.plugins ||
    !Array.isArray(projectConfig.plugins)
  ) {
    return;
  }

  const guard = new WorkspaceGuard(cwd);
  const globalConfig = loadConfig() as any;
  if (!globalConfig.approvedPlugins) {
    globalConfig.approvedPlugins = [];
  }

  const trusted = projectConfig.trustedPlugins || [];

  for (const pluginPath of projectConfig.plugins) {
    try {
      const resolvedPath = guard.resolve(pluginPath);
      const isTrusted =
        trusted.includes(pluginPath) || trusted.includes(resolvedPath);
      if (!isTrusted) {
        console.error(
          `\n${colors.red}[Plugin Loader] Error: Plugin "${pluginPath}" is listed in "plugins" but is not in the "trustedPlugins" allowlist inside .freellmapi.yml. Skipping.${colors.reset}`,
        );
        continue;
      }

      const fileUrl = pathToFileURL(resolvedPath).toString();
      const mod = await import(fileUrl);
      const tools = (mod.tools || []) as ChatToolDefinition[];
      const execute = mod.execute;

      if (typeof execute !== "function") {
        console.error(
          `\n${colors.red}[Plugin Loader] Error: Plugin "${pluginPath}" does not export an "execute" function. Skipping.${colors.reset}`,
        );
        continue;
      }

      const approvedKey = `${resolvedPath}`;
      const isApproved = globalConfig.approvedPlugins.includes(approvedKey);

      if (!isApproved) {
        console.log(
          `\n${colors.yellow}╔════════════════════════════════════════════════════════════════╗`,
        );
        console.log(
          `║                  PLUGIN SECURITY VERIFICATION                  ║`,
        );
        console.log(
          `╚════════════════════════════════════════════════════════════════╝`,
        );
        console.log(
          `A new plugin is requesting to be loaded for this workspace:`,
        );
        console.log(`- Path: ${colors.cyan}${pluginPath}${colors.reset}`);
        console.log(`- Resolved: ${colors.cyan}${resolvedPath}${colors.reset}`);
        console.log(
          `- Registers tools: ${colors.green}${tools.map((t) => t.function.name).join(", ") || "(none)"}${colors.reset}`,
        );
        console.log(
          `\n${colors.yellow}WARNING: Plugins run with full access to the user shell and can make network calls or exfiltrate credentials.${colors.reset}`,
        );

        const confirmed = await p.confirm({
          message: `Do you trust and want to load this plugin?`,
          initialValue: false,
        });

        if (p.isCancel(confirmed) || !confirmed) {
          console.log(
            `[Plugin Loader] Load cancelled for "${pluginPath}". Skipping.`,
          );
          continue;
        }

        globalConfig.approvedPlugins.push(approvedKey);
        saveConfig(globalConfig);
        console.log(
          `${colors.green}✓ Plugin approved and saved to ~/.fixocli/config.json${colors.reset}`,
        );
      }

      loadedPlugins.push({
        path: pluginPath,
        tools,
        execute,
      });
    } catch (err) {
      console.error(
        `\n${colors.red}[Plugin Loader] Failed to load plugin "${pluginPath}": ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
      );
    }
  }
}

/* ──────────────────────── Tool Definitions & Gating ──────────────────────── */

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "apply_patch",
  "replace_range",
  "insert_after",
  "rename_file",
  "delete_file",
  "create_branch",
  "commit_changes",
  "push_branch",
  "create_pull_request",
  "run_command",
  "str_replace",
  "todo_write",
  "run_command_async",
  "spawn_subagent",
]);

export function getActiveTools(mode?: string): ChatToolDefinition[] {
  const pluginTools = loadedPlugins.flatMap((p) => p.tools);
  let tools = [
    ...TOOL_DEFINITIONS,
    ...mcpManager.getTools(),
    ...mcpBridgeManager.getTools(),
    ...pluginTools,
  ];

  if (mode === "EXPLORE") {
    const allowed = [
      "read_file",
      "list_dir",
      "search_code",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_hover",
    ];
    tools = tools.filter((t) => allowed.includes(t.function.name));
  } else if (mode === "SCOUT") {
    const allowed = ["web_fetch", "web_search"];
    tools = tools.filter((t) => allowed.includes(t.function.name));
  } else if (mode === "PLAN") {
    const allowed = [
      "read_file",
      "list_dir",
      "search_code",
      "glob_files",
      "extract_symbols",
      "extract_imports",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_hover",
      "web_fetch",
      "web_search",
      "todo_read",
      "ask_user_question",
      "run_command",
      "write_file",
      "str_replace",
    ];
    tools = tools.filter((t) => allowed.includes(t.function.name));
  } else if (mode === "READ_ONLY") {
    tools = tools.filter((t) => !MUTATION_TOOL_NAMES.has(t.function.name));
  }

  return tools;
}

export function classifyExecutionRole(task: string): "BUILD" | "READ_ONLY" {
  const lower = task.toLowerCase();

  const explicitReadOnly =
    /\b(without (modif|chang|edit|alter)ing|read[\s-]only|do not (modif|chang|edit|alter))\b/;
  if (explicitReadOnly.test(lower)) return "READ_ONLY";

  const pureQuestion =
    /^\s*(please\s+)?(can you\s+|could you\s+|would you\s+)?(what|why|how|explain|describe)\b/;
  if (pureQuestion.test(lower)) return "READ_ONLY";

  const withoutNounMutations = lower
    .replace(
      /\b(the|this|that|a|an|our|their|its|those|these)\s+(fix|patch|repair|change|update|add|write|edit|create|delete|remove)s?\b/g,
      " ",
    )
    .replace(/\b(changes|updates|fixes|writes|edits|additions)\b/g, " ");
  const imperativeMutation =
    /\b(fix|patch|repair|resolve|refactor|update|implement|add|create|delete|remove|modify|change|edit|write)\b/;
  if (imperativeMutation.test(withoutNounMutations)) return "BUILD";

  const readOnlyPatterns: RegExp[] = [
    /\b(analy[sz]e|analysing|analysed)\b/,
    /\b(review|auditing|audit)\b/,
    /\b(explain|describe|what does|how does|why does)\b/,
    /\b(vulnerabilit(y|ies)|security review|threat model)\b/,
    /\b(read(ing)? the (entire )?code(base)?)\b/,
    /\b(find (the )?bugs?|find (the )?vulnerabilities|find (the )?issues?)\b/,
    /\b(list(ing)? (the )?files|show (me )?the files|what files)\b/,
    /\b(without (modif|chang|edit|alter)ing)\b/,
    /\b(read[\s-]only)\b/,
  ];
  for (const pattern of readOnlyPatterns) {
    if (pattern.test(lower)) return "READ_ONLY";
  }
  return "BUILD";
}

export function isToolResultFailure(result: string): boolean {
  const text = (result ?? "").trim();
  if (text.startsWith("Error:")) return true;
  if (text.startsWith("Command execution failed:")) return true;
  if (text.startsWith("Command exited with code")) return true;
  if (text.includes("(command failed with exit code")) return true;
  if (text.includes("(command terminated by signal")) return true;
  if (text.startsWith("Patch failed:")) return true;
  if (text.startsWith("Subagent failed")) return true;
  if (text.includes("todo_write: failed")) return true;
  return false;
}

function settleToolEvent(event: ToolCallEvent): ToolCallEvent {
  event.ok = !isToolResultFailure(event.result);
  return event;
}

function truncate(text: string | undefined | null, maxLen: number): string {
  if (!text) return "";
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/* ──────────────────────── Core Tool Executor Dispatcher ──────────────────────── */

export async function executeTool(
  name: string,
  args: Record<string, string>,
  cwd: string,
  verbose: boolean = false,
  options: ToolExecutionOptions = {},
): Promise<ToolCallEvent> {
  const event: ToolCallEvent = {
    tool: name,
    args,
    result: "",
    ok: true,
    isWrite: false,
  };

  // Check for user cancellation before starting any tool work
  if (options.signal?.aborted) {
    event.result = "Error: Task cancelled by user.";
    return settleToolEvent(event);
  }

  if (options.mode === "PLAN") {
    const blocked = await planModeBlock(name, args, cwd);
    if (blocked) {
      event.result = blocked;
      return settleToolEvent(event);
    }
  }

  if (name === "ask_user_question") {
    event.result = await answerAskUserQuestion(
      {
        question: args.question,
        options: args.options as unknown as string[] | string,
      },
      options.rl,
    );
    event.isWrite = false;
    return settleToolEvent(event);
  }

  let inlineSpinner: InlineSpinnerHandle | null = null;
  const toolStartedAt = Date.now();
  const setSpinner = (tool: ToolCallRender): void => {
    if (inlineSpinner) inlineSpinner.clear();
    inlineSpinner = startInlineToolSpinner(tool);
  };

  try {
    const policy = options.policy ?? options.session?.policy ?? "shell-confirm";

    // Auto-init git repo on first mutating tool call
    if (MUTATION_TOOL_NAMES.has(name)) {
      const git = new GitManager(cwd);
      if (!git.isGitRepo()) {
        try {
          spawnSync("git", ["init"], {
            cwd,
            encoding: "utf-8",
            stdio: "ignore",
          });
          spawnSync("git", ["add", "."], {
            cwd,
            encoding: "utf-8",
            stdio: "ignore",
          });
          spawnSync(
            "git",
            ["commit", "-m", "chore: initial checkpoint by fixo"],
            { cwd, encoding: "utf-8", stdio: "ignore" },
          );
        } catch {
          // Ignore if git fails
        }
      }
    }

    // PreToolUse hooks
    const sessionId = options.session?.id ?? "no-session";
    const preHook = fireHooks(cwd, "PreToolUse", {
      tool: name,
      args: args as Record<string, unknown>,
      sessionId,
    });
    if (preHook.fired && preHook.decision === "deny") {
      const reason = preHook.reason ?? "pre-tool hook denied";
      event.result = `Error: hook denied (${preHook.hookId ?? "unknown"}): ${reason}`;
      options.session?.record("tool_denied", { tool: name, reason, args });
      renderToolCall({ kind: "error", name, detail: `hook denied: ${reason}` });
      return settleToolEvent(event);
    }
    if (
      preHook.fired &&
      preHook.decision === "modify" &&
      preHook.modifiedArgs
    ) {
      const applied = applyModifiedArgs(
        cwd,
        args as Record<string, unknown>,
        preHook.modifiedArgs,
      );
      if (!applied.ok) {
        const reason = applied.reason ?? "pre-hook modify rejected";
        event.result = `Error: hook modify rejected: ${reason}`;
        options.session?.record("tool_denied", { tool: name, reason, args });
        renderToolCall({
          kind: "error",
          name,
          detail: `hook modify rejected: ${reason}`,
        });
        return settleToolEvent(event);
      }
      for (const [k, v] of Object.entries(applied.args)) {
        if (
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
        ) {
          args[k] = String(v);
        }
      }
    }

    const plugin = loadedPlugins.find((p) =>
      p.tools.some((t) => t.function.name === name),
    );
    if (plugin) {
      if (options.signal?.aborted) {
        event.result = "Error: Task cancelled by user.";
        return settleToolEvent(event);
      }
      const action: GateAction =
        name.includes("read") ||
        name.includes("get") ||
        name.includes("list") ||
        name.includes("view")
          ? "read"
          : "write";
      const decision = evaluateToolGate(
        name,
        args as Record<string, unknown>,
        cwd,
        policy,
        action,
        name,
      );
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record("tool_denied", {
          tool: name,
          reason: decision.reason,
          args,
          matchedRule: decision.matchedRule,
          source: decision.source,
        });
        return settleToolEvent(event);
      }
      options.session?.record("tool_started", {
        tool: name,
        args,
        risk: decision.risk,
        matchedRule: decision.matchedRule,
        source: decision.source,
      });
      console.log(`  ${colors.dim}🔌 Plugin: ${name}${colors.reset}`);
      try {
        event.result = await plugin.execute(name, args, {
          cwd,
          verbose,
          policy,
          options,
        });
        event.isWrite = action === "write";
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: "error", name, detail: truncate(msg, 80) });
      }
      options.session?.record("tool_finished", {
        tool: name,
        result: truncate(event.result, 2000),
        isWrite: event.isWrite,
      });
      return settleToolEvent(event);
    }

    if (mcpManager.hasTool(name)) {
      const action: GateAction =
        name.includes("read") ||
        name.includes("get") ||
        name.includes("list") ||
        name.includes("view")
          ? "read"
          : "write";
      const decision = evaluateToolGate(
        name,
        args as Record<string, unknown>,
        cwd,
        policy,
        action,
        name,
      );
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record("tool_denied", {
          tool: name,
          reason: decision.reason,
          args,
          matchedRule: decision.matchedRule,
          source: decision.source,
        });
        return settleToolEvent(event);
      }
      options.session?.record("tool_started", {
        tool: name,
        args,
        risk: decision.risk,
        matchedRule: decision.matchedRule,
        source: decision.source,
      });
      console.log(`  ${colors.dim}🔌 MCP: ${name}${colors.reset}`);
      try {
        event.result = await mcpManager.executeTool(name, args);
        event.isWrite = action === "write";
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: "error", name, detail: truncate(msg, 80) });
      }
      options.session?.record("tool_finished", {
        tool: name,
        result: truncate(event.result, 2000),
        isWrite: event.isWrite,
      });
      return settleToolEvent(event);
    }

    if (mcpBridgeManager.hasTool(name)) {
      const action: GateAction =
        name.includes("read") ||
        name.includes("get") ||
        name.includes("list") ||
        name.includes("view")
          ? "read"
          : "write";
      const decision = evaluateToolGate(
        name,
        args as Record<string, unknown>,
        cwd,
        policy,
        action,
        name,
      );
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record("tool_denied", {
          tool: name,
          reason: decision.reason,
          args,
          matchedRule: decision.matchedRule,
          source: decision.source,
        });
        return settleToolEvent(event);
      }
      options.session?.record("tool_started", {
        tool: name,
        args,
        risk: decision.risk,
        matchedRule: decision.matchedRule,
        source: decision.source,
      });
      console.log(`  ${colors.dim}🔌 Local MCP: ${name}${colors.reset}`);
      try {
        event.result = await mcpBridgeManager.executeTool(name, args);
        event.isWrite = action === "write";
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: "error", name, detail: truncate(msg, 80) });
      }
      options.session?.record("tool_finished", {
        tool: name,
        result: truncate(event.result, 2000),
        isWrite: event.isWrite,
      });
      return settleToolEvent(event);
    }

    const action: GateAction =
      name === "run_command"
        ? "command"
        : name === "read_file" ||
            name === "search_code" ||
            name === "list_dir" ||
            name === "web_fetch" ||
            name === "web_search"
          ? "read"
          : name === "delete_file"
            ? "delete"
            : "write";
    const policyTargetRaw =
      name === "web_fetch"
        ? args.url
        : name === "web_search"
          ? args.query
          : (args.command ?? args.path ?? "");
    const policyTarget =
      typeof policyTargetRaw === "string"
        ? policyTargetRaw
        : String(policyTargetRaw ?? "");
    const decision = evaluateToolGate(
      name,
      args as Record<string, unknown>,
      cwd,
      policy,
      action,
      policyTarget,
    );
    if (!decision.allowed) {
      event.result = `Error: ${decision.reason}`;
      options.session?.record("tool_denied", {
        tool: name,
        reason: decision.reason,
        args,
        matchedRule: decision.matchedRule,
        source: decision.source,
      });
      return settleToolEvent(event);
    }
    options.session?.record("tool_started", {
      tool: name,
      args,
      risk: decision.risk,
      matchedRule: decision.matchedRule,
      source: decision.source,
    });

    const outcome = await runRegisteredTool(name, args, {
      cwd,
      verbose,
      options,
      spinner: (tool) =>
        setSpinner({
          kind: tool.kind as ToolCallRender["kind"],
          name: tool.name,
          detail: tool.detail ?? "",
        }),
    });
    if (!outcome) {
      event.result = `Error: Unknown tool "${name}"`;
    } else {
      event.result = outcome.result;
      if (outcome.isWrite) event.isWrite = true;
      if (outcome.affectedPath) event.affectedPath = outcome.affectedPath;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    event.result = `Error: ${msg}`;
    if (inlineSpinner) {
      (inlineSpinner as InlineSpinnerHandle).fail(truncate(msg, 80));
      inlineSpinner = null;
    } else {
      renderToolCall({ kind: "error", name, detail: truncate(msg, 80) });
    }
  }

  settleToolEvent(event);
  if (inlineSpinner) {
    const handle = inlineSpinner as InlineSpinnerHandle;
    const elapsedMs = Date.now() - toolStartedAt;
    const elapsedStr =
      elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
    const failed = event.ok === false;
    if (failed) {
      handle.fail(
        `${truncate(event.result.replace(/^Error:\s*/, ""), 60)} (${elapsedStr})`,
      );
    } else {
      handle.succeed(`done (${elapsedStr})`);
    }
    inlineSpinner = null;
  }

  options.session?.record("tool_finished", {
    tool: name,
    result: truncate(event.result, 2000),
    isWrite: event.isWrite,
  });

  const postHook = fireHooks(cwd, "PostToolUse", {
    tool: name,
    args: args as Record<string, unknown>,
    sessionId: options.session?.id ?? "no-session",
  });
  if (postHook.fired && postHook.decision === "deny") {
    const reason = postHook.reason ?? "post-tool hook denied";
    event.result = `${event.result}\n[post-hook denied: ${reason}]`;
  }

  return settleToolEvent(event);
}
