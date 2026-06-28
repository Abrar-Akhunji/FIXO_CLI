/**
 * Single-Agent with Tool Calling — replaces the 7-stage pipeline.
 * One agent, 5 tools, 2–3 LLM calls for most tasks instead of 6+.
 *
 * Architecture:
 *   User Input → Complexity Check → Agentic Tool Loop → Result
 *   (trivial queries skip the tool loop entirely)
 */
import path from "path";
import fs from "fs";
import { WorkspaceGuard } from "../workspace-guard.js";
import type {
  ChatContentBlock,
  ChatMessage,
  TokenUsage,
} from "../shared/types.js";
import { AgentClient } from "./agent-client.js";
import { ConversationManager, sanitizeUserContent } from "./conversation.js";
import {
  getActiveTools,
  executeTool,
  classifyExecutionRole,
  type ToolCallEvent,
} from "./tool-executor.js";
import { isTrivialQuery } from "../planner.js";
import {
  decideAutoVerify,
  classifyVerifyOutput,
  buildRepairMessage,
} from "./auto-verifier.js";
import { buildRepoMap } from "./repo-map.js";
import type { AgentContext, AgentResult } from "../types.js";
import { loadConfig, getAgentLoopGuardConfig } from "../config.js";
import { recordTelemetry, telemetry } from "./telemetry.js";
import {
  buildProjectInstructionsBlock,
  recordFixoMdLoad,
} from "../context/fixo-md.js";
import { loadTodoList, summariseTodoList } from "../context/todo.js";
import { C } from "../ui/colors.js";
import {
  MarkdownStreamRenderer,
  renderMarkdown,
} from "../ui/markdown-stream.js";
import {
  SemanticLoopDetector,
  SemanticLoopAbortedError,
  toSafetyAlertDirective,
} from "../runtime/loop-trap.js";
import {
  LoopMitigationTracker,
  isReadTool,
  buildLoopBlockedReadResult,
} from "../runtime/loop-mitigation.js";
import { dashboard } from "../ui/render.js";
import { LoadingAnimation } from "../ui/loading-animation.js";
import * as p from "@clack/prompts";
export const promptsWrapper = {
  select: p.select,
  confirm: p.confirm,
  spinner: p.spinner,
  isCancel: p.isCancel,
};
import type readline from "readline";
import { TaskSession } from "../runtime/task-session.js";
import { BackgroundAwareness } from "./background-awareness.js";
import { FixoMdWatcher } from "../context/fixo-md-watcher.js";
import { FILE_WRITING_RULES_BLOCK } from "./file-writing-rules.js";

/* ──────────────────────── Constants ──────────────────────── */

const MAX_TOOL_RESULT_LENGTH = 30_000;

/**
 * Tools that mutate the workspace, the git tree, the network, or any
 * external state. Exported so the budget logic and the permission
 * prompt logic share one source of truth — keeping the
 * "investigation vs mutation" classification aligned with what the
 * user sees in the approval prompt.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "run_command",
  "run_command_async",
  "apply_patch",
  "replace_range",
  "insert_after",
  "str_replace",
  "rename_file",
  "delete_file",
  "create_branch",
  "commit_changes",
  "push_branch",
  "create_pull_request",
]);

/**
 * Returns true when the given tool name is a pure read / analysis
 * operation (read_file, search_code, list_dir, extract_symbols, ...).
 */
export function isReadOnlyTool(name: string): boolean {
  return !MUTATING_TOOL_NAMES.has(name);
}

const colors = {
  reset: C.RESET,
  bold: C.BOLD,
  dim: C.SNOW4,
  green: C.GREEN,
  yellow: C.YELLOW,
  cyan: C.BLUE,
  red: C.RED,
  gray: C.SNOW3,
  magenta: C.PURPLE,
};

export function evaluateInputIntent(task: string): "CHAT_ONLY" | "MUTATION" {
  const cleanTask = task.toLowerCase().trim();

  // Strong mutation indicators override any chat keywords (e.g. "refactor the list component")
  const mutationKeywords = [
    /\bcreate\b/,
    /\bwrite\b/,
    /\bfix\b/,
    /\brefactor\b/,
    /\bupdate\b/,
    /\bdelete\b/,
    /\badd\b/,
    /\bimplement\b/,
    /\bmodify\b/,
    /\bchange\b/,
    /\bmake\b/,
  ];
  if (mutationKeywords.some((pattern) => pattern.test(cleanTask))) {
    return "MUTATION";
  }

  // Codebase or file reference queries must have tools enabled
  const codebaseKeywords = [
    /\bcodebase\b/,
    /\brepo\b/,
    /\brepository\b/,
    /\bvulnerab\w*\b/,
    /\bfile\b/,
    /\bfolder\b/,
    /\bdirectory\b/,
    /\bpath\b/,
    /\btest\b/,
    /\berror\b/,
    /\bwarning\b/,
    /\bbug\b/,
    /\bissue\b/,
    /\bcompile\b/,
    /\bbuild\b/,
  ];
  const fileRefPattern =
    /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|md|yml|yaml|toml|sh|bash|txt|html|vue|svelte)\b/i;

  if (
    codebaseKeywords.some((pattern) => pattern.test(cleanTask)) ||
    fileRefPattern.test(cleanTask)
  ) {
    return "MUTATION";
  }

  const chatKeywords = [
    /\bguide\b/,
    /\bexplain\b/,
    /\bwhy\b/,
    /\bhow to\b/,
    /\blist\b/,
    /\breview\b/,
    /\btell me\b/,
    /\bwhat is\b/,
    /\bsuggest\b/,
    /\bwhat are\b/,
  ];

  if (chatKeywords.some((pattern) => pattern.test(cleanTask))) {
    return "CHAT_ONLY";
  }
  return "MUTATION";
}

/* ──────────────────────── Permission helpers ──────────────────────── */

