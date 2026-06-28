/**
 * Context Budget — proactive context-window enforcement.
 *
 * Pillar 4 of the resilience refactor. Goal: never let the agent send
 * a request that the upstream provider will reject with a 413 / 400
 * "context length exceeded" error. We do this by counting the exact
 * (or near-exact) token cost of the next request right before sending
 * it, and applying a tiered trim strategy if it would overflow.
 *
 * The strategy, in order of severity:
 *
 *   1. `pruneToolOutputs`     — drop the body of stale `tool` messages
 *                               older than the last TAIL turn-pair.
 *   2. `dropOldestTurns`      — splice out the oldest user/assistant
 *                               turn-pairs, preserving at least
 *                               MIN_MESSAGES_TO_KEEP.
 *   3. `truncateToolArgs`     — clip the `arguments` JSON of any
 *                               remaining tool_calls to a hard cap.
 *   4. `markForCompaction`    — give up trimming and return a
 *                               `markForCompaction: true` flag so the
 *                               caller can call `ConversationManager.compact()`,
 *                               which summarises the old turns via an
 *                               LLM call.
 *
 * The enforcer is intentionally stateless and side-effect-free at the
 * level of *messages*; it returns a new trimmed array and a report
 * describing what was done. `ConversationManager` applies the changes
 * to its own `history` field. This keeps the enforcer pure and easy
 * to unit-test.
 */

import type { ChatMessage } from "../shared/types.js";
import { countMessagesTokens, countTokens } from "./tokenizer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity tiers applied in order, from cheapest to most invasive. */
export type BudgetAction =
  | "none"
  | "prune-tool-outputs"
  | "drop-oldest-turns"
  | "truncate-tool-args"
  | "mark-for-compaction";

/** Full report returned by {@link ContextBudgetEnforcer.enforce}. */
export interface BudgetReport {
  /** Tokens measured before the enforcer ran. */
  readonly tokensBefore: number;
  /** Tokens measured after the enforcer ran. */
  readonly tokensAfter: number;
  /** Ordered list of actions that were applied. */
  readonly actions: BudgetAction[];
  /** True if the caller should trigger LLM-based compaction. */
  readonly markForCompaction: boolean;
  /** True if the final token count is within budget. */
  readonly withinBudget: boolean;
}

/** Strategy knob for callers that need to skip the cheaper tiers. */
export interface BudgetOptions {
  /** Hard cap on the trimmed token count. */
  readonly maxTokens: number;
  /** Model identifier used for BPE encoder selection. */
  readonly model?: string | null;
  /**
   * Number of most-recent messages to leave untouched. Two turn-pairs
   * (user+assistant+user+assistant) are kept verbatim by default. Must
   * be >= 2.
   */
  readonly tailMessages?: number;
  /**
   * Maximum characters of a tool-call `arguments` JSON to keep after
   * truncation. Defaults to 2,000 — same as the existing heuristic.
   */
  readonly maxToolArgChars?: number;
}

// ---------------------------------------------------------------------------
// TokenCounter — thin façade used by both the enforcer and external tests.
// ---------------------------------------------------------------------------

export class TokenCounter {
  constructor(private readonly model?: string | null) {}

  /** Count tokens in a single string. */
  count(text: string): number {
    return countTokens(text, this.model);
  }

  /** Count tokens in a list of messages (with per-message overhead). */
  countMessages(messages: ReadonlyArray<ChatMessage>): number {
    return countMessagesTokens(messages, this.model);
  }
}

// ---------------------------------------------------------------------------
// ContextBudgetEnforcer
// ---------------------------------------------------------------------------

const MIN_TAIL_MESSAGES = 2;
const DEFAULT_MAX_TOOL_ARG_CHARS = 2_000;

export class ContextBudgetEnforcer {
  private readonly counter: TokenCounter;

  constructor(model?: string | null) {
    this.counter = new TokenCounter(model);
  }

