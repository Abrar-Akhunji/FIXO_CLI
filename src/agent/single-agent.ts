/**
 * Single-Agent with Tool Calling — replaces the 7-stage pipeline.
 * One agent, 5 tools, 2–3 LLM calls for most tasks instead of 6+.
 *
 * Architecture:
 *   User Input → Complexity Check → Agentic Tool Loop → Result
 *   (trivial queries skip the tool loop entirely)
 */
import type { ChatContentBlock, ChatMessage, TokenUsage } from '../shared/types.js';
import { AgentClient, type ChatResult, type StreamChunk } from './agent-client.js';
import { ConversationManager } from './conversation.js';
import { getActiveTools, TOOL_DEFINITIONS, executeTool, classifyExecutionRole, type ToolCallEvent } from './tool-executor.js';
import { isTrivialQuery } from '../planner.js';
import { buildRepoMap } from './repo-map.js';
import type { AgentContext, AgentResult } from '../types.js';
import { loadConfig } from '../config.js';
import { recordTelemetry, telemetry } from './telemetry.js';
import {
  buildProjectInstructionsBlock,
  recordFixoMdLoad,
} from '../context/fixo-md.js';
import {
  loadTodoList,
  summariseTodoList,
} from '../context/todo.js';
import { C } from '../ui/colors.js';
import { MarkdownStreamRenderer, renderMarkdown } from '../ui/markdown-stream.js';
import {
  SemanticLoopDetector,
  SemanticLoopAbortedError,
  toSafetyAlertDirective,
} from '../runtime/loop-trap.js';
import { dashboard } from '../ui/render.js';
import * as p from '@clack/prompts';
export const promptsWrapper = {
  select: p.select,
  confirm: p.confirm,
  spinner: p.spinner,
  isCancel: p.isCancel,
};
import type readline from 'readline';
import { TaskSession } from '../runtime/task-session.js';
import {
  applyWorktreeAnnotations,
  parseWorktreeAnnotations,
  stripWorktreeAnnotations,
} from '../runtime/worktree.js';
import { BackgroundAwareness } from './background-awareness.js';
import { FixoMdWatcher } from '../context/fixo-md-watcher.js';

/* ──────────────────────── Constants ──────────────────────── */

const MAX_TOOL_RESULT_LENGTH = 30_000;

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

export function evaluateInputIntent(task: string): 'CHAT_ONLY' | 'MUTATION' {
  const cleanTask = task.toLowerCase().trim();
  
  // Strong mutation indicators override any chat keywords (e.g. "refactor the list component")
  const mutationKeywords = [
    /\bcreate\b/, /\bwrite\b/, /\bfix\b/, /\brefactor\b/, /\bupdate\b/, 
    /\bdelete\b/, /\badd\b/, /\bimplement\b/, /\bmodify\b/, /\bchange\b/, /\bmake\b/
  ];
  if (mutationKeywords.some(pattern => pattern.test(cleanTask))) {
    return 'MUTATION';
  }

  // Codebase or file reference queries must have tools enabled
  const codebaseKeywords = [
    /\bcodebase\b/, /\brepo\b/, /\brepository\b/, /\bvulnerab\w*\b/, /\bfile\b/, 
    /\bfolder\b/, /\bdirectory\b/, /\bpath\b/, /\btest\b/, /\berror\b/, 
    /\bwarning\b/, /\bbug\b/, /\bissue\b/, /\bcompile\b/, /\bbuild\b/
  ];
  const fileRefPattern = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|md|yml|yaml|toml|sh|bash|txt|html|vue|svelte)\b/i;

  if (codebaseKeywords.some(pattern => pattern.test(cleanTask)) || fileRefPattern.test(cleanTask)) {
    return 'MUTATION';
  }

  const chatKeywords = [
    /\bguide\b/, /\bexplain\b/, /\bwhy\b/, /\bhow to\b/, /\blist\b/, 
    /\breview\b/, /\btell me\b/, /\bwhat is\b/, /\bsuggest\b/, /\bwhat are\b/
  ];
  
  if (chatKeywords.some(pattern => pattern.test(cleanTask))) {
    return 'CHAT_ONLY';
  }
  return 'MUTATION';
}

/* ──────────────────────── Permission helpers ──────────────────────── */