function formatPermissionPrompt(
  name: string,
  args: Record<string, string>,
): string {
  switch (name) {
    case "write_file":
      return `Allow write to ${colors.cyan}${colors.bold}${args.path || "unknown path"}${colors.reset}?`;
    case "run_command":
      return `Allow command execution: ${colors.yellow}${colors.bold}${args.command || "unknown command"}${colors.reset}?`;
    case "apply_patch":
      return `Allow apply_patch (unified diff, ${(args.patch ?? "").length} chars)?`;
    case "replace_range":
      return `Allow replace_range on ${colors.cyan}${args.path}${colors.reset} lines ${args.startLine}..${args.endLine}?`;
    case "insert_after":
      return `Allow insert_after on ${colors.cyan}${args.path}${colors.reset}?`;
    case "rename_file":
      return `Allow rename ${colors.cyan}${args.from}${colors.reset} → ${colors.cyan}${args.to}${colors.reset}?`;
    case "delete_file":
      return `Allow ${colors.red}delete${colors.reset} ${colors.cyan}${args.path}${colors.reset}?`;
    case "create_branch":
      return `Allow create git branch "${args.branchName}"?`;
    case "commit_changes":
      return `Allow git commit: "${(args.message ?? "").slice(0, 80)}"?`;
    case "push_branch":
      return `Allow git push to ${args.remote || "origin"}?`;
    case "create_pull_request":
      return `Allow create pull request (base: ${args.baseBranch || "main"})?`;
    default:
      return `Allow ${name}?`;
  }
}

/* ──────────────────────── System Prompt ──────────────────────── */

/**
 * Build the `content` for the next user message. When the caller
 * supplied `pendingAttachments` (today: images queued via the
 * `/image` slash command), the content is a typed block array
 * with the task text first and the attachments after. Otherwise
 * the historical plain-string shape is preserved so providers
 * without vision support stay on the simple wire format.
 */
function buildUserContent(context: AgentContext): string | ChatContentBlock[] {
  const attachments = context.pendingAttachments;
  const sanitizedTask = sanitizeUserContent(context.task);
  if (!attachments || attachments.length === 0) {
    return sanitizedTask;
  }
  const blocks: ChatContentBlock[] = [{ type: "text", text: sanitizedTask }];
  for (const a of attachments) blocks.push(a);
  return blocks;
}

function buildSystemPrompt(
  repoMap: string,
  context: AgentContext,
  enableTools = true,
): string {
  const parts: string[] = [];
  if (enableTools) {
    parts.push(
      `You are FixO CLI, an autonomous AI coding agent. You help developers by reading, writing, and modifying code files in their workspace.`,
      ``,
      `## Capabilities`,
      `You have access to these tools:`,
      `- **read_file(path)** — Read a file's contents`,
      `- **write_file(path, content)** — Create or overwrite a file`,
      `- **run_command(command)** — Execute a shell command (npm test, git status, etc.)`,
      `- **search_code(query)** — Search for patterns in the codebase`,
      `- **list_dir(path)** — List directory contents`,
      ``,
      `## Guidelines`,
      `1. ALWAYS read existing files before modifying them to understand current code.`,
      `2. For new files, write complete contents — never use placeholders like "// ... rest of the file". For edits to existing files, follow the Editing Discipline below.`,
      `3. After making changes, run the verification command if one is configured.`,
      `4. Keep your text responses concise. Focus on what you did and why.`,
      `5. If the task is ambiguous, ask a clarifying question instead of guessing.`,
      `6. Preserve existing code comments and formatting unless asked to change them.`,
      ``,
      `## Editing Discipline`,
      `Pick the narrowest tool that fits the change. Rewriting a file you only need to tweak burns tokens, defeats the LSP pre-save granularity, and risks clobbering concurrent edits.`,
      `- **Single-region edit on an existing file** (one symbol, one block, one line) → use \`str_replace\`. It is surgical and atomic. By default it errors when the snippet is non-unique — narrow the snippet, don't disable the check.`,
      `- **Multi-region or hunked edit on an existing file** (several non-adjacent changes, or a diff you already have) → use \`apply_patch\` with a unified diff. One tool call, all hunks atomic.`,
      `- **New file** OR **full rewrite** where the prior content is genuinely irrelevant → use \`write_file\`. This is the only sanctioned use of \`write_file\` on an existing path.`,
      `Never use \`write_file\` to "edit" an existing file by rewriting it whole. If the diff is small enough to describe, it is small enough for \`str_replace\` or \`apply_patch\`.`,
      FILE_WRITING_RULES_BLOCK,
    );
  } else {
    parts.push(
      `You are FixO CLI, a friendly AI coding assistant. You help developers by answering questions, explaining code, and discussing software engineering concepts.`,
      ``,
      `## Guidelines`,
      `1. Provide clear, detailed, and accurate explanations.`,
      `2. Keep your responses focused and helpful.`,
      `3. If you refer to code structure, do so conceptually as you currently do not have active tool access to modify code.`,
    );
  }

  parts.push(``, `## Workspace`, `Working directory: ${context.cwd}`);

  // Add pinned files info
  if (context.selectedFiles.length > 0) {
    parts.push(`Pinned files: ${context.selectedFiles.join(", ")}`);
  }

  // Add verification command
  if (context.checkCommand) {
    parts.push(`Verification command: \`${context.checkCommand}\``);
  }

  // Add project-specific system prompt
  if (context.systemPromptOverride) {
    parts.push(``, `## Project Instructions`, context.systemPromptOverride);
  }

  // Add FIXO.md block (project-local instructions from the
  // configured lookup chain). Telemetry is emitted in a
  // microtask so the system-prompt build remains sync.
  const { block: fixoBlock, result: fixoResult } =
    buildProjectInstructionsBlock(context.cwd);
  if (fixoBlock.length > 0) {
    parts.push(fixoBlock);
    void recordFixoMdLoad(fixoResult);
  }

  // Add repo map
  parts.push(``, repoMap);

  // Append a one-line todo summary so the LLM always knows
  // what the current plan is without having to call
  // todo_read on every turn.
  const todoSummary = summariseTodoList(loadTodoList(context.cwd));
  if (todoSummary.length > 0) {
    parts.push(``, `## Todo`, todoSummary);
  }

  return parts.join("\n");
}

/* ──────────────────────── SingleAgent ──────────────────────── */

export class SingleAgent {
  private client: AgentClient;
  private verbose: boolean;
  private allowAll = false;
  /** AbortController used to cancel the current task on Escape / Ctrl+C. */
  private abortController = new AbortController();
  /** Set true once the user requests cancellation so the tool loop
   *  produces a clean "Task cancelled" message. */
  private markedForCancellation = false;
  private activeAnimation: LoadingAnimation | null = null;

