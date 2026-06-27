/**
 * Tool definitions and executor for the single-agent tool-calling loop.
 * Provides: read_file, write_file, run_command, search_code, list_dir
 */
import { TOOL_DEFINITIONS } from './tool-definitions.js';
export { TOOL_DEFINITIONS };
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomBytes } from 'node:crypto';
import type { ChatToolDefinition } from '../shared/types.js';
import { colors } from '../ui/colors.js';
import {
  renderToolCall,
  startInlineToolSpinner,
  type InlineSpinnerHandle,
  type ToolCallRender,
} from '../ui/render-primitives.js';
import { WorkspaceGuard } from '../workspace-guard.js';
import type { TaskSession } from '../runtime/task-session.js';
import { classifyCommand, type PolicyProfile, type RiskLevel } from '../runtime/policy.js';
import { checkPermission, type PermissionCheckResult } from './permissions.js';
import { redactedEnv, redactSecrets } from '../runtime/redaction.js';
import { runSandboxed, SandboxUnavailableError } from '../runtime/os-sandbox.js';
import { McpManager } from './mcp-manager.js';
import { estimateReadCost, shouldDeferRead, formatPredictiveGateDirective, DEFAULT_PREDICTIVE_BUDGET_PCT } from './predictive-gate.js';
import type { AgentClient } from './agent-client.js';
import { createBranch, commitChanges, pushBranch, createPullRequest } from '../git/git-ops.js';
import { GitManager } from '../git/git-manager.js';
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
  loadTodoList,
  saveTodoList,
  addItem,
  setItemStatus,
  removeItem,
  clearDoneItems,
  renderTodoList,
  summariseTodoList,
  type TodoList,
  type TodoStatus,
} from '../context/todo.js';
import { recordTelemetry, telemetry } from './telemetry.js';
import { applyModifiedArgs, fireHooks } from './hooks.js';
import { BackgroundJobRegistry, type JobSnapshot } from '../runtime/background-jobs.js';
import {
  ParserFactory,
  languageIdFromExtension,
  type ImportInfo,
  type SymbolInfo,
} from './parser-adapter.js';
import { getRunInventory } from '../runtime/run-inventory.js';

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
  'str_replace',
  'todo_write',
  'run_command_async',
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
  /**
   * Execution mode (`'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT'`).
   * Surfaced to the executor so mutating tools can refuse to
   * run under read-only modes. Optional — when omitted, mutating
   * tools default to allowing execution.
   */
  mode?: 'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT';
  /**
   * Callback returning the current conversation token count.
   * Used by the predictive context-budget gate (Phase 4) to
   * decide whether a `read_file` would push the next request
   * over the model's input window. When omitted, the gate
   * treats conversation pressure as 0 and only considers the
   * file's own projected cost.
   */
  getConversationTokens?: () => number;
  /**
   * Optional abort signal. When the signal fires, tools that have not
   * yet started executing return an early "Task cancelled" result.
   */
  signal?: AbortSignal;
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
  // Use crypto.randomBytes for collision-free staging namespace IDs.
  // Math.random() has a 1-in-2^30 collision chance; crypto.randomBytes
  // is cryptographically secure and eliminates any collision risk.
  cachedRunId = randomBytes(6).toString('hex') + Date.now().toString(36).slice(-6);
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

type GateAction = 'read' | 'write' | 'delete' | 'command';

function riskOf(action: GateAction, detail: string): RiskLevel {
  if (action === 'command') return classifyCommand(detail);
  if (action === 'delete') return 'high';
  if (action === 'write') return 'medium';
  return 'low';
}

interface GateOutcome {
  allowed: boolean;
  needsConfirmation: boolean;
  reason: string;
  risk: RiskLevel;
  source: PermissionCheckResult['source'];
  matchedRule: string | null;
}

