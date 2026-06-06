/**
 * Tool definitions and executor for the single-agent tool-calling loop.
 * Provides: read_file, write_file, run_command, search_code, list_dir
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ChatToolDefinition } from '../shared/types.js';
import { colors } from '../ui/colors.js';
import { renderToolCall } from '../ui/render-primitives.js';
import { WorkspaceGuard } from '../workspace-guard.js';
import type { TaskSession } from '../runtime/task-session.js';
import { decidePolicy, type PolicyProfile } from '../runtime/policy.js';
import { redactedEnv, redactSecrets } from '../runtime/redaction.js';
import { McpManager } from './mcp-manager.js';
import type { AgentClient } from './agent-client.js';
import { createBranch, commitChanges, pushBranch, createPullRequest } from '../git/git-ops.js';
import { pathToFileURL } from 'url';
import * as p from '@clack/prompts';
import { loadConfig, saveConfig, type SafetyConfig } from '../config.js';
import { AtomicStagingManager } from '../runtime/staging.js';
import { LspPreSaveGate, makeLspProvider } from '../lsp/lsp-pre-save.js';
import { syntaxHealthCheck, formatSyntaxVerdict } from '../lsp/syntax-fallback.js';
import { PlatformPathLockedError } from '../workspace-guard.js';

import { McpBridgeManager } from './mcp-bridge.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { webFetch, webSearch } from './web.js';
import {
  ParserFactory,
  languageIdFromExtension,
  type ImportInfo,
  type SymbolInfo,
} from './parser-adapter.js';

export const mcpManager = new McpManager();
export const mcpBridgeManager = new McpBridgeManager();

let lspManagerInstance: LspManager | null = null;

export function getLspManager(workspaceRoot: string): LspManager {
  if (!lspManagerInstance) {
    lspManagerInstance = new LspManager(workspaceRoot);
  }
  return lspManagerInstance;
}

export async function stopLspManager(): Promise<void> {
  if (lspManagerInstance) {
    await lspManagerInstance.stopAll();
    lspManagerInstance = null;
  }
}

export interface LoadedPlugin {
  path: string;
  tools: ChatToolDefinition[];
  execute: (name: string, args: Record<string, any>, context: any) => Promise<string>;
}

export const loadedPlugins: LoadedPlugin[] = [];

export async function initializePlugins(cwd: string, projectConfig?: any): Promise<void> {
  if (!projectConfig || !projectConfig.plugins || !Array.isArray(projectConfig.plugins)) {
    return;
  }

  const guard = new WorkspaceGuard(cwd);
  const globalConfig = loadConfig() as any;
  if (!globalConfig.approvedPlugins) {
    globalConfig.approvedPlugins = [];
  }

  const trusted = projectConfig.trustedPlugins || [];

  for (const pluginPath of projectConfig.plugins) {
    try {
      const resolvedPath = guard.resolve(pluginPath);
      const isTrusted = trusted.includes(pluginPath) || trusted.includes(resolvedPath);
      if (!isTrusted) {
        console.error(`\n${colors.red}[Plugin Loader] Error: Plugin "${pluginPath}" is listed in "plugins" but is not in the "trustedPlugins" allowlist inside .freellmapi.yml. Skipping.${colors.reset}`);
        continue;
      }

      const fileUrl = pathToFileURL(resolvedPath).toString();
      const mod = await import(fileUrl);
      const tools = (mod.tools || []) as ChatToolDefinition[];
      const execute = mod.execute;

      if (typeof execute !== 'function') {
        console.error(`\n${colors.red}[Plugin Loader] Error: Plugin "${pluginPath}" does not export an "execute" function. Skipping.${colors.reset}`);
        continue;
      }

      const approvedKey = `${resolvedPath}`;
      const isApproved = globalConfig.approvedPlugins.includes(approvedKey);

      if (!isApproved) {
        console.log(`\n${colors.yellow}╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║                  PLUGIN SECURITY VERIFICATION                  ║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝`);
        console.log(`A new plugin is requesting to be loaded for this workspace:`);
        console.log(`- Path: ${colors.cyan}${pluginPath}${colors.reset}`);
        console.log(`- Resolved: ${colors.cyan}${resolvedPath}${colors.reset}`);
        console.log(`- Registers tools: ${colors.green}${tools.map(t => t.function.name).join(', ') || '(none)'}${colors.reset}`);
        console.log(`\n${colors.yellow}WARNING: Plugins run with full access to the user shell and can make network calls or exfiltrate credentials.${colors.reset}`);

        const confirmed = await p.confirm({
          message: `Do you trust and want to load this plugin?`,
          initialValue: false,
        });

        if (p.isCancel(confirmed) || !confirmed) {
          console.log(`[Plugin Loader] Load cancelled for "${pluginPath}". Skipping.`);
          continue;
        }

        globalConfig.approvedPlugins.push(approvedKey);
        saveConfig(globalConfig);
        console.log(`${colors.green}✓ Plugin approved and saved to ~/.fixocli/config.json${colors.reset}`);
      }

      loadedPlugins.push({
        path: pluginPath,
        tools,
        execute,
      });

    } catch (err) {
      console.error(`\n${colors.red}[Plugin Loader] Failed to load plugin "${pluginPath}": ${err instanceof Error ? err.message : String(err)}${colors.reset}`);
    }
  }
}

/* ──────────────────────── Tool Definitions ──────────────────────── */

