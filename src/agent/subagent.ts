/**
 * subagent.ts — Isolated WorkerAgent driver.
 *
 * Phase 3.2: lets the parent agent delegate a sub-task to a
 * fresh WorkerAgent whose conversation history is *not* shared
 * with the parent. The subagent runs in BUILD mode (mutating
 * allowed) regardless of the parent's mode, and returns a
 * structured {@link SubagentResult} whose `transcript` field
 * carries only the final summary — never the raw tool log —
 * so the parent's context never bloats.
 *
 * Safety:
 *   - `selectedFiles` is replaced with the caller-supplied
 *     `contextFiles` (default: empty). The parent cannot leak
 *     its own pin-set into the subagent.
 *   - The subagent always runs in BUILD mode and inherits the
 *     parent's `cwd` and `policy`.
 *   - The subagent's own policy/permission engine still gates
 *     every tool call — there is no escape hatch.
 *   - If `runInBackground` is true, the spawn is fire-and-forget
 *     and a `jobId` is returned. The caller can poll via the
 *     shared BackgroundJobRegistry (Phase 3.1).
 */
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../types.js';
import { WorkerAgent } from './worker-agent.js';
import { recordTelemetry, telemetry } from './telemetry.js';

export type SubagentType =
  | 'general-purpose'
  | 'statusline-setup'
  | 'Explore'
  | 'Plan';

export interface SubagentRequest {
  task: string;
  type: SubagentType;
  /** Files the subagent is allowed to read for context. Default: []. */
  contextFiles?: string[];
  /** Spawn fire-and-forget and return a jobId. Default: false. */
  runInBackground?: boolean;
  /** Whether to clean up the subagent's session on exit. Default: 'none'. */
  cleanup?: 'session' | 'none';
  /** Per-subagent tool-call cap. Default: 15 (matches WorkerAgent). */
  maxLocalToolCalls?: number;
}

export interface SubagentResult {
  success: boolean;
  /** The subagent's final natural-language summary. */
  summary: string;
  /** Token usage (parent's bill). */
  tokensUsed: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Number of tool calls the subagent made. */
  toolCallCount: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Subagent type used. */
  type: SubagentType;
  /**
   * Concatenated *user-visible* tool outcomes. The raw tool
   * log stays inside the subagent. When the caller sets
   * `summaryOnly: true` (default), this field contains only
   * the final assistant message.
   */
  transcript: string;
  /** When `runInBackground` was true, the jobId to poll. */
  jobId?: string;
}

/**
 * Internal options the spawn site can set. `summaryOnly` and
 * `cleanHistory` are locked on for Phase 3.2 (no escape hatch).
 */
interface InternalOptions {
  summaryOnly: boolean;
  cleanHistory: boolean;
}

const DEFAULT_INTERNAL_OPTIONS: InternalOptions = {
  summaryOnly: true,
  cleanHistory: true,
};

const MAX_LOCAL_TOOL_CALLS_DEFAULT = 15;

/**
 * Spawn a subagent. Returns immediately when `runInBackground`
 * is true; otherwise awaits the subagent's completion and
 * returns its final summary.
 */
export async function spawnSubagent(
  req: SubagentRequest,
  parentCtx: AgentContext,
  internalOpts: Partial<InternalOptions> = {},
): Promise<SubagentResult> {
  const opts: InternalOptions = { ...DEFAULT_INTERNAL_OPTIONS, ...internalOpts };
  const start = Date.now();
  const id = `subagent_${randomUUID().slice(0, 8)}`;
  // The subagent inherits the parent's cwd and policy but
  // gets a *fresh* AgentContext. selectedFiles is replaced
  // with the caller's contextFiles (default empty) so the
  // parent cannot leak its pin-set.
  const subagentCtx: AgentContext = {
    task: req.task,
    model: parentCtx.model,
    cwd: parentCtx.cwd,
    verbose: parentCtx.verbose,
    selectedFiles: req.contextFiles ? [...req.contextFiles] : [],
    systemPromptOverride: undefined, // never inherit the parent's override
    checkCommand: undefined,
    policy: parentCtx.policy,
    yes: parentCtx.yes,
    // Phase 3.2 hard rule: subagents are always mutating.
    mode: 'BUILD',
  };
  if (req.runInBackground) {
    // Fire-and-forget. The caller polls by jobId.
    void runSubagentInBackground(id, req, subagentCtx, opts, start);
    return {
      success: true,
      summary: '(subagent running in background)',
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
      type: req.type,
      transcript: '',
      jobId: id,
    };
  }
  return await runSubagentInline(id, req, subagentCtx, opts, start);
}

