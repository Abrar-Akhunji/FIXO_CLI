/**
 * Tool definitions and executor for the single-agent tool-calling loop.
 * Provides: read_file, write_file, run_command, search_code, list_dir
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ChatToolDefinition } from '../shared/types.js';
import { colors } from '../ui/colors.js';
import { WorkspaceGuard } from '../workspace-guard.js';
import type { TaskSession } from '../runtime/task-session.js';
import { decidePolicy, type PolicyProfile } from '../runtime/policy.js';
import { redactedEnv, redactSecrets } from '../runtime/redaction.js';
import { McpManager } from './mcp-manager.js';
import type { AgentClient } from './agent-client.js';
import { createBranch, commitChanges, pushBranch, createPullRequest } from '../git/git-ops.js';
import { pathToFileURL } from 'url';
import * as p from '@clack/prompts';
import { loadConfig, saveConfig } from '../config.js';

import { McpBridgeManager } from './mcp-bridge.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { webFetch, webSearch } from './web.js';

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
  }
  
  return tools;
}

export const TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the full text contents of a file at the given path. Use this to understand existing code before making changes. Returns the file contents as a string.',
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
      logToolCall('🔌', 'Plugin', name);
      try {
        event.result = await plugin.execute(name, args, { cwd, verbose, policy, options });
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        console.log(`  ${colors.red}✗ ${name} failed: ${truncate(msg, 80)}${colors.reset}`);
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
      logToolCall('🔌', 'MCP', name);
      try {
        event.result = await mcpManager.executeTool(name, args);
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        console.log(`  ${colors.red}✗ ${name} failed: ${truncate(msg, 80)}${colors.reset}`);
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
      logToolCall('🔌', 'Local MCP', name);
      try {
        event.result = await mcpBridgeManager.executeTool(name, args);
        event.isWrite = action === 'write';
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        event.result = `Error: ${msg}`;
        console.log(`  ${colors.red}✗ ${name} failed: ${truncate(msg, 80)}${colors.reset}`);
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
        event.result = executeReadFile(args.path, cwd, options.session);
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        logToolCall('📖', 'Read', shortenPath(args.path, cwd));
        break;

      case 'write_file':
        event.result = executeWriteFile(args.path, args.content, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        logToolCall('✏️', 'Write', shortenPath(args.path, cwd));
        break;

      case 'run_command':
        logToolCall('⚙️', 'Run', truncate(args.command, 60));
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
        logToolCall('🔍', 'Search', `"${truncate(args.query, 40)}" in ${args.path ?? '.'}`);
        event.result = executeSearchCode(args.query, args.path, args.file_pattern, cwd);
        break;

      case 'list_dir':
        logToolCall('📂', 'List', args.path ?? '.');
        event.result = executeListDir(args.path, cwd);
        break;

      case 'delete_file':
        logToolCall('🗑️', 'Delete', shortenPath(args.path, cwd));
        event.result = executeDeleteFile(args.path, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'apply_patch':
        logToolCall('🩹', 'Patch', 'unified diff');
        event.result = executeApplyPatch(args.patch, cwd, options.session);
        event.isWrite = true;
        break;

      case 'replace_range':
        logToolCall('✂️', 'Replace', shortenPath(args.path, cwd));
        event.result = executeReplaceRange(args.path, Number(args.startLine), Number(args.endLine), args.content, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'insert_after':
        logToolCall('➕', 'Insert', shortenPath(args.path, cwd));
        event.result = executeInsertAfter(args.path, args.anchor, args.content, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        break;

      case 'rename_file':
        logToolCall('↪', 'Rename', `${args.from} -> ${args.to}`);
        event.result = executeRenameFile(args.from, args.to, cwd, options.session);
        event.isWrite = true;
        event.affectedPath = new WorkspaceGuard(cwd).resolve(args.to, 'file');
        break;

      case 'create_branch':
        logToolCall('🌳', 'Branch', args.branchName);
        event.result = createBranch(cwd, args.branchName);
        event.isWrite = true;
        break;

      case 'commit_changes':
        logToolCall('💾', 'Commit', truncate(args.message, 60));
        event.result = commitChanges(cwd, args.message);
        event.isWrite = true;
        break;

      case 'push_branch':
        logToolCall('🚀', 'Push', args.remote || 'origin');
        event.result = pushBranch(cwd, args.remote || 'origin');
        event.isWrite = true;
        break;

      case 'create_pull_request':
        logToolCall('🐙', 'PR', `base: ${args.baseBranch || 'main'}`);
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
        logToolCall('🔍', 'LSP Definition', `${fileBasename}:${line}:${char}`);
        
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
        logToolCall('🔍', 'LSP References', `${fileBasename}:${line}:${char}`);
        
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
        logToolCall('ℹ️', 'LSP Hover', `${fileBasename}:${line}:${char}`);
        
        const manager = getLspManager(cwd);
        const resolvedPath = new WorkspaceGuard(cwd).resolve(args.path, 'file');
        const hoverRes = await manager.hover(resolvedPath, line, char);
        event.result = JSON.stringify(hoverRes || null, null, 2);
        break;
      }

      case 'web_fetch':
        logToolCall('🌐', 'Web Fetch', args.url);
        event.result = await webFetch(args.url);
        break;

      case 'web_search':
        logToolCall('🔍', 'Web Search', truncate(args.query, 40));
        event.result = await webSearch(args.query);
        break;

      default:
        event.result = `Error: Unknown tool "${name}"`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    event.result = `Error: ${msg}`;
    console.log(`  ${colors.red}✗ ${name} failed: ${truncate(msg, 80)}${colors.reset}`);
  }
  options.session?.record('tool_finished', { tool: name, result: truncate(event.result, 2000), isWrite: event.isWrite });

  return event;
}

/* ──────────────────────── Tool Implementations ──────────────────────── */

