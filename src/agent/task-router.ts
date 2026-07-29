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
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Interface as ReadlineInterface } from "node:readline";

import {
  classifyComplexityHeuristic,
  classifyComplexityModel,
} from "../planner.js";
import { GitManager } from "../git/git-manager.js";
import {
  getAgentPoolConfig,
  getWorkspaceStateDir,
  loadConfig,
} from "../config.js";
import { telemetry, recordTelemetry } from "./telemetry.js";
import type { SingleAgent } from "./single-agent.js";
import type { ConversationManager } from "./conversation.js";
import type { AgentContext, AgentResult, ProjectConfig } from "../types.js";
import { colors as c } from "../ui/colors.js";
import { MODEL_DAG_VERIFIED } from "./providers-manager.js";
import { confirm, isCancel } from "@clack/prompts";

function gitStatus(cwd: string): Map<string, string> {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const status = new Map<string, string>();
    for (const record of output.split("\0")) {
      if (record.length < 4) continue;
      status.set(path.resolve(cwd, record.slice(3)), record.slice(0, 2));
    }
    return status;
  } catch {
    return new Map();
  }
}

function newUntrackedPaths(
  cwd: string,
  baseline: ReadonlyMap<string, string>,
): string[] {
  const current = gitStatus(cwd);
  return Array.from(current)
    .filter(([file, status]) => status === "??" && !baseline.has(file))
    .map(([file]) => file);
}

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
  route: "simple" | "complex" | "plan-mode-deferred";
}

/**
 * Decide simple-vs-complex and execute the task. UI-agnostic.
 */

