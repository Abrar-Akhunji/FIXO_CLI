/**
 * Interactive REPL shell for FixO CLI.
 * Provides command handling, file pinning, model selection,
 * and routes user input to the SingleAgent.
 */
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as p from '@clack/prompts';
import { SingleAgent } from '../agent/single-agent.js';
import { ConversationManager } from '../agent/conversation.js';
import { GitManager } from '../git/git-manager.js';
import type { AgentContext, ProjectConfig } from '../types.js';
import type { FreeLLMConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { WorkspaceGuard } from '../workspace-guard.js';
import { listRuns, showRun, undoRun } from '../runtime/task-session.js';
import { decidePolicy } from '../runtime/policy.js';
import { redactedEnv, redactSecrets } from '../runtime/redaction.js';
import { appendMemory, doctor, forgetMemory, readMemory } from '../project-memory.js';
import { buildIndex, explainIndexedTarget, findInIndex } from '../indexer.js';
import { reviewWorkspace } from '../review.js';
import { runProjectTests } from '../test-runner.js';
import { loadPlan, renderPlan, savePlan, classifyComplexityHeuristic } from '../planner.js';
import { mcpManager, mcpBridgeManager } from '../agent/tool-executor.js';
import { ProvidersManager, PROVIDER_REGISTRY } from '../agent/providers-manager.js';

import { colors, renderStatusLabel } from './colors.js';
import { COMMANDS_WITH_DESC, printWelcome, printHelp, buildPromptString, formatInputPaths } from './render.js';

const c = {
  ...colors,
  renderStatusLabel,
};



/* ──────────────────────── Welcome Banner ──────────────────────── */





/* ──────────────────────── Prompt Builder ──────────────────────── */



/* ──────────────────────── File Path Formatting ──────────────────────── */



/* ──────────────────────── Stats Tracker ──────────────────────── */

interface SessionStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalToolCalls: number;
  totalTasks: number;
  totalDurationMs: number;
}

/* ──────────────────────── REPL ──────────────────────── */

export interface PromptOptions {
  config: FreeLLMConfig;
  projectConfig?: ProjectConfig;
  cwd: string;
  verbose: boolean;
}

