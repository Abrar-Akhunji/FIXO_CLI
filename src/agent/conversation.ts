/**
 * ConversationManager — manages multi-turn chat context for the FixO CLI agent.
 *
 * Provides automatic context window management inspired by OpenCode:
 *   1. Tracks estimated token usage per model's context window limit
 *   2. Auto-compacts when the next request would overflow the context
 *   3. Uses a structured summary template to preserve critical information
 *   4. Preserves the N most-recent turns verbatim for continuity
 *   5. Prunes old tool outputs to free space before full compaction
 */

import type { ChatMessage } from '../shared/types.js';
import type { AgentClient } from './agent-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known context window limits (input tokens) for models/providers.
 * These are conservative estimates — we leave headroom for output tokens.
 * Format: pattern → max input tokens (context minus output reservation).
 */
const MODEL_CONTEXT_LIMITS: Array<[RegExp, number]> = [
  // Google Gemini — huge contexts
  [/gemini-2\.5-flash/i, 900_000],
  [/gemini-2\.5-pro/i, 900_000],
  [/gemini-2\.0/i, 900_000],
  [/gemini/i, 900_000],
  // Groq — standard
  [/llama-3\.3-70b/i, 120_000],
  [/llama-4/i, 120_000],
  [/deepseek-r1/i, 120_000],
  [/compound/i, 120_000],
  [/gpt-oss/i, 120_000],
  // Cerebras
  [/qwen-3-235b/i, 8_000], // Very small on free tier
  [/llama3\.1-8b/i, 8_000],
  // SambaNova
  [/deepseek-v3/i, 120_000],
  [/qwen3-coder/i, 120_000],
  // Mistral
  [/mistral-large/i, 120_000],
  [/codestral/i, 250_000],
  [/devstral/i, 120_000],
  [/magistral/i, 120_000],
  // OpenRouter — varies by model
  [/openrouter/i, 120_000],
  // Cloudflare — depends on model
  [/cloudflare/i, 120_000],
  // Cohere
  [/command-r/i, 120_000],
  // Zen / NVIDIA
  [/zen|nvidia/i, 120_000],
];

/** Default context limit when model is unknown */
const DEFAULT_CONTEXT_LIMIT = 120_000;

/** Reserve this many tokens for the output response */
const OUTPUT_TOKEN_RESERVATION = 8_000;

/** Maximum token budget for conversation history (usable input space) */
const DEFAULT_MAX_TOKEN_BUDGET = 100_000;

/** Minimum number of individual messages to keep (2 turn-pairs = 4 messages). */
const MIN_MESSAGES_TO_KEEP = 4;

/** Number of recent turn-pairs to preserve verbatim during compaction */
const TAIL_TURNS = 2;

/** Maximum characters for tool output in old messages before truncation */
const TOOL_OUTPUT_MAX_CHARS = 2_000;

/** Structured summary template (inspired by OpenCode) */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown below. Keep every section even when empty.

## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