/**
 * Names of all tools that perform a write / mutation. Used by
 * {@link getActiveTools} to enforce role-based tool masking
 * (Pillar 5 / Protection 2 — Strict Runtime Role Isolation).
 * Kept as a Set for O(1) membership checks; never read in
 * production paths.
 */
export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'apply_patch',
  'replace_range',
  'insert_after',
  'rename_file',
  'delete_file',
  'create_branch',
  'commit_changes',
  'push_branch',
  'create_pull_request',
  'run_command',
]);

/**
 * Build the active tool list for a given execution role. The
 * mode argument is the role the agent is operating in:
 *
 *   - `BUILD`  — the default; all tools are available.
 *   - `EXPLORE` — only read + LSP navigation tools.
 *   - `SCOUT`  — only web fetch / search.
 *   - `PLAN`   — read + web + LSP, but no mutations.
 *   - `READ_ONLY` (Pillar 5) — no mutation tools at all.
 *     This is the role forced on during vulnerability audits,
 *     reviews, and explanations, so the LLM has zero
 *     visibility of code-writing tools and cannot accidentally
 *     mutate the workspace.
 */
export function getActiveTools(mode?: string): ChatToolDefinition[] {
  const pluginTools = loadedPlugins.flatMap(p => p.tools);
  let tools = [...TOOL_DEFINITIONS, ...mcpManager.getTools(), ...mcpBridgeManager.getTools(), ...pluginTools];

  if (mode === 'EXPLORE') {
    const allowed = ['read_file', 'list_dir', 'search_code', 'lsp_goto_definition', 'lsp_find_references', 'lsp_hover'];
    tools = tools.filter(t => allowed.includes(t.function.name));
  } else if (mode === 'SCOUT') {
    const allowed = ['web_fetch', 'web_search'];
    tools = tools.filter(t => allowed.includes(t.function.name));
  } else if (mode === 'PLAN') {
    const readOnly = ['read_file', 'list_dir', 'search_code', 'lsp_goto_definition', 'lsp_find_references', 'lsp_hover', 'web_fetch', 'web_search'];
    tools = tools.filter(t => readOnly.includes(t.function.name));
  } else if (mode === 'READ_ONLY') {
    // Pillar 5 — strip every mutation tool. The agent sees
    // only read + search + LSP navigation.
    tools = tools.filter(t => !MUTATION_TOOL_NAMES.has(t.function.name));
  }

  return tools;
}

/**
 * Classify a task into an execution role. Read-only tasks
 * (analysis, explanation, review) get the `READ_ONLY` role so
 * mutation tools are not even visible to the model. This is
 * the dynamic-tool-masking layer of Pillar 5.
 */
export function classifyExecutionRole(task: string): 'BUILD' | 'READ_ONLY' {
  const lower = task.toLowerCase();
  // Read-only keywords — the agent must answer a question or
  // describe something, not modify files.
  const readOnlyPatterns: RegExp[] = [
    /\b(analy[sz]e|analysing|analysed)\b/,
    /\b(review|auditing|audit)\b/,
    /\b(explain|describe|what does|how does|why does)\b/,
    /\b(vulnerabilit(y|ies)|security review|threat model)\b/,
    /\b(read(ing)? the (entire )?code(base)?)\b/,
    /\b(find (the )?bugs?|find (the )?vulnerabilities|find (the )?issues?)\b/,
    /\b(list(ing)? (the )?files|show (me )?the files|what files)\b/,
    /\b(without (modif|chang|edit|alter)ing)\b/,
    /\b(read[\s-]only)\b/,
  ];
  for (const pattern of readOnlyPatterns) {
    if (pattern.test(lower)) return 'READ_ONLY';
  }
  return 'BUILD';
}