  constructor(verbose = false) {
    const config = loadConfig();
    this.client = new AgentClient(
      config.freellmapi_api_key || "",
      config.apiUrl,
      verbose,
      config.provider_mode,
      config.preferences.modelRouting,
    );
    this.verbose = verbose;
  }

  /** Expose the underlying client for direct API calls (e.g. compaction). */
  getClient(): AgentClient {
    return this.client;
  }

  /** Abort the current task. Any in-flight LLM call or tool execution
   *  will be interrupted at the next opportunity. */
  abort(): void {
    this.markedForCancellation = true;
    this.abortController.abort();
  }

  /** Reset the abort controller so a new task can be run after a
   *  cancellation. Called by the UI layer when the user starts a new
   *  task or when the cancelled task finishes unwinding. */
  reset(): void {
    this.abortController = new AbortController();
    this.markedForCancellation = false;
  }

  private async runStreamingImpl(
    context: AgentContext,
    conversation: ConversationManager,
    rl?: readline.Interface,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const totalUsage: TokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let toolCallCount = 0;
    const modifiedFiles: string[] = [];
    let resolvedModel = context.model;

    this.activeAnimation = new LoadingAnimation();
    this.activeAnimation.start();
    // Set model context limit for accurate overflow detection
    conversation.setContextLimit(context.model);

    // Phase 4: Read persistent summary
    try {
      const fixoDir = path.join(context.cwd || process.cwd(), ".fixo");
      const summaryFile = path.join(fixoDir, "last-run-summary.json");
      if (fs.existsSync(summaryFile)) {
        const summaryRaw = fs.readFileSync(summaryFile, "utf8");
        fs.rmSync(summaryFile, { force: true });
        const summary = JSON.parse(summaryRaw);
        if (
          summary &&
          summary.timestamp &&
          typeof summary.success === "boolean"
        ) {
          const ageMs = Date.now() - summary.timestamp;
          if (ageMs < 15 * 60 * 1000 && summary.success === false) {
            conversation.addMessage({
              role: "system",
              content:
                "Previous DAG Run Failed: " +
                (summary.reason || "Unknown error"),
            });
          }
        }
      }
    } catch (e) {
      if (process.env.DEBUG)
        console.warn("[single-agent] Error reading last-run-summary.json", e);
    }

    // ──── Trivial query → stream directly ────
    if (isTrivialQuery(context.task)) {
      const trivialSystem = `You are FixO CLI, a friendly AI coding assistant. Respond briefly and helpfully.`;

      // Auto-compact if context is getting large
      await this.autoCompactIfNeeded(
        conversation,
        trivialSystem,
        context.task,
        context.model,
      );
      // Pillar 4 — proactive budget enforcement
      await this.enforceContextBudget(
        conversation,
        trivialSystem,
        context.task,
        context.model,
      );

      const messages: ChatMessage[] = [
        { role: "system", content: trivialSystem },
        ...conversation.getMessages(),
        { role: "user", content: buildUserContent(context) },
      ];

      const streamRes = await this.streamResponse(
        messages,
        context.model,
        totalUsage,
        this.abortController.signal,
      );
      const fullResponse = streamRes.responseText;
      conversation.addTurn(context.task, fullResponse);

      return {
        success: true,
        response: fullResponse,
        modifiedFiles: [],
        tokensUsed: totalUsage,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
        model: streamRes.resolvedModel,
      };
    }

    const intent = evaluateInputIntent(context.task);
    if (intent === "CHAT_ONLY") {
      return await this.executePureChatStream(
        context.task,
        conversation,
        context,
      );
    }

    // ──── Complex task → tool loop ────
    let repoMap = "";
    let referencesBlock = "";

    if (!(context as any).isResume) {
      repoMap = await buildRepoMap(context.cwd, {
        maxDepth: loadConfig().preferences.repoMap?.maxDepth,
        maxFiles: loadConfig().preferences.repoMap?.maxFiles,
      });

      // Phase 3.2 — auto-collect cross-file references for the files
      // this run is likely to mutate (user-pinned files via /select).
      // The block is empty if no LSP server is on $PATH, so adding it
      // unconditionally is safe on machines without an LSP installed.
      if (context.selectedFiles && context.selectedFiles.length > 0) {
        try {
          const { gatherReferencesForTargets } =
            await import("./context-builder.js");
          const { getLspManager } = await import("./tool-executor.js");
          referencesBlock = await gatherReferencesForTargets(
            context.cwd,
            context.selectedFiles.map((f) => ({ file: f })),
            () => getLspManager(context.cwd),
          );
        } catch {
          // safe: any failure in the LSP path must not block the run
        }
      }

      try {
        const { getFrameworkGuidance } = await import("./context-builder.js");
        const frameworkBlock = getFrameworkGuidance(context.cwd);
        if (frameworkBlock) {
          referencesBlock = referencesBlock
            ? `${referencesBlock}\n\n${frameworkBlock}`
            : frameworkBlock;
        }
      } catch {
        // safe: dynamic import failure won't block the run
      }
    }

    const systemPrompt = referencesBlock
      ? `${buildSystemPrompt(repoMap, context)}\n\n${referencesBlock}`
      : buildSystemPrompt(repoMap, context);

    // Auto-compact before building messages if context is near limit
    await this.autoCompactIfNeeded(
      conversation,
      systemPrompt,
      context.task,
      context.model,
    );
    // Pillar 4 — proactive budget enforcement
    await this.enforceContextBudget(
      conversation,
      systemPrompt,
      context.task,
      context.model,
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...conversation.getMessages(),
      { role: "user", content: buildUserContent(context) },
    ];

    /**
     * Helper to inject a safety directive into the system message at the
     * head of the messages array. The directive is prepended (rather than
     * appended) so the LLM sees it before the conversation history,
     * which maximises the chance it changes its strategy on the next
     * turn. The base system prompt is preserved untouched.
     */
    const injectSafetyDirective = (directive: string): void => {
      if (messages.length === 0 || messages[0]?.role !== "system") {
        messages.unshift({ role: "system", content: directive });
        return;
      }
      const first = messages[0]!;
      messages[0] = {
        role: "system",
        content: `${directive}\n\n${first.content}`,
      };
    };

    const taskSession = new TaskSession({
      cwd: context.cwd,
      task: context.task,
      model: context.model,
      policy: context.policy,
    });

    // Pillar 2 — auto-collect any expired staged writes at the
    // start of every run. Stale staged writes from previous
    // sessions are quarantined to a single TTL-bounded folder
    // and removed here. Safe to run on every run start.
    try {
      const { AtomicStagingManager } = await import("../runtime/staging.js");
      AtomicStagingManager.garbageCollectAll(context.cwd);
    } catch {
      // Staging is best-effort cleanup; never block the run.
    }

    // Pillar 5 / Protection 2 — classify the task and gate
    // mutation tools. Read-only / review / analysis tasks run
    // without write_file, apply_patch, etc. visible to the LLM.
    const role = classifyExecutionRole(context.task);
    const activeTools = getActiveTools(
      role === "READ_ONLY" ? "READ_ONLY" : context.mode,
    );
    if (role === "READ_ONLY") {
      console.log(
        `${colors.dim}🛡  Read-only role — mutation tools hidden.${colors.reset}`,
      );
    }
    const safety = loadConfig().preferences.safety;
    // Tool-call budget. The agent loop runs at most `softLimit` calls
    // by default; when `autoExtend` is on and the semantic loop
    // detector is not warning, the budget silently lifts to
    // `hardLimit`. The hard limit is the absolute ceiling.
    const budget = safety.toolCalls;
    let toolCallLimit = Math.max(1, budget.softLimit);
    const toolCallHardLimit = Math.max(toolCallLimit, budget.hardLimit);
    /**
     * Investigation budget — applies when the agent has only invoked
     * read-only tools so far. Audits, reviews, and "find vulnerabilities"
     * tasks routinely need to read 80+ files before answering; if we
     * cap them at `hardLimit` they force the user to type `continue`
     * mid-investigation (the failure mode seen in Test 2 of the log).
     * Snaps back to `hardLimit` the moment a mutation fires.
     */
    const investigationMultiplier = Math.max(
      1,
      budget.investigationMultiplier ?? 1,
    );
    const toolCallInvestigationCeiling = Math.max(
      toolCallHardLimit,
      Math.floor(toolCallHardLimit * investigationMultiplier),
    );
    let anyMutationSeen = false;
    let investigationModeAnnounced = false;

    // Phase 2.2 — automatic post-edit verifier. After the tool loop
    // reports "no more tool calls", re-check the project's tests
    // (when configured) and — on failure — push a repair-request
    // back into the same conversation up to `autoVerifyMaxRepairs`
    // times before returning. Disabled outside BUILD mode and when
    // no file-mutating tool ran. Gate + classification + message
    // shape live in ./auto-verifier (testable in isolation).
    let autoVerifyRepairsUsed = 0;
    const autoVerifyMaxRepairs = Math.max(0, safety.autoVerifyMaxRepairs ?? 1);

    // Pillar 2 — semantic loop detector. Tracks per-file frequency so
    // an LLM which varies its search arguments but keeps hammering
    // the same file still trips. The composite LoopTrapDetector is
    // still wired in (callers may pass safety.loopTrap) so the two
    // detectors run in parallel; the semantic one covers the most
    // common accidental "stare at one file" failure mode.
    const semanticLoopDetector = new SemanticLoopDetector(
      safety.semanticLoopTrap,
    );
    // Phase 1b — opt-in sliding-window block accounting. Default is OFF
    // (legacy session-lifetime lockout) until Phase 7 flips the default
    // after soak. Sliding mode prevents the "immortal file" deadlock
    // observed in the June 22, 2026 log session.
    const loopGuardConfig = getAgentLoopGuardConfig();
    const loopMitigation = new LoopMitigationTracker({
      useSlidingWindow: loopGuardConfig.useSlidingWindow,
      blockWindowTurns: loopGuardConfig.blockWindowTurns,
    });
    let pendingSafetyDirective: string | null = null;

    // Pillar 5 — per-turn background-job awareness. The LLM
    // routinely forgets jobs it spawned earlier; we counter that by
    // injecting a compact `[Background Jobs]` directive at the head
    // of each chat() call. New terminal statuses are announced
    // exactly once; still-running jobs are reminded every turn.
    const backgroundAwareness = new BackgroundAwareness(context.cwd);

    // Phase 4 — FIXO.md per-turn re-injection. The watcher captures
    // the on-disk fingerprint at run start so the first check is a
    // no-op (file already baked into the system prompt). Any
    // mid-run create/update/delete surfaces as a [Project
    // Instructions] directive on the next chat().
    const fixoMdWatcher = new FixoMdWatcher(context.cwd);

    const indicator = this.activeAnimation!;

    let lastUsage: any = null;

    try {
      while (toolCallCount < toolCallLimit) {
        // Auto-extend the budget when the agent is at the soft limit
        // but the semantic loop detector is quiet — i.e. the work is
        // still progressing, not thrashing. Capped at hardLimit for
        // mutating runs; lifted to the investigation ceiling
        // (hardLimit * investigationMultiplier) while only read-only
        // tools have fired.
        if (
          budget.autoExtend &&
          toolCallCount + 1 >= toolCallLimit &&
          pendingSafetyDirective === null
        ) {
          const ceiling =
            !anyMutationSeen && investigationMultiplier > 1
              ? toolCallInvestigationCeiling
              : toolCallHardLimit;
          if (toolCallLimit < ceiling) {
            const previous = toolCallLimit;
            toolCallLimit = Math.min(ceiling, toolCallLimit * 2);
            if (toolCallLimit > previous) {
              const investigation =
                !anyMutationSeen && investigationMultiplier > 1;
              if (investigation && !investigationModeAnnounced) {
                console.log(
                  `${colors.dim}ⓘ Investigation mode — extended budget to ${toolCallLimit} (read-only tools only).${colors.reset}`,
                );
                investigationModeAnnounced = true;
              } else if (!investigation) {
                console.log(
                  `${colors.dim}↳ tool-call budget extended ${previous} → ${toolCallLimit} (no loop detected)${colors.reset}`,
                );
              }
            }
          }
        }
        // Background-job awareness: surface newly-finished and
        // still-running jobs as a directive before each chat() call.
        // Skipped on the first iteration because no async tools have
        // run yet — saves tokens when the user's task doesn't
        // involve background jobs at all.
        if (toolCallCount > 0) {
          const bgSnap = backgroundAwareness.snapshot();
          const bgDirective = backgroundAwareness.formatDirective(bgSnap);
          if (bgDirective) {
            injectSafetyDirective(bgDirective);
            backgroundAwareness.markAnnounced(bgSnap);
          }

          // FIXO.md mid-run change detection. Stats the active path
          // and only injects when the on-disk fingerprint differs
          // from what was baked into the system prompt. Skipped on
          // iter 0 for the same reason as the job-awareness check.
          const fixoMdWatch = fixoMdWatcher.check();
          const fixoDirective = fixoMdWatcher.formatDirective(fixoMdWatch);
          if (fixoDirective) {
            injectSafetyDirective(fixoDirective);
          }
        }

        indicator.setPhase({
          id: "reasoning",
          label: "Reasoning…",
          detail: "Analyzing context paths",
          icon: "⚡",
        });
        indicator.setTurn(toolCallCount + 1);
        dashboard.emit({
          type: "turn-start",
          turnIndex: toolCallCount + 1,
          task: context.task,
        });
        // Check for pre-turn cancellation
        if (this.abortController.signal.aborted) {
          throw new Error("Task cancelled by user.");
        }

        let result;
        try {
          result = await this.client.chat(messages, context.model, {
            tools: activeTools,
            tool_choice: "auto",
            signal: this.abortController.signal,
          });
          resolvedModel = result.model;
        } catch (err: any) {
          // Handle context overflow — auto-compact and retry once
          if (ConversationManager.isContextOverflowError(err)) {
            indicator.setPhase({
              id: "reasoning",
              label: "Context full…",
              detail: "Auto-compacting history",
              icon: "🔄",
            });
            console.log(
              `${colors.yellow}🔄 Context window full — auto-compacting...${colors.reset}`,
            );
            const compacted = await conversation.compact(
              this.client,
              context.model,
            );
            if (compacted) {
              const info = conversation.getLastCompactionInfo();
              console.log(
                `${colors.green}✓ Compacted: ${info?.messagesBefore ?? "?"} messages → summary + ${conversation.getMessageCount()} recent. ~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k tokens freed.${colors.reset}`,
              );
              // Rebuild messages with compacted history
              messages.length = 0;
              messages.push(
                { role: "system", content: systemPrompt },
                ...conversation.getMessages(),
                { role: "user", content: buildUserContent(context) },
              );
              continue; // Retry the LLM call
            }
          }
          throw err;
        } finally {
          dashboard.emit({
            type: "status",
            message: `Turn ${toolCallCount + 1} complete`,
          });
        }

        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;
        lastUsage = result.usage;

        // No tool calls → potentially run the auto-verifier, then
        // either continue the loop (one repair pass) or return.
        if (!result.tool_calls || result.tool_calls.length === 0) {
          const response = result.content ?? "";

          // Print the response (already received in non-streaming mode)
          if (response) {
            renderMarkdown(response);
          }

          // Phase 2.2 — automatic verifier.
          const verifyGate = decideAutoVerify({
            safety,
            context,
            modifiedFilesCount: modifiedFiles.length,
            repairsUsed: autoVerifyRepairsUsed,
          });
          if (verifyGate.run) {
            const { runProjectTests } = await import("../test-runner.js");
            const verifyOutput = runProjectTests(context.cwd);
            const outcome = classifyVerifyOutput(verifyOutput);
            if (outcome === "failing") {
              autoVerifyRepairsUsed += 1;
              console.log(
                `\n${colors.yellow}🔍 [Auto-Verify] Verification failed (repair attempt ${autoVerifyRepairsUsed}/${autoVerifyMaxRepairs}). Asking the model to fix...${colors.reset}`,
              );
              if (this.verbose) {
                console.log(`${colors.dim}${verifyOutput}${colors.reset}\n`);
              }
              messages.push({ role: "assistant", content: response });
              messages.push({
                role: "user",
                content: buildRepairMessage(verifyOutput),
              });
              // Counts toward tool budget so pathological repairs
              // don't extend the run indefinitely.
              toolCallCount += 1;
              continue;
            }
            // outcome === 'passing' or 'no-command' → fall through
            // to the success return below.
          }

          indicator.stop();
          this.activeAnimation = null;
          conversation.addTurn(context.task, response);
          if (result.usage && result.usage.total_tokens) {
            conversation.syncProviderTokens(result.usage.total_tokens);
          }
          taskSession.finish("success", response);

          return {
            success: true,
            response,
            modifiedFiles,
            tokensUsed: totalUsage,
            toolCallCount,
            durationMs: Date.now() - startTime,
            model: resolvedModel,
          };
        }

        // Execute tool calls (same as non-streaming)
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: result.content,
          tool_calls: result.tool_calls,
        };
        messages.push(assistantMsg);

        if (result.content) {
          console.log(`${colors.dim}${result.content}${colors.reset}`);
        }

        for (const toolCall of result.tool_calls) {
          let parsedArgs: Record<string, string>;
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            parsedArgs = { error: "Failed to parse tool arguments" };
          }

          // Pillar 2 — semantic loop detection. Records the tool
          // call *before* execution so even a permission-denied
          // tool still counts as a hit on the file. The verdict is
          // inspected *after* execution so a warn can be staged as
          // a system-prompt directive on the *next* LLM call.
          if (semanticLoopDetector.preference.enabled) {
            const verdict = semanticLoopDetector.record(
              toolCallCount,
              toolCall.function.name,
              parsedArgs,
              context.cwd,
            );
            if (verdict.state === "warn") {
              pendingSafetyDirective = toSafetyAlertDirective(verdict);
              console.log(
                `${colors.yellow}⚠  Semantic loop warning: ${verdict.target} ` +
                  `accessed ${verdict.count}× in the last ${verdict.windowSize} turns.${colors.reset}`,
              );
              const nowBlocking = loopMitigation.recordWarn(
                verdict.target,
                toolCallCount,
              );
              if (nowBlocking) {
                const blockMsg = loopGuardConfig.useSlidingWindow
                  ? `Further reads of ${verdict.target} will be rejected for the next ${loopGuardConfig.blockWindowTurns} turns — agent will be forced to pivot.`
                  : `Further reads of ${verdict.target} will be rejected this session — agent will be forced to pivot.`;
                console.log(`${colors.yellow}⚠  ${blockMsg}${colors.reset}`);
              }
            } else if (verdict.state === "hard-abort") {
              // Rollback any staged writes from this run before
              // throwing, so a runaway agent doesn't leave a
              // half-edited workspace behind.
              try {
                const { AtomicStagingManager } =
                  await import("../runtime/staging.js");
                AtomicStagingManager.rollbackAll(context.cwd, taskSession.id);
              } catch {
                // best-effort; never mask the abort error
              }
              throw new SemanticLoopAbortedError(
                verdict.target,
                verdict.count,
                verdict.windowSize,
              );
            }
          }

          // Apply any staged directive at the *start* of the next
          // LLM call, not after the current iteration's tools have
          // run. This keeps the conversation aligned with the model
          // that produced the warning.
          if (pendingSafetyDirective) {
            injectSafetyDirective(pendingSafetyDirective);
            pendingSafetyDirective = null;
          }

          // Active loop mitigation: if the model is trying to read
          // a target the loop-trap has already warned on N times,
          // short-circuit with a tool-error result instead of letting
          // the LLM stare at the same file again. The mitigation
          // tracker is per-session, so a future user task can re-read
          // the same file freely.
          if (
            isReadTool(toolCall.function.name) &&
            typeof parsedArgs.path === "string" &&
            loopMitigation.isBlocked(parsedArgs.path, toolCallCount)
          ) {
            const warns = loopMitigation.warnsFor(
              parsedArgs.path,
              toolCallCount,
            );
            const blockedResult = buildLoopBlockedReadResult(
              parsedArgs.path,
              warns,
            );
            console.log(
              `${colors.yellow}⚠  Loop-blocked read intercepted: ${parsedArgs.path}${colors.reset}`,
            );
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: blockedResult,
            });
            toolCallCount++;
            continue;
          }