export async function startREPL(options: PromptOptions): Promise<void> {
  const { config, projectConfig, cwd, verbose } = options;

  // ──── Initialize components ────
  const agent = new SingleAgent(verbose);
  const conversation = new ConversationManager();
  const git = new GitManager(cwd);
  const guard = new WorkspaceGuard(cwd);
  const branch = git.isGitRepo() ? git.getCurrentBranch() : '';

  // Initialize local skills and local MCP bridge
  const { skillsManager } = await import('../agent/skills.js');
  skillsManager.initialize(cwd);
  await mcpBridgeManager.initialize(cwd);

  const { randomUUID } = await import('node:crypto');
  let currentSessionId: string = randomUUID();
  let sessionModifiedFiles: string[] = [];
  let currentMode: 'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT' = 'BUILD';

  let currentModel = projectConfig?.model ?? config.defaultModel ?? 'auto';
  conversation.setContextLimit(currentModel);
  let selectedFiles: string[] = [];
  let isPrompting = false;
  let activeSuggestionsCount = 0;
  interface AutocompleteOption {
    display: string;
    value: string;
    desc: string;
  }

  let currentMatches: AutocompleteOption[] = [];
  let highlightedIndex = 0;
  let workspaceFiles: string[] = [];
  try {
    const { loadIndex } = await import('../indexer.js');
    const index = loadIndex(cwd);
    workspaceFiles = index.files.map(f => f.path);
  } catch (err) {
    // Ignore
  }

  let lastPromptRow = 0;
  let mouseReportingEnabled = false;

  const stats: SessionStats = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalToolCalls: 0,
    totalTasks: 0,
    totalDurationMs: 0,
  };

  // ──── Print welcome ────
  printWelcome();

  if (projectConfig?.systemPrompt) {
    console.log(`${c.dim}📋 Project config loaded (.freellmapi.yml)${c.reset}`);
  }

  const historyFile = path.join(os.homedir(), '.fixo_history');
  let commandHistory: string[] = [];
  try {
    if (fs.existsSync(historyFile)) {
      commandHistory = fs.readFileSync(historyFile, 'utf-8').split('\n').filter(Boolean);
    }
  } catch (error: any) {
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      console.warn(`[Debug Warning] Failed to read command history from ${historyFile}: ${error.message || error}`);
    }
  }

  // ──── Create readline interface ────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: commandHistory,
    historySize: 1000,
    completer: (line: string) => {
      const list = COMMANDS_WITH_DESC.map((c) => c.cmd);
      if (line.startsWith('/')) {
        const matches = list.filter((cmd) => cmd.startsWith(line));
        return [matches, line];
      }
      return [[], line];
    },
  });

  // ──── Mouse Reporting Helpers ────
  function enableMouseReporting() {
    if (process.stdout.isTTY && !mouseReportingEnabled) {
      process.stdout.write('\x1b[?1003h\x1b[?1006h');
      mouseReportingEnabled = true;
    }
  }

  function disableMouseReporting() {
    if (process.stdout.isTTY && mouseReportingEnabled) {
      process.stdout.write('\x1b[?1003l\x1b[?1006l');
      mouseReportingEnabled = false;
    }
  }

  function disableMouseReportingSync() {
    try {
      if (process.stdout.isTTY && mouseReportingEnabled) {
        fs.writeSync(1, '\x1b[?1003l\x1b[?1006l');
        mouseReportingEnabled = false;
      }
    } catch (e: any) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        console.warn(`[Debug Warning] Failed to disable mouse reporting: ${e.message || e}`);
      }
    }
  }

  // Register synchronous exit cleanups
  const exitCleanup = () => {
    try {
      const hist = (rl as any).history;
      if (Array.isArray(hist)) {
        fs.writeFileSync(historyFile, hist.join('\n'), 'utf-8');
      }
    } catch (error: any) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        console.warn(`[Debug Warning] Failed to write history file on exit: ${error.message || error}`);
      }
    }
    disableMouseReportingSync();
    mcpManager.shutdown();
    mcpBridgeManager.shutdown();
  };
  process.on('exit', exitCleanup);

  // ──── Graceful exit handlers ────
  const sigintHandler = () => {
    exitCleanup();
    console.log('\n\n👋 FixO CLI session ended safely. Core engine offline.');
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  const sigtermHandler = () => {
    exitCleanup();
    process.exit(0);
  };
  process.on('SIGTERM', sigtermHandler);

  const uncaughtExceptionHandler = (err: Error) => {
    exitCleanup();
    console.error('\n🔥 Uncaught Exception:', err);
    process.exit(1);
  };
  process.on('uncaughtException', uncaughtExceptionHandler);

  // ──── Suggestion Box Helpers ────
  function clearSuggestions() {
    if (activeSuggestionsCount > 0) {
      disableMouseReporting();
      const currentCursor = rl.cursor;
      readline.moveCursor(process.stdout, 0, 1);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write('\x1b[J');
      readline.moveCursor(process.stdout, 0, -1);
      readline.cursorTo(process.stdout, 2 + currentCursor);
      activeSuggestionsCount = 0;
    }
  }

  function drawSuggestions(matches: AutocompleteOption[]) {
    clearSuggestions();
    if (matches.length === 0) return;

    enableMouseReporting();

    const currentCursor = rl.cursor;
    let output = '\n';
    
    const width = 60;
    const borderTop = `${c.snow}┌────────────────────────────────────────────────────────┐${c.reset}\n`;
    const borderBottom = `${c.snow}└────────────────────────────────────────────────────────┘${c.reset}`;
    output += borderTop;
    
    let startIndex = 0;
    if (highlightedIndex >= 8) {
      startIndex = highlightedIndex - 7;
    }
    const visibleMatches = matches.slice(startIndex, startIndex + 8);

    visibleMatches.forEach((item, index) => {
      const actualIndex = startIndex + index;
      const isHighlighted = actualIndex === highlightedIndex;
      const prefix = isHighlighted ? '❯ ' : '  ';
      
      const displayStr = item.display;
      const descStr = item.desc || '';
      
      const displayLimit = 25;
      const descLimit = 28;
      
      let dispText = displayStr;
      if (dispText.length > displayLimit) {
        dispText = dispText.slice(0, displayLimit - 3) + '...';
      }
      dispText = dispText.padEnd(displayLimit);
      
      let descText = descStr;
      if (descText.length > descLimit) {
        descText = descText.slice(0, descLimit - 3) + '...';
      }
      descText = descText.padEnd(descLimit);
      
      if (isHighlighted) {
        output += `${c.snow}│${c.reset} \x1b[48;5;236m\x1b[38;5;208m${prefix}${dispText} ${c.dim}${descText}\x1b[0m ${c.snow}│${c.reset}\n`;
      } else {
        output += `${c.snow}│${c.reset} ${prefix}${dispText} ${c.dim}${descText}${c.reset} ${c.snow}│${c.reset}\n`;
      }
    });
    
    if (matches.length > 8) {
      const remaining = matches.length - 8;
      const moreStr = `... and ${remaining} more matches`.padEnd(54);
      output += `${c.snow}│${c.reset} ${c.dim}${moreStr}${c.reset} ${c.snow}│${c.reset}\n`;
    }
    output += borderBottom;

    activeSuggestionsCount = visibleMatches.length + (matches.length > 8 ? 1 : 0) + 2;
    process.stdout.write(output);
    
    readline.moveCursor(process.stdout, 0, -activeSuggestionsCount);
    readline.cursorTo(process.stdout, 2 + currentCursor);

    // Request cursor position asynchronously
    process.stdout.write('\x1b[6n');
  }

  function getActiveToken(lineStr: string, cursorOffset: number) {
    const beforeCursor = lineStr.slice(0, cursorOffset);
    const lastSlash = beforeCursor.lastIndexOf('/');
    const lastAt = beforeCursor.lastIndexOf('@');
    
    const lastTriggerIdx = Math.max(lastSlash, lastAt);
    if (lastTriggerIdx === -1) {
      return { trigger: null, query: '', index: -1 };
    }
    
    if (lastTriggerIdx > 0 && !/\s/.test(beforeCursor[lastTriggerIdx - 1])) {
      return { trigger: null, query: '', index: -1 };
    }
    
    const trigger = lastTriggerIdx === lastSlash ? '/' : '@';
    const query = beforeCursor.slice(lastTriggerIdx + 1);
    
    if (/\s/.test(query)) {
      return { trigger: null, query: '', index: -1 };
    }
    
    return { trigger, query, index: lastTriggerIdx };
  }

  function getSuggestions(lineStr: string, cursorOffset: number): { options: AutocompleteOption[]; trigger: '/' | '@' | null; query: string; triggerIndex: number } {
    const active = getActiveToken(lineStr, cursorOffset);
    if (!active.trigger) {
      return { options: [], trigger: null, query: '', triggerIndex: -1 };
    }

    const q = active.query.toLowerCase();
    
    if (active.trigger === '/') {
      const matches = COMMANDS_WITH_DESC.filter(c => c.cmd.toLowerCase().startsWith(active.query.toLowerCase() ? '/' + active.query.toLowerCase() : '/'));
      const options = matches.map(m => ({
        display: m.cmd,
        value: m.cmd + ' ',
        desc: m.desc,
      }));
      return { options, trigger: '/', query: active.query, triggerIndex: active.index };
    } else {
      const options: AutocompleteOption[] = [];
      
      const subagents = [
        { name: 'code', desc: 'Code Agent: read and modify workspace files' },
        { name: 'test', desc: 'Test Agent: write, run, or fix tests' },
        { name: 'doc', desc: 'Documentation Agent: edit markdown and docstrings' },
        { name: 'reviewer', desc: 'Reviewer Agent: audit diffs and code modifications' },
      ];
      for (const sa of subagents) {
        const key = '@' + sa.name;
        if (!active.query || sa.name.toLowerCase().startsWith(q)) {
          options.push({
            display: key,
            value: key + ' ',
            desc: sa.desc,
          });
        }
      }

      try {
        const list = skillsManager.getSkills();
        for (const s of list) {
          const key = '@' + s.name;
          if (!active.query || s.name.toLowerCase().startsWith(q)) {
            options.push({
              display: key,
              value: key + ' ',
              desc: s.description || 'Skill profile',
            });
          }
        }
      } catch (error: any) {
        if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
          console.warn(`[Debug Warning] Failed to load skills list: ${error.message || error}`);
        }
      }

      const matchingFiles = workspaceFiles.filter(f => f.toLowerCase().includes(q) || path.basename(f).toLowerCase().startsWith(q));
      matchingFiles.sort((a, b) => {
        const baseA = path.basename(a).toLowerCase();
        const baseB = path.basename(b).toLowerCase();
        const aStarts = baseA.startsWith(q);
        const bStarts = baseB.startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.localeCompare(b);
      });

      for (const file of matchingFiles.slice(0, 12)) {
        const key = '@' + file;
        options.push({
          display: '@' + path.basename(file),
          value: key + ' ',
          desc: file,
        });
      }

      return { options, trigger: '@', query: active.query, triggerIndex: active.index };
    }
  }

  // ──── Keypress registration ────
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const keypressHandler = (_char: any, key: any) => {
    if (!isPrompting) return;
    if (key && (key.name === 'up' || key.name === 'down' || key.name === 'escape' || key.name === 'tab' || key.name === 'enter' || key.name === 'return')) {
      return;
    }
    process.nextTick(() => {
      if (!isPrompting) return;
      const line = rl.line;
      const cursor = rl.cursor;
      const suggs = getSuggestions(line, cursor);
      if (suggs.trigger) {
        const oldMatchesCount = currentMatches.length;
        currentMatches = suggs.options;
        if (currentMatches.length !== oldMatchesCount) {
          highlightedIndex = 0;
        }
        drawSuggestions(currentMatches);
      } else {
        clearSuggestions();
        currentMatches = [];
      }
    });
  };

  process.stdin.on('keypress', keypressHandler);

  let mouseBuffer = '';

  // Monkey-patch process.stdin.emit to intercept keypress and mouse events
  const originalEmit = process.stdin.emit as any;
  (process.stdin as any).emit = function (event: string, ...args: any[]) {
    if (event === 'data') {
      const rawData = args[0];
      if (rawData) {
        let str = mouseBuffer + rawData.toString();
        mouseBuffer = '';

        // Intercept cursor position response
        if (str.startsWith('\x1b[') && str.endsWith('R')) {
          const match = str.match(/\x1b\[(\d+);(\d+)R/);
          if (match) {
            lastPromptRow = parseInt(match[1], 10);
            return true;
          }
        }

        // Remove fully-formed SGR mouse events
        str = str.replace(/\x1b\[<[0-9;]+[Mm]/g, '');

        // Buffer any trailing partial SGR mouse event
        const partialIdx = str.lastIndexOf('\x1b[<');
        if (partialIdx !== -1) {
          const remaining = str.slice(partialIdx);
          if (!/[Mm]/.test(remaining)) {
            mouseBuffer = remaining;
            str = str.slice(0, partialIdx);
          }
        }

        // Process mouse events for suggestions list if present in raw data
        const mouseMatches = rawData.toString().match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g);
        if (mouseMatches) {
          for (const rawMatch of mouseMatches) {
            const m = rawMatch.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
            if (m) {
              const [_, buttonStr, colStr, rowStr, action] = m;
              const button = parseInt(buttonStr, 10);
              const clickRow = parseInt(rowStr, 10);
              const isPressed = action === 'M';

              if (activeSuggestionsCount > 0 && lastPromptRow > 0) {
                // Mouse Scroll UP
                if (button === 64) {
                  highlightedIndex = (highlightedIndex - 1 + currentMatches.length) % currentMatches.length;
                  drawSuggestions(currentMatches);
                }
                // Mouse Scroll DOWN
                else if (button === 65) {
                  highlightedIndex = (highlightedIndex + 1) % currentMatches.length;
                  drawSuggestions(currentMatches);
                }
                else {
                  const boxStartRow = lastPromptRow + 1;
                  let startIndex = 0;
                  if (highlightedIndex >= 8) {
                    startIndex = highlightedIndex - 7;
                  }
                  const clickedItemIndex = clickRow - boxStartRow - 1;
                  const actualHoveredIndex = startIndex + clickedItemIndex;

                  if (actualHoveredIndex >= 0 && actualHoveredIndex < currentMatches.length && clickedItemIndex < Math.min(currentMatches.length, 8)) {
                    // Mouse hover/motion
                    if (button === 35 || button === 32) {
                      if (highlightedIndex !== actualHoveredIndex) {
                        highlightedIndex = actualHoveredIndex;
                        drawSuggestions(currentMatches);
                      }
                    }
                    // Left click press
                    else if (button === 0 && isPressed) {
                      highlightedIndex = actualHoveredIndex;
                      const selected = currentMatches[highlightedIndex];
                      if (selected) {
                        const line = rl.line;
                        const cursor = rl.cursor;
                        const active = getActiveToken(line, cursor);
                        if (active.index !== -1) {
                          const beforeTrigger = line.slice(0, active.index);
                          const afterCursor = line.slice(cursor);
                          const newLine = beforeTrigger + selected.value + afterCursor;
                          
                          rl.write(null, { ctrl: true, name: 'u' });
                          rl.write(newLine);
                          const moveCount = newLine.length - (beforeTrigger.length + selected.value.length);
                          for (let i = 0; i < moveCount; i++) {
                            rl.write(null, { name: 'left' });
                          }
                        }
                        clearSuggestions();
                      }
                      return true;
                    }
                  }
                }
              }
            }
          }
        }

        // If the remaining string is empty, forward an empty buffer rather than swallowing
        args[0] = str.length > 0 ? Buffer.from(str) : Buffer.alloc(0);
      }
    }

    if (event === 'keypress') {
      const [char, key] = args;

      // Tab on empty line → cycle mode (BEFORE suggestion handling, so it always works)
      if (isPrompting && key && key.name === 'tab' && rl.line.trim() === '') {
        const modes: Array<'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT'> = ['BUILD', 'EXPLORE', 'SCOUT', 'PLAN'];
        const nextIndex = (modes.indexOf(currentMode) + 1) % modes.length;
        currentMode = modes[nextIndex];

        // Clear readline state
        (rl as any).line = '';
        (rl as any).cursor = 0;

        // Clear current prompt line:
        process.stdout.write('\r\x1b[K');
        
        // Re-display updated status line:
        const currentBranch = git.isGitRepo() ? git.getCurrentBranch() : '';
        const dirName = path.basename(cwd);
        const dirLabel = c.renderStatusLabel(`📂 ${dirName}`);
        const branchLabel = currentBranch ? ` ${c.renderStatusLabel(`🌳 ${currentBranch}`)}` : '';
        const modelLabel = ` ${c.renderStatusLabel(`🤖 ${currentModel}`)}`;
        const modeLabel = ` ${c.renderStatusLabel(`⚙️ ${currentMode}`)}`;
        
        process.stdout.write(`\n${dirLabel}${branchLabel}${modelLabel}${modeLabel}\n`);
        process.stdout.write(`${c.cyan}❯${c.reset} `);
        return true; // swallow keypress
      }
    }
    return originalEmit.apply(this, [event, ...args]);
  };

  // ──── REPL loop ────
  const promptForInput = (): void => {
    // Restore raw mode and resume streams to recover from any clack/spinner interactions
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    rl.resume();

    const currentBranch = git.isGitRepo() ? git.getCurrentBranch() : '';
    const dirName = path.basename(cwd);
    const dirLabel = c.renderStatusLabel(`📂 ${dirName}`);
    const branchLabel = currentBranch ? ` ${c.renderStatusLabel(`🌳 ${currentBranch}`)}` : '';
    const modelLabel = ` ${c.renderStatusLabel(`🤖 ${currentModel}`)}`;
    const modeLabel = ` ${c.renderStatusLabel(`⚙️ ${currentMode}`)}`;
    console.log(`\n${dirLabel}${branchLabel}${modelLabel}${modeLabel}`);

    isPrompting = true;
    rl.question(
      `${c.cyan}❯${c.reset} `,
      async (input) => {
        isPrompting = false;
        disableMouseReporting();
        clearSuggestions();
        const trimmed = input.trim();

        if (!trimmed) {
          promptForInput();
          return;
        }

        try {
          await handleInput(trimmed);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`\n${c.red}✗ Error: ${msg}${c.reset}`);

          // Actionable error suggestions
          if (msg.includes('ECONNREFUSED')) {
            console.log(`${c.dim}  → Proxy server is down. Restart with: npm run dev${c.reset}`);
          } else if (msg.includes('413')) {
            console.log(`${c.dim}  → Reduce context: /unselect to clear pinned files${c.reset}`);
          } else if (msg.includes('429')) {
            console.log(`${c.dim}  → Rate limited. Wait a moment or add more API keys.${c.reset}`);
          }
        }

        promptForInput();
      },
    );
  };

  // ──── Input handler ────
  async function handleInput(input: string): Promise<void> {
    // ─── Slash commands ───
    if (input.startsWith('/')) {
      const parts = input.split(/\s+/).filter(Boolean);
      const cmd = parts[0];
      const args = parts.slice(1);

      switch (cmd) {
        case '/exit':
        case '/quit':
          disableMouseReporting();
          console.log(`\n${c.dim}👋 Goodbye!${c.reset}`);
          process.stdin.off('keypress', keypressHandler);
          (process.stdin as any).emit = originalEmit;
          process.off('exit', exitCleanup);
          process.off('SIGINT', sigintHandler);
          process.off('SIGTERM', sigtermHandler);
          process.off('uncaughtException', uncaughtExceptionHandler);
          rl.close();
          process.exit(0);

        case '/help':
          printHelp();
          return;

        case '/model': {
          if (args[0] === 'list') {
            // Print full model table grouped by provider
            console.log(`\n${c.bold}${c.cyan}Available Models by Provider${c.reset}`);
            console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
            for (const def of PROVIDER_REGISTRY) {
              const hasKey = ProvidersManager.has(def.name);
              const keyStatus = hasKey ? `${c.green}[key ✓]${c.reset}` : `${c.dim}[no key]${c.reset}`;
              console.log(`\n  ${c.snow}${c.bold}${def.displayName}${c.reset} ${keyStatus}`);
              for (const model of def.models) {
                console.log(`    ${c.cyan}•${c.reset} ${model}`);
              }
            }
            console.log(`\n${c.dim}  Use /providers add <name> to connect a provider with your API key.${c.reset}`);
            console.log(`${c.dim}  Or set model directly: /model <model-id>${c.reset}\n`);
            return;
          }
          if (args.length === 0) {
            // Redesigned interactive model picker grouped by provider
            rl.pause();
            const pickedProvider = await p.select({
              message: `Current model: ${c.cyan}${currentModel}${c.reset} — Select AI Provider:`,
              options: [
                { value: 'all', label: 'Show all models (flat list)', hint: 'classic view' },
                ...PROVIDER_REGISTRY.map(def => ({
                  value: def.name,
                  label: def.displayName,
                  hint: ProvidersManager.has(def.name) ? ' [key ✓]' : ' [no key]'
                })),
                { value: '__manual__', label: 'Enter model ID manually…', hint: '' },
              ],
              initialValue: PROVIDER_REGISTRY.find(def => def.models.includes(currentModel))?.name || 'all',
            });
            rl.resume();

            if (p.isCancel(pickedProvider)) {
              console.log(`\n${c.dim}Model unchanged: ${c.cyan}${currentModel}${c.reset}`);
              return;
            }

            if (pickedProvider === '__manual__') {
              rl.pause();
              const manual = await p.text({
                message: 'Enter model ID:',
                placeholder: 'e.g. gpt-4o, claude-opus-4-5, gemini-2.5-pro',
                validate: v => !v.trim() ? 'Model ID is required' : undefined,
              });
              rl.resume();
              if (!p.isCancel(manual) && manual) {
                currentModel = manual.trim();
                conversation.setContextLimit(currentModel);
                console.log(`\n${c.green}✓ Model set to: ${c.bold}${currentModel}${c.reset}`);
              }
              return;
            }

            if (pickedProvider === 'all') {
              rl.pause();
              const allOptions = PROVIDER_REGISTRY.flatMap(def =>
                def.models.map(m => ({
                  value: m,
                  label: `${m}`,
                  hint: def.displayName + (ProvidersManager.has(def.name) ? ' [key ✓]' : ''),
                }))
              );
              const picked = await p.select({
                message: 'Select a model from the flat list:',
                options: [
                  { value: currentModel, label: `Keep current: ${currentModel}`, hint: 'no change' },
                  ...allOptions,
                ],
                initialValue: currentModel,
              });
              rl.resume();
              if (p.isCancel(picked)) {
                console.log(`\n${c.dim}Model unchanged: ${c.cyan}${currentModel}${c.reset}`);
                return;
              }
              currentModel = picked as string;
              conversation.setContextLimit(currentModel);
              console.log(`\n${c.green}✓ Model set to: ${c.bold}${currentModel}${c.reset}`);
              return;
            }

            const def = PROVIDER_REGISTRY.find(p => p.name === pickedProvider)!;
            const hasKey = ProvidersManager.has(def.name);
            const keyStatus = hasKey ? `${c.green}[key ✓]${c.reset}` : `${c.red}[no key]${c.reset}`;

            rl.pause();
            const picked = await p.select({
              message: `Select a model from ${c.bold}${def.displayName}${c.reset} ${keyStatus}:`,
              options: def.models.map(m => {
                const isFree = m.includes('free') || m.includes('chat') || def.name === 'zen';
                const label = isFree ? `${m} (free)` : m;
                return {
                  value: m,
                  label,
                  hint: m === currentModel ? 'currently selected' : ''
                };
              }),
              initialValue: def.models.includes(currentModel) ? currentModel : undefined,
            });
            rl.resume();

            if (p.isCancel(picked)) {
              console.log(`\n${c.dim}Model unchanged: ${c.cyan}${currentModel}${c.reset}`);
              return;
            }

            currentModel = picked as string;
            conversation.setContextLimit(currentModel);
            console.log(`\n${c.green}✓ Model set to: ${c.bold}${currentModel}${c.reset}`);
            return;
          }
          currentModel = args.join(' ');
          conversation.setContextLimit(currentModel);
          console.log(`\n${c.green}✓ Model set to: ${c.bold}${currentModel}${c.reset}`);
          return;
        }

        case '/select': {
          if (args.length === 0) {
            if (selectedFiles.length === 0) {
              console.log(`\n${c.dim}No files selected. Usage: /select <file-path>${c.reset}`);
            } else {
              console.log(`\n${c.dim}Selected files:${c.reset}`);
              for (const f of selectedFiles) {
                console.log(`  ${c.cyan}${path.basename(f)}${c.reset} ${c.dim}(${f})${c.reset}`);
              }
            }
            return;
          }
          let rawPath = args.join(' ');
          if ((rawPath.startsWith("'") && rawPath.endsWith("'")) ||
              (rawPath.startsWith('"') && rawPath.endsWith('"'))) {
            rawPath = rawPath.slice(1, -1);
          }
          let filePath: string;
          try {
            filePath = guard.ensureFile(rawPath);
          } catch (error) {
            console.log(`\n${c.red}✗ ${error instanceof Error ? error.message : String(error)}${c.reset}`);
            return;
          }
          if (!fs.existsSync(filePath)) {
            console.log(`\n${c.red}✗ File not found: ${rawPath}${c.reset}`);
            return;
          }
          if (!selectedFiles.includes(filePath)) {
            selectedFiles.push(filePath);
          }
          console.log(`\n${c.green}✓ Pinned: ${c.bold}${path.basename(filePath)}${c.reset}`);
          return;
        }

        case '/unselect':
          selectedFiles = [];
          console.log(`\n${c.green}✓ All pinned files cleared${c.reset}`);
          return;

        case '/diff':
          console.log(`\n${git.getDiff()}`);
          return;

        case '/undo': {
          if (args[0]) {
            console.log(`\n${undoRun(cwd, args[0])}`);
            return;
          }
          rl.pause();
          const confirmed = await p.confirm({
            message: 'Are you sure you want to completely discard the last automated agent commit and restore all files?',
            initialValue: false,
          });
          rl.resume();
          if (p.isCancel(confirmed) || !confirmed) {
            console.log(`\n${c.yellow}  ⚠ Undo cancelled.${c.reset}`);
            return;
          }
          git.undoLastCommit();
          return;
        }

        case '/clear':
          conversation.clear();
          console.log(`\n${c.green}✓ Conversation cleared${c.reset}`);
          return;

        case '/log':
          console.log(`\n${git.getRecentCommits(10)}`);
          return;

        case '/stats':
          printStats(stats);
          {
            const ctxTokens = conversation.getTotalTokens();
            const ctxLimit = conversation.getContextLimit();
            const ctxPct = Math.round((ctxTokens / ctxLimit) * 100);
            const hasSummary = conversation.getSummary() ? ' (compacted)' : '';
            console.log(`${c.cyan}${c.bold}📊 Context Window${c.reset}`);
            console.log(`${c.dim}${'─'.repeat(40)}${c.reset}`);
            console.log(`  History messages:    ${c.bold}${conversation.getMessageCount()}${c.reset}${hasSummary}`);
            console.log(`  Context usage:       ${c.bold}${(ctxTokens / 1000).toFixed(0)}k / ${(ctxLimit / 1000).toFixed(0)}k${c.reset} (${ctxPct}%)`);
            console.log(`  Turns:               ${c.bold}${conversation.getTurnCount()}${c.reset}`);
            console.log('');
          }
          return;

        case '/runs': {
          const runs = listRuns(cwd, 12);
          console.log(runs.length
            ? `\n${runs.map(run => `${run.id} ${run.status} ${run.task.slice(0, 80)}`).join('\n')}`
            : '\n(no FixO runs recorded)');
          return;
        }

        case '/show-run':
          console.log(`\n${showRun(cwd, args[0] ?? '')}`);
          return;

        case '/memory':
          console.log(`\n${readMemory(cwd)}`);
          return;

        case '/remember': {
          const text = args.join(' ').trim();
          if (!text) {
            console.log(`\n${c.yellow}Usage: /remember <project fact>${c.reset}`);
            return;
          }
          rl.pause();
          const confirmed = await p.confirm({ message: `Add to project memory: ${text}?`, initialValue: false });
          rl.resume();
          if (!p.isCancel(confirmed) && confirmed) {
            appendMemory(cwd, text);
            console.log(`\n${c.green}✓ Memory updated${c.reset}`);
          }
          return;
        }

        case '/forget':
          rl.pause();
          {
            const confirmed = await p.confirm({ message: 'Clear FixO project memory?', initialValue: false });
            rl.resume();
            if (!p.isCancel(confirmed) && confirmed) {
              forgetMemory(cwd);
              console.log(`\n${c.green}✓ Memory cleared${c.reset}`);
            }
          }
          return;

        case '/doctor':
          console.log(`\n${doctor(cwd)}`);
          return;

        case '/index': {
          const index = buildIndex(cwd);
          workspaceFiles = index.files.map(f => f.path);
          console.log(`\n${c.green}✓ Indexed ${index.files.length} files${c.reset}`);
          return;
        }

        case '/find':
          console.log(`\n${findInIndex(cwd, args.join(' '))}`);
          return;

        case '/explain':
          console.log(`\n${explainIndexedTarget(cwd, args.join(' '))}`);
          return;

        case '/review':
          console.log(`\n${reviewWorkspace(cwd)}`);
          return;

        case '/test':
          console.log(`\n${runProjectTests(cwd)}`);
          return;

        case '/fix-tests': {
          let testResult = runProjectTests(cwd);
          if (testResult.includes('Status: 0')) {
            console.log(`\n${c.green}✓ All tests are passing!${c.reset}`);
            return;
          }

          let attempt = 1;
          const maxAttempts = 3;
          const modifiedFiles: string[] = [];

          while (attempt <= maxAttempts) {
            console.log(`\n${c.cyan}🔨 [Auto-Fix] Test failure detected (Attempt ${attempt}/${maxAttempts}). Invoking SingleAgent to repair...${c.reset}`);
            console.log(`${c.dim}${testResult}${c.reset}\n`);

            const repairTask = `The project tests are failing. Here is the test runner output:\n\n${testResult}\n\nPlease identify the files causing the failure, modify them to fix the issues, verify using the test commands, and ensure they pass.`;
            const context: AgentContext = {
              task: repairTask,
              model: currentModel,
              cwd,
              verbose,
              selectedFiles: [...selectedFiles],
              systemPromptOverride: projectConfig?.systemPrompt,
              checkCommand: projectConfig?.checkCommand,
              policy: projectConfig?.policy ?? config.preferences.policy,
              mode: 'BUILD',
              yes: true,
            };

            try {
              const result = await agent.runStreaming(context, conversation, rl);
              for (const file of result.modifiedFiles) {
                if (!modifiedFiles.includes(file)) {
                  modifiedFiles.push(file);
                }
              }
            } catch (err: any) {
              console.log(`\n${c.red}✗ Repair agent failed on attempt ${attempt}: ${err.message || err}${c.reset}`);
            }

            testResult = runProjectTests(cwd);
            if (testResult.includes('Status: 0')) {
              console.log(`\n${c.green}✓ All tests passed after repair attempt ${attempt}!${c.reset}`);
              break;
            } else {
              attempt++;
            }
          }

          if (!testResult.includes('Status: 0')) {
            console.log(`\n${c.red}✗ Auto-fix failed after ${maxAttempts} attempts. Remaining failures:${c.reset}`);
            console.log(`${c.dim}${testResult}${c.reset}`);
          } else {
            // Auto-commit if enabled and changes were made
            if (
              config.preferences.autoCommit &&
              (projectConfig?.autoCommit !== false) &&
              modifiedFiles.length > 0
            ) {
              console.log(`\n${c.green}✓ Auto-committing repaired test files...${c.reset}`);
              git.autoCommit('fix-tests: repair test failures', modifiedFiles);
            }
          }
          return;
        }

        case '/fix-ci':
          console.log(`\n${c.yellow}/fix-ci local mode: paste CI logs into a task or save them to a workspace file, then ask FixO to inspect that file.${c.reset}`);
          return;

        case '/plan':
          {
            const task = args.join(' ').trim();
            if (!task) {
              console.log(`\n${c.yellow}Usage: /plan <task>${c.reset}`);
              return;
            }
            const plan = savePlan(cwd, task);
            console.log(`\n${renderPlan(plan)}`);
          }
          return;

        case '/run-plan': {
          const dagFile = path.join(cwd, '.fixo', 'last-dag.json');
          if (fs.existsSync(dagFile)) {
            try {
              const { task, dag } = JSON.parse(fs.readFileSync(dagFile, 'utf-8'));
              console.log(`\n${c.cyan}[Saved Plan] Executing saved subtasks DAG for task: ${c.bold}${task}${c.reset}`);
              
              const { AgentPool } = await import('../agent/agent-pool.js');
              const pool = new AgentPool(3, projectConfig?.maxAttempts ?? 12);
              
              const context: AgentContext = {
                task,
                model: currentModel,
                cwd,
                verbose,
                selectedFiles: [...selectedFiles],
                systemPromptOverride: projectConfig?.systemPrompt,
                checkCommand: projectConfig?.checkCommand,
                policy: projectConfig?.policy ?? config.preferences.policy,
                mode: currentMode,
              };
              
              const success = await pool.execute(context, dag);
              if (success) {
                console.log(`\n${c.green}✓ Successfully completed complex task via parallel agents.${c.reset}`);
              } else {
                console.log(`\n${c.red}✗ Parallel workers failed to complete all subtasks.${c.reset}`);
                if (git.isGitRepo()) {
                  console.log(`\n${c.yellow}[Agent Pool] Rolling back all uncommitted changes due to run failure...${c.reset}`);
                  git.discardUncommittedChanges();
                }
              }
              return;
            } catch (err: any) {
              console.log(`\n${c.red}✗ Failed to run saved DAG: ${err.message}${c.reset}`);
            }
          }
          
          const plan = loadPlan(cwd);
          if (!plan) {
            console.log(`\n${c.yellow}No saved plan or DAG. Generate one with /plan <task> or run a complex task in PLAN mode.${c.reset}`);
            return;
          }
          console.log(`\n${c.dim}Executing saved plan task: ${plan.task}${c.reset}`);
          await handleInput(plan.task);
          return;
        }

        case '/mode': {
          rl.pause();
          const selected = await p.select({
            message: 'Select execution mode:',
            options: [
              { value: 'PLAN', label: 'PLAN Mode (Read-only, dry-run simulation)' },
              { value: 'BUILD', label: 'BUILD Mode (Writing & modifying allowed)' },
              { value: 'EXPLORE', label: 'EXPLORE Mode (Code exploration & LSP, no modifying)' },
              { value: 'SCOUT', label: 'SCOUT Mode (Web search & fetch only)' },
            ],
            initialValue: currentMode,
          });
          rl.resume();
          if (!p.isCancel(selected) && selected) {
            currentMode = selected as 'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT';
            console.log(`\n${c.green}✓ Execution mode set to: ${c.bold}${currentMode}${c.reset}`);
          } else {
            console.log(`\n${c.dim}Execution mode remains: ${c.cyan}${currentMode}${c.reset}`);
          }
          return;
        }

        case '/session': {
          const sub = args[0];
          const { SessionManager } = await import('../agent/conversation.js');
          if (sub === 'list') {
            const list = SessionManager.listSessions();
            if (list.length === 0) {
              console.log(`\n${c.dim}No saved sessions found.${c.reset}`);
            } else {
              console.log(`\n${c.cyan}${c.bold}Saved Sessions:${c.reset}`);
              for (const s of list) {
                const date = new Date(s.timestamp).toLocaleString();
                console.log(`  ${c.cyan}${s.sessionId}${c.reset} - ${c.bold}${s.model}${c.reset} (${s.messageCount} msgs)`);
                console.log(`    ${c.dim}Created: ${date} | Tokens: ${s.totalTokens.toLocaleString()}${c.reset}`);
                if (s.summary) {
                  console.log(`    ${c.dim}Summary: ${s.summary.slice(0, 80)}...${c.reset}`);
                }
              }
            }
          } else if (sub === 'load') {
            const uuid = args[1];
            if (!uuid) {
              console.log(`\n${c.yellow}Usage: /session load <uuid>${c.reset}`);
              return;
            }
            try {
              const data = SessionManager.loadSession(uuid);
              conversation.clear();
              conversation.importHistory(data.history);
              conversation.setSummary(data.summary || '');
              currentModel = data.model;
              conversation.setContextLimit(currentModel);
              sessionModifiedFiles = data.modifiedFiles || [];
              currentSessionId = data.sessionId;
              stats.totalPromptTokens = data.tokenUsage?.prompt_tokens || 0;
              stats.totalCompletionTokens = data.tokenUsage?.completion_tokens || 0;
              console.log(`\n${c.green}✓ Session restored successfully: ${c.bold}${uuid}${c.reset}`);
              console.log(`${c.dim}  Model set to: ${c.cyan}${currentModel}${c.reset}`);
            } catch (err: any) {
              console.log(`\n${c.red}✗ Failed to load session: ${err.message}${c.reset}`);
            }
          } else if (sub === 'new') {
            conversation.clear();
            sessionModifiedFiles = [];
            stats.totalPromptTokens = 0;
            stats.totalCompletionTokens = 0;
            stats.totalToolCalls = 0;
            stats.totalTasks = 0;
            stats.totalDurationMs = 0;
            const { randomUUID } = await import('node:crypto');
            currentSessionId = randomUUID();
            SessionManager.saveSession(
              conversation,
              currentModel,
              sessionModifiedFiles,
              {
                prompt_tokens: stats.totalPromptTokens,
                completion_tokens: stats.totalCompletionTokens,
                total_tokens: stats.totalPromptTokens + stats.totalCompletionTokens,
              },
              currentSessionId
            );
            console.log(`\n${c.green}✓ Active conversation memory purged. New session initialized: ${c.bold}${currentSessionId}${c.reset}`);
          } else {
            console.log(`\n${c.yellow}Usage: /session [list | load <uuid> | new]${c.reset}`);
          }
          return;
        }

        case '/providers': {
          const sub = args[0];
          if (!sub || sub === 'list') {
            const list = ProvidersManager.list();
            if (list.length === 0) {
              console.log(`\n${c.yellow}No providers configured.${c.reset}`);
              console.log(`${c.dim}  Use /providers add <name> to connect a provider (e.g. /providers add groq)${c.reset}`);
              console.log(`${c.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${c.reset}`);
            } else {
              console.log(`\n${c.bold}${c.cyan}Connected Providers${c.reset}`);
              console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
              for (const entry of list) {
                const addedDate = new Date(entry.addedAt).toLocaleDateString();
                console.log(`  ${c.cyan}${entry.name.padEnd(14)}${c.reset}${c.bold}${entry.displayName.padEnd(22)}${c.reset}${c.dim}${entry.maskedKey}  (added ${addedDate})${c.reset}`);
              }
              console.log(`\n${c.dim}  Use /providers remove <name> to remove a key.${c.reset}`);
              console.log(`${c.dim}  Use /providers test <name> to verify a connection.${c.reset}`);
            }
            return;
          }

          if (sub === 'add') {
            const name = args[1]?.toLowerCase();
            if (!name) {
              console.log(`\n${c.yellow}Usage: /providers add <provider-name>${c.reset}`);
              console.log(`${c.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${c.reset}`);
              return;
            }
            const def = ProvidersManager.getDefinition(name);
            if (!def) {
              console.log(`\n${c.red}✗ Unknown provider: ${name}${c.reset}`);
              console.log(`${c.dim}  Available: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${c.reset}`);
              return;
            }
            console.log(`\n${c.cyan}${c.bold}Connecting to ${def.displayName}${c.reset}`);
            console.log(`${c.dim}  Get your API key at: ${def.docsUrl}${c.reset}`);
            rl.pause();
            const apiKeyInput = await p.text({
              message: `Enter your ${def.displayName} API key:`,
              placeholder: 'sk-... or gsk_...',
              validate: v => !v.trim() ? 'API key is required' : undefined,
            });
            rl.resume();
            if (p.isCancel(apiKeyInput)) {
              console.log(`\n${c.dim}Provider add cancelled.${c.reset}`);
              return;
            }
            ProvidersManager.add(name, apiKeyInput as string);
            console.log(`\n${c.green}✓ ${def.displayName} API key saved securely to ~/.fixocli/providers.json${c.reset}`);
            console.log(`${c.dim}  FixO will now route ${def.displayName} requests directly (bypassing the SaaS proxy).${c.reset}`);
            console.log(`${c.dim}  Use /model list to see available ${def.displayName} models.${c.reset}`);
            return;
          }

          if (sub === 'remove') {
            const name = args[1]?.toLowerCase();
            if (!name) {
              console.log(`\n${c.yellow}Usage: /providers remove <name>${c.reset}`);
              return;
            }
            rl.pause();
            const confirmed = await p.confirm({ message: `Remove API key for ${name}?`, initialValue: false });
            rl.resume();
            if (!p.isCancel(confirmed) && confirmed) {
              const removed = ProvidersManager.remove(name);
              console.log(removed
                ? `\n${c.green}✓ Removed API key for ${name}.${c.reset}`
                : `\n${c.yellow}No key found for provider: ${name}${c.reset}`);
            }
            return;
          }

          if (sub === 'test') {
            const name = args[1]?.toLowerCase();
            if (!name) {
              console.log(`\n${c.yellow}Usage: /providers test <name>${c.reset}`);
              return;
            }
            const directConf = ProvidersManager.getDirectConfig(name);
            if (!directConf) {
              console.log(`\n${c.yellow}No key configured for ${name}. Use /providers add ${name} first.${c.reset}`);
              return;
            }
            console.log(`\n${c.dim}Testing connection to ${directConf.displayName} (${directConf.baseUrl})...${c.reset}`);
            try {
              const testHeaders: Record<string, string> = {
                'Authorization': `Bearer ${directConf.apiKey}`,
              };
              if (name === 'zen' || name === 'openrouter') {
                testHeaders['HTTP-Referer'] = 'https://opencode.ai/';
                testHeaders['X-Title'] = 'opencode';
              } else if (name === 'nvidia') {
                testHeaders['HTTP-Referer'] = 'https://opencode.ai/';
                testHeaders['X-Title'] = 'opencode';
                testHeaders['X-BILLING-INVOKE-ORIGIN'] = 'OpenCode';
              } else if (name === 'cerebras') {
                testHeaders['X-Cerebras-3rd-Party-Integration'] = 'opencode';
              }

              const resp = await fetch(`${directConf.baseUrl}/models`, {
                headers: testHeaders,
                signal: AbortSignal.timeout(8000),
              });
              if (resp.ok) {
                console.log(`${c.green}✓ Connection to ${directConf.displayName} successful! (HTTP ${resp.status})${c.reset}`);
              } else {
                const text = await resp.text().catch(() => '');
                console.log(`${c.red}✗ ${directConf.displayName} returned HTTP ${resp.status}${text ? ': ' + text.slice(0, 100) : ''}${c.reset}`);
              }
            } catch (err: any) {
              console.log(`${c.red}✗ Connection failed: ${err.message}${c.reset}`);
            }
            return;
          }

          console.log(`\n${c.yellow}Usage: /providers [list | add <name> | remove <name> | test <name>]${c.reset}`);
          console.log(`${c.dim}  Available providers: ${PROVIDER_REGISTRY.map(p => p.name).join(', ')}${c.reset}`);
          return;
        }

        case '/compact': {
          const msgCount = conversation.getMessageCount();
          if (msgCount === 0) {
            console.log(`\n${c.dim}Nothing to compact — conversation is empty.${c.reset}`);
            return;
          }
          const tokensBefore = conversation.getTotalTokens();
          const contextLimit = conversation.getContextLimit();
          console.log(`\n${c.cyan}[Compact] Summarising ${msgCount} messages to free context tokens...${c.reset}`);
          console.log(`${c.dim}  Current context: ${(tokensBefore / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k tokens${c.reset}`);
          try {
            const compacted = await conversation.compact(agent.getClient(), currentModel);
            if (compacted) {
              const info = conversation.getLastCompactionInfo();
              const tokensAfter = conversation.getTotalTokens();
              console.log(`${c.green}✓ Compacted: ${info?.messagesBefore ?? msgCount} messages → summary + ${conversation.getMessageCount()} recent messages.${c.reset}`);
              console.log(`${c.dim}  Context: ${(tokensBefore / 1000).toFixed(0)}k → ${(tokensAfter / 1000).toFixed(0)}k tokens (~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k freed).${c.reset}`);
            } else {
              console.log(`${c.dim}Not enough messages to compact (need more than 4 messages).${c.reset}`);
            }
          } catch (err: any) {
            console.log(`${c.red}✗ Compact failed: ${err.message}${c.reset}`);
          }
          return;
        }

        case '/snapshot': {
          const label = args.join(' ').trim() || `snapshot-${Date.now()}`;
          if (!git.isGitRepo()) {
            console.log(`\n${c.yellow}⚠ Not a git repository — cannot create snapshot.${c.reset}`);
            return;
          }
          const hash = git.createSnapshot(label);
          if (hash) {
            console.log(`\n${c.green}✓ Workspace snapshot created: ${c.bold}${hash}${c.reset}${c.dim} (label: ${label})${c.reset}`);
            console.log(`${c.dim}  Use /undo or git revert to roll back to this point.${c.reset}`);
          }
          return;
        }

        case '/skills': {
          const { skillsManager } = await import('../agent/skills.js');
          const list = skillsManager.getSkills();
          if (list.length === 0) {
            console.log(`\n${c.dim}No skills registered. Register skill profiles by adding SKILL.md under ~/.fixocli/skills/<name>/ or .fixocli/skills/<name>/${c.reset}`);
          } else {
            console.log(`\n${c.cyan}${c.bold}Registered Skills:${c.reset}`);
            for (const skill of list) {
              console.log(`  - ${c.bold}${skill.name}${c.reset}${skill.description ? `: ${skill.description}` : ''} ${c.dim}(${skill.location})${c.reset}`);
            }
          }
          return;
        }

        case '/theme':
        case '/variant': {
          const { themeMode, setThemeMode } = await import('./colors.js');
          const newMode = themeMode === 'dark' ? 'inverted' : 'dark';
          setThemeMode(newMode);
          console.log(`\n${c.cyan}✓ Theme set to: ${newMode === 'dark' ? 'Dark Void Minimalist' : 'High-Contrast Inverted'}${c.reset}`);
          return;
        }

        case '/telemetry': {
          const sub = args[0]?.toLowerCase();
          if (sub === 'on' || sub === 'enable') {
            config.preferences.telemetry = true;
            saveConfig(config);
            console.log(`\n${c.green}✓ Telemetry enabled${c.reset}`);
          } else if (sub === 'off' || sub === 'disable') {
            config.preferences.telemetry = false;
            saveConfig(config);
            console.log(`\n${c.green}✓ Telemetry disabled${c.reset}`);
          } else {
            console.log(`\n${c.dim}Telemetry is currently ${config.preferences.telemetry ? `${c.green}ON${c.reset}${c.dim}` : `${c.red}OFF${c.reset}${c.dim}`}. Usage: /telemetry on|off${c.reset}`);
          }
          return;
        }

        default:
          console.log(`\n${c.yellow}Unknown command: ${cmd}. Type /help for available commands.${c.reset}`);
          return;
      }
    }

    // ─── Shell commands (! prefix) ───
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      const decision = decidePolicy(config.preferences.policy ?? 'shell-confirm', 'command', cmd);
      if (!decision.allowed) {
        console.log(`\n${c.red}✗ ${decision.reason}${c.reset}`);
        return;
      }
      rl.pause();
      const confirmed = await p.confirm({
        message: `Allow execution of local shell command: ${c.cyan}${cmd}${c.reset}? (${decision.reason})`,
        initialValue: false,
      });
      rl.resume();
      if (p.isCancel(confirmed) || !confirmed) {
        console.log(`\n${c.cyan}  ⚠ Execution cancelled.${c.reset}`);
        return;
      }
      console.log(`${c.dim}⚙️ Running: ${cmd}${c.reset}`);
      try {
        const { spawnSync } = await import('child_process');
        const result = spawnSync(cmd, {
          shell: true,
          cwd,
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: redactedEnv(),
        });
        const output = redactSecrets([result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n'));
        if (output.trim()) console.log(output);
      } catch (error: any) {
        if (error.stdout) console.log(error.stdout);
        if (error.stderr) console.error(`${c.red}${error.stderr}${c.reset}`);
      }
      return;
    }

    // ─── Agent task ───
    // Format any paths in the input for display
    const displayInput = formatInputPaths(input, cwd);
    if (displayInput !== input) {
      // Re-display with highlighted paths
      process.stdout.write(`\x1b[1A\x1b[2K`); // Move up and clear line
      console.log(`${c.cyan}❯${c.reset} ${displayInput}`);
    }

    // Extract any file paths from input for automatic pinning
    const pathsInInput = extractFilePaths(input, cwd);

    const dirtyBefore = git.isGitRepo() ? git.getDirtyFiles() : [];

    const context: AgentContext = {
      task: input,
      model: currentModel,
      cwd,
      verbose,
      selectedFiles: [...selectedFiles, ...pathsInInput],
      systemPromptOverride: projectConfig?.systemPrompt,
      checkCommand: projectConfig?.checkCommand,
      policy: projectConfig?.policy ?? config.preferences.policy,
      mode: currentMode,
    };

    const classification = classifyComplexityHeuristic(input);
    let result;
    const startTime = Date.now();

    if (classification.complexity === 'complex') {
      console.log(`\n${c.cyan}[Routing Engine] Complex task detected (${classification.reason}). Routing to Orchestrator...${c.reset}`);
      try {
        const { Orchestrator } = await import('../agent/orchestrator.js');
        const { AgentPool } = await import('../agent/agent-pool.js');

        console.log(`\n${c.cyan}[Orchestrator] Generating plan for complex task...${c.reset}`);
        const orchestrator = new Orchestrator(verbose);
        const dag = await orchestrator.plan(context);

        // Render planned phases in high contrast box
        const width = 60;
        const borderTop = `┌${'─'.repeat(width)}┐`;
        const borderBottom = `└${'─'.repeat(width)}┘`;
        console.log(`\n${c.cyan}${borderTop}${c.reset}`);
        console.log(`${c.cyan}│${c.reset}  ${c.bold}Planned Subtask Phases (Complex Task decomposition):${c.reset}${' '.repeat(width - 52)}${c.cyan}│${c.reset}`);
        console.log(`${c.cyan}├${'─'.repeat(width)}┤${c.reset}`);
        for (const sub of dag.subtasks) {
          const deps = sub.dependencies.length > 0 ? ` (deps: ${sub.dependencies.join(', ')})` : '';
          const lineStr = `  - [${sub.persona.toUpperCase()}] ${sub.title}${deps}`;
          const pad = Math.max(0, width - lineStr.length - 4);
          console.log(`${c.cyan}│${c.reset}  ${c.bold}${lineStr}${c.reset}${' '.repeat(pad)}  ${c.cyan}│${c.reset}`);
        }
        console.log(`${c.cyan}${borderBottom}${c.reset}\n`);

        // Save the DAG to .fixo/last-dag.json
        const fixoDir = path.join(cwd, '.fixo');
        fs.mkdirSync(fixoDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixoDir, 'last-dag.json'),
          JSON.stringify({ task: input, dag }, null, 2),
          'utf-8'
        );

        if (currentMode === 'PLAN') {
          console.log(`${c.green}✓ Plan generated and saved successfully.${c.reset}`);
          console.log(`${c.dim}  To execute this plan, switch to BUILD mode (type /mode build or hit [TAB]) and run: /run-plan${c.reset}\n`);
          return;
        }

        const budgetLimit = projectConfig?.maxAttempts ?? 12;
        const pool = new AgentPool(3, budgetLimit);

        console.log(`\n${c.cyan}[Agent Pool] Executing DAG of subtasks (concurrency limit: 3, budget: ${budgetLimit} tool calls)...${c.reset}`);
        const success = await pool.execute(context, dag);
        const durationMs = Date.now() - startTime;

        const totalPromptTokens = orchestrator.tokensUsed.prompt_tokens + pool.tokensUsed.prompt_tokens;
        const totalCompletionTokens = orchestrator.tokensUsed.completion_tokens + pool.tokensUsed.completion_tokens;

        // Find modified files to report
        const { getModifiedFiles, getBranchPoint } = await import('../agent/worker-agent.js');
        const relativeModified = getModifiedFiles(cwd, getBranchPoint(cwd));
        const modifiedFiles = relativeModified.map(f => path.resolve(cwd, f));

        if (!success) {
          console.log(`\n${c.red}✗ Parallel workers failed to complete all subtasks.${c.reset}`);
          if (git.isGitRepo()) {
            console.log(`\n${c.yellow}[Agent Pool] Rolling back all uncommitted changes due to run failure...${c.reset}`);
            git.discardUncommittedChanges();
          }
        }

        result = {
          success,
          response: success
            ? 'Successfully completed complex task via parallel agents.'
            : 'Failed to complete all complex subtasks.',
          modifiedFiles,
          tokensUsed: {
            prompt_tokens: totalPromptTokens,
            completion_tokens: totalCompletionTokens,
            total_tokens: totalPromptTokens + totalCompletionTokens
          },
          toolCallCount: pool.toolCallCount,
          durationMs,
          model: context.model,
        };

      } catch (err: any) {
        console.error(`\n${c.red}✗ Orchestrated execution failed: ${err.message || err}${c.reset}`);
        if (git.isGitRepo()) {
          console.log(`\n${c.yellow}[Agent Pool] Rolling back all uncommitted changes due to error...${c.reset}`);
          git.discardUncommittedChanges();
        }
        const durationMs = Date.now() - startTime;
        result = {
          success: false,
          response: `Orchestrated run failed: ${err.message || err}`,
          modifiedFiles: [],
          tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          toolCallCount: 0,
          durationMs,
          model: context.model,
        };
      }
    } else {
      console.log(`\n${c.cyan}[Routing Engine] Simple task detected (${classification.reason}). Routing to SingleAgent...${c.reset}`);
      result = await agent.runStreaming(context, conversation, rl);
    }

    // Print result summary
    console.log('');
    const modelPart = result.model ? `${result.model} · ` : '';
    const tokenInfo = `${c.dim}${modelPart}${result.tokensUsed.total_tokens} tokens · ${result.toolCallCount} tool calls · ${(result.durationMs / 1000).toFixed(1)}s${c.reset}`;
    console.log(tokenInfo);

    // Auto-commit if enabled
    if (
      config.preferences.autoCommit &&
      (projectConfig?.autoCommit !== false) &&
      result.modifiedFiles.length > 0
    ) {
      const gitModified = result.modifiedFiles.map(f => guard.relative(f));
      const preExistingEdits = gitModified.filter(f => dirtyBefore.includes(f));
      let allowed = true;
      if (preExistingEdits.length > 0) {
        rl.pause();
        const confirmed = await p.confirm({
          message: `The agent modified files with pre-existing uncommitted edits: ${preExistingEdits.join(', ')}. Allow auto-commit?`,
          initialValue: false,
        });
        rl.resume();
        if (p.isCancel(confirmed) || !confirmed) {
          allowed = false;
          console.log(`\n${c.yellow}  ⚠ Auto-commit skipped due to pre-existing edits.${c.reset}`);
        }
      }
      if (allowed) {
        git.autoCommit(input, result.modifiedFiles);
      }
    }

    // Update stats
    stats.totalPromptTokens += result.tokensUsed.prompt_tokens;
    stats.totalCompletionTokens += result.tokensUsed.completion_tokens;
    stats.totalToolCalls += result.toolCallCount;
    stats.totalTasks++;
    stats.totalDurationMs += result.durationMs;

    // Token budget warning → replaced with auto-compact
    const currentContextTokens = conversation.getTotalTokens();
    const contextLimit = conversation.getContextLimit();
    const contextPct = Math.round((currentContextTokens / contextLimit) * 100);

    // Auto-compact after each turn if context is getting large
    if (conversation.shouldCompact()) {
      console.log(`\n${c.yellow}🔄 Context at ${contextPct}% (${(currentContextTokens / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k) — auto-compacting...${c.reset}`);
      try {
        const compacted = await conversation.compact(agent.getClient(), currentModel);
        if (compacted) {
          const info = conversation.getLastCompactionInfo();
          const newTokens = conversation.getTotalTokens();
          console.log(`${c.green}✓ Compacted: ${info?.messagesBefore ?? '?'} messages → summary + ${conversation.getMessageCount()} recent. ${(currentContextTokens / 1000).toFixed(0)}k → ${(newTokens / 1000).toFixed(0)}k tokens.${c.reset}`);
        }
      } catch (err) {
        // Don't let compaction errors crash the REPL
        console.log(`${c.dim}[Context] Auto-compact failed, continuing with current context.${c.reset}`);
      }
    } else if (contextPct > 50) {
      console.log(`\n${c.dim}📊 Context: ${(currentContextTokens / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k tokens (${contextPct}%)${c.reset}`);
    }

    // Save stateful session persistence
    try {
      const { SessionManager } = await import('../agent/conversation.js');
      // Merge modified files from this run
      for (const file of result.modifiedFiles) {
        if (!sessionModifiedFiles.includes(file)) {
          sessionModifiedFiles.push(file);
        }
      }
      SessionManager.saveSession(
        conversation,
        currentModel,
        sessionModifiedFiles,
        {
          prompt_tokens: stats.totalPromptTokens,
          completion_tokens: stats.totalCompletionTokens,
          total_tokens: stats.totalPromptTokens + stats.totalCompletionTokens,
        },
        currentSessionId
      );
    } catch (err) {
      // Ignore session save errors
    }
  }

  // Start the loop
  promptForInput();
}