export const TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the full text contents of a file at the given path. Use this to understand existing code before making changes. Returns the file contents as a string. Files larger than the large-file gate (15 KiB / 350 lines by default) will return a [Context-Budget Guard] synthetic directive telling you to call extract_symbols or extract_imports first.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to read, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_symbols',
      description:
        'Extract symbol declarations (classes, functions, interfaces, types, consts) from a file. Output is capped at 100 entries. Cheaper than read_file for large files because it skips the body content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to inspect, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_imports',
      description:
        'Extract import statements from a file. Output is capped at 100 entries. Cheaper than read_file for large files because it skips the body content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to inspect, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch to files in the workspace. Prefer this over write_file for editing existing files.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Unified diff patch text.' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_range',
      description: 'Replace inclusive 1-based line range in a file. Requires reading the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'string' },
          endLine: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'startLine', 'endLine', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_after',
      description: 'Insert content after the first exact anchor match in a file. Requires reading the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          anchor: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'anchor', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Rename or move a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file. Creates the file and any parent directories if they do not exist. Overwrites existing content entirely.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The file path to write, relative to the workspace root or absolute.',
          },
          content: {
            type: 'string',
            description: 'The full file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command and return its stdout and stderr output. Use this to run tests, build projects, install dependencies, or verify changes. Commands run in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command (optional, defaults to workspace root).',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search for a text or regex pattern in workspace files. Returns matching lines with file paths and line numbers. Use this to find where functions, classes, or variables are defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search pattern (plain text or regex).',
          },
          path: {
            type: 'string',
            description:
              'Directory or file to search in (optional, defaults to workspace root).',
          },
          file_pattern: {
            type: 'string',
            description:
              'Glob pattern to filter files, e.g., "*.ts" or "*.py" (optional).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List files and directories at the given path. Returns names, types (file/dir), and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The directory path to list (optional, defaults to workspace root).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file at the given path from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to delete, relative to the workspace root or absolute.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_branch',
      description: 'Create and checkout a new Git branch.',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string', description: 'The name of the branch to create.' },
        },
        required: ['branchName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_changes',
      description: 'Stage all current changes and commit them.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The commit message.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'push_branch',
      description: 'Push the current active branch to origin or custom remote.',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'The remote repository name (default: origin).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pull_request',
      description: 'Create a pull request on GitHub for the current branch.',
      parameters: {
        type: 'object',
        properties: {
          baseBranch: { type: 'string', description: 'The base branch to merge into (default: main).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_goto_definition',
      description: 'Find definition coordinates for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_find_references',
      description: 'Find all reference locations for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_hover',
      description: 'Retrieve type information and documentation for a symbol at a given 0-indexed line and character position using LSP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol.' },
          line: { type: 'integer', description: '0-indexed line number.' },
          character: { type: 'integer', description: '0-indexed character offset.' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a webpage using an HTTP GET request and return its content converted to Markdown. Use this to read documentation or external references.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Perform a web search for a given query and return a list of search results as Markdown snippets. Use this to find information on the web.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
];

/* ──────────────────────── Tool Executor ──────────────────────── */

export interface ToolCallEvent {
  tool: string;
  args: Record<string, string>;
  result: string;
  isWrite: boolean;
  affectedPath?: string;
}

export interface ToolExecutionOptions {
  session?: TaskSession;
  policy?: PolicyProfile;
  allowWithoutPrompt?: boolean;
  client?: AgentClient;
  model?: string;
  /**
   * Safety preferences (Pillar 1/2/3). When
   * `preferences.safety.atomicStaging` is true, file writes are
   * routed through {@link AtomicStagingManager} so the swap is
   * atomic and rollback is possible. When undefined, the legacy
   * direct-write path is used.
   */
  safety?: SafetyConfig;
}

/* ──────────────────────── Per-process Run ID (Pillar 2) ──────────── */

let cachedRunId: string | null = null;

/**
 * Lazily generate a per-process run id. Used to namespace
 * `.fixo/staging/<runId>/` so concurrent runs against the same
 * workspace never collide. The id is a 12-character base36 token.
 */
export function getOrCreateRunId(): string {
  if (cachedRunId) return cachedRunId;
  cachedRunId = Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-6);
  return cachedRunId;
}

/** Test/utility hook — reset the cached run id. */
export function resetRunId(): void {
  cachedRunId = null;
}

/* ──────────────────────── LSP Pre-Save Gate (Pillar 3) ──────────── */

let cachedLspGate: LspPreSaveGate | null = null;

/**
 * Lazily construct a singleton {@link LspPreSaveGate} that wires
 * the tool-executor to the live `LspManager`. Mode is read from
 * the user's safety config (default: `'warn'`). The gate is a
 * no-op when no language server is installed on `PATH`, matching
 * the existing `LspManager` behaviour.
 */
export function getOrCreateLspGate(cwd: string, safety: SafetyConfig): LspPreSaveGate {
  if (cachedLspGate) return cachedLspGate;
  cachedLspGate = new LspPreSaveGate({
    mode: safety.lspPreSave,
    provider: makeLspProvider(getLspManager(cwd)),
  });
  return cachedLspGate;
}

/** Test/utility hook — reset the cached gate. */
export function resetLspGate(): void {
  cachedLspGate = null;
}

/* ──────────────────────── Atomic Write Helper (Pillar 2) ─────────── */

/**
 * Stage-and-commit a file write. When `safety.atomicStaging` is
 * true, the new content goes through
 * {@link AtomicStagingManager} so the swap is atomic and the
 * pre-commit hook (Pillar 3) gets a chance to validate. When
 * false, the legacy direct-write path is used and a `null`
 * staging manager is returned to the caller.
 */
async function applyAtomicWrite(
  cwd: string,
  filePath: string,
  content: string,
  safety: SafetyConfig | undefined,
  session: TaskSession | undefined,
): Promise<{ result: string; staged: boolean; created: boolean }> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  const existed = fs.existsSync(resolved);

  if (!safety?.atomicStaging) {
    // Legacy path: write directly (preserves the existing diff-printing
    // and session semantics inside the caller).
    const parentDir = path.dirname(resolved);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, 'utf-8');
    session?.noteChange(resolved);
    return {
      result: existed ? `File updated: ${filePath}` : `File created: ${filePath}`,
      staged: false,
      created: !existed,
    };
  }

  const mgr = new AtomicStagingManager(cwd, getOrCreateRunId(), {
    ttlMs: safety.stagingTtlMs,
    // Pillar 3 — wire the LSP pre-save gate as the staging
    // manager's pre-commit hook. The gate runs diagnostics on
    // the staged file; in `block` mode it throws on any
    // error-severity diagnostic, which causes the staging
    // manager to surface a PreCommitHookRejectedError and the
    // user keeps the original file. In `warn` mode the gate
    // just logs via onResult and lets the commit proceed.
    preCommitHook: async (e) => {
      const gate = getOrCreateLspGate(cwd, safety);
      const result = await gate.check(e);
      gate.enforce(result, e);
    },
    // Pillar 5 / Protection 3 — structural syntax health check.
    // JS/TS files are passed through the brace/paren/bracket
    // balance check in `src/lsp/syntax-fallback.ts`. The real
    // TypeScript compile is the LSP gate's job; this is a fast
    // structural sanity check that catches the catastrophic case
    // (unclosed `try` block, dangling `catch` keyword, etc.).
    syntaxHealthCheck: async (e, content) => {
      const lower = e.targetPath.toLowerCase();
      const isJs = lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs');
      const isTs = lower.endsWith('.ts') || lower.endsWith('.tsx');
      if (!isJs && !isTs) return;
      const verdict = syntaxHealthCheck(content);
      if (verdict.state === 'ok') return;
      const e2 = new Error(
        `Structural syntax check failed for ${path.basename(e.targetPath)}: ` +
        `${formatSyntaxVerdict(verdict)} ` +
        `The staged write was rejected to protect the target file.`,
      );
      (e2 as Error & { code?: string }).code = 'FIXO_STRUCTURAL_SYNTAX';
      throw e2;
    },
  });
  const entry = mgr.stage(filePath, content, 0o644);
  const commit = await mgr.commit(entry.id);
  if (commit.committed) {
    session?.noteChange(resolved);
  }
  return {
    result: existed
      ? `File updated (atomic): ${filePath}`
      : `File created (atomic): ${filePath}`,
    staged: commit.committed,
    created: !existed,
  };
}

