/**
 * task-router.ts — Phase 2.1 extraction.
 *
 * Before: the simple-vs-complex routing decision, the
 * `Orchestrator.plan()` invocation, the `.fixo/last-dag.json`
 * persistence, the `AgentPool.execute()` call, and the failure
 * rollback path all lived inline inside `src/ui/prompt.ts`'s REPL
 * handler. That made the routing path:
 *   - impossible to unit-test independently of the TUI,
 *   - impossible to reuse from a future `--headless` flag or web
 *     backend without copy-pasting 100+ lines,
 *   - fragile to safely touch for unrelated UI changes.
 *
 * After: the routing decision lives here. `prompt.ts` calls a single
 * `routeAndExecute()` and only handles rendering the result. The
 * router is UI-agnostic — every console line it prints is a
 * pass-through "what the user already saw" so the REPL experience is
 * byte-identical, but the *control flow* is no longer tangled with
 * the TUI.
 *
 * Phase 2.3 swaps `classifyComplexityHeuristic` for the LLM-backed
 * `classifyComplexityModel` inside this same function — a one-line
 * change that's a no-op for prompt.ts.
 *
 * Phase 0.0 incident: the rollback path here uses
 * `git.discardChangesIn(modifiedFiles)` instead of the (removed)
 * `discardUncommittedChanges()` — scoped rollback only, never a
 * full workspace wipe.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Interface as ReadlineInterface } from 'node:readline';

import { classifyComplexityHeuristic, classifyComplexityModel } from '../planner.js';
import { GitManager } from '../git/git-manager.js';
import type { SingleAgent } from './single-agent.js';
import type { ConversationManager } from './conversation.js';
import type { AgentContext, AgentResult, ProjectConfig } from '../types.js';
import { colors as c } from '../ui/colors.js';

export interface RouteDeps {
  /**
   * Pre-constructed single-agent instance. The router uses it only
   * on the simple path; the complex path constructs its own
   * Orchestrator + AgentPool internally.
   */
  agent: SingleAgent;
  conversation: ConversationManager;
  rl: ReadlineInterface;
  projectConfig?: ProjectConfig;
  verbose: boolean;
  /**
   * Called immediately before {@link SingleAgent.runStreaming} starts
   * on the simple path. The REPL uses this to set `isTaskRunning` /
   * `currentRunningAgent` for the `/cancel` slash-command and the
   * status bar — UI state that doesn't belong in core routing.
   * Never called on the complex path.
   */
  onSimplePathStart?: (agent: SingleAgent) => void;
  /**
   * Called after the simple path returns (success or error). Pairs
   * with {@link onSimplePathStart}. The router additionally invokes
   * `agent.reset()` itself — that's domain behaviour, not UI state.
   */
  onSimplePathEnd?: (agent: SingleAgent) => void;
}

/**
 * Outcome of a routing decision plus the {@link AgentResult} the
 * caller would have observed inline.
 */
export interface RouteResult {
  result: AgentResult;
  /** Which path actually ran. Lets the caller decide whether to skip
   *  post-run UI affordances (e.g. the planner aborts execution in
   *  PLAN mode and returns early). */
  route: 'simple' | 'complex' | 'plan-mode-deferred';
}

/**
 * Decide simple-vs-complex and execute the task. UI-agnostic.
 */
export async function routeAndExecute(
  input: string,
  context: AgentContext,
  deps: RouteDeps,
): Promise<RouteResult> {
  // Phase 2.3 — LLM-backed classifier. Short-circuits to heuristic
  // for trivial / unambiguously-complex inputs, so we don't pay a
  // network call on every keystroke. Network failure → heuristic
  // fallback so routing still works offline.
  let classification;
  try {
    classification = await classifyComplexityModel(input, context.model, deps.agent.getClient());
  } catch {
    // safe: classifier failure must never abort a real run.
    classification = classifyComplexityHeuristic(input);
  }
  const startTime = Date.now();

  if (classification.complexity === 'complex') {
    return await runComplexPath(input, context, classification.reason, startTime, deps);
  }
  return await runSimplePath(context, classification.reason, startTime, deps);
}

/* ──────────────────────── Simple path ──────────────────────── */

async function runSimplePath(
  context: AgentContext,
  reason: string,
  startTime: number,
  deps: RouteDeps,
): Promise<RouteResult> {
  console.log(`\n${c.cyan}[Routing Engine] Simple task detected (${reason}). Routing to SingleAgent...${c.reset}`);
  deps.onSimplePathStart?.(deps.agent);
  try {
    const result = await deps.agent.runStreaming(context, deps.conversation, deps.rl);
    return { result, route: 'simple' };
  } finally {
    deps.onSimplePathEnd?.(deps.agent);
    deps.agent.reset();
    void startTime;
  }
}

/* ──────────────────────── Complex path ──────────────────────── */

