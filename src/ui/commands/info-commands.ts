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

export const logCommand: CommandHandler = async (ctx) => {
    console.log(`\n${ctx.git.getRecentCommits(10)}`);
    return;

};

export const statsCommand: CommandHandler = async (ctx) => {
    if (ctx.printStats) ctx.printStats(ctx.state.stats);
    {
      const ctxTokens = ctx.conversation.getTotalTokens();
      const ctxLimit = ctx.conversation.getContextLimit();
      const ctxPct = Math.round((ctxTokens / ctxLimit) * 100);
      const hasSummary = ctx.conversation.getSummary() ? ' (compacted)' : '';
      console.log(`${colors.cyan}${colors.bold}📊 Context Window${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(40)}${colors.reset}`);
      console.log(`  History messages:    ${colors.bold}${ctx.conversation.getMessageCount()}${colors.reset}${hasSummary}`);
      console.log(`  Context usage:       ${colors.bold}${(ctxTokens / 1000).toFixed(0)}k / ${(ctxLimit / 1000).toFixed(0)}k${colors.reset} (${ctxPct}%)`);
      console.log(`  Turns:               ${colors.bold}${ctx.conversation.getTurnCount()}${colors.reset}`);
      console.log('');
    }
    return;

};

export const runsCommand: CommandHandler = async (ctx) => {
    const runs = listRuns(ctx.cwd, 12);
    console.log(runs.length
      ? `\n${runs.map(run => `${run.id} ${run.status} ${run.task.slice(0, 80)}`).join('\n')}`
      : '\n(no FixO runs recorded)');
    return;
};

export const showRunCommand: CommandHandler = async (ctx) => {
    console.log(`\n${showRun(ctx.cwd, ctx.args[0] ?? '')}`);
    return;

};

export const memoryCommand: CommandHandler = async (ctx) => {
    console.log(`\n${readMemory(ctx.cwd)}`);
    return;

};

export const rememberCommand: CommandHandler = async (ctx) => {
    const text = ctx.args.join(' ').trim();
    if (!text) {
      console.log(`\n${colors.yellow}Usage: /remember <project fact>${colors.reset}`);
      return;
    }
    ctx.rl.pause();
    const confirmed = await p.confirm({ message: `Add to project memory: ${text}?`, initialValue: false });
    ctx.rl.resume();
    if (!p.isCancel(confirmed) && confirmed) {
      appendMemory(ctx.cwd, text);
      console.log(`\n${colors.green}✓ Memory updated${colors.reset}`);
    }
    return;
};

export const forgetCommand: CommandHandler = async (ctx) => {
    ctx.rl.pause();
    {
      const confirmed = await p.confirm({ message: 'Clear FixO project memory?', initialValue: false });
      ctx.rl.resume();
      if (!p.isCancel(confirmed) && confirmed) {
        forgetMemory(ctx.cwd);
        console.log(`\n${colors.green}✓ Memory cleared${colors.reset}`);
      }
    }
    return;

};

export const doctorCommand: CommandHandler = async (ctx) => {
    console.log(`\n${doctor(ctx.cwd)}`);
    return;

};

export const indexCommand: CommandHandler = async (ctx) => {
    const index = await buildIndex(ctx.cwd);
    if (ctx.workspaceFiles) {
      ctx.workspaceFiles.length = 0;
      ctx.workspaceFiles.push(...index.files.map(f => f.path));
    }
    console.log(`\n${colors.green}✓ Indexed ${index.files.length} files${colors.reset}`);
    return;
};

export const findCommand: CommandHandler = async (ctx) => {
    console.log(`\n${await findInIndex(ctx.cwd, ctx.args.join(' '))}`);
    return;

};

export const explainCommand: CommandHandler = async (ctx) => {
    console.log(`\n${await explainIndexedTarget(ctx.cwd, ctx.args.join(' '))}`);
    return;

};

export const skillsCommand: CommandHandler = async (ctx) => {
    const { skillsManager } = await import('../../agent/skills.js');
    const list = skillsManager.getSkills();
    if (list.length === 0) {
      console.log(`\n${colors.dim}No skills registered. Register skill profiles by adding SKILL.md under ~/.fixocli/skills/<name>/ or .fixocli/skills/<name>/${colors.reset}`);
    } else {
      console.log(`\n${colors.cyan}${colors.bold}Registered Skills:${colors.reset}`);
      for (const skill of list) {
        console.log(`  - ${colors.bold}${skill.name}${colors.reset}${skill.description ? `: ${skill.description}` : ''} ${colors.dim}(${skill.location})${colors.reset}`);
      }
    }
    return;
};

export const telemetryCommand: CommandHandler = async (ctx) => {
    const sub = ctx.args[0]?.toLowerCase();
    if (sub === 'on' || sub === 'enable') {
      ctx.config.preferences.telemetry = true;
      saveConfig(ctx.config);
      console.log(`\n${colors.green}✓ Telemetry enabled${colors.reset}`);
    } else if (sub === 'off' || sub === 'disable') {
      ctx.config.preferences.telemetry = false;
      saveConfig(ctx.config);
      console.log(`\n${colors.green}✓ Telemetry disabled${colors.reset}`);
    } else {
      console.log(`\n${colors.dim}Telemetry is currently ${ctx.config.preferences.telemetry ? `${colors.green}ON${colors.reset}${colors.dim}` : `${colors.red}OFF${colors.reset}${colors.dim}`}. Usage: /telemetry on|off${colors.reset}`);
    }
    return;
};