function formatPermissionPrompt(
  name: string,
  args: Record<string, string>,
): string {
  switch (name) {
    case 'write_file':
      return `Allow write to ${colors.cyan}${colors.bold}${args.path || 'unknown path'}${colors.reset}?`;
    case 'run_command':
      return `Allow command execution: ${colors.yellow}${colors.bold}${args.command || 'unknown command'}${colors.reset}?`;
    case 'apply_patch':
      return `Allow apply_patch (unified diff, ${(args.patch ?? '').length} chars)?`;
    case 'replace_range':
      return `Allow replace_range on ${colors.cyan}${args.path}${colors.reset} lines ${args.startLine}..${args.endLine}?`;
    case 'insert_after':
      return `Allow insert_after on ${colors.cyan}${args.path}${colors.reset}?`;
    case 'rename_file':
      return `Allow rename ${colors.cyan}${args.from}${colors.reset} → ${colors.cyan}${args.to}${colors.reset}?`;
    case 'delete_file':
      return `Allow ${colors.red}delete${colors.reset} ${colors.cyan}${args.path}${colors.reset}?`;
    case 'create_branch':
      return `Allow create git branch "${args.branchName}"?`;
    case 'commit_changes':
      return `Allow git commit: "${(args.message ?? '').slice(0, 80)}"?`;
    case 'push_branch':
      return `Allow git push to ${args.remote || 'origin'}?`;
    case 'create_pull_request':
      return `Allow create pull request (base: ${args.baseBranch || 'main'})?`;
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
  if (!attachments || attachments.length === 0) {
    return context.task;
  }
  const blocks: ChatContentBlock[] = [{ type: 'text', text: context.task }];
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

  parts.push(
    ``,
    `## Workspace`,
    `Working directory: ${context.cwd}`,
  );

  // Add pinned files info
  if (context.selectedFiles.length > 0) {
    parts.push(`Pinned files: ${context.selectedFiles.join(', ')}`);
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
  const { block: fixoBlock, result: fixoResult } = buildProjectInstructionsBlock(context.cwd);
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

  return parts.join('\n');
}

/* ──────────────────────── SingleAgent ──────────────────────── */

export class SingleAgent {
  private client: AgentClient;
  private verbose: boolean;
  private allowAll = false;

  constructor(verbose = false) {
    const config = loadConfig();
    this.client = new AgentClient(config.freellmapi_api_key || '', config.apiUrl, verbose);
    this.verbose = verbose;
  }

  /** Expose the underlying client for direct API calls (e.g. compaction). */
  getClient(): AgentClient {
    return this.client;
  }

  async runStreaming(
    context: AgentContext,
    conversation: ConversationManager,
    rl?: readline.Interface,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let toolCallCount = 0;
    const modifiedFiles: string[] = [];
    let resolvedModel = context.model;

    // Set model context limit for accurate overflow detection
    conversation.setContextLimit(context.model);

    // ──── Trivial query → stream directly ────
    if (isTrivialQuery(context.task)) {
      const trivialSystem = `You are FixO CLI, a friendly AI coding assistant. Respond briefly and helpfully.`;

      // Auto-compact if context is getting large
      await this.autoCompactIfNeeded(conversation, trivialSystem, context.task, context.model);
      // Pillar 4 — proactive budget enforcement
      await this.enforceContextBudget(conversation, trivialSystem, context.task, context.model);

      const messages: ChatMessage[] = [
        { role: 'system', content: trivialSystem },
        ...conversation.getMessages(),
        { role: 'user', content: buildUserContent(context) },
      ];

      const streamRes = await this.streamResponse(messages, context.model, totalUsage);
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
    if (intent === 'CHAT_ONLY') {
      return await this.executePureChatStream(context.task, conversation, context);
    }

    // ──── Complex task → tool loop ────
    const repoMap = buildRepoMap(context.cwd);
    const systemPrompt = buildSystemPrompt(repoMap, context);

    // Auto-compact before building messages if context is near limit
    await this.autoCompactIfNeeded(conversation, systemPrompt, context.task, context.model);
    // Pillar 4 — proactive budget enforcement
    await this.enforceContextBudget(conversation, systemPrompt, context.task, context.model);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversation.getMessages(),
      { role: 'user', content: buildUserContent(context) },
    ];

    /**
     * Helper to inject a safety directive into the system message at the
     * head of the messages array. The directive is prepended (rather than
     * appended) so the LLM sees it before the conversation history,
     * which maximises the chance it changes its strategy on the next
     * turn. The base system prompt is preserved untouched.
     */
    const injectSafetyDirective = (directive: string): void => {
      if (messages.length === 0 || messages[0]?.role !== 'system') {
        messages.unshift({ role: 'system', content: directive });
        return;
      }
      const first = messages[0]!;
      messages[0] = {
        role: 'system',
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
      const { AtomicStagingManager } = await import('../runtime/staging.js');
      AtomicStagingManager.garbageCollectAll(context.cwd);
    } catch {
      // Staging is best-effort cleanup; never block the run.
    }

    // Pillar 5 / Protection 2 — classify the task and gate
    // mutation tools. Read-only / review / analysis tasks run
    // without write_file, apply_patch, etc. visible to the LLM.
    const role = classifyExecutionRole(context.task);
    const activeTools = getActiveTools(role === 'READ_ONLY' ? 'READ_ONLY' : context.mode);
    if (role === 'READ_ONLY') {
      console.log(`${colors.dim}🛡  Read-only role — mutation tools hidden.${colors.reset}`);
    }
    const safety = loadConfig().preferences.safety;
    // Tool-call budget. The agent loop runs at most `softLimit` calls
    // by default; when `autoExtend` is on and the semantic loop
    // detector is not warning, the budget silently lifts to
    // `hardLimit`. The hard limit is the absolute ceiling.
    const budget = safety.toolCalls;
    let toolCallLimit = Math.max(1, budget.softLimit);
    const toolCallHardLimit = Math.max(toolCallLimit, budget.hardLimit);

    // Pillar 2 — semantic loop detector. Tracks per-file frequency so
    // an LLM which varies its search arguments but keeps hammering
    // the same file still trips. The composite LoopTrapDetector is
    // still wired in (callers may pass safety.loopTrap) so the two
    // detectors run in parallel; the semantic one covers the most
    // common accidental "stare at one file" failure mode.
    const semanticLoopDetector = new SemanticLoopDetector(safety.semanticLoopTrap);
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

    console.log(`\n${colors.cyan}${colors.bold}🤖 Agent working...${colors.reset}`);

    try {
      while (toolCallCount < toolCallLimit) {
        // Auto-extend the budget when the agent is at the soft limit
        // but the semantic loop detector is quiet — i.e. the work is
        // still progressing, not thrashing. Capped at hardLimit.
        if (
          budget.autoExtend &&
          toolCallCount + 1 >= toolCallLimit &&
          toolCallLimit < toolCallHardLimit &&
          pendingSafetyDirective === null
        ) {
          const previous = toolCallLimit;
          toolCallLimit = Math.min(toolCallHardLimit, toolCallLimit * 2);
          if (toolCallLimit > previous) {
            console.log(
              `${colors.dim}↳ tool-call budget extended ${previous} → ${toolCallLimit} (no loop detected)${colors.reset}`,
            );
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

        const spinner = promptsWrapper.spinner();
        spinner.start(`⚡ Agent is analyzing context paths… (turn ${toolCallCount + 1})`);
        dashboard.emit({
          type: 'turn-start',
          turnIndex: toolCallCount + 1,
          task: context.task,
        });
        let result;
        try {
          result = await this.client.chat(messages, context.model, {
            tools: activeTools,
            tool_choice: 'auto',
          });
          resolvedModel = result.model;
        } catch (err: any) {
          // Handle context overflow — auto-compact and retry once
          if (ConversationManager.isContextOverflowError(err)) {
            spinner.stop('🔄 Context overflow detected');
            console.log(`${colors.yellow}🔄 Context window full — auto-compacting...${colors.reset}`);
            const compacted = await conversation.compact(this.client, context.model);
            if (compacted) {
              const info = conversation.getLastCompactionInfo();
              console.log(`${colors.green}✓ Compacted: ${info?.messagesBefore ?? '?'} messages → summary + ${conversation.getMessageCount()} recent. ~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k tokens freed.${colors.reset}`);
              // Rebuild messages with compacted history
              messages.length = 0;
              messages.push(
                { role: 'system', content: systemPrompt },
                ...conversation.getMessages(),
                { role: 'user', content: buildUserContent(context) },
              );
              continue; // Retry the LLM call
            }
          }
          throw err;
        } finally {
          spinner.stop('🤖 Thought completed');
          dashboard.emit({
            type: 'status',
            message: `Turn ${toolCallCount + 1} complete`,
          });
        }

        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;

        // No tool calls → stream final response
        if (!result.tool_calls || result.tool_calls.length === 0) {
          const response = result.content ?? '';

          // Print the response (already received in non-streaming mode)
          if (response) {
            renderMarkdown(response);
          }

          conversation.addTurn(context.task, response);
          taskSession.finish('success', response);

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
          role: 'assistant',
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
            parsedArgs = { error: 'Failed to parse tool arguments' };
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
            if (verdict.state === 'warn') {
              pendingSafetyDirective = toSafetyAlertDirective(verdict);
              console.log(
                `${colors.yellow}⚠  Semantic loop warning: ${verdict.target} ` +
                `accessed ${verdict.count}× in the last ${verdict.windowSize} turns.${colors.reset}`,
              );
            } else if (verdict.state === 'hard-abort') {
              // Rollback any staged writes from this run before
              // throwing, so a runaway agent doesn't leave a
              // half-edited workspace behind.
              try {
                const { AtomicStagingManager } = await import('../runtime/staging.js');
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

          const allowed = await this.askPermission(toolCall.function.name, parsedArgs, rl, context.yes);

          let event: ToolCallEvent;
          if (!allowed) {
            console.log(`  ${colors.red}✗ Permission denied for ${toolCall.function.name}${colors.reset}`);
            dashboard.emit({
              type: 'tool-finish',
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? '',
              state: 'failed',
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
            dashboard.emit({
              type: 'tool-start',
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? '',
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
              type: 'tool-finish',
              tool: toolCall.function.name,
              target: parsedArgs.path ?? parsedArgs.from ?? '',
              state: event.result.startsWith('Error:') ? 'failed' : 'completed',
              durationMs: Date.now() - toolStart,
            });
          }

          if (event.isWrite && event.affectedPath) {
            if (!modifiedFiles.includes(event.affectedPath)) {
              modifiedFiles.push(event.affectedPath);
            }
          }

          let toolResult = event.result;
          if (toolResult.length > MAX_TOOL_RESULT_LENGTH) {
            toolResult =
              toolResult.slice(0, MAX_TOOL_RESULT_LENGTH) +
              `\n\n... (truncated, ${toolResult.length} total characters)`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          });

          toolCallCount++;
        }
      }

      console.log(
        `${colors.yellow}⚠  Tool call limit reached (${toolCallLimit}).${colors.reset}`,
      );

      conversation.addTurn(
        context.task,
        `Task processed with ${toolCallCount} tool calls.`,
      );

      const limitResponse = `Completed with ${toolCallCount} tool calls (limit reached).`;
      taskSession.finish('success', limitResponse);

      return {
        success: true,
        response: limitResponse,
        modifiedFiles,
        tokensUsed: totalUsage,
        toolCallCount,
        durationMs: Date.now() - startTime,
        model: resolvedModel,
      };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      taskSession.finish('error', errorMsg);
      throw error;
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
    rl?: readline.Interface,
    allowWithoutPrompt?: boolean,
  ): Promise<boolean> {
    const MUTATING_TOOLS = new Set([
      'write_file',
      'run_command',
      'apply_patch',
      'replace_range',
      'insert_after',
      'rename_file',
      'delete_file',
      'create_branch',
      'commit_changes',
      'push_branch',
      'create_pull_request',
    ]);
    if (!MUTATING_TOOLS.has(name)) {
      return true;
    }

    if (allowWithoutPrompt || this.allowAll) {
      return true;
    }

    if (rl) rl.pause();

    try {
      const message = formatPermissionPrompt(name, args);

      const choice = await promptsWrapper.select({
        message,
        options: [
          { value: 'yes', label: 'Yes, allow' },
          { value: 'no', label: 'No, deny' },
          { value: 'all', label: 'Yes to all (trust session)' },
        ],
        initialValue: 'yes',
      });

      if (promptsWrapper.isCancel(choice) || choice === 'no') {
        return false;
      }
      if (choice === 'all') {
        this.allowAll = true;
        return true;
      }
      return choice === 'yes';
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
  ): Promise<{ responseText: string; resolvedModel: string }> {
    let fullText = '';
    let resolvedModel = model;
    const policy = loadConfig().preferences.resilience?.streamResume ?? 'auto';
    const maxResumeAttempts =
      loadConfig().preferences.resilience?.maxResumeAttempts ?? 3;

    const stream = policy === 'auto'
      ? this.client.chatStreamWithResume(messages, model, {}, maxResumeAttempts)
      : this.client.chatStream(messages, model);

    const renderer = new MarkdownStreamRenderer();
    // Reasoning / chain-of-thought is suppressed by default. Models
    // that emit `<think>` blocks or `reasoning_content` deltas are
    // routed through here; the user only sees a short status line.
    // Set DEBUG=1 or pass --verbose to render the raw thinking dim
    // inline so developers can still inspect it.
    const showThinking =
      !!process.env.DEBUG || !!process.env.VERBOSE || process.argv.includes('--verbose');
    let thinkingAnnounced = false;

    for await (const chunk of stream) {
      if (chunk.type === 'content' && chunk.content) {
        renderer.write(chunk.content);
        fullText += chunk.content;
      }
      if (chunk.type === 'thinking' && chunk.thinking) {
        if (showThinking) {
          // Dim secondary colour so the thought stream is visually
          // subordinate to the actual response.
          process.stdout.write(`${colors.dim}${chunk.thinking}${colors.reset}`);
        } else if (!thinkingAnnounced) {
          process.stdout.write(`  ${colors.dim}⚡ Agent is reasoning…${colors.reset}\n`);
          thinkingAnnounced = true;
        }
      }
      if (chunk.type === 'done') {
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
      if (!fullText.endsWith('\n')) renderer.write('\n');
      renderer.flush();
    }

    return { responseText: fullText, resolvedModel };
  }

  private async executePureChatStream(
    task: string,
    conversation: ConversationManager,
    context: AgentContext,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    
    const repoMap = buildRepoMap(context.cwd);
    const systemPrompt = buildSystemPrompt(repoMap, context, false);

    // Auto-compact before chat if context is near limit
    await this.autoCompactIfNeeded(conversation, systemPrompt, task, context.model);
    // Pillar 4 — proactive budget enforcement
    await this.enforceContextBudget(conversation, systemPrompt, task, context.model);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversation.getMessages(),
      { role: 'user', content: task },
    ];

    const streamRes = await this.streamResponse(messages, context.model, totalUsage);
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

    const estimatedTokens = conversation.estimateNextRequestTokens(systemPrompt, userMessage);
    const limit = conversation.getContextLimit();
    console.log(`\n${colors.yellow}🔄 Context approaching limit (${(estimatedTokens / 1000).toFixed(0)}k / ${(limit / 1000).toFixed(0)}k tokens) — auto-compacting...${colors.reset}`);

    const success = await conversation.compact(this.client, model);
    if (success) {
      const info = conversation.getLastCompactionInfo();
      const newEstimate = conversation.estimateNextRequestTokens(systemPrompt, userMessage);
      console.log(
        `${colors.green}✓ Compacted: ${info?.messagesBefore ?? '?'} messages → summary + ${conversation.getMessageCount()} recent messages. ` +
        `~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k tokens freed (${(newEstimate / 1000).toFixed(0)}k / ${(limit / 1000).toFixed(0)}k now).${colors.reset}`
      );
    } else {
      console.log(`${colors.dim}[Context] Could not compact further. Proceeding with current context.${colors.reset}`);
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
    const policy = config.preferences.resilience?.contextBudget ?? 'auto';
    if (policy === 'never') {
      return { trimmed: false, compacted: false, tokensAfter: 0 };
    }

    const limit = conversation.getContextLimit();
    const ratio = config.preferences.resilience?.contextBudgetRatio ?? 0.8;
    const maxTokens = Math.max(1, Math.floor(limit * ratio));

    const { trimmed, report } = conversation.enforceBudget(maxTokens, model);
    if (!trimmed) {
      return { trimmed: false, compacted: false, tokensAfter: report.tokensAfter };
    }

    console.log(
      `${colors.dim}[ContextBudget] ${report.tokensAfter} tokens after ` +
      `${report.actions.join(' → ')} (was ${report.tokensBefore}).${colors.reset}`
    );

    recordTelemetry(
      telemetry.contextBudget({
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
        actions: [...report.actions],
        markedForCompaction: report.markForCompaction,
      }),
    );

    if (report.markForCompaction && policy === 'auto') {
      // Defer to the existing auto-compaction path which produces a
      // structured LLM-generated summary.
      await this.autoCompactIfNeeded(conversation, systemPrompt, userMessage, model);
      const reEstimated = conversation.estimateNextRequestTokens(systemPrompt, userMessage);
      return { trimmed: true, compacted: true, tokensAfter: reEstimated };
    }

    return { trimmed: true, compacted: false, tokensAfter: report.tokensAfter };
  }

  /** Proxy health check passthrough. */
  async ping(): Promise<boolean> {
    return this.client.ping();
  }
}