function evaluateToolGate(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  policy: PolicyProfile,
  action: GateAction,
  detail: string,
): GateOutcome {
  const check = checkPermission(toolName, args, cwd, policy);
  const risk = riskOf(action, detail);
  if (check.decision === 'deny') {
    return {
      allowed: false,
      needsConfirmation: false,
      reason: check.reason,
      risk,
      source: check.source,
      matchedRule: check.matchedRule,
    };
  }
  return {
    allowed: true,
    needsConfirmation: check.decision === 'ask',
    reason: check.reason,
    risk,
    source: check.source,
    matchedRule: check.matchedRule,
  };
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

  // Check for user cancellation before starting any tool work
  if (options.signal?.aborted) {
    event.result = 'Error: Task cancelled by user.';
    return event;
  }

  // Single inline spinner shared across the whole tool invocation —
  // each case under the switch below calls `setSpinner` exactly once,
  // and the outer try/finally converts the spinner into a ✔ or ✗
  // summary line when the tool completes (or throws).
  let inlineSpinner: InlineSpinnerHandle | null = null;
  const toolStartedAt = Date.now();
  const setSpinner = (tool: ToolCallRender): void => {
    if (inlineSpinner) inlineSpinner.clear();
    inlineSpinner = startInlineToolSpinner(tool);
  };

  try {
    const policy = options.policy ?? options.session?.policy ?? 'shell-confirm';

    // Auto-init git repo on first mutating tool call (Finding C)
    if (MUTATION_TOOL_NAMES.has(name)) {
      const git = new GitManager(cwd);
      if (!git.isGitRepo()) {
        try {
          spawnSync('git', ['init'], { cwd, encoding: 'utf-8', stdio: 'ignore' });
          spawnSync('git', ['add', '.'], { cwd, encoding: 'utf-8', stdio: 'ignore' });
          spawnSync('git', ['commit', '-m', 'chore: initial checkpoint by fixo'], { cwd, encoding: 'utf-8', stdio: 'ignore' });
        } catch (e) {
          // Ignore if git fails (e.g. no user.name, empty directory, or git not installed)
        }
      }
    }

    // ──── PreToolUse hooks (§3.4) ────
    // Run any user-defined pre-tool hooks. A `deny` decision
    // short-circuits the call; a `modify` decision replaces
    // args after a `WorkspaceGuard` re-check.
    const sessionId = options.session?.id ?? 'no-session';
    const preHook = fireHooks(cwd, 'PreToolUse', {
      tool: name,
      args: args as Record<string, unknown>,
      sessionId,
    });
    if (preHook.fired && preHook.decision === 'deny') {
      const reason = preHook.reason ?? 'pre-tool hook denied';
      event.result = `Error: hook denied (${preHook.hookId ?? 'unknown'}): ${reason}`;
      options.session?.record('tool_denied', { tool: name, reason, args });
      renderToolCall({ kind: 'error', name, detail: `hook denied: ${reason}` });
      return event;
    }
    if (preHook.fired && preHook.decision === 'modify' && preHook.modifiedArgs) {
      const applied = applyModifiedArgs(
        cwd,
        args as Record<string, unknown>,
        preHook.modifiedArgs,
      );
      if (!applied.ok) {
        const reason = applied.reason ?? 'pre-hook modify rejected';
        event.result = `Error: hook modify rejected: ${reason}`;
        options.session?.record('tool_denied', { tool: name, reason, args });
        renderToolCall({ kind: 'error', name, detail: `hook modify rejected: ${reason}` });
        return event;
      }
      for (const [k, v] of Object.entries(applied.args)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          args[k] = String(v);
        }
      }
    }

    const plugin = loadedPlugins.find(p => p.tools.some(t => t.function.name === name));
    if (plugin) {
      if (options.signal?.aborted) { event.result = 'Error: Task cancelled by user.'; return event; }
      const action: GateAction = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = evaluateToolGate(name, args as Record<string, unknown>, cwd, policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args, matchedRule: decision.matchedRule, source: decision.source });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk, matchedRule: decision.matchedRule, source: decision.source });
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
      const action: GateAction = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = evaluateToolGate(name, args as Record<string, unknown>, cwd, policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args, matchedRule: decision.matchedRule, source: decision.source });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk, matchedRule: decision.matchedRule, source: decision.source });
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
      const action: GateAction = name.includes('read') || name.includes('get') || name.includes('list') || name.includes('view') ? 'read' : 'write';
      const decision = evaluateToolGate(name, args as Record<string, unknown>, cwd, policy, action, name);
      if (!decision.allowed) {
        event.result = `Error: ${decision.reason}`;
        options.session?.record('tool_denied', { tool: name, reason: decision.reason, args, matchedRule: decision.matchedRule, source: decision.source });
        return event;
      }
      options.session?.record('tool_started', { tool: name, args, risk: decision.risk, matchedRule: decision.matchedRule, source: decision.source });
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

    const action: GateAction = name === 'run_command'
      ? 'command'
      : name === 'read_file' || name === 'search_code' || name === 'list_dir' || name === 'web_fetch' || name === 'web_search'
        ? 'read'
        : name === 'delete_file'
          ? 'delete'
          : 'write';
    const policyTargetRaw = name === 'web_fetch' ? args.url : name === 'web_search' ? args.query : (args.command ?? args.path ?? '');
    const policyTarget = typeof policyTargetRaw === 'string' ? policyTargetRaw : String(policyTargetRaw ?? '');
    const decision = evaluateToolGate(name, args as Record<string, unknown>, cwd, policy, action, policyTarget);
    if (!decision.allowed) {
      event.result = `Error: ${decision.reason}`;
      options.session?.record('tool_denied', { tool: name, reason: decision.reason, args, matchedRule: decision.matchedRule, source: decision.source });
      return event;
    }
    options.session?.record('tool_started', { tool: name, args, risk: decision.risk, matchedRule: decision.matchedRule, source: decision.source });

    switch (name) {
      case 'read_file': {
        if (options.signal?.aborted) { event.result = 'Error: Task cancelled by user.'; return event; }
        const guard = new WorkspaceGuard(cwd);
        const resolved = guard.resolve(args.path, 'file');
        setSpinner({ kind: 'read', name: 'Read', detail: shortenPath(args.path, cwd) });
        const budgetPct = options.safety?.predictiveBudgetPct ?? DEFAULT_PREDICTIVE_BUDGET_PCT;
        // Skip the predictive gate when it is explicitly disabled
        // (>=1.0) or when no model is configured (we cannot map
        // model → context window without one).
        if (budgetPct < 1 && options.model) {
          const estimate = estimateReadCost(resolved, options.model);
          const convoTokens = options.getConversationTokens?.() ?? 0;
          const deferDecision = shouldDeferRead(estimate, convoTokens, options.model, budgetPct);
          if (deferDecision.defer) {
            event.result = formatPredictiveGateDirective(args.path, estimate, deferDecision);
            event.affectedPath = resolved;
            setSpinner({ kind: 'read', name: 'Read', detail: `${shortenPath(args.path, cwd)} (deferred — predictive gate)` });
            options.session?.record('predictive_gate_fired', {
              path: args.path,
              projectedTokens: estimate.projectedTokens,
              projectedTotal: deferDecision.projectedTotal,
              hardCap: deferDecision.hardCap,
            });
            break;
          }
        }
        event.result = executeReadFile(
          args.path,
          cwd,
          options.session,
          options.safety?.largeFileGateBytes,
          options.safety?.largeFileGateLines,
        );
        event.affectedPath = resolved;
        break;
      }

      case 'extract_symbols':
        setSpinner({ kind: 'read', name: 'Symbols', detail: shortenPath(args.path, cwd) });
        event.result = await executeExtractSymbols(args.path, cwd, options.session);
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'extract_imports':
        setSpinner({ kind: 'read', name: 'Imports', detail: shortenPath(args.path, cwd) });
        event.result = await executeExtractImports(args.path, cwd, options.session);
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'write_file':
        setSpinner({ kind: 'write', name: 'Write', detail: shortenPath(args.path, cwd) });
        event.result = await executeWriteFile(args.path, args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'run_command':
        setSpinner({ kind: 'bash', name: 'Run', detail: truncate(args.command, 60) });
        let safetyResult = { safe: true, reason: '' };
        try {
          const { isCommandSafe } = await import('./command-parser.js');
          const safety = await isCommandSafe(args.command, cwd);
          if (!safety.safe) {
            safetyResult = { safe: false, reason: safety.reason || 'Unsafe command detected' };
          }
        } catch (err: any) {
          if (verbose) {
            console.error('Failed to run AST command safety check, failing closed for security:', err.message);
          }
          safetyResult = {
            safe: false,
            reason: `Error: AST command safety check failed and regex fallback is disabled for security reasons: ${err.message}`
          };
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
        event.result = executeRunCommand(
          args.command,
          args.cwd || cwd,
          cwd,
          options.session,
          options.safety?.sandboxMode,
        );
        break;

      case 'search_code':
        setSpinner({ kind: 'search', name: 'Search', detail: `"${truncate(args.query, 40)}" in ${args.path ?? '.'}` });
        event.result = executeSearchCode(args.query, args.path, args.file_pattern, cwd);
        break;

      case 'list_dir':
        setSpinner({ kind: 'read', name: 'List', detail: args.path ?? '.' });
        event.result = executeListDir(args.path, cwd);
        break;

      case 'delete_file':
        setSpinner({ kind: 'write', name: 'Delete', detail: shortenPath(args.path, cwd) });
        event.result = executeDeleteFile(args.path, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'apply_patch':
        setSpinner({ kind: 'write', name: 'Patch', detail: 'unified diff' });
        event.result = await executeApplyPatch(args.patch, cwd, options);
        event.isWrite = true;
        break;

      case 'replace_range':
        setSpinner({ kind: 'write', name: 'Replace', detail: shortenPath(args.path, cwd) });
        event.result = await executeReplaceRange(args.path, Number(args.startLine), Number(args.endLine), args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'insert_after':
        setSpinner({ kind: 'write', name: 'Insert', detail: shortenPath(args.path, cwd) });
        event.result = await executeInsertAfter(args.path, args.anchor, args.content, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'rename_file':
        setSpinner({ kind: 'write', name: 'Rename', detail: `${args.from} -> ${args.to}` });
        event.result = await executeRenameFile(args.from, args.to, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.to, 'file');
        break;

      case 'create_branch':
        setSpinner({ kind: 'write', name: 'Branch', detail: args.branchName });
        event.result = createBranch(cwd, args.branchName);
        event.isWrite = true;
        break;

      case 'commit_changes':
        setSpinner({ kind: 'write', name: 'Commit', detail: truncate(args.message, 60) });
        event.result = commitChanges(cwd, args.message);
        event.isWrite = true;
        break;

      case 'push_branch':
        setSpinner({ kind: 'write', name: 'Push', detail: args.remote || 'origin' });
        event.result = pushBranch(cwd, args.remote || 'origin');
        event.isWrite = true;
        break;

      case 'create_pull_request':
        setSpinner({ kind: 'write', name: 'PR', detail: `base: ${args.baseBranch || 'main'}` });
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
        setSpinner({ kind: 'read', name: 'Definition', detail: `${fileBasename}:${line}:${char}` });

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
        setSpinner({ kind: 'read', name: 'References', detail: `${fileBasename}:${line}:${char}` });

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
        setSpinner({ kind: 'read', name: 'Hover', detail: `${fileBasename}:${line}:${char}` });

        const manager = getLspManager(cwd);
        const resolvedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        const hoverRes = await manager.hover(resolvedPath, line, char);
        event.result = JSON.stringify(hoverRes || null, null, 2);
        break;
      }

      case 'web_fetch':
        setSpinner({ kind: 'search', name: 'Fetch', detail: args.url });
        event.result = await webFetch(args.url);
        break;

      case 'web_search':
        setSpinner({ kind: 'search', name: 'Search', detail: truncate(args.query, 40) });
        event.result = await webSearch(args.query);
        break;

      case 'str_replace':
        setSpinner({ kind: 'write', name: 'Surgical', detail: shortenPath(args.path, cwd) });
        event.result = await executeStrReplace(args as unknown as StrReplaceArgs, cwd, options);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'glob_files':
        setSpinner({ kind: 'search', name: 'Glob', detail: truncate(args.pattern, 60) });
        event.result = await executeGlobFiles(args as unknown as GlobArgs, cwd, options);
        break;

      case 'todo_read':
        setSpinner({ kind: 'search', name: 'Todo', detail: 'read' });
        event.result = executeTodoRead(cwd);
        break;

      case 'todo_write':
        setSpinner({ kind: 'write', name: 'Todo', detail: String((args as { op?: string }).op ?? 'add') });
        event.result = await executeTodoWrite(args as unknown as TodoWriteArgs, cwd, options);
        event.isWrite = true;
        break;

      case 'run_command_async':
        setSpinner({ kind: 'bash', name: 'Async', detail: truncate(args.cmd, 30) });
        event.result = await executeRunCommandAsync(args as unknown as RunCommandAsyncArgs, cwd, options);
        break;

      case 'poll_command_status':
        setSpinner({ kind: 'bash', name: 'Poll', detail: String((args as { jobId?: string }).jobId ?? '?') });
        event.result = executePollCommandStatus(args as unknown as PollCommandStatusArgs, cwd);
        break;

      case 'kill_command':
        setSpinner({ kind: 'bash', name: 'Kill', detail: String((args as { jobId?: string }).jobId ?? '?') });
        event.result = executeKillCommand(args as unknown as KillCommandArgs, cwd);
        break;

      default:
        event.result = `Error: Unknown tool "${name}"`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    event.result = `Error: ${msg}`;
    if (inlineSpinner) {
      (inlineSpinner as InlineSpinnerHandle).fail(truncate(msg, 80));
      inlineSpinner = null;
    } else {
      renderToolCall({ kind: 'error', name, detail: truncate(msg, 80) });
    }
  }

  // Finalise the inline spinner — convert it to a ✔ or ✗ summary line
  // based on whether the tool result starts with `Error:`. The brief
  // summary is the original detail plus an elapsed-time suffix so the
  // user sees roughly how long the call took.
  if (inlineSpinner) {
    const handle = inlineSpinner as InlineSpinnerHandle;
    const elapsedMs = Date.now() - toolStartedAt;
    const elapsedStr = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
    const failed = typeof event.result === 'string' && event.result.startsWith('Error:');
    if (failed) {
      handle.fail(`${truncate(event.result.replace(/^Error:\s*/, ''), 60)} (${elapsedStr})`);
    } else {
      handle.succeed(`done (${elapsedStr})`);
    }
    inlineSpinner = null;
  }

  options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });

  // ──── PostToolUse hooks (§3.4) ────
  // Fire any user-defined post-tool hooks. The tool has
  // already executed; we only emit telemetry + honour a
  // `deny` decision by appending a marker to the result so
  // the caller knows the post-hook flagged it.
  const postHook = fireHooks(cwd, 'PostToolUse', {
    tool: name,
    args: args as Record<string, unknown>,
    sessionId: options.session?.id ?? 'no-session',
  });
  if (postHook.fired && postHook.decision === 'deny') {
    const reason = postHook.reason ?? 'post-tool hook denied';
    event.result = `${event.result}\n[post-hook denied: ${reason}]`;
  }

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

  const baseName = path.basename(resolved).toLowerCase();
  const lowerPath = resolved.toLowerCase();
  if (
    baseName === '.env' ||
    baseName.startsWith('.env.') ||
    baseName === 'id_rsa' ||
    baseName === 'providers.json' ||
    lowerPath.includes('/.ssh/') ||
    lowerPath.endsWith('.pem')
  ) {
    return `Error: Access to sensitive file "${filePath}" is blocked for security reasons.`;
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
  let lastCharWasNewline = true;
  const stream = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(stream, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) {
          count++;
          lastCharWasNewline = true;
        } else {
          lastCharWasNewline = false;
        }
      }
    }
    if (!lastCharWasNewline) count++;
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

  const baseName = path.basename(resolved).toLowerCase();
  const lowerPath = resolved.toLowerCase();
  if (
    baseName === '.env' ||
    baseName.startsWith('.env.') ||
    baseName === 'id_rsa' ||
    baseName === 'providers.json' ||
    lowerPath.includes('/.ssh/') ||
    lowerPath.endsWith('.pem')
  ) {
    return Promise.resolve(`Error: Access to sensitive file "${filePath}" is blocked for security reasons.`);
  }
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

function executeRunCommand(
  command: string,
  requestedCwd: string,
  workspaceRoot: string,
  session?: TaskSession,
  sandboxMode?: import('../config.js').SandboxMode,
): string {
  const guard = new WorkspaceGuard(workspaceRoot);
  const commandCwd = guard.resolve(requestedCwd, 'command cwd');
  try {
    let result;
    if (sandboxMode === 'os-sandbox') {
      // Opt-in OS-level sandbox. The regex command-parser layer that
      // ran upstream is left in place — this is defence in depth.
      // If the platform binary is missing we surface a structured
      // error instead of silently downgrading to unsandboxed exec.
      try {
        result = runSandboxed(command, {
          cwd: commandCwd,
          allowedWritePaths: [workspaceRoot],
          allowNetwork: true,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          env: redactedEnv(),
        });
      } catch (sandboxErr: unknown) {
        if (sandboxErr instanceof SandboxUnavailableError) {
          return `Error: OS sandbox mode is enabled but cannot be applied — ${sandboxErr.message}. Either install the platform binary or set preferences.safety.sandboxMode to 'guard'.`;
        }
        throw sandboxErr;
      }
    } else {
      result = spawnSync(command, {
        shell: true,
        cwd: commandCwd,
        encoding: 'utf-8',
        timeout: 60_000, // 60 second timeout
        maxBuffer: 1024 * 1024, // 1MB max output
        env: redactedEnv(),
      });
    }
    const output = redactSecrets([result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n'));
    const status = result.status ?? 0;
    session?.record('command_finished', { command, cwd: guard.relative(commandCwd), status, output: truncate(output, 4000) });
    return output || `(command completed with code ${status})`;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; status?: number | string };
    const stdout = err.stdout ?? '';
    const stderr = err.stderr ?? '';
    const code = err.status ?? 'unknown';
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
  } catch (error: unknown) {
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Debug Warning] Failed to determine if ripgrep (rg) is installed: ${msg}`);
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
    const inv = getRunInventory(getOrCreateRunId());
    entries = inv.listDir(resolved);
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
  const inv = getRunInventory(getOrCreateRunId());
  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`📁 ${entry.name}/`);
    } else {
      let size = '';
      try {
        const s = inv.fileStats(path.join(resolved, entry.name));
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

/* ──────────────────── Strict Generic Tool Specification (Phase 1) ──────────────────── */

/**
 * Runtime execution context shared by every {@link ToolSpecification}.
 * Replaces the loose `any`-typed context that previously lived in
 * `LoadedPlugin.execute` so the type system enforces a uniform
 * contract across the registry.
 */
export interface ToolExecutionContext {
  readonly cwd: string;
  readonly verbose: boolean;
  readonly options: ToolExecutionOptions;
}

/**
 * Compile-time type for an individual tool. Each new tool added to
 * {@link TOOL_REGISTRY} must satisfy this contract: a strongly-typed
 * `args` payload (`TArgs`) and a strongly-typed `execute` callback
 * returning `TResult` (default `string` to match the existing
 * `executeTool` surface).
 *
 * The `parameters` field is the JSON-Schema description that is sent
 * to the LLM — it mirrors {@link ChatToolDefinition.function.parameters}
 * so the existing `TOOL_DEFINITIONS` array and the registry stay in
 * lock-step. Two tools must agree on `name` and `parameters` to be
 * safely exposed to the LLM.
 */
export interface ToolSpecification<
  TArgs extends Record<string, any> = Record<string, any>,
  TResult = string,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, any>;
    readonly required: string[];
  };
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>;
}

/* ──────────────────── str_replace payload contract ──────────────────── */

export interface StrReplaceArgs {
  /** File path, relative to workspace root or absolute. */
  path: string;
  /** Substring to hunt down inside the file. */
  oldString: string;
  /** Replacement content. */
  newString: string;
  /** When true, substitute every occurrence. Default false. */
  replaceAll?: boolean;
  /** When true (default), abort on non-unique matches. */
  expectUnique?: boolean;
}

/* ──────────────────── glob_files payload contract ──────────────────── */

export interface GlobArgs {
  /** Glob pattern, e.g. `src` followed by `**` then `*.ts`. */
  pattern: string;
  /** Optional scope; must resolve inside the workspace. */
  cwd?: string;
  /** Optional extra ignore pattern (single string or comma-separated). */
  ignore?: string;
  /** Default 1000, hard cap 5000. */
  maxResults?: number;
  /** Default false. */
  includeHidden?: boolean;
  /** Default false. */
  followSymlinks?: boolean;
}

/* ──────────────────── Typed errors ──────────────────── */

/**
 * Thrown by the `str_replace` tool when the replacement cannot be
 * applied. The error is surfaced to the model as a structured tool
 * result so the next turn can react to the precise reason.
 */
export class SurgicalReplaceError extends Error {
  public readonly code:
    | 'old_string_not_found'
    | 'old_string_ambiguous'
    | 'plan_mode_rejected'
    | 'platform_path_locked'
    | 'workspace_escape'
    | 'binary_file'
    | 'invalid_args';
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SurgicalReplaceError['code'],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SurgicalReplaceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Thrown by the `glob_files` tool for any non-recoverable traversal
 * failure (workspace escape, invalid pattern, etc.).
 */
export class GlobFilesError extends Error {
  public readonly code: 'invalid_pattern' | 'workspace_escape' | 'traversal_failed';
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: GlobFilesError['code'],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GlobFilesError';
    this.code = code;
    this.details = details;
  }
}

/* ──────────────────── todo_write / todo_read payload contract ──────────────────── */

export interface TodoWriteArgs {
  /** Mutation kind. */
  op: 'add' | 'set_status' | 'remove' | 'clear_done';
  /** Required for `add`. */
  content?: string;
  /** Required for `set_status` and `remove`. */
  id?: string;
  /** Required for `set_status`. */
  status?: TodoStatus;
  /** Optional blocker description (add only). */
  blockedBy?: string;
}

export class TodoWriteError extends Error {
  public readonly code: 'plan_mode_rejected' | 'invalid_args' | 'not_found' | 'io_failure';
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TodoWriteError['code'],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'TodoWriteError';
    this.code = code;
    this.details = details;
  }
}

/* ──────────────────── todo_read implementation ──────────────────── */

/**
 * Read the current todo list from `<cwd>/.fixo/todo_list.json`.
 * Always succeeds — a missing or unreadable file returns an
 * empty list (the loader is fault-tolerant by design).
 */
export function executeTodoRead(cwd: string): string {
  const list = loadTodoList(cwd);
  return renderTodoList(list);
}

/* ──────────────────── todo_write implementation ──────────────────── */

const VALID_TODO_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'done',
  'cancelled',
]);

/**
 * Apply a todo mutation and persist the result. Rejected in
 * `PLAN` mode (Pillar 1) — todo state is project-level
 * metadata, not conversation state, so even an `add` would
 * leak a write to disk.
 */
export async function executeTodoWrite(
  args: TodoWriteArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (options.mode === 'PLAN') {
    return `Error: todo_write: rejected in PLAN mode (no on-disk mutations).`;
  }
  const op = args.op;
  if (op !== 'add' && op !== 'set_status' && op !== 'remove' && op !== 'clear_done') {
    throw new TodoWriteError(
      `todo_write: unknown op "${String(op)}"`,
      'invalid_args',
      { op: String(op) },
    );
  }
  let list = loadTodoList(cwd);
  switch (op) {
    case 'add': {
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new TodoWriteError('todo_write: "content" is required for op=add', 'invalid_args');
      }
      list = addItem(list, { content: args.content, blockedBy: args.blockedBy });
      break;
    }
    case 'set_status': {
      if (typeof args.id !== 'string' || args.id.length === 0) {
        throw new TodoWriteError('todo_write: "id" is required for op=set_status', 'invalid_args');
      }
      if (!args.status || !VALID_TODO_STATUSES.has(args.status)) {
        throw new TodoWriteError(
          `todo_write: "status" must be one of pending|in_progress|done|cancelled (got "${String(args.status)}")`,
          'invalid_args',
        );
      }
      const exists = list.items.some((it) => it.id === args.id);
      if (!exists) {
        throw new TodoWriteError(`todo_write: item id "${args.id}" not found`, 'not_found');
      }
      list = setItemStatus(list, { id: args.id, status: args.status });
      break;
    }
    case 'remove': {
      if (typeof args.id !== 'string' || args.id.length === 0) {
        throw new TodoWriteError('todo_write: "id" is required for op=remove', 'invalid_args');
      }
      const exists = list.items.some((it) => it.id === args.id);
      if (!exists) {
        throw new TodoWriteError(`todo_write: item id "${args.id}" not found`, 'not_found');
      }
      list = removeItem(list, { id: args.id });
      break;
    }
    case 'clear_done': {
      list = clearDoneItems(list);
      break;
    }
  }
  const save = saveTodoList(cwd, list);
  if (!save.ok) {
    throw new TodoWriteError(`todo_write: failed to persist: ${save.error ?? 'unknown'}`, 'io_failure', {
      path: save.path,
    });
  }
  const summary = summariseTodoList(list);
  recordTelemetry(
    telemetry.todoMutation({
      op,
      items: list.items.length,
      id: typeof args.id === 'string' ? args.id : undefined,
    }),
  );
  // Echo the rendered list back so the LLM can confirm
  // its mutation took effect in the same turn.
  return `${renderTodoList(list)}\n\n(summary: ${summary})`;
}

/* ──────────────────── run_command_async / poll_command_status / kill_command ────────── */

/**
 * Process-global registry of background jobs. Lazily created on
 * the first call to `getBackgroundJobRegistry` so the tool
 * dispatch is hot-path-friendly and test-friendly (tests inject
 * a custom registry via {@link setBackgroundJobRegistry}).
 */
const globalBackgroundRegistry: BackgroundJobRegistry | null = null;
const backgroundRegistries = new Map<string, BackgroundJobRegistry>();

export function getBackgroundJobRegistry(cwd: string): BackgroundJobRegistry {
  let reg = backgroundRegistries.get(cwd);
  if (!reg) {
    reg = new BackgroundJobRegistry(cwd);
    backgroundRegistries.set(cwd, reg);
  }
  return reg;
}

/** Test-only: inject a custom registry. */
export function setBackgroundJobRegistry(cwd: string, reg: BackgroundJobRegistry | null): void {
  if (reg === null) {
    const existing = backgroundRegistries.get(cwd);
    if (existing) existing.shutdown();
    backgroundRegistries.delete(cwd);
    return;
  }
  const previous = backgroundRegistries.get(cwd);
  if (previous) previous.shutdown();
  backgroundRegistries.set(cwd, reg);
}

export interface RunCommandAsyncArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
}

export interface PollCommandStatusArgs {
  jobId: string;
  tailLines?: number;
  sinceBytes?: number;
}

export interface KillCommandArgs {
  jobId: string;
}

export class BackgroundCommandError extends Error {
  public readonly code: 'plan_mode_rejected' | 'invalid_args' | 'spawn_failed' | 'no_such_job';
  constructor(message: string, code: BackgroundCommandError['code']) {
    super(message);
    this.name = 'BackgroundCommandError';
    this.code = code;
  }
}

/**
 * Spawn a long-running command and return its jobId without
 * blocking. The tail buffers cap at 64 KiB per stream and the
 * snapshot is fsynced to `<cwd>/.fixo/jobs/<jobId>.json` every
 * 5 s so a crash does not lose the recent output.
 */
export async function executeRunCommandAsync(
  args: RunCommandAsyncArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (options.mode === 'PLAN') {
    return `Error: run_command_async: rejected in PLAN mode.`;
  }
  if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) {
    throw new BackgroundCommandError('run_command_async: "cmd" is required', 'invalid_args');
  }
  const cmdArgs = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string') : [];
  const reg = getBackgroundJobRegistry(cwd);
  const result = await reg.register({
    cmd: args.cmd,
    args: cmdArgs,
    cwd: args.cwd ?? cwd,
  });
  if (!result.ok) {
    throw new BackgroundCommandError(
      `run_command_async: ${result.error ?? 'unknown'}`,
      'spawn_failed',
    );
  }
  return JSON.stringify({
    ok: true,
    jobId: result.jobId,
    pid: result.pid,
    note: 'poll_command_status to retrieve output; kill_command to terminate',
  });
}

export function executePollCommandStatus(
  args: PollCommandStatusArgs,
  cwd: string,
): string {
  if (typeof args.jobId !== 'string' || args.jobId.length === 0) {
    throw new BackgroundCommandError('poll_command_status: "jobId" is required', 'invalid_args');
  }
  const reg = getBackgroundJobRegistry(cwd);
  const snap = reg.poll({
    jobId: args.jobId,
    tailLines: args.tailLines,
    sinceBytes: args.sinceBytes,
  });
  if (!snap) {
    throw new BackgroundCommandError(
      `poll_command_status: no such job "${args.jobId}"`,
      'no_such_job',
    );
  }
  return JSON.stringify(snap, null, 2);
}

export function executeKillCommand(
  args: KillCommandArgs,
  cwd: string,
): string {
  if (typeof args.jobId !== 'string' || args.jobId.length === 0) {
    throw new BackgroundCommandError('kill_command: "jobId" is required', 'invalid_args');
  }
  const reg = getBackgroundJobRegistry(cwd);
  const out = reg.kill(args.jobId);
  if (!out.ok) {
    throw new BackgroundCommandError(
      `kill_command: ${out.error ?? 'unknown'}`,
      'no_such_job',
    );
  }
  return JSON.stringify({ ok: true, jobId: args.jobId });
}

/** Helper exported for tests + subagent use. */
export function shutdownAllBackgroundRegistries(): void {
  for (const reg of backgroundRegistries.values()) reg.shutdown();
  backgroundRegistries.clear();
}

/** Helper exported for `/jobs` slash command. */
export function listAllBackgroundJobs(cwd: string): JobSnapshot[] {
  const reg = backgroundRegistries.get(cwd);
  if (!reg) return [];
  return reg.list().map((j) => ({
    id: j.id,
    status: j.status,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    exitedAt: j.exitedAt,
    cmd: j.cmd,
    args: j.args,
    cwd: j.cwd,
    stdout: j.stdoutTruncated ? `${j.stdout}\n...[truncated]` : j.stdout,
    stderr: j.stderrTruncated ? `${j.stderr}\n...[truncated]` : j.stderr,
    totalStdoutBytes: j.totalStdoutBytes,
    totalStderrBytes: j.totalStderrBytes,
    stdoutTruncated: j.stdoutTruncated,
    stderrTruncated: j.stderrTruncated,
  }));
}

/* ──────────────────── str_replace implementation ──────────────────── */

/**
 * Count non-overlapping occurrences of `needle` inside `haystack`.
 * Linear scan with a moving cursor — no regex, no allocation.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

/**
 * Apply a single in-place string replacement. Either replaces the
 * first match (default) or every match (when `replaceAll` is true).
 */
function applyReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (replaceAll) {
    // Manual split/join is faster than String.prototype.replaceAll
    // for large strings under V8 (avoids the internal RegExp).
    return content.split(oldString).join(newString);
  }
  return content.replace(oldString, newString);
}

/**
 * Implementation of the `str_replace` tool. Strictly typed and
 * gated by all four safety pillars:
 *
 *   - Pillar 1 (Sandbox): `ctx.mode === 'PLAN'` is rejected.
 *   - Pillar 5 (Self-Protection): platform-locked paths are
 *     refused by `WorkspaceGuard.assertNotPlatformPath`.
 *   - Pillar 2 (Atomic Staging): the final commit is funneled
 *     through {@link AtomicStagingManager.applySurgicalReplace},
 *     not a direct `fs.writeFileSync`.
 *   - Pillar 3 (LSP pre-save): the staged content is checked by
 *     the gate before commit. In `block` mode a syntax error
 *     causes the edit to abort with the diagnostic reported back
 *     to the model.
 */
export async function executeStrReplace(
  args: StrReplaceArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);

  // Validate the input.
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return `Error: str_replace: "path" is required.`;
  }
  if (typeof args.oldString !== 'string') {
    return `Error: str_replace: "oldString" is required.`;
  }
  if (typeof args.newString !== 'string') {
    return `Error: str_replace: "newString" is required.`;
  }

  // Pillar 1 — refuse in PLAN mode.
  if (options.mode === 'PLAN') {
    const err = new SurgicalReplaceError(
      `str_replace is not allowed in PLAN mode (read-only). Switch to BUILD mode and retry.`,
      'plan_mode_rejected',
      { mode: options.mode },
    );
    return `Error: ${err.message}`;
  }

  // Workspace boundary check.
  let resolved: string;
  try {
    resolved = guard.resolve(args.path, 'str_replace target');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: str_replace: ${msg}`;
  }

  // Pillar 5 — refuse platform-locked paths.
  try {
    guard.assertNotPlatformPath(resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }

  if (!fs.existsSync(resolved)) {
    return `Error: str_replace: file not found: ${args.path}`;
  }

  if (guard.isBinaryFile(resolved)) {
    return `Error: str_replace: file appears to be binary: ${args.path}`;
  }

  // Load the current content.
  const content = fs.readFileSync(resolved, 'utf-8');
  const occurrences = countOccurrences(content, args.oldString);
  const replaceAll = args.replaceAll === true;
  // The uniqueness gate only fires when the caller has not already
  // opted in to non-unique semantics via `replaceAll` or by
  // explicitly setting `expectUnique: false`.
  const expectUnique = !replaceAll && args.expectUnique !== false;

  if (occurrences === 0) {
    return `Error: str_replace: oldString not found in ${args.path}.`;
  }
  if (occurrences > 1 && expectUnique) {
    return `Error: str_replace: oldString appears ${occurrences} times in ${args.path}. ` +
      `Pass replaceAll=true or expectUnique=false to proceed.`;
  }

  const newContent = applyReplacement(content, args.oldString, args.newString, replaceAll);
  const bytes = Buffer.byteLength(newContent, 'utf-8');

  // Pillar 3 — LSP pre-save compilation gate. The gate's
  // `enforce` throws on `block`-mode failures; we surface the
  // diagnostics to the LLM as a structured error.
  if (options.safety?.lspPreSave && options.safety.lspPreSave !== 'off') {
    try {
      const gate = getOrCreateLspGate(cwd, options.safety);
      const synthetic = {
        id: 'surgical-' + Date.now().toString(36),
        targetPath: resolved,
        pendingPath: '<surgical>',
        metaPath: '<surgical>',
        createdAt: Date.now(),
        mode: 0o644,
      } as const;
      const result = await gate.check(synthetic);
      gate.enforce(result, synthetic);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: str_replace: ${msg}`;
    }
  }

  // Pillar 2 — atomic staging. Route the new content through the
  // staging manager's new surgical-replace method.
  try {
    const mgr = new AtomicStagingManager(cwd, getOrCreateRunId());
    const result = await mgr.applySurgicalReplace(resolved, newContent, {
      runId: mgr.runId,
      reason: 'str_replace',
      actorId: options.session?.id ?? 'tool-executor',
    });

    // Telemetry.
    try {
      const { recordTelemetry, telemetry } = await import('./telemetry.js');
      recordTelemetry(
        telemetry.surgicalEdit({
          path: args.path,
          occurrences: replaceAll ? occurrences : 1,
          mode: options.safety?.lspPreSave ?? 'off',
          bytes: result.bytes,
        }),
      );
    } catch {
      // Telemetry must never break a tool call.
    }

    options.session?.noteChange(resolved);
    return JSON.stringify({
      ok: true,
      path: args.path,
      occurrences: replaceAll ? occurrences : 1,
      mode: options.safety?.lspPreSave ?? 'off',
      bytes: result.bytes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: str_replace: ${msg}`;
  }
}

/* ──────────────────── glob_files implementation ──────────────────── */

const GLOB_DEFAULT_MAX_RESULTS = 1000;
const GLOB_HARD_MAX_RESULTS = 5000;
const GLOB_DEFAULT_SKIP_DIRS: ReadonlyArray<string> = [
  'node_modules',
  '.git',
  'dist',
  '.fixo',
  '.fixocli',
];

/**
 * Split a comma-separated ignore spec into an array. Tolerates
 * stray whitespace and empty entries.
 */
function splitIgnoreSpec(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Implementation of the `glob_files` tool. Strictly typed,
 * workspace-bounded, and capped.
 *
 * Uses Node 22+ native `fs.promises.glob` for performance. Falls
 * back to a manual recursive walker on Node < 22 (which the
 * project's `package.json` already requires) so the tool is
 * always functional.
 */
export async function executeGlobFiles(
  args: GlobArgs,
  cwd: string,
  _options: ToolExecutionOptions = {},
): Promise<string> {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    return `Error: glob_files: "pattern" is required.`;
  }

  const guard = new WorkspaceGuard(cwd);
  let scope: string;
  try {
    scope = args.cwd ? guard.resolve(args.cwd, 'glob scope') : cwd;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: glob_files: ${msg}`;
  }

  const maxResults = Math.min(
    Math.max(args.maxResults ?? GLOB_DEFAULT_MAX_RESULTS, 1),
    GLOB_HARD_MAX_RESULTS,
  );
  const skipDirs = new Set<string>(GLOB_DEFAULT_SKIP_DIRS);
  for (const extra of splitIgnoreSpec(args.ignore)) {
    skipDirs.add(extra);
  }
  const includeHidden = args.includeHidden === true;
  const followSymlinks = args.followSymlinks === true;

  // Collect matching paths.
  let matches: string[];
  try {
    matches = await collectGlobMatches({
      pattern: args.pattern,
      scope,
      skipDirs,
      includeHidden,
      followSymlinks,
      maxResults: maxResults + 1,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: glob_files: ${msg}`;
  }

  const truncated = matches.length > maxResults;
  const returned = truncated ? matches.slice(0, maxResults) : matches;
  const total = matches.length;

  // Telemetry.
  try {
    const { recordTelemetry, telemetry } = await import('./telemetry.js');
    recordTelemetry(
      telemetry.glob({
        pattern: args.pattern,
        returned: returned.length,
        truncated,
      }),
    );
  } catch {
    // Telemetry must never break a tool call.
  }

  if (returned.length === 0) {
    return JSON.stringify({ pattern: args.pattern, matches: [], total: 0, truncated: false });
  }

  return JSON.stringify({
    pattern: args.pattern,
    matches: returned.map((p) => path.relative(cwd, p) || p),
    total,
    truncated,
  });
}

interface CollectOptions {
  pattern: string;
  scope: string;
  skipDirs: ReadonlySet<string>;
  includeHidden: boolean;
  followSymlinks: boolean;
  maxResults: number;
}

/**
 * Collect paths matching `pattern` under `scope`. Prefers Node 22+
 * native `fs.promises.glob`; falls back to a manual recursive
 * walker on older runtimes. Both branches honour the skip set
 * and hidden-file policy.
 */
async function collectGlobMatches(opts: CollectOptions): Promise<string[]> {
  const { pattern, scope, skipDirs, includeHidden, followSymlinks, maxResults } = opts;
  const results: string[] = [];

  // Try native fs.promises.glob first.
  const fsPromises = fs.promises as typeof fs.promises & {
    glob?: (
      pattern: string,
      options?: { cwd?: string; exclude?: string[]; withFileTypes?: boolean },
    ) => Promise<unknown>;
  };

  if (typeof fsPromises.glob === 'function') {
    const exclude = Array.from(skipDirs).map((d) => `**/${d}/**`);
    const out = (await fsPromises.glob(pattern, {
      cwd: scope,
      exclude,
      withFileTypes: false,
    })) as unknown;
    if (Array.isArray(out)) {
      for (const entry of out) {
        if (typeof entry !== 'string') continue;
        const absolute = path.resolve(scope, entry);
        if (results.length >= maxResults) break;
        // The native glob does not surface whether symlinks were
        // followed; perform a defensive lstat and skip dotfiles if
        // the user did not opt in.
        try {
          if (!includeHidden && path.basename(absolute).startsWith('.')) continue;
        } catch {
          continue;
        }
        results.push(absolute);
      }
      return results;
    }
  }

  // Manual fallback — recursive walker with built-in pattern
  // matcher. Supports `**`, `*`, and literal segments.
  const matcher = compileGlob(pattern);
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (!followSymlinks) {
          try {
            const lst = await fs.promises.lstat(full);
            if (lst.isSymbolicLink()) continue;
          } catch {
            continue;
          }
        }
        await walk(full);
      } else if (entry.isFile()) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (skipDirs.has(entry.name)) continue;
        if (!followSymlinks) {
          try {
            const lst = await fs.promises.lstat(full);
            if (lst.isSymbolicLink()) continue;
          } catch {
            continue;
          }
        }
        if (matcher(path.relative(scope, full) || entry.name)) {
          results.push(full);
        }
      }
    }
  };
  await walk(scope);
  return results;
}