async function runComplexPath(
  input: string,
  context: AgentContext,
  reason: string,
  startTime: number,
  deps: RouteDeps,
): Promise<RouteResult> {
  const { cwd, mode: currentMode } = context;
  const git = new GitManager(cwd);

  console.log(`\n${c.cyan}[Routing Engine] Complex task detected (${reason}). Routing to Orchestrator...${c.reset}`);

  try {
    const { Orchestrator } = await import('./orchestrator.js');
    const { AgentPool } = await import('./agent-pool.js');

    console.log(`\n${c.cyan}[Orchestrator] Generating plan for complex task...${c.reset}`);
    const orchestrator = new Orchestrator(deps.verbose);
    const dag = await orchestrator.plan(context);

    const width = 60;
    const borderTop = `┌${'─'.repeat(width)}┐`;
    const borderBottom = `└${'─'.repeat(width)}┘`;
    console.log(`\n${c.cyan}${borderTop}${c.reset}`);
    console.log(`${c.cyan}│${c.reset}  ${c.bold}Planned Subtask Phases (Complex Task decomposition):${c.reset}${' '.repeat(width - 52)}${c.cyan}│${c.reset}`);
    console.log(`${c.cyan}├${'─'.repeat(width)}┤${c.reset}`);
    for (const sub of dag.subtasks) {
      const deps2 = sub.dependencies.length > 0 ? ` (deps: ${sub.dependencies.join(', ')})` : '';
      const lineStr = `  - [${sub.persona.toUpperCase()}] ${sub.title}${deps2}`;
      const pad = Math.max(0, width - lineStr.length - 4);
      console.log(`${c.cyan}│${c.reset}  ${c.bold}${lineStr}${c.reset}${' '.repeat(pad)}  ${c.cyan}│${c.reset}`);
    }
    console.log(`${c.cyan}${borderBottom}${c.reset}\n`);

    const fixoDir = path.join(cwd, '.fixo');
    fs.mkdirSync(fixoDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixoDir, 'last-dag.json'),
      JSON.stringify({ task: input, dag }, null, 2),
      'utf-8',
    );

    if (currentMode === 'PLAN') {
      console.log(`${c.green}✓ Plan generated and saved successfully.${c.reset}`);
      console.log(`${c.dim}  To execute this plan, switch to BUILD mode (type /mode build or hit [TAB]) and run: /run-plan${c.reset}\n`);
      const durationMs = Date.now() - startTime;
      return {
        result: {
          success: true,
          response: 'Plan generated and saved. Switch to BUILD mode and run /run-plan to execute.',
          modifiedFiles: [],
          tokensUsed: {
            prompt_tokens: orchestrator.tokensUsed.prompt_tokens,
            completion_tokens: orchestrator.tokensUsed.completion_tokens,
            total_tokens: orchestrator.tokensUsed.total_tokens,
          },
          toolCallCount: 0,
          durationMs,
          model: context.model,
        },
        route: 'plan-mode-deferred',
      };
    }

    const budgetLimit = deps.projectConfig?.maxAttempts ?? 12;
    const pool = new AgentPool(3, budgetLimit);

    console.log(`\n${c.cyan}[Agent Pool] Executing DAG of subtasks (concurrency limit: 3, budget: ${budgetLimit} tool calls)...${c.reset}`);
    const success = await pool.execute(context, dag);
    const durationMs = Date.now() - startTime;

    const totalPromptTokens = orchestrator.tokensUsed.prompt_tokens + pool.tokensUsed.prompt_tokens;
    const totalCompletionTokens = orchestrator.tokensUsed.completion_tokens + pool.tokensUsed.completion_tokens;

    const { getModifiedFiles, getBranchPoint } = await import('./worker-agent.js');
    const relativeModified = getModifiedFiles(cwd, getBranchPoint(cwd));
    const modifiedFiles = relativeModified.map((f) => path.resolve(cwd, f));

    if (!success) {
      console.log(`\n${c.red}✗ Parallel workers failed to complete all subtasks.${c.reset}`);
      if (git.isGitRepo()) {
        // Phase 0.0 — scope rollback to worker-touched files only.
        if (modifiedFiles.length > 0) {
          console.log(`\n${c.yellow}[Agent Pool] Rolling back ${modifiedFiles.length} file(s) the workers touched...${c.reset}`);
          git.discardChangesIn(modifiedFiles);
        } else {
          console.log(`\n${c.dim}[Agent Pool] No worker-touched files detected — leaving workspace untouched.${c.reset}`);
        }
      }
    }

    return {
      result: {
        success,
        response: success
          ? 'Successfully completed complex task via parallel agents.'
          : 'Failed to complete all complex subtasks.',
        modifiedFiles,
        tokensUsed: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalPromptTokens + totalCompletionTokens,
        },
        toolCallCount: pool.toolCallCount,
        durationMs,
        model: context.model,
      },
      route: 'complex',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red}✗ Orchestrated execution failed: ${message}${c.reset}`);
    if (git.isGitRepo()) {
      // Phase 0.0 — never reset files the workers didn't touch.
      try {
        const { getModifiedFiles, getBranchPoint } = await import('./worker-agent.js');
        const touched = getModifiedFiles(cwd, getBranchPoint(cwd));
        if (touched.length > 0) {
          console.log(`\n${c.yellow}[Agent Pool] Rolling back ${touched.length} file(s) the workers touched...${c.reset}`);
          git.discardChangesIn(touched);
        } else {
          console.log(`\n${c.dim}[Agent Pool] No worker-touched files detected — leaving workspace untouched.${c.reset}`);
        }
      } catch (_inner) {
        // safe: rollback discovery itself must never crash the error path
        console.log(`\n${c.dim}[Agent Pool] Rollback discovery failed — leaving workspace untouched as a precaution.${c.reset}`);
      }
    }
    const durationMs = Date.now() - startTime;
    return {
      result: {
        success: false,
        response: `Orchestrated run failed: ${message}`,
        modifiedFiles: [],
        tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        toolCallCount: 0,
        durationMs,
        model: context.model,
      },
      route: 'complex',
    };
  }
}
