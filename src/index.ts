#!/usr/bin/env node
/**
 * FixO CLI — Entry Point
 *
 * Boot sequence:
 * 1. Load global config (~/.fixocli/config.json)
 * 2. If first run → run setup wizard
 * 3. Load project config (.freellmapi.yml) if present
 * 4. Ensure proxy server is running on the configured port
 * 5. Launch interactive REPL
 */
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, getDefaultConfig, type FreeLLMConfig } from './config.js';
import { runSetupWizard } from './setup-wizard.js';
import { startREPL } from './ui/prompt.js';
import type { ProjectConfig } from './types.js';
import yaml from 'js-yaml';

import { colors } from './ui/colors.js';
const c = colors;

/* ──────────────────────── CLI Args ──────────────────────── */

function parseArgs(): {
  help: boolean;
  version: boolean;
  verbose: boolean;
  yes: boolean;
  model?: string;
  port?: number;
  task?: string;
} {
  const args = process.argv.slice(2);
  const result = {
    help: false,
    version: false,
    verbose: false,
    yes: false,
    model: undefined as string | undefined,
    port: undefined as number | undefined,
    task: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--version':
      case '-V':
        result.version = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--yes':
      case '-y':
        result.yes = true;
        break;
      case '--model':
      case '-m':
        if (i + 1 < args.length) result.model = args[++i];
        break;
      case '--port':
      case '-p':
        if (i + 1 < args.length) result.port = parseInt(args[++i], 10);
        break;
      case '--task':
      case '-t':
        if (i + 1 < args.length && !result.task) {
          result.task = args.slice(i + 1).join(' ');
          i = args.length; // consume rest
        }
        break;
      default:
        // If no flag, treat rest as task
        if (!arg.startsWith('-') && !result.task) {
          result.task = args.slice(i).join(' ');
          i = args.length;
        }
        break;
    }
  }

  return result;
}

function printHelpMessage(): void {
  console.log(`
${c.cyan}${c.bold}FixO CLI${c.reset} — Autonomous Free Multi-Provider LLM Coding Tool

${c.bold}USAGE${c.reset}
  fixo                           Start interactive REPL
  fixo "fix the bug"             Run a one-shot task
  fixo --help                    Show this help

${c.bold}OPTIONS${c.reset}
  -h, --help          Show help
  -V, --version       Show version
  -v, --verbose       Enable verbose/debug output
  -y, --yes           Allow low-risk actions without repeated prompts
  -m, --model <name>  Set the model (default: auto)
  -p, --port <port>   Proxy server port (default: 3001)
  -t, --task <text>   Run a one-shot task

${c.bold}INTERACTIVE COMMANDS${c.reset}
  /help               Show all commands
  /model [name|list]  Set model or list available models
  /providers          Manage AI provider API keys
  /mode [mode]        Set PLAN/BUILD/EXPLORE/SCOUT mode
  /select [file]      Pin a file for agent context
  /unselect           Clear all pinned files
  /plan <task>        Generate a structured execution plan
  /run-plan           Execute the last saved plan
  /diff               Show git diff
  /undo               Undo last AI change
  /snapshot [label]   Create a named git snapshot
  /log                Show recent git commits
  /clear              Clear conversation
  /compact            Summarise & compress conversation
  /stats              Show usage statistics
  /session            Manage sessions (list|load|new)
  /runs               List recent FixO task ledgers
  /show-run <id>      Show details of a specific run
  /review             Review current git diff
  /test               Run detected project checks
  /fix-ci             Fix CI failures (paste logs)
  /memory             Show project memory
  /remember <fact>    Add a project fact to memory
  /forget             Clear all project memory
  /index              Build local repo index
  /find <query>       Search the repo index
  /explain <target>   Explain a file or symbol
  /skills             List registered skill profiles
  /doctor             Run FixO diagnostics
  /theme              Toggle Dark Void / Inverted theme
  /exit               Exit

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# Start interactive mode${c.reset}
  fixo

  ${c.dim}# One-shot task${c.reset}
  fixo "add input validation to user.ts"

  ${c.dim}# Use a specific model${c.reset}
  fixo -m gemini-2.5-flash "explain this codebase"
  `);
}

/* ──────────────────────── Project Config ──────────────────────── */

const KNOWN_CONFIG_KEYS = new Set(['model', 'checkCommand', 'autoCommit', 'policy', 'executionMode', 'maxAttempts', 'systemPrompt', 'plugins', 'trustedPlugins']);

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
  const yamlPath = path.join(cwd, '.freellmapi.yml');
  const yamlAltPath = path.join(cwd, '.freellmapi.yaml');

  let configPath: string | undefined;
  if (fs.existsSync(yamlPath)) configPath = yamlPath;
  else if (fs.existsSync(yamlAltPath)) configPath = yamlAltPath;

  if (!configPath) return undefined;

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const doc = yaml.load(content) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object') return undefined;

    for (const key of Object.keys(doc)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        console.warn(`${c.yellow}⚠ Unknown config key "${key}" in ${path.basename(configPath)}${c.reset}`);
      }
    }

    const config: ProjectConfig = {};
    if (typeof doc.model === 'string') config.model = doc.model;
    if (typeof doc.checkCommand === 'string') config.checkCommand = doc.checkCommand;
    if (doc.autoCommit !== undefined) config.autoCommit = Boolean(doc.autoCommit);
    if (typeof doc.policy === 'string') config.policy = doc.policy as ProjectConfig['policy'];
    if (typeof doc.executionMode === 'string') config.executionMode = doc.executionMode as ProjectConfig['executionMode'];
    if (doc.maxAttempts !== undefined) config.maxAttempts = parseInt(String(doc.maxAttempts), 10);
    if (typeof doc.systemPrompt === 'string') config.systemPrompt = doc.systemPrompt;
    if (Array.isArray(doc.plugins)) config.plugins = doc.plugins.map(String);
    if (Array.isArray(doc.trustedPlugins)) config.trustedPlugins = doc.trustedPlugins.map(String);

    return config;
  } catch {
    return undefined;
  }
}