  /**
   * Enforce a token budget on a message list, returning a new list and
   * a report describing what was changed.
   *
   * The original `messages` array is NEVER mutated; the result is a
   * deep-enough copy that callers can adopt safely.
   */
  enforce(
    messages: ReadonlyArray<ChatMessage>,
    options: BudgetOptions,
  ): {
    messages: ChatMessage[];
    report: BudgetReport;
  } {
    const tailMessages = Math.max(MIN_TAIL_MESSAGES, options.tailMessages ?? 4);
    const maxToolArgChars =
      options.maxToolArgChars ?? DEFAULT_MAX_TOOL_ARG_CHARS;
    const actions: BudgetAction[] = [];

    let working: ChatMessage[] = messages.map(cloneMessage);
    const tokensBefore = this.counter.countMessages(messages);
    let tokens = this.counter.countMessages(working);

    const compactionThreshold = options.maxTokens * 0.6;

    if (tokens <= options.maxTokens) {
      const markForCompaction = tokens > compactionThreshold;
      const finalActions = markForCompaction
        ? (["mark-for-compaction"] as BudgetAction[])
        : (["none"] as BudgetAction[]);
      return {
        messages: working,
        report: {
          tokensBefore,
          tokensAfter: tokens,
          actions: finalActions,
          markForCompaction,
          withinBudget: true,
        },
      };
    }

    // Tier 1: prune tool outputs in non-tail messages.
    working = this.pruneToolOutputs(working, tailMessages);
    const tokensAfterTier1 = this.counter.countMessages(working);
    if (tokensAfterTier1 < tokens) actions.push("prune-tool-outputs");
    tokens = tokensAfterTier1;
    if (tokens <= options.maxTokens) {
      return finish(
        working,
        tokensBefore,
        tokens,
        actions,
        compactionThreshold,
      );
    }

    // Tier 2: drop oldest turn-pairs.
    const lengthBeforeTier2 = working.length;
    working = this.dropOldestTurns(working, tailMessages);
    if (working.length < lengthBeforeTier2) actions.push("drop-oldest-turns");
    tokens = this.counter.countMessages(working);
    if (tokens <= options.maxTokens) {
      return finish(
        working,
        tokensBefore,
        tokens,
        actions,
        compactionThreshold,
      );
    }

    // Tier 3: truncate remaining tool-call arguments.
    const beforeTier3 = JSON.stringify(working);
    working = this.truncateToolArgs(working, maxToolArgChars);
    const afterTier3 = JSON.stringify(working);
    if (afterTier3.length < beforeTier3.length)
      actions.push("truncate-tool-args");
    tokens = this.counter.countMessages(working);
    if (tokens <= options.maxTokens) {
      return finish(
        working,
        tokensBefore,
        tokens,
        actions,
        compactionThreshold,
      );
    }

    // Tier 4: nothing else we can do without an LLM. Tell the caller to
    // compact (summarise) the oldest turns.
    return {
      messages: working,
      report: {
        tokensBefore,
        tokensAfter: tokens,
        actions: [...actions, "mark-for-compaction"],
        markForCompaction: true,
        withinBudget: false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Strategy tiers
  // -------------------------------------------------------------------------

  private pruneToolOutputs(
    messages: ChatMessage[],
    tailMessages: number,
  ): ChatMessage[] {
    const keepFrom = Math.max(0, messages.length - tailMessages);
    return messages.map((m, i) => {
      if (i >= keepFrom) return m;
      if (
        m.role === "tool" &&
        m.content &&
        m.content.length > DEFAULT_MAX_TOOL_ARG_CHARS
      ) {
        return {
          ...m,
          content:
            m.content.slice(0, DEFAULT_MAX_TOOL_ARG_CHARS) +
            `\n\n... [pruned: ${m.content.length} → ${DEFAULT_MAX_TOOL_ARG_CHARS} chars]`,
        };
      }
      return m;
    });
  }

  private dropOldestTurns(
    messages: ChatMessage[],
    tailMessages: number,
  ): ChatMessage[] {
    // We must drop *complete* turn-pairs to keep the conversation
    // coherent. Walk forward from the head, counting turn-pairs
    // (one user + one assistant = one pair). Drop pairs as long as
    // the remaining array is still at least `tailMessages` long.
    if (messages.length <= tailMessages) return messages;
    let userCount = 0;
    let dropUntil = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") userCount += 1;
      // Each "user" beyond the first marks the start of a new turn-
      // pair. If we have at least one user and dropping everything up
      // to and including the assistant that follows still leaves the
      // tail intact, we can cut.
      if (
        userCount >= 1 &&
        i + 1 < messages.length &&
        messages[i + 1].role === "assistant"
      ) {
        // Proposed cut: keep everything from i+2 onward.
        const remaining = messages.length - (i + 2);
        if (remaining >= tailMessages) {
          dropUntil = i + 2;
        } else {
          break;
        }
      }
    }
    return dropUntil > 0
      ? messages.slice(dropUntil)
      : messages.slice(-tailMessages);
  }

  private truncateToolArgs(
    messages: ChatMessage[],
    maxChars: number,
  ): ChatMessage[] {
    return messages.map((m) => {
      if (m.role !== "assistant" || !m.tool_calls) return m;
      const toolCalls = m.tool_calls.map((tc) => {
        if (!tc.function || tc.function.arguments.length <= maxChars) return tc;
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: tc.function.arguments.slice(0, maxChars) + '..."}',
          },
        };
      });
      return { ...m, tool_calls: toolCalls };
    });
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function cloneMessage(m: ChatMessage): ChatMessage {
  return {
    ...m,
    content: m.content ?? null,
    tool_calls: m.tool_calls
      ? m.tool_calls.map((tc) => ({
          ...tc,
          function: { ...tc.function },
        }))
      : undefined,
  };
}

function finish(
  messages: ChatMessage[],
  tokensBefore: number,
  tokensAfter: number,
  actions: BudgetAction[],
  compactionThreshold: number,
): { messages: ChatMessage[]; report: BudgetReport } {
  const markForCompaction = tokensAfter > compactionThreshold;
  if (markForCompaction && !actions.includes("mark-for-compaction")) {
    actions = [...actions, "mark-for-compaction"];
  }
  return {
    messages,
    report: {
      tokensBefore,
      tokensAfter,
      actions,
      markForCompaction,
      withinBudget: true,
    },
  };
}