async function askUnsafeCommandPermission(
  command: string,
  reason: string,
  allowWithoutPrompt?: boolean
): Promise<boolean> {
  if (allowWithoutPrompt) {
    console.log(`\n${colors.yellow}⚠ Security Warning: Executing potentially unsafe command: ${colors.bold}${command}${colors.reset}\nReason: ${reason}`);
    return true;
  }
  
  console.log(`\n${colors.red}${colors.bold}⚠ SECURITY WARNING:${colors.reset}`);
  console.log(`The agent is attempting to execute a command that violates safety sandboxing:`);
  console.log(`- Command: ${colors.yellow}${command}${colors.reset}`);
  console.log(`- Danger: ${colors.red}${reason}${colors.reset}\n`);

  const confirmed = await p.confirm({
    message: `Do you want to bypass this warning and allow execution?`,
    initialValue: false,
  });

  return !p.isCancel(confirmed) && confirmed;
}

/**
 * Execute a tool call and return its result string.
 * Also logs the operation to the terminal with colored output.
 */
export async function executeTool(
  name: string,
  args: Record<string, string>,
  cwd: string,
  verbose: boolean = false,
  options: ToolExecutionOptions = {},
): Promise<ToolCallEvent> {
  const event: ToolCallEvent = {
    tool: name,
    args,
    result: '',
    isWrite: false,
  };

  try {
    const policy = options.policy ?? options.session?.policy ?? 'shell-confirm';

    const plugin = loadedPlugins.find(p => p.tools.some(t => t.function.name === name));
    if (plugin) {
      const action = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = decidePolicy(policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk });
      console.log(`  ${colors.dim}🔌 Plugin: ${name}${colors.reset}`);
      try {
        event.result = await plugin.execute(name, args, { cwd, verbose, policy, options });
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: 'error', name, detail: truncate(msg, 80) });
      }
      options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });
      return event;
    }

    if (mcpManager.hasTool(name)) {
      const action = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = decidePolicy(policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk });
      console.log(`  ${colors.dim}🔌 MCP: ${name}${colors.reset}`);
      try {
        event.result = await mcpManager.executeTool(name, args);
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: 'error', name, detail: truncate(msg, 80) });
      }
      options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });
      return event;
    }

    if (mcpBridgeManager.hasTool(name)) {
      const action = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = decidePolicy(policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk });
      console.log(`  ${colors.dim}🔌 Local MCP: ${name}${colors.reset}`);
      try {
        event.result = await mcpBridgeManager.executeTool(name, args);
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        renderToolCall({ kind: 'error', name, detail: truncate(msg, 80) });
      }
      options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });
      return event;
    }

    const action = name === 'run_command'
      ? 'command'
      : name === 'read_file' || name === 'search_code' || name === 'list_dir' || name === 'web_fetch' || name === 'web_search'
        ? 'read'
        : name === 'delete_file'
          ? 'delete'
          : 'write';
    const policyTarget = name === 'web_fetch' ? args.url : name === 'web_search' ? args.query : (args.command ?? args.path ?? '');
    const decision = decidePolicy(policy, action, policyTarget);
    if (!decision.allowed) {
      event.result = `Error: ${decision.reason}`;
      options.session?.record('tool_denied', { tool: name, reason: decision.reason, args });
      return event;
    }
    options.session?.record('tool_started', { tool: name, args, risk: decision.risk });
    switch (name) {
      case 'read_file':
        event.result = executeReadFile(
          args.path,
          cwd,
          options.session,
          options.safety?.largeFileGateBytes,
          options.safety?.largeFileGateLines,
        );
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        renderToolCall({ kind: 'read', name: 'Read', detail: shortenPath(args.path, cwd) });
        break;

      case 'extract_symbols':
        event.result = await executeExtractSymbols(args.path, cwd, options.session);
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        renderToolCall({ kind: 'read', name: 'Symbols', detail: shortenPath(args.path, cwd) });
        break;

      case 'extract_imports':
        event.result = await executeExtractImports(args.path, cwd, options.session);
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        renderToolCall({ kind: 'read', name: 'Imports', detail: shortenPath(args.path, cwd) });
        break;

      case 'write_file':
        event.result = await executeWriteFile(args.path, args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        renderToolCall({ kind: 'write', name: 'Write', detail: shortenPath(args.path, cwd) });
        break;

      case 'run_command':
        renderToolCall({ kind: 'bash', name: 'Run', detail: truncate(args.command, 60) });
        let safetyResult = { safe: true, reason: '' };
        try {
          const { isCommandSafe } = await import('./command-parser.js');
          const safety = await isCommandSafe(args.command, cwd);
          if (!safety.safe) {
            safetyResult = { safe: false, reason: safety.reason || 'Unsafe command detected' };
          }
        } catch (err: any) {
          if (verbose) {
            console.error('Failed to run AST command safety check, falling back to regex safety check:', err.message);
          }
          const trimmed = args.command.trim();
          const { DANGEROUS_COMMANDS } = await import('../runtime/policy.js');
          for (const pattern of DANGEROUS_COMMANDS) {
            if (pattern.test(trimmed)) {
              safetyResult = {
                safe: false,
                reason: `Regex security match: Command contains potentially unsafe pattern/metacharacter: ${pattern.toString()}`
              };
              break;
            }
          }
        }

        if (!safetyResult.safe) {
          const allowed = await askUnsafeCommandPermission(
            args.command,
            safetyResult.reason,
            options.allowWithoutPrompt
          );
          if (!allowed) {
            event.result = `Error: Security block - Execution denied for unsafe command: ${safetyResult.reason}`;
            break;
          }
        }
        event.result = executeRunCommand(args.command, args.cwd || cwd, cwd, options.session);
        break;

      case 'search_code':
        renderToolCall({ kind: 'search', name: 'Search', detail: `"${truncate(args.query, 40)}" in ${args.path ?? '.'}` });
        event.result = executeSearchCode(args.query, args.path, args.file_pattern, cwd);
        break;

      case 'list_dir':
        renderToolCall({ kind: 'read', name: 'List', detail: args.path ?? '.' });
        event.result = executeListDir(args.path, cwd);
        break;

      case 'delete_file':
        renderToolCall({ kind: 'write', name: 'Delete', detail: shortenPath(args.path, cwd) });
        event.result = executeDeleteFile(args.path, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'apply_patch':
        renderToolCall({ kind: 'write', name: 'Patch', detail: 'unified diff' });
        event.result = await executeApplyPatch(args.patch, cwd, options);
        event.isWrite = true;
        break;

      case 'replace_range':
        renderToolCall({ kind: 'write', name: 'Replace', detail: shortenPath(args.path, cwd) });
        event.result = await executeReplaceRange(args.path, Number(args.startLine), Number(args.endLine), args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'insert_after':
        renderToolCall({ kind: 'write', name: 'Insert', detail: shortenPath(args.path, cwd) });
        event.result = await executeInsertAfter(args.path, args.anchor, args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'rename_file':
        renderToolCall({ kind: 'write', name: 'Rename', detail: `${args.from} -> ${args.to}` });
        event.result = await executeRenameFile(args.from, args.to, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.to, 'file');
        break;

      case 'create_branch':
        renderToolCall({ kind: 'write', name: 'Branch', detail: args.branchName });
        event.result = createBranch(cwd, args.branchName);
        event.isWrite = true;
        break;

      case 'commit_changes':
        renderToolCall({ kind: 'write', name: 'Commit', detail: truncate(args.message, 60) });
        event.result = commitChanges(cwd, args.message);
        event.isWrite = true;
        break;

      case 'push_branch':
        renderToolCall({ kind: 'write', name: 'Push', detail: args.remote || 'origin' });
        event.result = pushBranch(cwd, args.remote || 'origin');
        event.isWrite = true;
        break;

      case 'create_pull_request':
        renderToolCall({ kind: 'write', name: 'PR', detail: `base: ${args.baseBranch || 'main'}` });
        if (!options.client) {
          throw new Error('Agent client is required to generate pull request description');
        }
        event.result = await createPullRequest(cwd, options.client, options.model || 'auto', args.baseBranch || 'main');
        event.isWrite = true;
        break;

      case 'lsp_goto_definition': {
        const line = Number(args.line);
        const char = Number(args.character);
        const fileBasename = path.basename(args.path);
        renderToolCall({ kind: 'read', name: 'Definition', detail: `${fileBasename}:${line}:${char}` });

        const manager = getLspManager(cwd);
        const resolvedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        const def = await manager.gotoDefinition(resolvedPath, line, char);
        event.result = JSON.stringify(def || null, null, 2);
        break;
      }

      case 'lsp_find_references': {
        const line = Number(args.line);
        const char = Number(args.character);
        const fileBasename = path.basename(args.path);
        renderToolCall({ kind: 'read', name: 'References', detail: `${fileBasename}:${line}:${char}` });

        const manager = getLspManager(cwd);
        const resolvedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        const refs = await manager.findReferences(resolvedPath, line, char);
        event.result = JSON.stringify(refs || null, null, 2);
        break;
      }

      case 'lsp_hover': {
        const line = Number(args.line);
        const char = Number(args.character);
        const fileBasename = path.basename(args.path);
        renderToolCall({ kind: 'read', name: 'Hover', detail: `${fileBasename}:${line}:${char}` });

        const manager = getLspManager(cwd);
        const resolvedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        const hoverRes = await manager.hover(resolvedPath, line, char);
        event.result = JSON.stringify(hoverRes || null, null, 2);
        break;
      }

      case 'web_fetch':
        renderToolCall({ kind: 'search', name: 'Fetch', detail: args.url });
        event.result = await webFetch(args.url);
        break;

      case 'web_search':
        renderToolCall({ kind: 'search', name: 'Search', detail: truncate(args.query, 40) });
        event.result = await webSearch(args.query);
        break;

      default:
        event.result = `Error: Unknown tool "${name}"`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    event.result = `Error: ${msg}`;
    renderToolCall({ kind: 'error', name, detail: truncate(msg, 80) });
  }
  options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });

  return event;
}

/* ──────────────────────── Tool Implementations ──────────────────────── */

function executeReadFile(
  filePath: string,
  cwd: string,
  session?: TaskSession,
  largeFileGateBytes: number = 15 * 1024,
  largeFileGateLines: number = 350,
): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');

  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${filePath}" is a directory, not a file. Use list_dir instead.`;
  }

  // Skip binary files
  if (stat.size > 500_000) {
    return `Error: File is too large (${(stat.size / 1024).toFixed(0)} KB). Read a smaller file or search for specific content.`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }

  // Pillar 3 — Context-Budget Guard. When a file exceeds either
  // the byte or line gate we refuse to return the full body and
  // instead hand the LLM a synthetic directive telling it to use
  // the structural pre-scan tools (`extract_symbols` /
  // `extract_imports`) instead. This prevents an LLM from
  // dumping half the workspace into the context window.
  if (
    stat.size > largeFileGateBytes ||
    // Read just enough to count lines without holding the file in
    // memory twice. `readFileSync` is unavoidable for the content
    // path below, so accept the cost here.
    countLines(resolved) > largeFileGateLines
  ) {
    return buildContextBudgetGuardDirective(
      resolved,
      stat.size,
      largeFileGateBytes,
      largeFileGateLines,
    );
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  session?.noteRead(resolved);
  return content;
}