Rules:
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers.
- Do not mention the summary process or that context was compacted.`;

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
  private history: ChatMessage[] = [];
  private maxTokenBudget: number;
  private summary: string = '';
  private contextLimit: number = DEFAULT_CONTEXT_LIMIT;
  private _lastCompactionInfo: { messagesBefore: number; tokensFreed: number } | null = null;

  constructor(maxTokenBudget: number = DEFAULT_MAX_TOKEN_BUDGET) {
    this.maxTokenBudget = maxTokenBudget;
  }

  // ---------------------------------------------------------------------------
  // Model-aware context limits
  // ---------------------------------------------------------------------------

  /**
   * Auto-configure the context budget based on the model being used.
   * Call this whenever the model changes.
   */
  setContextLimit(model: string): void {
    for (const [pattern, limit] of MODEL_CONTEXT_LIMITS) {
      if (pattern.test(model)) {
        this.contextLimit = limit - OUTPUT_TOKEN_RESERVATION;
        this.maxTokenBudget = Math.min(this.maxTokenBudget, this.contextLimit);
        return;
      }
    }
    this.contextLimit = DEFAULT_CONTEXT_LIMIT - OUTPUT_TOKEN_RESERVATION;
  }

  getContextLimit(): number {
    return this.contextLimit;
  }

  /** Returns info about the last compaction (for UX display). */
  getLastCompactionInfo(): { messagesBefore: number; tokensFreed: number } | null {
    const info = this._lastCompactionInfo;
    this._lastCompactionInfo = null;
    return info;
  }

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  /**
   * Approximate token count for a piece of text.
   * Uses the common ~4-characters-per-token heuristic.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate tokens consumed by a single message, accounting for both its
   * `content` and any attached `tool_calls`.
   */
  private estimateMessageTokens(message: ChatMessage): number {
    const contentTokens = this.estimateTokens(message.content ?? '');
    const toolCallTokens = this.estimateTokens(
      JSON.stringify(message.tool_calls ?? []),
    );
    return contentTokens + toolCallTokens;
  }

  /**
   * Calculate the total estimated token count across the entire history.
   */
  getTotalTokens(): number {
    return this.history.reduce(
      (sum, msg) => sum + this.estimateMessageTokens(msg),
      0,
    );
  }

  /**
   * Estimate the total token count for the NEXT LLM request.
   * This is what actually matters for context overflow detection.
   */
  estimateNextRequestTokens(systemPrompt: string, userMessage: string): number {
    const systemTokens = this.estimateTokens(systemPrompt);
    const historyTokens = this.getTotalTokens();
    const userTokens = this.estimateTokens(userMessage);
    const summaryTokens = this.summary ? this.estimateTokens(this.summary) : 0;
    return systemTokens + summaryTokens + historyTokens + userTokens;
  }

  // ---------------------------------------------------------------------------
  // Mutation helpers
  // ---------------------------------------------------------------------------

  /**
   * Add a user message and the corresponding assistant response as a single
   * conversational turn, then prune if the budget is exceeded.
   */
  addTurn(userMessage: string, assistantResponse: string): void {
    this.history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantResponse },
    );
    this.pruneToFitBudget();
  }

  /**
   * Add a raw {@link ChatMessage} (useful for tool-call results or other
   * non-standard messages), then prune if the budget is exceeded.
   */
  addMessage(message: ChatMessage): void {
    this.history.push(message);
    this.pruneToFitBudget();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Return all messages for injection into the LLM context.
   * If a compacted summary exists, it is prepended as the first message.
   */
  getMessages(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    if (this.summary) {
      msgs.push({
        role: 'assistant',
        content: `[Previous conversation context]\n\n${this.summary}`,
      });
    }
    msgs.push(...this.history);
    return msgs;
  }

  /** Number of complete user/assistant turn pairs in the history. */
  getTurnCount(): number {
    return Math.floor(this.history.length / 2);
  }

  /** Total number of messages in history (excluding summary). */
  getMessageCount(): number {
    return this.history.length;
  }

  // ---------------------------------------------------------------------------
  // Pruning
  // ---------------------------------------------------------------------------

  /**
   * Remove the oldest user/assistant pairs until the total token estimate
   * fits within {@link maxTokenBudget}.
   */
  pruneToFitBudget(): void {
    while (
      this.getTotalTokens() > this.maxTokenBudget &&
      this.history.length > MIN_MESSAGES_TO_KEEP
    ) {
      let nextUserIndex = -1;
      for (let i = 1; i < this.history.length; i++) {
        if (this.history[i].role === 'user') {
          nextUserIndex = i;
          break;
        }
      }
      if (nextUserIndex !== -1 && (this.history.length - nextUserIndex) >= MIN_MESSAGES_TO_KEEP) {
        this.history.splice(0, nextUserIndex);
      } else {
        break;
      }
    }
  }

  /**
   * Prune large tool outputs in older messages to free context space.
   * Keeps the last TAIL_TURNS * 2 messages untouched.
   */
  pruneToolOutputs(): number {
    let freedChars = 0;
    const keepFrom = Math.max(0, this.history.length - TAIL_TURNS * 2);

    for (let i = 0; i < keepFrom; i++) {
      const msg = this.history[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > TOOL_OUTPUT_MAX_CHARS) {
        const original = msg.content.length;
        msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX_CHARS) +
          `\n\n... [truncated: ${original} → ${TOOL_OUTPUT_MAX_CHARS} chars to save context]`;
        freedChars += original - TOOL_OUTPUT_MAX_CHARS;
      }
      // Also truncate large assistant tool_calls arguments
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments && tc.function.arguments.length > TOOL_OUTPUT_MAX_CHARS * 2) {
            const original = tc.function.arguments.length;
            tc.function.arguments = tc.function.arguments.slice(0, TOOL_OUTPUT_MAX_CHARS) + '...}';
            freedChars += original - TOOL_OUTPUT_MAX_CHARS;
          }
        }
      }
    }

    return Math.ceil(freedChars / 4); // Return estimated tokens freed
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Clear all conversation history and summary. */
  clear(): void {
    this.history = [];
    this.summary = '';
  }

  // ---------------------------------------------------------------------------
  // Serialisation — session persistence / recovery
  // ---------------------------------------------------------------------------

  /** Export a deep copy of the raw history for external persistence. */
  exportHistory(): ChatMessage[] {
    return this.history.map((msg) => ({ ...msg }));
  }

  /**
   * Import a previously-exported history, replacing the current one.
   * Automatically prunes to fit the current token budget after import.
   */
  importHistory(messages: ChatMessage[]): void {
    this.history = messages.map((msg) => ({ ...msg }));
    this.pruneToFitBudget();
  }

  // ---------------------------------------------------------------------------
  // Compaction & Summarization
  // ---------------------------------------------------------------------------

  getSummary(): string {
    return this.summary;
  }

  setSummary(summary: string): void {
    this.summary = summary;
  }

  /**
   * Check if the conversation should be compacted before the next request.
   * Uses the estimated next request size vs the model's context limit.
   * If systemPrompt/userMessage are not provided, uses a simpler history-only check.
   */
  shouldCompact(systemPrompt?: string, userMessage?: string): boolean {
    if (this.history.length <= MIN_MESSAGES_TO_KEEP) return false;

    if (systemPrompt && userMessage) {
      // Predictive check: will the next request overflow the context window?
      const estimated = this.estimateNextRequestTokens(systemPrompt, userMessage);
      // Trigger compaction at 75% of context limit to leave headroom
      return estimated > this.contextLimit * 0.75;
    }

    // Fallback: simple history-based check
    return this.getTotalTokens() > this.maxTokenBudget * 0.7;
  }

  /**
   * Compact the conversation using a structured summary.
   * - Preserves the last TAIL_TURNS turn-pairs verbatim
   * - Summarizes everything else using the SUMMARY_TEMPLATE
   * - Prunes old tool outputs before summarizing
   *
   * Returns true if compaction succeeded.
   */
  async compact(client: AgentClient, model: string): Promise<boolean> {
    if (this.history.length <= MIN_MESSAGES_TO_KEEP) {
      return false;
    }

    const messagesBefore = this.history.length;
    const tokensBefore = this.getTotalTokens();

    // Step 1: Prune tool outputs to free immediate space
    this.pruneToolOutputs();

    // Step 2: Identify what to compact vs preserve
    // Preserve: last TAIL_TURNS turn-pairs (user+assistant = 2 messages each)
    const tailMessages = TAIL_TURNS * 2;
    const keepCount = Math.min(tailMessages, this.history.length);
    const toCompact = this.history.slice(0, this.history.length - keepCount);
    const preserved = this.history.slice(this.history.length - keepCount);

    if (toCompact.length === 0) {
      return false;
    }

    // Step 3: Format history for summarization
    const formattedHistory = toCompact
      .map((msg) => {
        const role = msg.role.toUpperCase();
        if (msg.role === 'tool') {
          const content = (msg.content ?? '').slice(0, 500);
          return `TOOL_RESULT (${msg.tool_call_id ?? 'unknown'}): ${content}`;
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const tools = msg.tool_calls.map(tc =>
            `  → ${tc.function?.name}(${(tc.function?.arguments ?? '').slice(0, 100)}...)`
          ).join('\n');
          return `${role}: ${msg.content || '(tool calls)'}\n${tools}`;
        }
        return `${role}: ${msg.content || '(empty)'}`;
      })
      .join('\n\n');

    // Step 4: Build compaction prompt
    const previousSummarySection = this.summary
      ? `Here is the previous summary to UPDATE (preserve still-true details, remove stale details, merge new facts):\n<previous-summary>\n${this.summary}\n</previous-summary>\n\n`
      : '';

    const compactionPrompt = `${previousSummarySection}Create a comprehensive summary from the conversation history above.\n\n${SUMMARY_TEMPLATE}`;

    try {
      const response = await client.chat(
        [
          {
            role: 'system',
            content: 'You are a technical context summarization engine. You produce structured summaries that preserve every critical fact needed to continue a coding conversation.',
          },
          {
            role: 'user',
            content: `Here is the conversation history to summarize:\n\n${formattedHistory}\n\n${compactionPrompt}`,
          },
        ],
        model,
        { max_tokens: 4000, agent_task_type: 'investigation', required_capabilities: ['fast'] }
      );

      this.summary = response.content?.trim() || '';

      // Replace history with only the preserved tail messages
      this.history = [...preserved];

      const tokensAfter = this.getTotalTokens() + this.estimateTokens(this.summary);
      this._lastCompactionInfo = {
        messagesBefore,
        tokensFreed: Math.max(0, tokensBefore - tokensAfter),
      };

      return true;
    } catch (error) {
      console.warn(`[Context Compaction] Failed to compact: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Check if an error indicates context window overflow from the provider.
   * If true, the caller should auto-compact and retry.
   */
  static isContextOverflowError(error: any): boolean {
    const msg = (error?.message ?? '').toLowerCase();
    return msg.includes('too many tokens')
      || msg.includes('context length')
      || msg.includes('context_length_exceeded')
      || msg.includes('maximum context')
      || msg.includes('token limit')
      || msg.includes('input too long')
      || msg.includes('request too large')
      || (msg.includes('413') && (msg.includes('token') || msg.includes('too large')))
      || (msg.includes('400') && msg.includes('token'));
  }
}