/* ──────────────────────── Main ──────────────────────── */

async function main(): Promise<void> {
  // Node version check (major >= 24)
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 24) {
    console.error(`${c.red}Error: FixO CLI requires Node.js version 24.0.0 or higher (current version: ${process.version}).${c.reset}`);
    process.exit(1);
  }

  const args = parseArgs();

  if (args.help) {
    printHelpMessage();
    process.exit(0);
  }

  if (args.version) {
    try {
      const pkgPath = new URL('../package.json', import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      console.log(`fixo-cli v${pkg.version}`);
    } catch {
      console.log('fixo-cli v1.0.0');
    }
    process.exit(0);
  }

  // ──── Step 1: Load config ────
  let config = loadConfig();

  // ──── Step 2: First-run wizard & Validation ────
  if (!config._firstRunComplete || !config.freellmapi_api_key || !config.apiUrl) {
    config = await runSetupWizard();
    saveConfig(config);
  } else {
    // Validate API Key
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${config.apiUrl}/models`, {
        headers: { Authorization: `Bearer ${config.freellmapi_api_key}` },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.status === 401 || res.status === 403) {
        console.warn(`${c.yellow}⚠ Warning: API Key appears invalid (HTTP ${res.status}). You may need to re-run setup.${c.reset}`);
      }
    } catch (err: unknown) {
      console.warn(`${c.yellow}⚠ Warning: Could not validate API key (connection failed). Proceeding in offline mode or assuming temporary network issue.${c.reset}`);
    }
  }

  // ──── Apply CLI port override ────
  if (args.port) {
    if (config.apiUrl) {
      try {
        const url = new URL(config.apiUrl);
        url.port = args.port.toString();
        config.apiUrl = url.toString();
      } catch {
        config.apiUrl = `http://localhost:${args.port}/v1`;
      }
    } else {
      config.apiUrl = `http://localhost:${args.port}/v1`;
    }
  }

  // ──── Step 3: Load project config ────
  const cwd = process.cwd();
  const projectConfig = loadProjectConfig(cwd);

  // ──── Step 3.5: Initialize MCP & Plugins ────
  const { mcpManager, mcpBridgeManager, initializePlugins } = await import('./agent/tool-executor.js');
  await mcpManager.initialize();
  await mcpBridgeManager.initialize(cwd);

  const { skillsManager } = await import('./agent/skills.js');
  skillsManager.initialize(cwd);

  await initializePlugins(cwd, projectConfig);

  // Register shutdown hook
  process.on('exit', () => {
    mcpManager.shutdown();
    mcpBridgeManager.shutdown();
  });

  // ──── Apply CLI overrides ────
  const model = args.model ?? projectConfig?.model ?? config.defaultModel;
  const verbose = args.verbose;

  // ──── Step 4: Launch ────
  if (args.task) {
    // One-shot mode: run task and exit
    const { SingleAgent } = await import('./agent/single-agent.js');
    const { ConversationManager } = await import('./agent/conversation.js');
    const agent = new SingleAgent(verbose);
    const conversation = new ConversationManager();

    const result = await agent.runStreaming(
      {
        task: args.task,
        model: model ?? 'auto',
        cwd,
        verbose,
        selectedFiles: [],
        systemPromptOverride: projectConfig?.systemPrompt,
        checkCommand: projectConfig?.checkCommand,
        policy: projectConfig?.policy ?? config.preferences.policy,
        yes: args.yes,
      },
      conversation,
    );

    // Print final stats
    const modelPart = result.model ? `${result.model} · ` : '';
    console.log(
      `\n${c.dim}${modelPart}${result.tokensUsed.total_tokens} tokens · ${result.toolCallCount} tool calls · ${(result.durationMs / 1000).toFixed(1)}s${c.reset}`,
    );

    const { stopLspManager } = await import('./agent/tool-executor.js');
    await stopLspManager();

    process.exit(result.success ? 0 : 1);
  }

  // Interactive REPL mode
  await startREPL({
    config,
    projectConfig,
    cwd,
    verbose,
  });

  const { stopLspManager } = await import('./agent/tool-executor.js');
  await stopLspManager();
}

// ──── Run ────
main().catch((error) => {
  console.error(`${c.red}Fatal error: ${error.message ?? error}${c.reset}`);
  process.exit(1);
});