          // Phase 1b — escape valve for the loop-mitigation deadlock.
          // If the model is now trying to MUTATE a loop-blocked file
          // (write, rename, delete, patch), the prior canMutate check
          // would refuse it because the read was never satisfied. We
          // register a forced read hash on the session so the next
          // canMutate call succeeds — preserving the staleness-check
          // intent without trapping the file as "immortal". Clearing
          // the loop block as well prevents the lockout from carrying
          // over after the pivot has already happened.
          if (
            MUTATING_TOOL_NAMES.has(toolCall.function.name) &&
            typeof parsedArgs.path === "string" &&
            loopMitigation.isBlocked(parsedArgs.path, toolCallCount)
          ) {
            taskSession.noteReadForMutation(parsedArgs.path);
            loopMitigation.reset(parsedArgs.path);
          }

          const allowed = await this.askPermission(
            toolCall.function.name,
            parsedArgs,
            context.cwd,
            rl,
            context.yes,
            context,
          );

          let event: ToolCallEvent;
          if (!allowed) {
            console.log(
              `  ${colors.red}✗ Permission denied for ${toolCall.function.name}${colors.reset}`,
            );
            dashboard.emit({
              type: "tool-finish",
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? "",
              state: "failed",
              durationMs: 0,
            });
            event = {
              tool: toolCall.function.name,
              args: parsedArgs,
              result: `Error: User denied permission to execute ${toolCall.function.name}.`,
              isWrite: false,
            };
          } else {
            const toolStart = Date.now();

            // Set dynamic phase based on tool kind
            if (isReadTool(toolCall.function.name)) {
              indicator.setPhase({
                id: "reading",
                label: "Reading codebase…",
                detail: parsedArgs.path || parsedArgs.from || "",
                icon: "✦",
              });
            } else if (
              toolCall.function.name === "run_command" ||
              toolCall.function.name === "run_command_async"
            ) {
              indicator.setPhase({
                id: "executing",
                label: "Running command…",
                detail: parsedArgs.command || "",
                icon: "$",
              });
            } else if (
              toolCall.function.name === "search_code" ||
              toolCall.function.name === "search_symbols"
            ) {
              indicator.setPhase({
                id: "searching",
                label: "Searching…",
                detail: parsedArgs.query || "",
                icon: "⌕",
              });
            } else {
              indicator.setPhase({
                id: "writing",
                label: "Writing code…",
                detail: parsedArgs.path || parsedArgs.file || "",
                icon: "✎",
              });
            }

            dashboard.emit({
              type: "tool-start",
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? "",
              turnIndex: toolCallCount + 1,
            });
            event = await executeTool(
              toolCall.function.name,
              parsedArgs,
              context.cwd,
              this.verbose,
              {
                session: taskSession,
                policy: context.policy,
                allowWithoutPrompt: context.yes,
                safety,
              },
            );
            dashboard.emit({
              type: "tool-finish",
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? "",
              state: event.result.startsWith("Error:") ? "failed" : "completed",
              durationMs: Date.now() - toolStart,
            });
          }

