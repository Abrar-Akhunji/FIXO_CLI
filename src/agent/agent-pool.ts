import fs from "fs";
import type { AgentContext, Subtask, TaskDAG } from "../types.js";
import { WorkerAgent } from "./worker-agent.js";
import { colors } from "../ui/colors.js";
import { logTelemetry, telemetry, recordTelemetry } from "./telemetry.js";
import { couldOverlapFile } from "./orchestrator.js";
import { getAgentDagConfig } from "../config.js";

/**
 * Phase 5.3 — would dispatching `candidate` conflict on writes with
 * any of the currently in-flight subtasks?
 *
 * Pure function — runs at dispatch time as a defense-in-depth check
 * against orchestrator output that the static `serializeWriteConflicts`
 * pass missed (e.g. because it was disabled, or because a file was
 * declared at runtime by a previous reviewer-feedback subtask). The
 * conflict definition matches the static pass: file-set overlap, OR
 * either side declares an empty file set under
 * `serializeMissingFiles`.
 *
 * Returns the id of the in-flight blocker (for logging) or null.
 */
export function findInFlightConflict(
  candidate: Subtask,
  inFlight: readonly Subtask[],
  options: { serializeMissingFiles?: boolean } = {},
): string | null {
  const serializeMissingFiles = options.serializeMissingFiles ?? true;
  const candFiles = candidate.files ?? [];
  for (const peer of inFlight) {
    const peerFiles = peer.files ?? [];
    if (candFiles.length > 0 && peerFiles.length > 0) {
      for (const a of candFiles) {
        for (const b of peerFiles) {
          if (couldOverlapFile(a, b)) return peer.id;
        }
      }
    } else if (serializeMissingFiles) {
      // Either side has unknown writes — conservative defer.
      return peer.id;
    }
  }
  return null;
}

/**
 * Phase 5.2 — partition the run's touched files by subtask outcome.
 *
 * Given a DAG whose subtasks have been executed (so `status` is set
 * and `touchedFiles` is populated for the ones that wrote something),
 * compute:
 *
 *   - `successFiles`      — files touched by at least one completed
 *                           subtask. These are preserved on disk when
 *                           partial-commit is active.
 *   - `failureOnlyFiles`  — files touched ONLY by failed subtasks
 *                           (i.e. not also present in `successFiles`).
 *                           These are the rollback targets.
 *   - `partialCommitPath` — true when the flag is on AND at least one
 *                           subtask succeeded. Caller uses this to
 *                           decide whether to take the partial-commit
 *                           branch or the legacy all-or-nothing branch.
 *
 * Conflict policy: a file touched by both a completed AND a failed
 * subtask is attributed to the success side. Rationale: writes are
 * sequential and the on-disk state is the last write; ties go to the
 * subtask that succeeded. (Phase 3 will add write-set conflict
 * detection to prevent the collision in the first place.)
 *
 * Pure function. No filesystem access, no git. Trivially unit-testable.
 */
export function computePartialCommitPlan(
  subtasks: readonly Subtask[],
  options: { preservePartialOnFailure: boolean },
): {
  successFiles: string[];
  failureOnlyFiles: string[];
  partialCommitPath: boolean;
  completedCount: number;
  failedCount: number;
} {
  const completed = subtasks.filter((s) => s.status === "completed");
  const failed = subtasks.filter((s) => s.status === "failed");
  const successSet = new Set<string>(
    completed.flatMap((s) => s.touchedFiles ?? []),
  );
  const failureOnly = new Set<string>(
    failed
      .flatMap((s) => s.touchedFiles ?? [])
      .filter((f) => !successSet.has(f)),
  );
  return {
    successFiles: Array.from(successSet),
    failureOnlyFiles: Array.from(failureOnly),
    partialCommitPath: options.preservePartialOnFailure && successSet.size > 0,
    completedCount: completed.length,
    failedCount: failed.length,
  };
}