/**
 * Count lines in a file. Uses a streaming read so a 500 KB binary
 * that has slipped past `isBinaryFile` cannot OOM the process.
 */
function countLines(filePath: string): number {
  let count = 0;
  let sawNewline = true;
  const stream = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(stream, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) {
          count++;
          sawNewline = true;
        } else {
          sawNewline = false;
        }
      }
    }
    if (!sawNewline) count++;
  } finally {
    fs.closeSync(stream);
  }
  return count;
}

/**
 * Build the [Context-Budget Guard] directive returned to the LLM
 * when `read_file` would otherwise flood the context window.
 */
function buildContextBudgetGuardDirective(
  resolved: string,
  bytes: number,
  byteLimit: number,
  lineLimit: number,
): string {
  const relPath = path.relative(process.cwd(), resolved) || resolved;
  return (
    `[Context-Budget Guard] File '${relPath}' is ${(bytes / 1024).toFixed(1)} KiB ` +
    `(> ${(byteLimit / 1024).toFixed(0)} KiB) or exceeds ${lineLimit} lines. ` +
    `Full body suppressed to protect the context window. ` +
    `Call extract_symbols(path='${relPath}') to list top-level declarations, ` +
    `or extract_imports(path='${relPath}') to list dependencies, before ` +
    `narrowing your read with a tool like search_code.`
  );
}