          if (event.isWrite && event.affectedPath) {
            if (!modifiedFiles.includes(event.affectedPath)) {
              modifiedFiles.push(event.affectedPath);
            }
          }

          // Investigation-budget gate: any mutating tool snaps the
          // ceiling back to hardLimit on the next iteration. We check
          // the tool name (not just event.isWrite) because run_command
          // is mutating-by-default even when it doesn't touch a file.
          if (
            !anyMutationSeen &&
            (event.isWrite || MUTATING_TOOL_NAMES.has(toolCall.function.name))
          ) {
            anyMutationSeen = true;
            if (toolCallLimit > toolCallHardLimit) {
              toolCallLimit = toolCallHardLimit;
            }
          }

          let toolResult = sanitizeUserContent(event.result);
          if (toolResult.length > MAX_TOOL_RESULT_LENGTH) {
            toolResult =
              toolResult.slice(0, MAX_TOOL_RESULT_LENGTH) +
              `\n\n... (truncated, ${toolResult.length} total characters)`;
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });

          toolCallCount++;
        }
      }

      indicator.stop();
      this.activeAnimation = null;

      console.log(
        `${colors.yellow}⚠  Tool call limit reached (${toolCallLimit}).${colors.reset}`,
      );

      conversation.addTurn(
        context.task,
        `Task processed with ${toolCallCount} tool calls.`,
      );
      if (lastUsage && lastUsage.total_tokens) {
        conversation.syncProviderTokens(lastUsage.total_tokens);
      }

      const limitResponse = `Completed with ${toolCallCount} tool calls (limit reached).`;
      taskSession.finish("success", limitResponse);

      return {
        success: true,
        response: limitResponse,
        modifiedFiles,
        tokensUsed: totalUsage,
        toolCallCount,
        durationMs: Date.now() - startTime,
        model: resolvedModel,
      };
    } catch (error: unknown) {
      if (this.markedForCancellation) {
        indicator.markCancelled();
      } else {
        indicator.stop();
      }
      this.activeAnimation = null;
      const errorMsg = error instanceof Error ? error.message : String(error);
      taskSession.finish("error", errorMsg);
      throw error;
    }
  }

  /**
   * Public runStreaming API with outer catch/finally block to handle any errors
   * thrown during early simple paths or the tool loop itself.
   */
  async runStreaming(
    context: AgentContext,
    conversation: ConversationManager,
    rl?: readline.Interface,
  ): Promise<AgentResult> {
    try {
      return await this.runStreamingImpl(context, conversation, rl);
    } catch (error: unknown) {
      if (this.activeAnimation) {
        if (this.markedForCancellation) {
          this.activeAnimation.markCancelled();
        } else {
          this.activeAnimation.stop();
        }
        this.activeAnimation = null;
      }
      throw error;
    } finally {
      if (this.activeAnimation) {
        this.activeAnimation.stop();
        this.activeAnimation = null;
      }
    }
  }

  /**
   * Ask the user for permission to execute a tool.
   * Prompts for every state-mutating tool: write_file,
   * run_command, apply_patch, replace_range, insert_after,
   * rename_file, delete_file, create_branch, commit_changes,
   * push_branch, create_pull_request. Read-only tools (read_file,
   * search_code, list_dir, extract_symbols, extract_imports)
   * are auto-allowed.
   */
  private async askPermission(
    name: string,
    args: Record<string, string>,
    workspaceRoot: string,
    rl?: readline.Interface,
    allowWithoutPrompt?: boolean,
    context?: AgentContext,
  ): Promise<boolean> {
    if (!MUTATING_TOOL_NAMES.has(name)) {
      return true;
    }

    let isOutsideWorkspace = false;
    let resolvedOutsidePath: string | undefined;
    const guard = new WorkspaceGuard(workspaceRoot);
    const targetPath =
      args.path ||
      args.to ||
      args.file ||
      args.target ||
      (name === "run_command" && args.cwd);
    if (targetPath) {
      const resolved = path.resolve(workspaceRoot, targetPath);
      if (!guard.isInside(resolved)) {
        isOutsideWorkspace = true;
        resolvedOutsidePath = resolved;
      }
    }

    if (!isOutsideWorkspace && (allowWithoutPrompt || this.allowAll)) {
      return true;
    }

    if (rl) rl.pause();

    try {
      const message = formatPermissionPrompt(name, args);
      const options: any[] = [
        { value: "yes", label: "Yes, allow" },
        { value: "no", label: "No, deny" },
      ];
      if (!isOutsideWorkspace) {
        options.push({ value: "all", label: "Yes to all (trust session)" });
      }

      const choice = await promptsWrapper.select({
        message,
        options,
        initialValue: "yes",
      });

      if (promptsWrapper.isCancel(choice) || choice === "no") {
        return false;
      }

      const isApproved = choice === "yes" || choice === "all";
      if (isApproved && isOutsideWorkspace && resolvedOutsidePath && context) {
        context.allowedOutsidePaths = context.allowedOutsidePaths || new Set();
        context.allowedOutsidePaths.add(resolvedOutsidePath);
      }

      if (choice === "all" && !isOutsideWorkspace) {
        this.allowAll = true;
      }
      return isApproved;
    } finally {
      if (rl) rl.resume();
    }
  }

  /**
   * Stream a text-only response to the terminal.
   *
   * Selects the resumable streaming path when `preferences.resilience.
   * streamResume === 'auto'` (the default). Set it to `'never'` to
   * fall back to the legacy non-resumable path — useful for tests
   * that want to observe raw stream cuts.
   */
  private async streamResponse(
    messages: ChatMessage[],
    model: string,
    usage: TokenUsage,
    signal?: AbortSignal,
  ): Promise<{ responseText: string; resolvedModel: string }> {
    let fullText = "";
    let resolvedModel = model;
    const policy = loadConfig().preferences.resilience?.streamResume ?? "auto";
    const maxResumeAttempts =
      loadConfig().preferences.resilience?.maxResumeAttempts ?? 3;

    const stream =
      policy === "auto"
        ? this.client.chatStreamWithResume(
            messages,
            model,
            { signal },
            maxResumeAttempts,
          )
        : this.client.chatStream(messages, model, { signal });

    const renderer = new MarkdownStreamRenderer();
    // Reasoning / chain-of-thought is suppressed by default. Models
    // that emit `<think>` blocks or `reasoning_content` deltas are
    // routed through here; the user only sees a short status line.
    // Set DEBUG=1 or pass --verbose to render the raw thinking dim
    // inline so developers can still inspect it.
    const showThinking =
      !!process.env.DEBUG ||
      !!process.env.VERBOSE ||
      process.argv.includes("--verbose");
    let thinkingAnnounced = false;

    let firstChunkReceived = false;

    try {
      for await (const chunk of stream) {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (this.activeAnimation) {
            this.activeAnimation.stop();
            this.activeAnimation = null;
          }
        }
        if (chunk.type === "content" && chunk.content) {
          renderer.write(chunk.content);
          fullText += chunk.content;
        }
        if (chunk.type === "thinking" && chunk.thinking) {
          if (showThinking) {
            // Dim secondary colour so the thought stream is visually
            // subordinate to the actual response.
            process.stdout.write(
              `${colors.dim}${chunk.thinking}${colors.reset}`,
            );
          } else if (!thinkingAnnounced) {
            process.stdout.write(
              `  ${colors.dim}⚡ Agent is reasoning…${colors.reset}\n`,
            );
            thinkingAnnounced = true;
          }
        }
        if (chunk.type === "done") {
          if (chunk.usage) {
            usage.prompt_tokens += chunk.usage.prompt_tokens;
            usage.completion_tokens += chunk.usage.completion_tokens;
            usage.total_tokens += chunk.usage.total_tokens;
          }
          if (chunk.model) {
            resolvedModel = chunk.model;
          }
        }
      }

      if (fullText) {
        if (!fullText.endsWith("\n")) renderer.write("\n");
        renderer.flush();
      }
    } finally {
      if (this.activeAnimation) {
        this.activeAnimation.stop();
        this.activeAnimation = null;
      }
    }

    return { responseText: fullText, resolvedModel };
  }

  private async executePureChatStream(
    task: string,
    conversation: ConversationManager,
    context: AgentContext,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const totalUsage: TokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const repoMap = await buildRepoMap(context.cwd, {
      maxDepth: loadConfig().preferences.repoMap?.maxDepth,
      maxFiles: loadConfig().preferences.repoMap?.maxFiles,
    });
    const systemPrompt = buildSystemPrompt(repoMap, context, false);

    // Auto-compact before chat if context is near limit
    await this.autoCompactIfNeeded(
      conversation,
      systemPrompt,
      task,
      context.model,
    );
    // Pillar 4 — proactive budget enforcement
    await this.enforceContextBudget(
      conversation,
      systemPrompt,
      task,
      context.model,
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...conversation.getMessages(),
      { role: "user", content: task },
    ];

    const streamRes = await this.streamResponse(
      messages,
      context.model,
      totalUsage,
      this.abortController.signal,
    );
    const fullResponse = streamRes.responseText;
    conversation.addTurn(task, fullResponse);

    return {
      success: true,
      response: fullResponse,
      modifiedFiles: [],
      tokensUsed: totalUsage,
      toolCallCount: 0,
      durationMs: Date.now() - startTime,
      model: streamRes.resolvedModel,
    };
  }

  /**
   * Auto-compact the conversation if the next request would approach the context limit.
   * This is the core of the auto-context-management system.
   */
  private async autoCompactIfNeeded(
    conversation: ConversationManager,
    systemPrompt: string,
    userMessage: string,
    model: string,
  ): Promise<void> {
    if (!conversation.shouldCompact(systemPrompt, userMessage)) {
      return;
    }

    const estimatedTokens = conversation.estimateNextRequestTokens(
      systemPrompt,
      userMessage,
    );
    const limit = conversation.getContextLimit();
    console.log(
      `\n${colors.yellow}🔄 Context approaching limit (${(estimatedTokens / 1000).toFixed(0)}k / ${(limit / 1000).toFixed(0)}k tokens) — auto-compacting...${colors.reset}`,
    );

    const success = await conversation.compact(this.client, model);
    if (success) {
      const info = conversation.getLastCompactionInfo();
      const newEstimate = conversation.estimateNextRequestTokens(
        systemPrompt,
        userMessage,
      );
      console.log(
        `${colors.green}✓ Compacted: ${info?.messagesBefore ?? "?"} messages → summary + ${conversation.getMessageCount()} recent messages. ` +
          `~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k tokens freed (${(newEstimate / 1000).toFixed(0)}k / ${(limit / 1000).toFixed(0)}k now).${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.dim}[Context] Could not compact further. Proceeding with current context.${colors.reset}`,
      );
    }
  }

  /**
   * Pillar 4 — proactive context-budget enforcement.
   *
   * Runs the {@link ContextBudgetEnforcer} against the conversation
   * history right before the LLM call. Honours the kill-switch in
   * `preferences.resilience.contextBudget`:
   *
   *   - `never`    — no-op, returns immediately.
   *   - `truncate` — runs the enforcer; if it asks for compaction,
   *                  we skip the LLM call (the next request will
   *                  likely 413) and let the caller see a smaller
   *                  prompt.
   *   - `auto`     — runs the enforcer; if it asks for compaction,
   *                  we additionally call `ConversationManager.compact`
   *                  to summarise the oldest turns via the LLM.
   *
   * Returns a short report so callers can log what happened.
   */
  async enforceContextBudget(
    conversation: ConversationManager,
    systemPrompt: string,
    userMessage: string,
    model: string,
  ): Promise<{ trimmed: boolean; compacted: boolean; tokensAfter: number }> {
    const config = loadConfig();
    const policy = config.preferences.resilience?.contextBudget ?? "auto";
    if (policy === "never") {
      return { trimmed: false, compacted: false, tokensAfter: 0 };
    }

    const limit = conversation.getContextLimit();
    const ratio = config.preferences.resilience?.contextBudgetRatio ?? 0.8;
    const maxTokens = Math.max(1, Math.floor(limit * ratio));

    const { trimmed, report } = conversation.enforceBudget(maxTokens, model);
    if (!trimmed) {
      return {
        trimmed: false,
        compacted: false,
        tokensAfter: report.tokensAfter,
      };
    }

    console.log(
      `${colors.dim}[ContextBudget] ${report.tokensAfter} tokens after ` +
        `${report.actions.join(" → ")} (was ${report.tokensBefore}).${colors.reset}`,
    );

    recordTelemetry(
      telemetry.contextBudget({
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
        actions: [...report.actions],
        markedForCompaction: report.markForCompaction,
      }),
    );

    if (report.markForCompaction && policy === "auto") {
      // Defer to the existing auto-compaction path which produces a
      // structured LLM-generated summary.
      await this.autoCompactIfNeeded(
        conversation,
        systemPrompt,
        userMessage,
        model,
      );
      const reEstimated = conversation.estimateNextRequestTokens(
        systemPrompt,
        userMessage,
      );
      return { trimmed: true, compacted: true, tokensAfter: reEstimated };
    }

    return { trimmed: true, compacted: false, tokensAfter: report.tokensAfter };
  }

  /** Proxy health check passthrough. */
  async ping(): Promise<boolean> {
    return this.client.ping();
  }
}
