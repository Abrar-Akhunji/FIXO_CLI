import type { AgentContext, Subtask, TaskDAG } from '../types.js';
import { WorkerAgent } from './worker-agent.js';
import { colors } from '../ui/colors.js';
import { logTelemetry } from './telemetry.js';

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
  const completed = subtasks.filter(s => s.status === 'completed');
  const failed = subtasks.filter(s => s.status === 'failed');
  const successSet = new Set<string>(completed.flatMap(s => s.touchedFiles ?? []));
  const failureOnly = new Set<string>(
    failed.flatMap(s => s.touchedFiles ?? []).filter(f => !successSet.has(f)),
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

  public tokensUsed = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  public toolCallCount = 0;

  constructor(concurrencyLimit = 3, subtaskBudget = 12) {
    this.concurrencyLimit = concurrencyLimit;
    this.subtaskBudget = subtaskBudget;
    this.worker = new WorkerAgent();
  }

  private renderProgressDashboard(subtasks: Subtask[]): void {
    const width = 60;
    const borderTop = `┌${'─'.repeat(width)}┐`;
    const borderBottom = `└${'─'.repeat(width)}┘`;
    
    const completedCount = subtasks.filter(s => s.status === 'completed').length;
    const totalCount = subtasks.length;
    
    console.log(`\n${colors.cyan}${borderTop}${colors.reset}`);
    const titleText = ` FixO Agent Pool Progress: ${completedCount}/${totalCount} completed `;
    const padding = Math.max(0, width - titleText.length);
    const padLeft = Math.floor(padding / 2);
    const padRight = padding - padLeft;
    console.log(`${colors.cyan}│${colors.reset}${' '.repeat(padLeft)}${colors.bold}${titleText}${colors.reset}${' '.repeat(padRight)}${colors.cyan}│${colors.reset}`);
    console.log(`${colors.cyan}├${'─'.repeat(width)}┤${colors.reset}`);
    
    for (const sub of subtasks) {
      let statusIcon = '⏳';
      let statusColor = colors.dim;
      if (sub.status === 'running') {
        statusIcon = '🔄';
        statusColor = colors.cyan;
      } else if (sub.status === 'completed') {
        statusIcon = '✅';
        statusColor = colors.green;
      } else if (sub.status === 'failed') {
        statusIcon = '❌';
        statusColor = colors.red;
      }
      
      const personaLabel = `[${sub.persona.toUpperCase()}]`.padEnd(10);
      const titleLimit = width - 16;
      let titleStr = sub.title;
      if (titleStr.length > titleLimit) {
        titleStr = titleStr.slice(0, titleLimit - 3) + '...';
      }
      titleStr = titleStr.padEnd(titleLimit);
      
      console.log(`${colors.cyan}│${colors.reset}  ${statusIcon}  ${statusColor}${personaLabel}${titleStr}${colors.reset}  ${colors.cyan}│${colors.reset}`);
    }
    console.log(`${colors.cyan}${borderBottom}${colors.reset}\n`);
  }

  async execute(context: AgentContext, dag: TaskDAG): Promise<boolean> {
    const subtasks = dag.subtasks;
    
    for (const s of subtasks) {
      s.status = 'pending';
    }
    this.renderProgressDashboard(subtasks);

    const runId = `pool-run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await logTelemetry({
      id: runId,
      tool: 'agent_pool_start',
      arguments: { subtasks: subtasks.map(s => ({ id: s.id, title: s.title, persona: s.persona })) },
      status: 'started'
    });

    const runNext = async (): Promise<void> => {
      const runnable = subtasks.filter(
        s => s.status === 'pending' && s.dependencies.every(depId => {
          const dep = subtasks.find(x => x.id === depId);
          return dep && dep.status === 'completed';
        })
      );

      if (runnable.length === 0) {
        return;
      }

      const tasksToStart = runnable.slice(0, this.concurrencyLimit - this.activeRuns);
      if (tasksToStart.length === 0) return;

      const promises = tasksToStart.map(async (task) => {
        task.status = 'running';
        this.activeRuns++;
        console.log(`\n${colors.cyan}[Agent Pool] Spawned worker for subtask: ${colors.bold}${task.title}${colors.reset} (${task.persona.toUpperCase()})`);
        this.renderProgressDashboard(subtasks);
        
        await logTelemetry({
          id: `task-${task.id}`,
          tool: `worker_agent_${task.persona}`,
          arguments: { subtaskId: task.id, title: task.title, description: task.description },
          status: 'started'
        });

        try {
          const res = await this.worker.run(
            context,
            task,
            this.subtaskBudget
          );

          if (res.tokensUsed) {
            this.tokensUsed.prompt_tokens += res.tokensUsed.prompt_tokens;
            this.tokensUsed.completion_tokens += res.tokensUsed.completion_tokens;
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
            task.status = 'completed';
            task.result = res.output;
            console.log(`${colors.green}[Agent Pool] Subtask completed: ${colors.bold}${task.title}${colors.reset}`);
            this.renderProgressDashboard(subtasks);
            
            await logTelemetry({
              id: `task-${task.id}`,
              tool: `worker_agent_${task.persona}`,
              arguments: { subtaskId: task.id, title: task.title },
              status: 'completed',
              newContent: res.output
            });

            // Reviewer Feedback Loop Integration
            if (task.persona === 'reviewer') {
              const output = res.output || '';
              const isApproved = output.toUpperCase().includes('APPROVED') && 
                                 !output.toUpperCase().includes('NOT APPROVED') && 
                                 !output.toUpperCase().includes('REJECTED');
              if (!isApproved) {
                const reviewDepth = (task.id.match(/review-/g) || []).length;
                if (reviewDepth >= 3) {
                  console.log(`\n${colors.yellow}[Agent Pool] Warning: Maximum reviewer feedback depth (3) reached. Stopping repair cycle for: ${task.title}${colors.reset}`);
                } else {
                  console.log(`\n${colors.yellow}[Agent Pool] Reviewer requested changes: ${output.slice(0, 300)}...${colors.reset}`);
                  
                  const { getModifiedFiles, getBranchPoint } = await import('./worker-agent.js');
                  const modifiedFilesList = getModifiedFiles(context.cwd, getBranchPoint(context.cwd));
                  
                  const repairTaskId = `repair-${task.id}-${Date.now()}`;
                  const repairTask: Subtask = {
                    id: repairTaskId,
                    title: `Repair issues from ${task.title}`,
                    description: `Fix the following issues raised by the reviewer:\n${output}`,
                    persona: 'code',
                    dependencies: [task.id],
                    files: modifiedFilesList,
                    status: 'pending'
                  };
                  
                  const nextReviewerTaskId = `review-${repairTaskId}-${Date.now()}`;
                  const nextReviewerTask: Subtask = {
                    id: nextReviewerTaskId,
                    title: `Re-review after ${repairTask.title}`,
                    description: `Verify if the issues raised in ${task.title} have been successfully fixed.`,
                    persona: 'reviewer',
                    dependencies: [repairTaskId],
                    files: [],
                    status: 'pending'
                  };
                  
                  subtasks.push(repairTask, nextReviewerTask);
                  console.log(`${colors.cyan}[Agent Pool] Added dynamic repair subtask (${repairTaskId}) and follow-up reviewer subtask (${nextReviewerTaskId})${colors.reset}`);
                  this.renderProgressDashboard(subtasks);
                }
              }
            }
          } else {
            task.status = 'failed';
            console.error(`${colors.red}[Agent Pool] Subtask failed: ${colors.bold}${task.title}${colors.reset} - ${res.output}`);
            this.renderProgressDashboard(subtasks);
            
            await logTelemetry({
              id: `task-${task.id}`,
              tool: `worker_agent_${task.persona}`,
              arguments: { subtaskId: task.id, title: task.title },
              status: 'failed',
              error: res.output
            });
          }
        } catch (err: any) {
          task.status = 'failed';
          console.error(`${colors.red}[Agent Pool] Subtask failed with error: ${colors.bold}${task.title}${colors.reset} - ${err.message || err}`);
          this.renderProgressDashboard(subtasks);
          
          await logTelemetry({
            id: `task-${task.id}`,
            tool: `worker_agent_${task.persona}`,
            arguments: { subtaskId: task.id, title: task.title },
            status: 'failed',
            error: err.message || String(err)
          });


        } finally {
          this.activeRuns--;
          await runNext();
        }
      });

      await Promise.all(promises);
    };

    while (subtasks.some(s => s.status === 'pending' || s.status === 'running')) {
      const activeBefore = this.activeRuns;
      await runNext();
      
      if (this.activeRuns === 0 && activeBefore === 0) {
        break;
      }
    }

    const allCompleted = subtasks.every(s => s.status === 'completed');
    await logTelemetry({
      id: runId,
      tool: 'agent_pool_finish',
      arguments: { allCompleted },
      status: allCompleted ? 'completed' : 'failed'
    });

    return allCompleted;
  }
}