export interface SessionData {
  sessionId: string;
  timestamp: string;
  model: string;
  history: ChatMessage[];
  summary: string;
  modifiedFiles: string[];
  tokenUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigDir } from '../config.js';

export class SessionManager {
  static getSessionsDir(): string {
    const dir = path.join(getConfigDir(), 'sessions');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static saveSession(
    conversation: ConversationManager,
    model: string,
    modifiedFiles: string[],
    tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    sessionId?: string
  ): string {
    const id = sessionId || crypto.randomUUID();
    const dir = this.getSessionsDir();
    const filePath = path.join(dir, `session_${id}.json`);
    const data: SessionData = {
      sessionId: id,
      timestamp: new Date().toISOString(),
      model,
      history: conversation.exportHistory(),
      summary: conversation.getSummary(),
      modifiedFiles,
      tokenUsage,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return id;
  }

  static listSessions(): Array<{ sessionId: string; timestamp: string; model: string; messageCount: number; summary: string; totalTokens: number }> {
    const dir = this.getSessionsDir();
    const results: any[] = [];
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('session_') && file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
            const data = JSON.parse(raw) as SessionData;
            results.push({
              sessionId: data.sessionId,
              timestamp: data.timestamp,
              model: data.model,
              messageCount: data.history.length,
              summary: data.summary,
              totalTokens: data.tokenUsage?.total_tokens || 0,
            });
          } catch (err: any) {
            console.warn(`[Debug Warning] Failed to parse session file ${file}:`, err.message || err);
          }
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[Debug Warning] Failed to list sessions in ${dir}:`, err.message || err);
      }
    }
    return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  static loadSession(id: string): SessionData {
    const dir = this.getSessionsDir();
    const filePath = path.join(dir, `session_${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session file not found for ID: ${id}`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SessionData;
  }
}