/**
 * Resolve a file's `LanguageId` from its extension. Falls back to
 * 'generic' for unrecognised suffixes.
 */
function resolveLanguageId(filePath: string) {
  return languageIdFromExtension(path.extname(filePath));
}

async function executeExtractSymbols(
  filePath: string,
  cwd: string,
  session?: TaskSession,
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const language = resolveLanguageId(resolved);
  const parser = await ParserFactory.getParser();
  const symbols: SymbolInfo[] = parser.extractSymbols(content, language);
  session?.noteStructuralMap?.(resolved, { symbols: true, imports: false });
  if (symbols.length === 0) {
    return `No symbols detected in '${filePath}' (language=${language}).`;
  }
  const lines = symbols.map(
    (s) => `- [${s.kind}${s.exported ? ', exported' : ''}] ${s.name} (line ${s.line})`,
  );
  return `Symbols in '${filePath}' (${symbols.length}):\n${lines.join('\n')}`;
}

async function executeExtractImports(
  filePath: string,
  cwd: string,
  session?: TaskSession,
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const language = resolveLanguageId(resolved);
  const parser = await ParserFactory.getParser();
  const imports: ImportInfo[] = parser.extractImports(content, language);
  session?.noteStructuralMap?.(resolved, { symbols: false, imports: true });
  if (imports.length === 0) {
    return `No imports detected in '${filePath}' (language=${language}).`;
  }
  const lines = imports.map((i) => {
    const tag = i.isTypeOnly ? ' [type-only]' : '';
    const syms = i.symbols.length > 0 ? ` {${i.symbols.join(', ')}}` : '';
    return `- '${i.source}'${tag}${syms} (line ${i.line})`;
  });
  return `Imports in '${filePath}' (${imports.length}):\n${lines.join('\n')}`;
}