/* ──────────────────────── Helpers ──────────────────────── */

function extractFilePaths(input: string, cwd: string): string[] {
  const paths: string[] = [];
  const guard = new WorkspaceGuard(cwd);
  // Only match paths that look like real file references:
  // - Quoted paths with extensions
  // - Unquoted paths with a directory separator AND a code/doc extension
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.css', '.scss', '.json', '.md', '.yml', '.yaml', '.toml', '.env', '.sh', '.bash', '.txt', '.html', '.vue', '.svelte']);
  const extensionPattern = Array.from(extensions).join('|').replace(/\./g, '\\.');
  const patterns = [
    new RegExp(`'([^']+${extensionPattern})'`, 'g'),
    new RegExp(`"([^"]+${extensionPattern})"`, 'g'),
    new RegExp(`\\b([\\w.-]+\\/${extensionPattern})\\b`, 'g'),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      let filePath: string;
      try {
        filePath = guard.ensureFile(match[1]);
      } catch {
        continue;
      }
      if (fs.existsSync(filePath) && !paths.includes(filePath)) {
        paths.push(filePath);
      }
    }
  }

  return paths;
}

function printStats(stats: SessionStats): void {
  const totalTokens = stats.totalPromptTokens + stats.totalCompletionTokens;
  const avgDuration = stats.totalTasks > 0
    ? (stats.totalDurationMs / stats.totalTasks / 1000).toFixed(1)
    : '0';

  // Rough cost estimation: $3/M input + $15/M output tokens (average across providers)
  const estimatedCost =
    (stats.totalPromptTokens / 1_000_000) * 3 +
    (stats.totalCompletionTokens / 1_000_000) * 15;

  console.log('');
  console.log(`${c.cyan}${c.bold}📊 Session Statistics${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(40)}${c.reset}`);
  console.log(`  Tasks completed:     ${c.bold}${stats.totalTasks}${c.reset}`);
  console.log(`  Tool calls:          ${c.bold}${stats.totalToolCalls}${c.reset}`);
  console.log(`  Input tokens:        ${c.bold}${stats.totalPromptTokens.toLocaleString()}${c.reset}`);
  console.log(`  Output tokens:       ${c.bold}${stats.totalCompletionTokens.toLocaleString()}${c.reset}`);
  console.log(`  Total tokens:        ${c.bold}${totalTokens.toLocaleString()}${c.reset}`);
  console.log(`  Avg task duration:   ${c.bold}${avgDuration}s${c.reset}`);
  console.log(`  Cost savings:        ${c.green}${c.bold}~$${estimatedCost.toFixed(2)} saved${c.reset} ${c.dim}(free models!)${c.reset}`);
  console.log('');
}
