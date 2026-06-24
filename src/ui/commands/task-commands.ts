import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as p from '@clack/prompts';
import { SingleAgent } from '../../agent/single-agent.js';
import { ConversationManager } from '../../agent/conversation.js';
import { GitManager } from '../../git/git-manager.js';
import type { AgentContext, ProjectConfig } from '../../types.js';
import type { ChatContentBlock } from '../../shared/types.js';
import { loadImageAsBlock } from '../image-attach.js';
import type { FreeLLMConfig } from '../../config.js';
import { saveConfig } from '../../config.js';
import { WorkspaceGuard } from '../../workspace-guard.js';
import { listRuns, showRun, undoRun } from '../../runtime/task-session.js';
import { checkPermission } from '../../agent/permissions.js';
import { redactedEnv, redactSecrets } from '../../runtime/redaction.js';
import { appendMemory, doctor, forgetMemory, readMemory } from '../../project-memory.js';
import { buildIndex, explainIndexedTarget, findInIndex } from '../../indexer.js';
import { reviewWorkspace } from '../../review.js';
import { runProjectTests } from '../../test-runner.js';
import { loadPlan, renderPlan, savePlan, classifyComplexityHeuristic } from '../../planner.js';
import { mcpManager, mcpBridgeManager } from '../../agent/tool-executor.js';
import { ProvidersManager, PROVIDER_REGISTRY } from '../../agent/providers-manager.js';

import { C, colors } from '../colors.js';
import { COMMANDS_WITH_DESC, printHelp, buildPromptString, formatInputPaths } from '../render.js';
import {
  addItem,
  loadTodoList,
  removeItem,
  renderTodoList,
  saveTodoList,
  setItemStatus,
  summariseTodoList,
} from '../../context/todo.js';
import { renderStatusBar, type CLIState } from '../render-primitives.js';

import { type CommandHandler } from './types.js';

export const reviewCommand: CommandHandler = async (ctx) => {
    console.log(`\n${reviewWorkspace(ctx.cwd)}`);
    return;

};

export const testCommand: CommandHandler = async (ctx) => {
    console.log(`\n${runProjectTests(ctx.cwd)}`);
    return;

};

export const fixTestsCommand: CommandHandler = async (ctx) => {
    let testResult = runProjectTests(ctx.cwd);
    if (testResult.includes('Status: 0')) {
      console.log(`\n${colors.green}✓ All tests are passing!${colors.reset}`);
      return;
    }

    let attempt = 1;
    const maxAttempts = 3;
    const modifiedFiles: string[] = [];

    while (attempt <= maxAttempts) {
      console.log(`\n${colors.cyan}🔨 [Auto-Fix] Test failure detected (Attempt ${attempt}/${maxAttempts}). Invoking SingleAgent to repair...${colors.reset}`);
      console.log(`${colors.dim}${testResult}${colors.reset}\n`);

      const repairTask = `The project tests are failing. Here is the test runner output:\n\n${testResult}\n\nPlease identify the files causing the failure, modify them to fix the issues, verify using the test commands, and ensure they pass.`;
      const context: AgentContext = {
        task: repairTask,
        model: ctx.state.currentModel,
        cwd: ctx.cwd,
        verbose: ctx.verbose,
        selectedFiles: [...ctx.state.selectedFiles],
        systemPromptOverride: ctx.projectConfig?.systemPrompt,
        checkCommand: ctx.projectConfig?.checkCommand,
        policy: ctx.projectConfig?.policy ?? ctx.config.preferences.policy,
        mode: 'BUILD',
        yes: true,
      };

      try {
        ctx.state.isTaskRunning = true;
        ctx.state.currentRunningAgent = ctx.agent;
        const result = await ctx.agent.runStreaming(context, ctx.conversation, ctx.rl);
        for (const file of result.modifiedFiles) {
          if (!modifiedFiles.includes(file)) {
            modifiedFiles.push(file);
          }
        }
      } catch (err: any) {
        console.log(`\n${colors.red}✗ Repair ctx.agent failed on attempt ${attempt}: ${err.message || err}${colors.reset}`);
      } finally {
        ctx.state.isTaskRunning = false;
        ctx.state.currentRunningAgent = null;
        ctx.agent.reset();
      }

      testResult = runProjectTests(ctx.cwd);
      if (testResult.includes('Status: 0')) {
        console.log(`\n${colors.green}✓ All tests passed after repair attempt ${attempt}!${colors.reset}`);
        break;
      } else {
        attempt++;
      }
    }

    if (!testResult.includes('Status: 0')) {
      console.log(`\n${colors.red}✗ Auto-fix failed after ${maxAttempts} attempts. Remaining failures:${colors.reset}`);
      console.log(`${colors.dim}${testResult}${colors.reset}`);
    } else {
      // Auto-commit if enabled and changes were made
      if (
        ctx.config.preferences.autoCommit &&
        (ctx.projectConfig?.autoCommit !== false) &&
        modifiedFiles.length > 0
      ) {
        console.log(`\n${colors.green}✓ Auto-committing repaired test files...${colors.reset}`);
        ctx.git.autoCommit('fix-tests: repair test failures', modifiedFiles);
      }
    }
    return;
};