function writeLastRunSummary(cwd: string, success: boolean, reason: string) {
  const metadataDir = getWorkspaceStateDir(cwd);
  fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
  const summaryFile = path.join(metadataDir, "last-run-summary.json");
  fs.writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        success,
        reason,
        timestamp: Date.now(),
      },
      null,
      2,
    ),
  );
}

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
    classification = await classifyComplexityModel(
      input,
      context.model,
      deps.agent.getClient(),
    );
  } catch {
    // safe: classifier failure must never abort a real run.
    classification = classifyComplexityHeuristic(input);
  }
  const startTime = Date.now();

  const cleanInput = input.trim().toLowerCase();
  const isContinue =
    cleanInput === "continue" ||
    cleanInput === "go on" ||
    cleanInput === "keep going";
  const msgs = deps.conversation.getMessages();
  const lastMsg = msgs[msgs.length - 1];
  const isFollowingLimit =
    lastMsg?.role === "assistant" &&
    typeof lastMsg.content === "string" &&
    lastMsg.content.includes("(limit reached)");

  if (isContinue && isFollowingLimit) {
    context.systemPromptOverride =
      (context.systemPromptOverride
        ? context.systemPromptOverride + "\n\n"
        : "") +
      "DIRECTIVE: You are resuming exactly from your last known state and Todo item. Do not re-read or scan the workspace.";
    (context as any).isResume = true;
    return await runSimplePath(
      context,
      "Resume from tool-limit pause",
      startTime,
      deps,
    );
  } else if (isContinue) {
    context.systemPromptOverride =
      (context.systemPromptOverride
        ? context.systemPromptOverride + "\n\n"
        : "") +
      "DIRECTIVE: The user has asked you to continue. Review the conversation history and proceed with the next logical step. If there is no clear next step, ask the user what they want to do.";
    (context as any).isResume = true;
    return await runSimplePath(
      context,
      "Generic continuation",
      startTime,
      deps,
    );
  }

  if (classification.complexity === "complex") {
    const config = loadConfig();
    const isVerified =
      context.model &&
      Array.from(MODEL_DAG_VERIFIED).some((m) => context.model!.includes(m));
    const routingConfig = config.preferences?.agent?.routing;

    if (
      routingConfig?.honorVerificationFlag &&
      !routingConfig?.allowUnverifiedDag &&
      !isVerified
    ) {
      console.log(
        `\n${c.yellow}⚠ Task classified as complex, but model '${context.model}' is unverified for autonomous DAG execution.${c.reset}`,
      );

      let useComplex = false;
      if (deps.rl && process.env.NODE_ENV !== "test") {
        deps.rl.pause();
        try {
          const choice = await confirm({
            message: `Do you want to run the complex DAG on this unverified model? (This setting will not be saved)`,
            initialValue: false,
          });
          if (!isCancel(choice) && choice === true) {
            useComplex = true;
          }
        } finally {
          deps.rl.resume();
        }
      }

      if (!useComplex) {
        console.log(
          `${c.dim}Routing to SingleAgent as a safety fallback. Set 'allowUnverifiedDag: true' in config to override permanently.${c.reset}`,
        );
        return await runSimplePath(
          context,
          "Unverified model fallback",
          startTime,
          deps,
        );
      }
    }
    return await runComplexPath(
      input,
      context,
      classification.reason,
      startTime,
      deps,
    );
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
  console.log(
    `\n${c.cyan}[Routing Engine] Simple task detected (${reason}). Routing to SingleAgent...${c.reset}`,
  );
  deps.onSimplePathStart?.(deps.agent);
  try {
    const result = await deps.agent.runStreaming(
      context,
      deps.conversation,
      deps.rl,
    );
    return { result, route: "simple" };
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

  const preRunStatus = gitStatus(cwd);

  console.log(
    `\n${c.cyan}[Routing Engine] Complex task detected (${reason}). Routing to Orchestrator...${c.reset}`,
  );

  try {
    const { Orchestrator } = await import("./orchestrator.js");
    const { AgentPool, computePartialCommitPlan } =
      await import("./agent-pool.js");

    console.log(
      `\n${c.cyan}[Orchestrator] Generating plan for complex task...${c.reset}`,
    );
    const orchestrator = new Orchestrator(deps.verbose);
    const dag = await orchestrator.plan(context);

    const width = 60;
    const borderTop = `┌${"─".repeat(width)}┐`;
    const borderBottom = `└${"─".repeat(width)}┘`;
    console.log(`\n${c.cyan}${borderTop}${c.reset}`);
    console.log(
      `${c.cyan}│${c.reset}  ${c.bold}Planned Subtask Phases (Complex Task decomposition):${c.reset}${" ".repeat(width - 52)}${c.cyan}│${c.reset}`,
    );
    console.log(`${c.cyan}├${"─".repeat(width)}┤${c.reset}`);
    for (const sub of dag.subtasks) {
      const deps2 =
        sub.dependencies.length > 0
          ? ` (deps: ${sub.dependencies.join(", ")})`
          : "";
      const lineStr = `  - [${sub.persona.toUpperCase()}] ${sub.title}${deps2}`;
      const pad = Math.max(0, width - lineStr.length - 4);
      console.log(
        `${c.cyan}│${c.reset}  ${c.bold}${lineStr}${c.reset}${" ".repeat(pad)}  ${c.cyan}│${c.reset}`,
      );
    }
    console.log(`${c.cyan}${borderBottom}${c.reset}\n`);

    const metadataDir = getWorkspaceStateDir(cwd);
    fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(metadataDir, "last-dag.json"),
      JSON.stringify({ task: input, dag }, null, 2),
      "utf-8",
    );

    if (currentMode === "PLAN") {
      console.log(
        `${c.green}✓ Plan generated and saved successfully.${c.reset}`,
      );
      console.log(
        `${c.dim}  To execute this plan, switch to BUILD mode (type /mode build or hit [TAB]) and run: /run-plan${c.reset}\n`,
      );
      const durationMs = Date.now() - startTime;
      return {
        result: {
          success: true,
          response:
            "Plan generated and saved. Switch to BUILD mode and run /run-plan to execute.",
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
        route: "plan-mode-deferred",
      };
    }

    const maxAttempts = deps.projectConfig?.maxAttempts ?? 3;
    // subtaskBudget is hardcoded to 100 in the AgentPool constructor by default, but we should pass it explicitly as second arg if we want.
    // Let's pass the default values for the first two arguments and maxAttempts for the third.
    const pool = new AgentPool(3, 100, maxAttempts);

    console.log(
      `\n${c.cyan}[Agent Pool] Executing DAG of subtasks (concurrency limit: 3, max repair attempts: ${maxAttempts})...${c.reset}`,
    );
    const success = await pool.execute(context, dag);
    const durationMs = Date.now() - startTime;

    const totalPromptTokens =
      orchestrator.tokensUsed.prompt_tokens + pool.tokensUsed.prompt_tokens;
    const totalCompletionTokens =
      orchestrator.tokensUsed.completion_tokens +
      pool.tokensUsed.completion_tokens;

    const { getModifiedFiles, getBranchPoint } =
      await import("./worker-agent.js");
    const relativeModified = getModifiedFiles(cwd, getBranchPoint(cwd));
    const modifiedFiles = relativeModified.map((f) => path.resolve(cwd, f));

    // Phase 5.2 — per-subtask attribution via the pure `computePartialCommitPlan`
    // helper. The pool attaches `touchedFiles` to each subtask; the
    // helper partitions them by subtask outcome. See agent-pool.ts.
    const poolConfig = getAgentPoolConfig();
    const plan = computePartialCommitPlan(dag.subtasks, {
      preservePartialOnFailure: poolConfig.preservePartialOnFailure,
    });
    const completedSubtasks = dag.subtasks.filter(
      (s) => s.status === "completed",
    );
    const failedSubtasks = dag.subtasks.filter((s) => s.status === "failed");
    const successFiles = new Set<string>(plan.successFiles);
    const failureOnlyFiles = new Set<string>(plan.failureOnlyFiles);
    const partialCommitPath = plan.partialCommitPath;

    if (!success) {
      console.log(
        `\n${c.red}✗ Parallel workers failed to complete all subtasks.${c.reset}`,
      );

      if (partialCommitPath && git.isGitRepo()) {
        // Phase 5.2 — preserve successful peers' work; only roll back
        // files attributable solely to failed subtasks.
        console.log(
          `\n${c.cyan}[Agent Pool] Partial completion: ${completedSubtasks.length}/${dag.subtasks.length} subtasks succeeded — preserving their work.${c.reset}`,
        );
        console.log(
          `  ${c.green}Files committed (${successFiles.size}):${c.reset}`,
        );
        for (const f of successFiles)
          console.log(`    + ${path.relative(cwd, f)}`);
        if (failureOnlyFiles.size > 0) {
          console.log(
            `  ${c.yellow}Rolling back ${failureOnlyFiles.size} file(s) from failed subtasks:${c.reset}`,
          );
          for (const f of failureOnlyFiles)
            console.log(`    - ${path.relative(cwd, f)}`);
          git.discardChangesIn(Array.from(failureOnlyFiles));
        }
        if (failedSubtasks.length > 0) {
          console.log(`  ${c.red}Failed subtasks:${c.reset}`);
          for (const s of failedSubtasks) {
            console.log(
              `    ${c.red}✗${c.reset} [${s.persona.toUpperCase()}] ${s.title}`,
            );
            if (s.result) {
              const trimmed = s.result.slice(0, 160);
              console.log(
                `      ${c.dim}${trimmed}${s.result.length > 160 ? "…" : ""}${c.reset}`,
              );
            }
          }
        }
        recordTelemetry(
          telemetry.poolSubtaskPartialCommitted({
            runId: `route-${startTime}`,
            succeeded: completedSubtasks.length,
            failed: failedSubtasks.length,
            filesCommitted: successFiles.size,
          }),
        );
      } else if (git.isGitRepo()) {
        // Phase 0.0 (legacy default) — all-or-nothing rollback scoped
        // to worker-touched files. Still the default when the new
        // partial-commit flag is OFF or when no subtask succeeded.
        if (modifiedFiles.length > 0) {
          console.log(
            `\n${c.yellow}[Agent Pool] Rolling back ${modifiedFiles.length} file(s) the workers touched...${c.reset}`,
          );
          git.discardChangesIn(modifiedFiles);
        } else {
          console.log(
            `\n${c.dim}[Agent Pool] No worker-touched files detected — leaving workspace untouched.${c.reset}`,
          );
        }
      }

      // Only Git can tell us which files were newly created without walking
      // the entire tree. Existing TaskSession ledgers cover tool mutations;
      // this baseline covers untracked files created by commands or workers.
      const topLevelNew = newUntrackedPaths(cwd, preRunStatus).filter(
        (file) => !successFiles.has(file),
      );

      if (topLevelNew.length > 0) {
        console.log(
          `\n${c.yellow}Orphaned files/directories detected from failed run:${c.reset}`,
        );
        for (const p of topLevelNew) {
          console.log(`  - ${path.relative(cwd, p)}`);
        }
        let shouldDelete: boolean | symbol = false;
        if (process.env.NODE_ENV === "test") {
          shouldDelete = false;
        } else {
          shouldDelete = await confirm({
            message: "Delete these orphaned paths?",
            initialValue: false,
          });
        }

        if (isCancel(shouldDelete) || !shouldDelete) {
          console.log(
            `${c.yellow}Orphaned paths kept. You can manually delete them if needed.${c.reset}`,
          );
        } else {
          for (const p of topLevelNew) {
            try {
              fs.rmSync(p, { recursive: true, force: true });
            } catch (e) {
              if (process.env.DEBUG)
                console.warn(
                  `[task-router] Error removing orphaned path ${p}:`,
                  e,
                );
            }
          }
          console.log(
            `${c.green}✓ Orphaned paths cleaned up successfully.${c.reset}`,
          );
        }
      }
    }

    // Phase 5.2 — when partial-commit applied, the effective
    // modifiedFiles is the set kept on disk (not the full git diff,
    // which still includes paths we just rolled back).
    const effectiveModifiedFiles = partialCommitPath
      ? Array.from(successFiles)
      : modifiedFiles;

    let outcomeSummary = "";
    if (success) {
      outcomeSummary =
        `Complex task completed successfully. Orchestrator planned and parallel agents executed the following subtasks:\n` +
        dag.subtasks
          .map((s) => `- [${s.persona.toUpperCase()}] ${s.title}`)
          .join("\n");
    } else {
      const parts = [
        partialCommitPath
          ? `Complex task partially completed: ${completedSubtasks.length}/${dag.subtasks.length} subtasks succeeded. Files kept: ${successFiles.size}.`
          : `Complex task failed or partially completed. The orchestrator planned subtasks but execution did not fully succeed.`,
        ``,
        `### Completed Subtasks Output Summary:`,
      ];

      if (completedSubtasks.length > 0) {
        for (const s of completedSubtasks) {
          parts.push(
            `- **[${s.persona.toUpperCase()}] ${s.title}**:`,
            `  result: ${s.result || "No output recorded."}`,
          );
        }
      } else {
        parts.push(`None.`);
      }

      parts.push(``, `### Failed Subtasks:`);
      if (failedSubtasks.length > 0) {
        for (const s of failedSubtasks) {
          parts.push(
            `- **[${s.persona.toUpperCase()}] ${s.title}**:`,
            `  error: ${s.result || "No error message recorded."}`,
          );
        }
      } else {
        parts.push(`None.`);
      }

      outcomeSummary = parts.join("\n");
    }
    deps.conversation.addTurn(input, outcomeSummary);
    deps.conversation.addTokenSurcharge(
      totalPromptTokens + totalCompletionTokens,
    );
    const finalResponse = success
      ? "Successfully completed complex task via parallel agents."
      : partialCommitPath
        ? `Partial completion: ${completedSubtasks.length}/${dag.subtasks.length} subtasks succeeded, ${failedSubtasks.length} failed. Successful peers' files were preserved.`
        : "Failed to complete all complex subtasks.";
    writeLastRunSummary(cwd, success, finalResponse);
    return {
      result: {
        success,
        response: finalResponse,
        modifiedFiles: effectiveModifiedFiles,
        tokensUsed: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalPromptTokens + totalCompletionTokens,
        },
        toolCallCount: pool.toolCallCount,
        durationMs,
        model: context.model,
      },
      route: "complex",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `\n${c.red}✗ Orchestrated execution failed: ${message}${c.reset}`,
    );
    if (git.isGitRepo()) {
      // Phase 0.0 — never reset files the workers didn't touch.
      try {
        const { getModifiedFiles, getBranchPoint } =
          await import("./worker-agent.js");
        const touched = getModifiedFiles(cwd, getBranchPoint(cwd));
        if (touched.length > 0) {
          console.log(
            `\n${c.yellow}[Agent Pool] Rolling back ${touched.length} file(s) the workers touched...${c.reset}`,
          );
          git.discardChangesIn(touched);
        } else {
          console.log(
            `\n${c.dim}[Agent Pool] No worker-touched files detected — leaving workspace untouched.${c.reset}`,
          );
        }
      } catch (_inner) {
        // safe: rollback discovery itself must never crash the error path
        console.log(
          `\n${c.dim}[Agent Pool] Rollback discovery failed — leaving workspace untouched as a precaution.${c.reset}`,
        );
      }
    }

    const topLevelNew = newUntrackedPaths(cwd, preRunStatus);

    if (topLevelNew.length > 0) {
      console.log(
        `\n${c.yellow}Orphaned files/directories detected from failed run:${c.reset}`,
      );
      for (const p of topLevelNew) {
        console.log(`  - ${path.relative(cwd, p)}`);
      }
      let shouldDelete: boolean | symbol = false;
      if (process.env.NODE_ENV === "test") {
        shouldDelete = false; // Never delete in hermetic tests automatically
      } else {
        shouldDelete = await confirm({
          message: "Delete these orphaned paths?",
          initialValue: false,
        });
      }

      if (isCancel(shouldDelete) || !shouldDelete) {
        console.log(
          `${c.yellow}Orphaned paths kept. You can manually delete them if needed.${c.reset}`,
        );
      } else {
        for (const p of topLevelNew) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch (e) {
            if (process.env.DEBUG)
              console.warn(
                `[task-router] Error removing orphaned path ${p}:`,
                e,
              );
          }
        }
        console.log(
          `${c.green}✓ Orphaned paths cleaned up successfully.${c.reset}`,
        );
      }
    }

    const outcomeSummary = `Complex task failed due to an error: ${message}`;
    writeLastRunSummary(cwd, false, `Orchestrated run failed: ${message}`);
    deps.conversation.addTurn(input, outcomeSummary);

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
      route: "complex",
    };
  }
}