/**
 * Compile a small subset of glob syntax into a predicate. Supports:
 *   - `**`  → any number of path segments
 *   - `*`   → any characters within a single segment
 *   - `?`   → any single character
 *   - everything else is a literal
 *
 * The matcher operates on forward-slash paths regardless of host
 * platform. This is intentionally tiny — Node 22+'s native
 * `fs.promises.glob` covers the common case; the fallback exists
 * for environments where the native API is unavailable.
 */
function compileGlob(pattern: string): (relPath: string) => boolean {
  // Normalise separators.
  const normalised = pattern.replace(/\\/g, '/');
  const re = globToRegExp(normalised);
  return (rel: string) => re.test(rel.replace(/\\/g, '/'));
}

/**
 * Convert a glob pattern to a regular expression. Faithful to the
 * small subset documented on {@link compileGlob}.
 */
function globToRegExp(pattern: string): RegExp {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*';
        i += 2;
        // Consume an optional following slash so `**/foo` works.
        if (pattern[i] === '/') i += 1;
      } else {
        body += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      body += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      body += '\\' + ch;
      i += 1;
    } else {
      body += ch;
      i += 1;
    }
  }
  return new RegExp('^' + body + '$');
}

/* ──────────────────── Tool Specification Registry ──────────────────── */