export const fixCiCommand: CommandHandler = async (ctx) => {
    console.log(`\n${colors.yellow}/fix-ci local mode: paste CI logs into a task or save them to a workspace file, then ask FixO to inspect that file.${colors.reset}`);
    return;

};

export const planCommand: CommandHandler = async (ctx) => {
    {
      const task = ctx.args.join(' ').trim();
      if (!task) {
        console.log(`\n${colors.yellow}Usage: /plan <task>${colors.reset}`);
        return;
      }
      const plan = savePlan(ctx.cwd, task);
      console.log(`\n${renderPlan(plan)}`);
    }
    return;

};

export const runPlanCommand: CommandHandler = async (ctx) => {
    const dagFile = path.join(ctx.cwd, '.fixo', 'last-dag.json');
    if (fs.existsSync(dagFile)) {
      try {
        const { task, dag } = JSON.parse(fs.readFileSync(dagFile, 'utf-8'));
        console.log(`\n${colors.cyan}[Saved Plan] Executing saved subtasks DAG for task: ${colors.bold}${task}${colors.reset}`);
        
        const { AgentPool } = await import('../../agent/agent-pool.js');
        const pool = new AgentPool(3, ctx.projectConfig?.maxAttempts ?? 12);
        
        const context: AgentContext = {
          task,
          model: ctx.state.currentModel,
          cwd: ctx.cwd,
          verbose: ctx.verbose,
          selectedFiles: [...ctx.state.selectedFiles],
          systemPromptOverride: ctx.projectConfig?.systemPrompt,
          checkCommand: ctx.projectConfig?.checkCommand,
          policy: ctx.projectConfig?.policy ?? ctx.config.preferences.policy,
          mode: ctx.state.currentMode as any,
        };
        
        const success = await pool.execute(context, dag);
        if (success) {
          console.log(`\n${colors.green}✓ Successfully completed complex task via parallel agents.${colors.reset}`);
        } else {
          console.log(`\n${colors.red}✗ Parallel workers failed to complete all subtasks.${colors.reset}`);
          if (ctx.git.isGitRepo()) {
            // Phase 0.0 (Jun 21 incident): roll back only files the
            // workers actually touched, not the entire workspace.
            const { getModifiedFiles, getBranchPoint } = await import('../../agent/worker-agent.js');
            const touched = getModifiedFiles(ctx.cwd, getBranchPoint(ctx.cwd));
            if (touched.length > 0) {
              console.log(`\n${colors.yellow}[Agent Pool] Rolling back ${touched.length} file(s) the workers touched...${colors.reset}`);
              ctx.git.discardChangesIn(touched);
            } else {
              console.log(`\n${colors.dim}[Agent Pool] No worker-touched files detected — leaving workspace untouched.${colors.reset}`);
            }
          }
        }
        return;
      } catch (err: any) {
        console.log(`\n${colors.red}✗ Failed to run saved DAG: ${err.message}${colors.reset}`);
      }
    }
    
    const plan = loadPlan(ctx.cwd);
    if (!plan) {
      console.log(`\n${colors.yellow}No saved plan or DAG. Generate one with /plan <task> or run a complex task in PLAN mode.${colors.reset}`);
      return;
    }
    console.log(`\n${colors.dim}Executing saved plan task: ${plan.task}${colors.reset}`);
    await ctx.handleInput(plan.task);
    return;
};