export class AgentPool {
  private concurrencyLimit: number;
  private activeRuns = 0;
  private worker: WorkerAgent;
  private subtaskBudget: number;
  private maxAttempts: number;

  public tokensUsed = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  public toolCallCount = 0;

  constructor(concurrencyLimit = 3, subtaskBudget = 100, maxAttempts = 3) {
    this.concurrencyLimit = concurrencyLimit;
    this.subtaskBudget = subtaskBudget;
    this.maxAttempts = maxAttempts;
    this.worker = new WorkerAgent();
  }

  private renderProgressDashboard(subtasks: Subtask[]): void {
    const width = 60;
    const borderTop = `┌${"─".repeat(width)}┐`;
    const borderBottom = `└${"─".repeat(width)}┘`;

    const completedCount = subtasks.filter(
      (s) => s.status === "completed",
    ).length;
    const totalCount = subtasks.length;

    console.log(`\n${colors.cyan}${borderTop}${colors.reset}`);
    const titleText = ` FixO Agent Pool Progress: ${completedCount}/${totalCount} completed `;
    const padding = Math.max(0, width - titleText.length);
    const padLeft = Math.floor(padding / 2);
    const padRight = padding - padLeft;
    console.log(
      `${colors.cyan}│${colors.reset}${" ".repeat(padLeft)}${colors.bold}${titleText}${colors.reset}${" ".repeat(padRight)}${colors.cyan}│${colors.reset}`,
    );
    console.log(`${colors.cyan}├${"─".repeat(width)}┤${colors.reset}`);

    for (const sub of subtasks) {
      let statusIcon = "⏳";
      let statusColor = colors.dim;
      if (sub.status === "running") {
        statusIcon = "🔄";
        statusColor = colors.cyan;
      } else if (sub.status === "completed") {
        statusIcon = "✅";
        statusColor = colors.green;
      } else if (sub.status === "failed") {
        statusIcon = "❌";
        statusColor = colors.red;
      }

      const personaLabel = `[${sub.persona.toUpperCase()}]`.padEnd(10);
      const titleLimit = width - 16;
      let titleStr = sub.title;
      if (titleStr.length > titleLimit) {
        titleStr = titleStr.slice(0, titleLimit - 3) + "...";
      }
      titleStr = titleStr.padEnd(titleLimit);

      console.log(
        `${colors.cyan}│${colors.reset}  ${statusIcon}  ${statusColor}${personaLabel}${titleStr}${colors.reset}  ${colors.cyan}│${colors.reset}`,
      );
    }
    console.log(`${colors.cyan}${borderBottom}${colors.reset}\n`);
  }

