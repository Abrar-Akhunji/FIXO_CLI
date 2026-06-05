/**
 * Single-Agent with Tool Calling — replaces the 7-stage pipeline.
 * One agent, 5 tools, 2–3 LLM calls for most tasks instead of 6+.
 *
 * Architecture:
 *   User Input → Complexity Check → Agentic Tool Loop → Result
 *   (trivial queries skip the tool loop entirely)
 */
import type { ChatMessage, TokenUsage } from '../shared/types.js';
import { AgentClient, type ChatResult, type StreamChunk } from './agent-client.js';
import { ConversationManager } from './conversation.js';
import { getActiveTools, TOOL_DEFINITIONS, executeTool, type ToolCallEvent } from './tool-executor.js';
import { isTrivialQuery } from '../planner.js';
import { buildRepoMap } from './repo-map.js';
import type { AgentContext, AgentResult } from '../types.js';
import { loadConfig } from '../config.js';
import * as p from '@clack/prompts';
export const promptsWrapper = {
  select: p.select,
  confirm: p.confirm,
  spinner: p.spinner,
  isCancel: p.isCancel,
};
import type readline from 'readline';
import { TaskSession } from '../runtime/task-session.js';

/* ──────────────────────── Constants ──────────────────────── */

const MAX_TOOL_CALLS = 25;
const MAX_TOOL_RESULT_LENGTH = 30_000;

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
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

/* ──────────────────────── System Prompt ──────────────────────── */

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
      `2. Write complete file contents — never use placeholders like "// ... rest of the file".`,
      `3. After making changes, run the verification command if one is configured.`,
      `4. Keep your text responses concise. Focus on what you did and why.`,
      `5. If the task is ambiguous, ask a clarifying question instead of guessing.`,
      `6. Preserve existing code comments and formatting unless asked to change them.`,
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

  // Add repo map
  parts.push(``, repoMap);

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
        { role: 'user', content: context.task },
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
      { role: 'user', content: context.task },
    ];

    const taskSession = new TaskSession({
      cwd: context.cwd,
      task: context.task,
      model: context.model,
      policy: context.policy,
    });

    console.log(`\n${colors.cyan}${colors.bold}🤖 Agent working...${colors.reset}`);

    try {
      while (toolCallCount < MAX_TOOL_CALLS) {
        const spinner = promptsWrapper.spinner();
        spinner.start(`🤖 Agent thinking (turn ${toolCallCount + 1})...`);
        let result;
        try {
          result = await this.client.chat(messages, context.model, {
            tools: getActiveTools(context.mode),
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
                { role: 'user', content: context.task },
              );
              continue; // Retry the LLM call
            }
          }
          throw err;
        } finally {
          spinner.stop('🤖 Thought completed');
        }

        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;

        // No tool calls → stream final response
        if (!result.tool_calls || result.tool_calls.length === 0) {
          const response = result.content ?? '';

          // Print the response (already received in non-streaming mode)
          if (response) {
            console.log(`\n${response}`);
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

          const allowed = await this.askPermission(toolCall.function.name, parsedArgs, rl, context.yes);

          let event: ToolCallEvent;
          if (!allowed) {
            console.log(`  ${colors.red}✗ Permission denied for ${toolCall.function.name}${colors.reset}`);
            event = {
              tool: toolCall.function.name,
              args: parsedArgs,
              result: `Error: User denied permission to execute ${toolCall.function.name}.`,
              isWrite: false,
            };
          } else {
            event = await executeTool(
              toolCall.function.name,
              parsedArgs,
              context.cwd,
              this.verbose,
              {
                session: taskSession,
                policy: context.policy,
                allowWithoutPrompt: context.yes,
              },
            );
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
        `${colors.yellow}⚠  Tool call limit reached (${MAX_TOOL_CALLS}).${colors.reset}`,
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
   * Prompts for write_file and run_command.
   */
  private async askPermission(
    name: string,
    args: Record<string, string>,
    rl?: readline.Interface,
    allowWithoutPrompt?: boolean,
  ): Promise<boolean> {
    if (name !== 'write_file' && name !== 'run_command') {
      return true;
    }

    if (allowWithoutPrompt || this.allowAll) {
      return true;
    }

    if (rl) rl.pause();

    try {
      let message = '';
      if (name === 'write_file') {
        const filepath = args.path || 'unknown path';
        message = `Allow write to ${colors.cyan}${colors.bold}${filepath}${colors.reset}?`;
      } else if (name === 'run_command') {
        const command = args.command || 'unknown command';
        message = `Allow command execution: ${colors.yellow}${colors.bold}${command}${colors.reset}?`;
      }

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

    for await (const chunk of stream) {
      if (chunk.type === 'content' && chunk.content) {
        process.stdout.write(chunk.content);
        fullText += chunk.content;
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
      process.stdout.write('\n');
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