async function runSubagentInline(
  id: string,
  req: SubagentRequest,
  subagentCtx: AgentContext,
  _opts: InternalOptions,
  start: number,
): Promise<SubagentResult> {
  const subtask = {
    id,
    title: req.task.slice(0, 80),
    description: req.task,
    persona: 'code' as const,
    dependencies: [],
    files: req.contextFiles ?? [],
    status: 'running' as const,
  };
  const worker = new WorkerAgent(subagentCtx.verbose);
  const subtaskBudget = 15;
  try {
    const inner = await worker.run(subagentCtx, subtask, subtaskBudget);
    const durationMs = Date.now() - start;
    const tokensUsed = inner.tokensUsed;
    const summary = extractSummary(inner.output);
    recordTelemetry(
      telemetry.subagentSummary({
        taskType: req.type,
        inputTokens: tokensUsed.prompt_tokens,
        outputTokens: tokensUsed.completion_tokens,
        durationMs,
      }),
    );
    return {
      success: inner.success,
      summary,
      tokensUsed,
      toolCallCount: inner.toolCallCount,
      durationMs,
      type: req.type,
      transcript: opts_transcript(inner.output, summary),
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    recordTelemetry(
      telemetry.subagentSummary({
        taskType: req.type,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - start,
      }),
    );
    return {
      success: false,
      summary: `Subagent failed: ${msg}`,
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: Date.now() - start,
      type: req.type,
      transcript: '',
    };
  }
}

async function runSubagentInBackground(
  id: string,
  req: SubagentRequest,
  subagentCtx: AgentContext,
  opts: InternalOptions,
  start: number,
): Promise<void> {
  try {
    const result = await runSubagentInline(id, req, subagentCtx, opts, start);
    // Stash the result in a small global in-memory cache so
    // `/jobs` or a future `poll_subagent` can read it back.
    backgroundSubagentResults.set(id, result);
  } catch (err) {
    backgroundSubagentResults.set(id, {
      success: false,
      summary: `Subagent crashed: ${(err as Error).message}`,
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: Date.now() - start,
      type: req.type,
      transcript: '',
    });
  }
}

const backgroundSubagentResults = new Map<string, SubagentResult>();

/** Read the latest result for a background subagent. */
export function getBackgroundSubagentResult(jobId: string): SubagentResult | null {
  return backgroundSubagentResults.get(jobId) ?? null;
}

/** Clear the background subagent cache (test-only). */
export function _resetBackgroundSubagents(): void {
  backgroundSubagentResults.clear();
}

/**
 * Build the subagent's `AgentContext` from the parent context
 * and a request. Exposed for testability — the actual subagent
 * is constructed inside `spawnSubagent`.
 *
 * Invariants locked by Phase 3.2:
 *   - `mode` is forced to 'BUILD'
 *   - `selectedFiles` is replaced by `req.contextFiles` (or [])
 *   - `systemPromptOverride` is dropped
 *   - `cwd`, `policy`, `yes`, `model`, `verbose` are inherited
 */
export function buildSubagentContext(
  req: SubagentRequest,
  parentCtx: AgentContext,
): AgentContext {
  return {
    task: req.task,
    model: parentCtx.model,
    cwd: parentCtx.cwd,
    verbose: parentCtx.verbose,
    selectedFiles: req.contextFiles ? [...req.contextFiles] : [],
    systemPromptOverride: undefined,
    checkCommand: undefined,
    policy: parentCtx.policy,
    yes: parentCtx.yes,
    mode: 'BUILD',
  };
}

/* ──────────────────────── helpers ──────────────────────── */

function extractSummary(rawOutput: string): string {
  // The WorkerAgent returns the assistant's final `content`
  // field. When `summaryOnly` is on, this is the only piece
  // of output the parent gets to see. We do *not* parse the
  // raw output further — that would risk leaking tool log.
  return rawOutput.trim();
}

function opts_transcript(rawOutput: string, summary: string): string {
  // When `summaryOnly` is true, transcript === summary. We
  // still pass the raw output as a fallback so the parent
  // can recover more context if it asks for it explicitly.
  return summary.length > 0 ? summary : rawOutput;
}
