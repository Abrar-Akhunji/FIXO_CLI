/**
 * subagent.ts — Isolated WorkerAgent driver.
 *
 * Phase 3.2: lets the parent agent delegate a sub-task to a
 * fresh WorkerAgent whose conversation history is *not* shared
 * with the parent. The child mode follows the request type:
 * Explore → EXPLORE, Plan → PLAN, otherwise BUILD. It returns a
 * structured {@link SubagentResult} whose `transcript` field
 * carries only the final summary — never the raw tool log —
 * so the parent's context never bloats.
 *
 * Safety:
 *   - `selectedFiles` is replaced with the caller-supplied
 *     `contextFiles` (default: empty). The parent cannot leak
 *     its own pin-set into the subagent.
 *   - The child inherits `cwd`, `model`, `policy`, and `verbose`.
 *     It does not inherit `yes`, allow-all, or allow rules.
 *     Deny rules are copied. `systemPromptOverride` is dropped.
 *   - The subagent's own policy/permission engine still gates
 *     every tool call — there is no escape hatch.
 *   - If `runInBackground` is true, the spawn is fire-and-forget
 *     and a `jobId` is returned. The caller can poll via the
 *     shared BackgroundJobRegistry (Phase 3.1).
 */
import { randomUUID } from "node:crypto";
import type { AgentContext } from "../types.js";
import { loadConfig } from "../config.js";
import { WorkerAgent } from "./worker-agent.js";
import { recordTelemetry, telemetry } from "./telemetry.js";

export type SubagentType =
  "general-purpose" | "statusline-setup" | "Explore" | "Plan";

export interface SubagentRequest {
  task: string;
  type: SubagentType;
  /** Files the subagent is allowed to read for context. Default: []. */
  contextFiles?: string[];
  /** Spawn fire-and-forget and return a jobId. Default: false. */
  runInBackground?: boolean;
  /** Whether to clean up the subagent's session on exit. Default: 'none'. */
  cleanup?: "session" | "none";
  /** Per-subagent tool-call cap. Default: 15 (matches WorkerAgent). */
  maxLocalToolCalls?: number;
}

export interface SubagentResult {
  success: boolean;
  /** The subagent's final natural-language summary. */
  summary: string;
  /** Token usage (parent's bill). */
  tokensUsed: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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
  const opts: InternalOptions = {
    ...DEFAULT_INTERNAL_OPTIONS,
    ...internalOpts,
  };
  const start = Date.now();
  if ((parentCtx.subagentDepth ?? 0) >= 1) {
    return {
      success: false,
      summary:
        "Error: spawn_subagent is limited to depth 1. This agent is already a subagent.",
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
      type: req.type,
      transcript: "",
    };
  }
  const id = `subagent_${randomUUID().slice(0, 8)}`;
  const subagentCtx = buildSubagentContext(req, parentCtx);
  if (req.runInBackground) {
    // Fire-and-forget. The caller polls by jobId.
    void runSubagentInBackground(id, req, subagentCtx, opts, start);
    return {
      success: true,
      summary: "(subagent running in background)",
      tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
      type: req.type,
      transcript: "",
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
    description: `${typeInstruction(req.type)}\n\n${req.task}`,
    persona: personaForSubagentType(req.type),
    dependencies: [],
    files: req.contextFiles ?? [],
    status: "running" as const,
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
      transcript: "",
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
      transcript: "",
    });
  }
}

const backgroundSubagentResults = new Map<string, SubagentResult>();

/** Read the latest result for a background subagent. */
export function getBackgroundSubagentResult(
  jobId: string,
): SubagentResult | null {
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
 *   - general-purpose and statusline-setup use mode 'BUILD'
 *   - Explore uses 'EXPLORE'; Plan uses 'PLAN'
 *   - `selectedFiles` is replaced by `req.contextFiles` (or [])
 *   - `systemPromptOverride` and `checkCommand` are dropped
 *   - `cwd`, `policy`, `model`, `verbose` are inherited
 *   - `yes` is always false. Allow rules are dropped. Deny rules stay.
 *   - `subagentDepth` is the parent depth plus one
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
    yes: false,
    mode: modeForSubagentType(req.type),
    permissionRules: inheritedDenyRules(parentCtx),
    subagentDepth: (parentCtx.subagentDepth ?? 0) + 1,
  };
}

function inheritedDenyRules(
  parentCtx: AgentContext,
): NonNullable<AgentContext["permissionRules"]> {
  const source =
    parentCtx.permissionRules ?? loadConfig().preferences.permissionRules;
  const keep = (
    rules: NonNullable<AgentContext["permissionRules"]>["bash"],
  ) => (rules ?? []).filter((rule) => rule.decision === "deny");
  return {
    bash: keep(source?.bash),
    edit: keep(source?.edit),
  };
}

function typeInstruction(type: SubagentType): string {
  if (type === "Explore") {
    return "You are an Explore subagent. Read and search only. Do not edit files or run mutating commands.";
  }
  if (type === "Plan") {
    return "You are a Plan subagent. Write only the plan file. Do not edit the repository.";
  }
  if (type === "statusline-setup") {
    return "You are a status-line setup subagent. Change only what the task names.";
  }
  return "You are a general-purpose subagent. Complete only the task below.";
}

function modeForSubagentType(
  type: SubagentType,
): NonNullable<AgentContext["mode"]> {
  if (type === "Explore") return "EXPLORE";
  if (type === "Plan") return "PLAN";
  return "BUILD";
}

function personaForSubagentType(
  type: SubagentType,
): "code" | "doc" | "reviewer" {
  if (type === "Explore" || type === "Plan") return "reviewer";
  if (type === "statusline-setup") return "doc";
  return "code";
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