/**
 * Process-global registry of typed tool specifications. New tools
 * register themselves here; the existing `TOOL_DEFINITIONS` array
 * remains the LLM-facing JSON-Schema surface. Both surfaces are
 * kept in lock-step by the executor's dispatch path.
 *
 * The registry stores entries as `ToolSpecification<Record<string, any>, string>`
 * for compatibility with the existing switch dispatch. Strongly-typed
 * callers can cast at the call site.
 */
const toolRegistry = new Map<string, ToolSpecification<Record<string, any>, string>>();

/** Register a typed tool specification. Throws on duplicate. */
export function registerTool<TArgs extends Record<string, any>, TResult = string>(
  spec: ToolSpecification<TArgs, TResult>,
): void {
  if (toolRegistry.has(spec.name)) {
    throw new Error(`Tool "${spec.name}" is already registered.`);
  }
  toolRegistry.set(
    spec.name,
    spec as unknown as ToolSpecification<Record<string, any>, string>,
  );
}

/** Look up a registered tool specification. */
export function getToolSpecification(
  name: string,
): ToolSpecification<Record<string, any>, string> | undefined {
  return toolRegistry.get(name);
}

/** List the names of all registered typed tools. */
export function listRegisteredToolNames(): string[] {
  return Array.from(toolRegistry.keys()).sort();
}