function executeWriteFile(
  filePath: string,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  // Pillar 5 / Protection 1 — refuse to mutate the platform's
  // own runtime. This is the guard that prevents an autonomous
  // agent from corrupting `src/agent/tool-executor.ts` and
  // breaking its own host.
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError) {
      return Promise.resolve(err.message);
    }
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok) return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const existed = fs.existsSync(resolved);

  return applyAtomicWrite(cwd, filePath, content, options.safety, options.session)
    .then(() => {
      if (!existed) return `File created: ${filePath}`;
      // Existing file — print the diff for the user.
      try {
        const relativePath = guard.relative(resolved);
        const result = spawnSync('git', ['diff', '--color=always', '--', relativePath], { cwd, encoding: 'utf-8' });
        if (result.status === 0 && result.stdout) {
          const diffOutput = result.stdout.trim();
          if (diffOutput) {
            console.log(`\n${colors.cyan}--- File Changes Diff ---${colors.reset}`);
            const lines = diffOutput.split('\n');
            if (lines.length > 50) {
              console.log(lines.slice(0, 48).join('\n') + `\n${colors.yellow}... (diff truncated)${colors.reset}`);
            } else {
              console.log(diffOutput);
            }
            console.log(`${colors.cyan}-------------------------${colors.reset}\n`);
          }
        }
      } catch {
        // Fail-safe diff printing
      }
      return `File updated: ${filePath}`;
    });
}

function executeRunCommand(command: string, requestedCwd: string, workspaceRoot: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(workspaceRoot);
  const commandCwd = guard.resolve(requestedCwd, 'command cwd');
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: commandCwd,
      encoding: 'utf-8',
      timeout: 60_000, // 60 second timeout
      maxBuffer: 1024 * 1024, // 1MB max output
      env: redactedEnv(),
    });
    const output = redactSecrets([result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n'));
    const status = result.status ?? 0;
    session?.record('command_finished', { command, cwd: guard.relative(commandCwd), status, output: truncate(output, 4000) });
    return output || `(command completed with code ${status})`;
  } catch (error: any) {
    const stdout = error.stdout ?? '';
    const stderr = error.stderr ?? '';
    const code = error.status ?? 'unknown';
    return redactSecrets(`Command exited with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`.trim());
  }
}

function executeSearchCode(
  query: string,
  searchPath: string | undefined,
  filePattern: string | undefined,
  cwd: string,
): string {
  const guard = new WorkspaceGuard(cwd);
  const targetDir = searchPath ? guard.resolve(searchPath, 'search path') : cwd;

  // Try ripgrep first
  let hasRg = false;
  try {
    const which = spawnSync('which', ['rg'], { encoding: 'utf-8' });
    if (which.status === 0 && which.stdout.trim()) {
      hasRg = true;
    }
  } catch (error: any) {
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      console.warn(`[Debug Warning] Failed to determine if ripgrep (rg) is installed: ${error.message || error}`);
    }
  }

  let output = '';
  if (hasRg) {
    const args = ['-n', '--no-heading', '--color', 'never', query];
    if (filePattern) {
      args.push('-g', filePattern);
    }
    args.push(targetDir);

    const result = spawnSync('rg', args, {
      encoding: 'utf-8',
      cwd,
      maxBuffer: 512 * 1024,
      timeout: 15000,
    });
    output = result.stdout ?? '';
  } else {
    // Fallback to grep
    const args = ['-rn', query];
    if (filePattern) {
      args.push(`--include=${filePattern}`);
    }
    args.push(targetDir);

    const result = spawnSync('grep', args, {
      encoding: 'utf-8',
      cwd,
      maxBuffer: 512 * 1024,
      timeout: 15000,
    });
    output = result.stdout ?? '';
  }

  if (!output.trim()) {
    return `No matches found for "${query}"`;
  }

  // Make paths relative to workspace and limit to 50 results
  const lines = output.trim().split('\n').slice(0, 50).map((line) => {
    if (line.startsWith(cwd)) {
      return line.slice(cwd.length + 1);
    }
    return line;
  });

  return lines.join('\n');
}