function executeReadFile(filePath: string, cwd: string, session?: TaskSession): string {
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

  const content = fs.readFileSync(resolved, 'utf-8');
  session?.noteRead(resolved);
  return content;
}

function executeWriteFile(filePath: string, content: string, cwd: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  const mutation = session?.canMutate(resolved);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(resolved);

  // Create parent directories
  const parentDir = path.dirname(resolved);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const existed = fs.existsSync(resolved);
  fs.writeFileSync(resolved, content, 'utf-8');
  session?.noteChange(resolved);

  if (existed) {
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
  }

  return existed
    ? `File updated: ${filePath}`
    : `File created: ${filePath}`;
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

function logToolCall(icon: string, action: string, detail: string): void {
  console.log(`  ${colors.dim}${icon} ${action}: ${detail}${colors.reset}`);
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

function executeApplyPatch(patch: string, cwd: string, session?: TaskSession): string {
  if (!patch?.trim()) return 'Error: patch is required.';
  for (const file of filesFromPatch(patch)) {
    try { session?.captureBefore(file); } catch { /* best effort */ }
  }
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd,
    input: patch,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return `Patch failed:\n${result.stderr || result.stdout}`;
  for (const file of filesFromPatch(patch)) {
    try { session?.noteChange(file); } catch { /* best effort */ }
  }
  return 'Patch applied.';
}

function executeReplaceRange(filePath: string, startLine: number, endLine: number, content: string, cwd: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  const mutation = session?.canMutate(resolved);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(resolved);
  const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    return `Error: invalid line range ${startLine}-${endLine}.`;
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...content.split('\n'));
  fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
  session?.noteChange(resolved);
  return `Replaced ${filePath}:${startLine}-${endLine}.`;
}

function executeInsertAfter(filePath: string, anchor: string, content: string, cwd: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, 'file');
  const mutation = session?.canMutate(resolved);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(resolved);
  const original = fs.readFileSync(resolved, 'utf-8');
  const idx = original.indexOf(anchor);
  if (idx === -1) return `Error: anchor not found in ${filePath}.`;
  const insertAt = idx + anchor.length;
  fs.writeFileSync(resolved, original.slice(0, insertAt) + content + original.slice(insertAt), 'utf-8');
  session?.noteChange(resolved);
  return `Inserted content in ${filePath}.`;
}

function executeRenameFile(from: string, to: string, cwd: string, session?: TaskSession): string {
  const guard = new WorkspaceGuard(cwd);
  const source = guard.resolve(from, 'source file');
  const target = guard.resolve(to, 'target file');
  const mutation = session?.canMutate(source);
  if (mutation && !mutation.ok) return `Error: ${mutation.reason}`;
  session?.captureBefore(source);
  session?.captureBefore(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  session?.noteChange(source);
  session?.noteChange(target);
  return `Renamed ${from} -> ${to}.`;
}

function filesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('--- a/')) files.add(line.slice(6));
  }
  return Array.from(files).filter(file => file !== '/dev/null');
}