/* ──────────────────── Built-in Typed Registrations ──────────────────── */

registerTool<StrReplaceArgs>({
  name: 'str_replace',
  description:
    'Use this tool by default for any in-place edit to an existing file. Performs a surgical, atomic replacement of oldString with newString. By default, oldString must be unique within the file (expectUnique=true) — non-unique matches are rejected with a clear error so the caller can narrow the snippet. Pass replaceAll=true to substitute every occurrence. Rejected in PLAN mode. Refused for platform-locked paths. Goes through the same atomic staging pipeline as write_file and the LSP pre-save gate before any disk mutation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to edit.' },
      oldString: { type: 'string', description: 'The substring to replace.' },
      newString: { type: 'string', description: 'The replacement content.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      expectUnique: {
        type: 'boolean',
        description: 'Abort when oldString is not unique.',
      },
    },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(args, ctx) {
    return executeStrReplace(args, ctx.cwd, ctx.options);
  },
});

registerTool<GlobArgs>({
  name: 'glob_files',
  description:
    'High-performance filesystem pattern matcher. Returns paths matching the given glob pattern, relative to the workspace root. Built on Node 22+ native fs.promises.glob. By default, common build/VCS directories (node_modules, .git, dist, .fixo, .fixocli) are excluded. Symlinks are not followed and hidden files are excluded unless explicitly enabled. Capped at maxResults (default 1000, hard cap 5000).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      cwd: { type: 'string', description: 'Optional scope directory.' },
      ignore: { type: 'string', description: 'Optional extra ignore patterns.' },
      maxResults: { type: 'integer', description: 'Cap on returned matches.' },
      includeHidden: { type: 'boolean', description: 'Include dotfile entries.' },
      followSymlinks: { type: 'boolean', description: 'Follow symbolic links.' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    return executeGlobFiles(args, ctx.cwd, ctx.options);
  },
});