  async execute(context: AgentContext, dag: TaskDAG): Promise<boolean> {
    const subtasks = dag.subtasks;

    for (const s of subtasks) {
      s.status = "pending";
    }
    this.renderProgressDashboard(subtasks);

    const runId = `pool-run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await logTelemetry({
      id: runId,
      tool: "agent_pool_start",
      arguments: {
        subtasks: subtasks.map((s) => ({
          id: s.id,
          title: s.title,
          persona: s.persona,
        })),
      },
      status: "started",
    });

    // Phase 5.3 — runtime cross-check config. If the orchestrator's
    // static pass missed a conflict (e.g. it was disabled, or a
    // dynamically-added reviewer-repair subtask overlapped an
    // in-flight peer), defer dispatch instead of racing.
    const dagCfg = getAgentDagConfig();

    const runNext = async (): Promise<void> => {
      const dependencySatisfied = subtasks.filter(
        (s) =>
          s.status === "pending" &&
          s.dependencies.every((depId) => {
            const dep = subtasks.find((x) => x.id === depId);
            return dep && dep.status === "completed";
          }),
      );

      if (dependencySatisfied.length === 0) {
        return;
      }

      // Phase 5.3 — among dependency-ready candidates, drop any whose
      // declared write set could conflict with an in-flight peer.
      // Deferred candidates will be reconsidered on the next runNext()
      // tick once their conflicting peer completes.
      const inFlight = subtasks.filter((s) => s.status === "running");
      const runnable = dagCfg.serializeWriteConflicts
        ? dependencySatisfied.filter((candidate) => {
            const blocker = findInFlightConflict(candidate, inFlight, {
              serializeMissingFiles: dagCfg.serializeMissingFiles,
            });
            if (blocker) {
              try {
                recordTelemetry(
                  telemetry.dagWriteSetConflictAvoided({
                    runId,
                    file: candidate.files?.[0] ?? "<unknown>",
                    serializedSubtasks: [blocker, candidate.id],
                  }),
                );
              } catch {
                /* never break dispatch */
              }
              return false;
            }
            return true;
          })
        : dependencySatisfied;

      if (runnable.length === 0) {
        return;
      }

      const tasksToStart = runnable.slice(
        0,
        this.concurrencyLimit - this.activeRuns,
      );
      if (tasksToStart.length === 0) return;

      const promises = tasksToStart.map(async (task) => {
        task.status = "running";
        this.activeRuns++;
        console.log(
          `\n${colors.cyan}[Agent Pool] Spawned worker for subtask: ${colors.bold}${task.title}${colors.reset} (${task.persona.toUpperCase()})`,
        );
        this.renderProgressDashboard(subtasks);

        await logTelemetry({
          id: `task-${task.id}`,
          tool: `worker_agent_${task.persona}`,
          arguments: {
            subtaskId: task.id,
            title: task.title,
            description: task.description,
          },
          status: "started",
        });

        let workspaceManifest = "";
        try {
          const files = fs.readdirSync(context.cwd, { withFileTypes: true });
          workspaceManifest = files
            .filter((f) => !f.name.startsWith(".") || f.name === ".env.example")
            .map((f) => (f.isDirectory() ? `${f.name}/` : f.name))
            .join("\n");
        } catch (e) {
          workspaceManifest = "Could not retrieve directory listing.";
        }

        try {
          let budget = this.subtaskBudget;
          if (
            this.subtaskBudget === 100 ||
            this.subtaskBudget === 40 ||
            this.subtaskBudget === 12
          ) {
            if (task.persona === "reviewer") budget = 80;
            else if (task.persona === "code") budget = 120;
            else if (task.persona === "test") budget = 100;
            else if (task.persona === "doc") budget = 80;
          }

          const res = await this.worker.run(
            context,
            task,
            budget,
            undefined,
            workspaceManifest,
          );

          if (res.tokensUsed) {
            this.tokensUsed.prompt_tokens += res.tokensUsed.prompt_tokens;
            this.tokensUsed.completion_tokens +=
              res.tokensUsed.completion_tokens;
            this.tokensUsed.total_tokens += res.tokensUsed.total_tokens;
          }
          if (res.toolCallCount) {
            this.toolCallCount += res.toolCallCount;
          }

          // Phase 5.2 — attach per-subtask touched-files attribution so
          // task-router can decide rollback granularity on peer failure.
          // Captured on BOTH paths (success and failure) — even failed
          // subtasks may have written something before they failed.
          if (res.touchedFiles && res.touchedFiles.length > 0) {
            task.touchedFiles = res.touchedFiles;
          }

          if (res.success) {
            task.status = "completed";
            task.result = res.output;
            console.log(
              `${colors.green}[Agent Pool] Subtask completed: ${colors.bold}${task.title}${colors.reset}`,
            );
            this.renderProgressDashboard(subtasks);

            await logTelemetry({
              id: `task-${task.id}`,
              tool: `worker_agent_${task.persona}`,
              arguments: { subtaskId: task.id, title: task.title },
              status: "completed",
              newContent: res.output,
            });

            // Reviewer Feedback Loop Integration
            if (task.persona === "reviewer") {
              const output = res.output || "";
              const isApproved =
                output.toUpperCase().includes("APPROVED") &&
                !output.toUpperCase().includes("NOT APPROVED") &&
                !output.toUpperCase().includes("REJECTED");
              if (!isApproved) {
                const attemptCount = (task.attemptCount || 1) + 1;
                if (attemptCount > this.maxAttempts) {
                  console.log(
                    `\n${colors.yellow}[Agent Pool] Warning: Maximum repair attempts (${this.maxAttempts}) reached. Stopping repair cycle for: ${task.title}${colors.reset}`,
                  );
                } else {
                  console.log(
                    `\n${colors.yellow}[Agent Pool] Reviewer requested changes: ${output.slice(0, 300)}...${colors.reset}`,
                  );

                  const { getModifiedFiles, getBranchPoint } =
                    await import("./worker-agent.js");
                  const modifiedFilesList = getModifiedFiles(
                    context.cwd,
                    getBranchPoint(context.cwd),
                  );

                  const repairTaskId = `repair-${task.id}-${Date.now()}`;
                  const repairTask: Subtask = {
                    id: repairTaskId,
                    title: `Repair issues from ${task.title}`,
                    description: `Fix the following issues raised by the reviewer:\n${output}`,
                    persona: "code",
                    dependencies: [task.id],
                    files: modifiedFilesList,
                    status: "pending",
                    attemptCount,
                  };

                  const nextReviewerTaskId = `review-${repairTaskId}-${Date.now()}`;
                  const nextReviewerTask: Subtask = {
                    id: nextReviewerTaskId,
                    title: `Re-review after ${repairTask.title}`,
                    description: `Verify if the issues raised in ${task.title} have been successfully fixed.`,
                    persona: "reviewer",
                    dependencies: [repairTaskId],
                    files: [],
                    status: "pending",
                    attemptCount,
                  };

                  subtasks.push(repairTask, nextReviewerTask);
                  console.log(
                    `${colors.cyan}[Agent Pool] Added dynamic repair subtask (${repairTaskId}) and follow-up reviewer subtask (${nextReviewerTaskId})${colors.reset}`,
                  );
                  this.renderProgressDashboard(subtasks);
                }
              }
            }
          } else {
            task.status = "failed";
            task.result = res.output;
            console.error(
              `${colors.red}[Agent Pool] Subtask failed: ${colors.bold}${task.title}${colors.reset} - ${res.output}`,
            );
            this.renderProgressDashboard(subtasks);

            await logTelemetry({
              id: `task-${task.id}`,
              tool: `worker_agent_${task.persona}`,
              arguments: { subtaskId: task.id, title: task.title },
              status: "failed",
              error: res.output,
            });
          }
        } catch (err: any) {
          task.status = "failed";
          task.result = err.message || String(err);
          console.error(
            `${colors.red}[Agent Pool] Subtask failed with error: ${colors.bold}${task.title}${colors.reset} - ${err.message || err}`,
          );
          this.renderProgressDashboard(subtasks);

          await logTelemetry({
            id: `task-${task.id}`,
            tool: `worker_agent_${task.persona}`,
            arguments: { subtaskId: task.id, title: task.title },
            status: "failed",
            error: err.message || String(err),
          });
        } finally {
          this.activeRuns--;
          await runNext();
        }
      });

      await Promise.all(promises);
    };

    while (
      subtasks.some((s) => s.status === "pending" || s.status === "running")
    ) {
      const activeBefore = this.activeRuns;
      await runNext();

      if (this.activeRuns === 0 && activeBefore === 0) {
        break;
      }
    }

    const allCompleted = subtasks.every((s) => s.status === "completed");
    await logTelemetry({
      id: runId,
      tool: "agent_pool_finish",
      arguments: { allCompleted },
      status: allCompleted ? "completed" : "failed",
    });

    return allCompleted;
  }
}