function executeListDir(dirPath: string | undefined, cwd: string): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = dirPath ? guard.resolve(dirPath, 'directory') : cwd;

  if (!fs.existsSync(resolved)) {
    return `Error: Directory not found: ${dirPath ?? '.'}`;
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return `Error: "${dirPath}" is a file, not a directory. Use read_file instead.`;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    return `Error: Cannot read directory: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Filter and sort
  const filtered = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
    .filter((e) => e.name !== 'node_modules')
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const lines: string[] = [];
  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`📁 ${entry.name}/`);
    } else {
      let size = '';
      try {
        const s = fs.statSync(path.join(resolved, entry.name));
        size = formatSize(s.size);
      } catch {
        // Ignore
      }
      lines.push(`   ${entry.name}${size ? `  (${size})` : ''}`);
    }
  }

  return lines.join('\n') || '(empty directory)';
}

/* ──────────────────────── Helpers ──────────────────────── */

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}

function shortenPath(filePath: string, cwd: string): string {
  try {
    const guard = new WorkspaceGuard(cwd);
    return guard.relative(guard.resolve(filePath, 'path'));
  } catch {
    return filePath;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function executeDeleteFile(filePath: string, cwd: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  const mutation = session?.canMutate(resolved);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(resolved);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${filePath}" is a directory. delete_file can only delete files.`;
  }

  fs.unlinkSync(resolved);
  session?.noteChange(resolved);
  return `File deleted: ${filePath}`;
}

function executeApplyPatch(
  patch: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (!patch?.trim()) return Promise.resolve('Error: patch is required.');
  const guard = new WorkspaceGuard(cwd);
  // Pillar 5 — refuse to apply patches that target platform
  // runtime files. The `git apply` invocation would otherwise
  // succeed in corrupting our own source.
  for (const file of filesFromPatch(patch)) {
    try {
      const resolved = guard.resolve(file, 'patch target');
      guard.assertNotPlatformPath(resolved);
    } catch (err: unknown) {
      if (err instanceof PlatformPathLockedError) {
        return Promise.resolve(err.message);
      }
      if (err instanceof Error) {
        return Promise.resolve(`Error: ${err.message}`);
      }
      throw err;
    }
  }
  for (const file of filesFromPatch(patch)) {
    try { options.session?.captureBefore(file); } catch { /* best effort */ }
  }
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd,
    input: patch,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return Promise.resolve(`Patch failed:\n${result.stderr || result.stdout}`);
  for (const file of filesFromPatch(patch)) {
    try { options.session?.noteChange(file); } catch { /* best effort */ }
  }
  return Promise.resolve('Patch applied.');
}

function executeReplaceRange(
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError) return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok) return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const original = fs.readFileSync(resolved, 'utf-8');
  const lines = original.split('\n');
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    return Promise.resolve(`Error: invalid line range ${startLine}-${endLine}.`);
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...content.split('\n'));
  return applyAtomicWrite(cwd, filePath, lines.join('\n'), options.safety, options.session)
    .then(() => `Replaced ${filePath}:${startLine}-${endLine}.`);
}

function executeInsertAfter(
  filePath: string,
  anchor: string,
  content: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError) return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(resolved);
  if (mutation && !mutation.ok) return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(resolved);
  const original = fs.readFileSync(resolved, 'utf-8');
  const idx = original.indexOf(anchor);
  if (idx === -1) return Promise.resolve(`Error: anchor not found in ${filePath}.`);
  const insertAt = idx + anchor.length;
  const next = original.slice(0, insertAt) + content + original.slice(insertAt);
  return applyAtomicWrite(cwd, filePath, next, options.safety, options.session)
    .then(() => `Inserted content in ${filePath}.`);
}

function executeRenameFile(
  from: string,
  to: string,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const source = guard.resolve(from, 'source file');
  const target = guard.resolve(to, 'target file');
  try {
    guard.assertNotPlatformPath(source);
    guard.assertNotPlatformPath(target);
  } catch (err: unknown) {
    if (err instanceof PlatformPathLockedError) return Promise.resolve(err.message);
    throw err;
  }
  const mutation = options.session?.canMutate(source);
  if (mutation && !mutation.ok) return Promise.resolve(`Error: ${mutation.reason}`);
  options.session?.captureBefore(source);
  options.session?.captureBefore(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  options.session?.noteChange(source);
  options.session?.noteChange(target);
  return Promise.resolve(`Renamed ${from} -> ${to}.`);
}

function filesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('--- a/')) files.add(line.slice(6));
  }
  return Array.from(files).filter(file => file !== '/dev/null');
}