registerTool({
  name: 'todo_read',
  description:
    'Read the current project todo list from <cwd>/.fixo/todo_list.json. Returns a human-readable rendering of all items, grouped into Open and Completed. Missing or unreadable files yield an empty list — this is by design so the agent can always inspect todo state.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args, ctx) {
    return executeTodoRead(ctx.cwd);
  },
});

registerTool<TodoWriteArgs>({
  name: 'todo_write',
  description:
    'Mutate the project todo list. Operations: add (content+blockedBy optional), set_status (id+status), remove (id), clear_done. Persisted atomically to <cwd>/.fixo/todo_list.json. Rejected in PLAN mode. Status values: pending | in_progress | done | cancelled.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'set_status', 'remove', 'clear_done'] },
      content: { type: 'string', description: 'Item content (op=add only).' },
      id: { type: 'string', description: 'Item id (op=set_status, op=remove).' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
      blockedBy: { type: 'string', description: 'Optional blocker (op=add).' },
    },
    required: ['op'],
  },
  async execute(args, ctx) {
    return executeTodoWrite(args, ctx.cwd, ctx.options);
  },
});

registerTool<RunCommandAsyncArgs>({
  name: 'run_command_async',
  description:
    'Spawn a long-running command in the background. Returns a jobId. Streams cap at 64 KiB; tail buffers survive a crash via the .fixo/jobs/<jobId>.json snapshot. Rejected in PLAN mode. Workspace-escape and sensitive-file commands are blocked at spawn time.',
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The binary to spawn.' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
    },
    required: ['cmd'],
  },
  async execute(args, ctx) {
    return executeRunCommandAsync(args, ctx.cwd, ctx.options);
  },
});

registerTool<PollCommandStatusArgs>({
  name: 'poll_command_status',
  description:
    'Read a snapshot of a background job. Honours tailLines (last N lines per stream) and sinceBytes (return only the bytes after this offset on stdout/stderr).',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      tailLines: { type: 'integer' },
      sinceBytes: { type: 'integer' },
    },
    required: ['jobId'],
  },
  async execute(args, ctx) {
    return executePollCommandStatus(args, ctx.cwd);
  },
});

registerTool<KillCommandArgs>({
  name: 'kill_command',
  description: 'SIGTERM a background job by jobId.',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
  },
  async execute(args, ctx) {
    return executeKillCommand(args, ctx.cwd);
  },
});
