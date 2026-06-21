import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import type readline from 'readline';
import type { ChatMessage, ChatToolDefinition } from '../shared/types.js';
import type { AgentContext, Subtask } from '../types.js';
import { loadIndex } from '../indexer.js';
import { WorkspaceGuard } from '../workspace-guard.js';
import { AgentClient } from './agent-client.js';
import { loadConfig } from '../config.js';
import { executeTool, getActiveTools, type ToolCallEvent } from './tool-executor.js';
import { colors } from '../ui/colors.js';
import { workspaceLockManager } from '../workspace-lock.js';
import { logTelemetry } from './telemetry.js';
import { checkPermission } from './permissions.js';
import {
  SemanticLoopDetector,
  SemanticLoopAbortedError,
  toSafetyAlertDirective,
} from '../runtime/loop-trap.js';
import * as p from '@clack/prompts';
import { FILE_WRITING_RULES_BLOCK } from './file-writing-rules.js';

function getPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      const p = line.slice(6).trim();
      if (p && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

export async function acquireLockWithRetryAndTimeout(
  manager: any,
  paths: string[],
  agentId: string,
  lockType: 'read' | 'write'
): Promise<boolean> {
  const backoffs = [500, 1500];
  const timeoutMs = 30000;
  const startTime = Date.now();
  let retryCount = 0;

  while (true) {
    let allAcquired = true;
    const acquiredSoFar: string[] = [];
    
    for (const p of paths) {
      const success = manager.acquireLock(p, agentId, lockType);
      if (success) {
        acquiredSoFar.push(p);
      } else {
        allAcquired = false;
        break;
      }
    }
    
    if (allAcquired) {
      return true;
    }
    
    for (const p of acquiredSoFar) {
      manager.releaseLock(p, agentId);
    }

    if (Date.now() - startTime >= timeoutMs) {
      await logTelemetry({
        id: `lock-${agentId}-${Date.now()}`,
        tool: 'lock_manager',
        arguments: { paths, agentId, lockType, error: 'Lock wait timeout exceeded' },
        status: 'failed'
      });
      return false;
    }

    const delay = retryCount < backoffs.length ? backoffs[retryCount] : 1000;
    retryCount++;
    
    console.log(`\n${colors.yellow}[Lock Manager] Lock conflict for agent ${agentId} on files: ${paths.join(', ')}. Retrying in ${delay}ms...${colors.reset}`);
    await logTelemetry({
      id: `lock-conflict-${agentId}-${Date.now()}`,
      tool: 'lock_manager',
      arguments: { paths, agentId, lockType, retryCount, delay },
      status: 'started'
    });
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}


export function getBranchPoint(cwd: string): string {
  try {
    const mergeBase = execSync('git merge-base HEAD main', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (mergeBase) return mergeBase;
  } catch (error: any) {
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      console.warn(`[Debug Warning] Failed to get branch point: ${error.message || error}`);
    }
  }
  return 'HEAD';
}

export function getModifiedFiles(cwd: string, branchPoint: string): string[] {
  try {
    let diffCmd = ['diff', '--name-only', branchPoint, 'HEAD'];
    if (branchPoint === 'HEAD') {
      diffCmd = ['diff', '--name-only', 'HEAD'];
    }
    const files = execSync(`git ${diffCmd.join(' ')}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);
    return files;
  } catch (error: any) {
    if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
      console.warn(`[Debug Warning] Failed to get modified files: ${error.message || error}`);
    }
    return [];
  }
}

export async function partitionContext(
  cwd: string,
  persona: 'code' | 'test' | 'doc' | 'reviewer',
  subtaskFiles: string[] = []
): Promise<{ systemPrompt: string; filesToLoad: string[] }> {
  const guard = new WorkspaceGuard(cwd);
  const index = await loadIndex(cwd);
  const branchPoint = getBranchPoint(cwd);
  const modified = getModifiedFiles(cwd, branchPoint);

  const targetFiles = Array.from(new Set([...modified, ...subtaskFiles]));

  let filesToLoad: string[] = [];
  let systemPrompt = '';

  if (persona === 'code') {
    const codeFiles = new Set<string>();
    for (const f of targetFiles) {
      codeFiles.add(f);
      const indexed = index.files.find(idx => idx.path === f);
      if (indexed && indexed.resolvedImports) {
        for (const imp of indexed.resolvedImports) {
          codeFiles.add(imp);
        }
      }
    }
    filesToLoad = Array.from(codeFiles);
    systemPrompt = `You are the FixO Code Agent. Your job is to read and modify code files in the workspace.
You have access to files and their dependencies. Focus only on the requested code changes.
${FILE_WRITING_RULES_BLOCK}`;
  } else if (persona === 'test') {
    const testFiles = new Set<string>();
    for (const f of index.files) {
      const isTest = f.path.includes('.test.') || f.path.includes('.spec.') || f.path.includes('__tests__') || f.path.includes('test/');
      if (isTest) {
        testFiles.add(f.path);
        if (f.resolvedImports) {
          for (const imp of f.resolvedImports) {
            testFiles.add(imp);
          }
        }
      }
    }
    filesToLoad = Array.from(testFiles);
    systemPrompt = `You are the FixO Test Agent. Your job is to run, write, or fix unit and integration tests.
Ensure code changes are thoroughly covered by tests and all test suites pass.
${FILE_WRITING_RULES_BLOCK}`;
  } else if (persona === 'doc') {
    const docFiles = new Set<string>();
    for (const f of index.files) {
      const isDoc = f.path.endsWith('.md') || f.path.includes('changelog') || f.path.includes('CHANGELOG');
      if (isDoc) {
        docFiles.add(f.path);
      } else {
        try {
          const content = fs.readFileSync(path.join(cwd, f.path), 'utf-8');
          if (content.includes('/**') || content.includes('//')) {
            if (targetFiles.includes(f.path)) {
              docFiles.add(f.path);
            }
          }
        } catch (error: any) {
          if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
            console.warn(`[Debug Warning] Failed to read file ${f.path} during doc partitioning: ${error.message || error}`);
          }
        }
      }
    }
    filesToLoad = Array.from(docFiles);
    systemPrompt = `You are the FixO Documentation Agent. Your job is to update project documentation, README markdown files, JSDoc/TSDoc comments, and API schemas.`;
  } else if (persona === 'reviewer') {
    filesToLoad = [];
    let diffContent = '';
    try {
      let diffCmd = ['diff', branchPoint, 'HEAD'];
      if (branchPoint === 'HEAD') {
        diffCmd = ['diff', 'HEAD'];
      }
      diffContent = execSync(`git ${diffCmd.join(' ')}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        console.warn(`[Debug Warning] Failed to run git diff in reviewer partition: ${error.message || error}`);
      }
    }
    systemPrompt = `You are the FixO Reviewer Agent. Your job is to audit code modifications.
Analyze the provided Git diff and check for code quality, syntax errors, and potential bugs.

Active Workspace Git Diff:
\`\`\`diff
${diffContent}
\`\`\``;
  }

  return { systemPrompt, filesToLoad };
}

export class WorkerAgent {
  private client: AgentClient;
  private verbose: boolean;
  private allowAll = false;
  /** AbortController used to cancel the current worker task. */
  private abortController = new AbortController();
  /** Set true once the user requests cancellation. */
  private markedForCancellation = false;

  constructor(verbose = false) {
    const config = loadConfig();
    this.client = new AgentClient(
      config.freellmapi_api_key || '',
      config.apiUrl,
      verbose,
      config.provider_mode,
    );
    this.verbose = verbose;
  }

  /** Abort the current worker task. */
  abort(): void {
    this.markedForCancellation = true;
    this.abortController.abort();
  }

  /** Reset the abort controller after a cancellation. */
  reset(): void {
    this.abortController = new AbortController();
    this.markedForCancellation = false;
  }

  async run(
    context: AgentContext,
    subtask: Subtask,
    globalBudgetDecrement: () => void,
    rl?: readline.Interface
  ): Promise<{
    success: boolean;
    output: string;
    tokensUsed: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    toolCallCount: number;
  }> {
    const { systemPrompt, filesToLoad } = await partitionContext(context.cwd, subtask.persona, subtask.files);
    
    const parts = [
      systemPrompt,
      ``,
      `## Subtask to Accomplish`,
      `Title: ${subtask.title}`,
      `Description: ${subtask.description}`,
      ``,
      `## Workspace`,
      `Working directory: ${context.cwd}`
    ];

    try {
      const { retrieveRelevantFacts } = await import('../project-memory.js');
      const relevantFacts = await retrieveRelevantFacts(context.cwd, `${subtask.title} ${subtask.description}`, this.client, 5);
      if (relevantFacts.length > 0) {
        parts.push(
          ``,
          `## Project Memory (Relevant Facts & Guidelines)`,
          relevantFacts.map(f => `- ${f}`).join('\n')
        );
      }
    } catch (error: any) {
      if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
        console.warn(`[Debug Warning] Failed to retrieve relevant memory facts: ${error.message || error}`);
      }
    }

    const guard = new WorkspaceGuard(context.cwd);
    let pinnedBytes = 0;
    const MAX_PINNED_TOTAL_BYTES = 180_000;
    const MAX_PINNED_FILE_BYTES = 80_000;
    
    if (filesToLoad.length > 0) {
      parts.push(``, `## Partitioned Files Context`);
      for (const filePath of filesToLoad) {
        try {
          const resolved = guard.ensureFile(filePath);
          const relPath = guard.relative(resolved);
          if (!fs.existsSync(resolved) || guard.isBinaryFile(resolved)) continue;
          
          let content = fs.readFileSync(resolved, 'utf-8');
          const fileBytes = Buffer.byteLength(content, 'utf-8');
          
          if (fileBytes > MAX_PINNED_FILE_BYTES) {
            content = content.slice(0, MAX_PINNED_FILE_BYTES) + `\n\n... (truncated, file too large)`;
          }
          
          const contentBytes = Buffer.byteLength(content, 'utf-8');
          if (pinnedBytes + contentBytes > MAX_PINNED_TOTAL_BYTES) {
            const availableBytes = MAX_PINNED_TOTAL_BYTES - pinnedBytes;
            if (availableBytes > 100) {
              content = content.slice(0, availableBytes) + `\n\n... (truncated, context size limit reached)`;
              parts.push(
                `File: \`${relPath}\``,
                `\`\`\``,
                content,
                `\`\`\``,
                ``
              );
              pinnedBytes += Buffer.byteLength(content, 'utf-8');
            }
            break;
          }
          
          parts.push(
            `File: \`${relPath}\``,
            `\`\`\``,
            content,
            `\`\`\``,
            ``
          );
          pinnedBytes += contentBytes;
        } catch (error: any) {
          if (process.env.DEBUG || process.env.VERBOSE || process.argv.includes('--verbose')) {
            console.warn(`[Debug Warning] Failed to load context file ${filePath}: ${error.message || error}`);
          }
        }
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: parts.join('\n') },
      { role: 'user', content: `Please accomplish this subtask: ${subtask.description}` }
    ];

    const tokensUsed = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let toolCallCount = 0;
    const maxLocalToolCalls = 15;

    // Pillar 2 — semantic loop detector for the worker. Mirrors
    // the wiring in single-agent.ts. The worker does not maintain
    // a TaskSession (it executes inside the parent session), so we
    // skip the staged-write rollback on hard-abort and let the
    // parent session's normal cleanup handle it.
    const safety = loadConfig().preferences.safety;
    const semanticLoopDetector = new SemanticLoopDetector(safety.semanticLoopTrap);
    let pendingSafetyDirective: string | null = null;

    /**
     * Prepend a safety directive to the system message at the head
     * of the messages array.
     */
    const injectSafetyDirective = (directive: string): void => {
      if (messages.length === 0 || messages[0]?.role !== 'system') {
        messages.unshift({ role: 'system', content: directive });
        return;
      }
      const first = messages[0]!;
      messages[0] = {
        role: 'system',
        content: `${directive}\n\n${first.content}`,
      };
    };

    while (toolCallCount < maxLocalToolCalls) {
      // Check for user cancellation before each LLM call
      if (this.abortController.signal.aborted) {
        throw new Error('Worker task cancelled by user.');
      }

      const spinner = p.spinner();
      spinner.start(`🤖 Worker agent thinking (turn ${toolCallCount + 1})...`);
      let result;
      try {
        result = await this.client.chat(messages, context.model, {
          tools: getActiveTools(context.mode),
          tool_choice: 'auto',
          agent_task_type: 'mutation',
          required_capabilities: ['tool-calling', 'coding'],
          signal: this.abortController.signal,
        });
      } finally {
        spinner.stop('🤖 Worker thought completed');
      }

      if (result.usage) {
        tokensUsed.prompt_tokens += result.usage.prompt_tokens;
        tokensUsed.completion_tokens += result.usage.completion_tokens;
        tokensUsed.total_tokens += result.usage.total_tokens;
      }

      if (!result.tool_calls || result.tool_calls.length === 0) {
        return {
          success: true,
          output: result.content || 'Completed subtask successfully.',
          tokensUsed,
          toolCallCount
        };
      }

      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.tool_calls
      });

      for (const toolCall of result.tool_calls) {
        let parsedArgs: Record<string, string>;
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          parsedArgs = { error: 'Failed to parse tool arguments' };
        }

        // Pillar 2 — semantic loop detection. Records the tool
        // call *before* execution so a permission-denied tool
        // still counts. Hard-abort terminates the worker; the
        // parent session will see a non-success SubtaskResult
        // and decide what to do.
        if (semanticLoopDetector.preference.enabled) {
          const verdict = semanticLoopDetector.record(
            toolCallCount,
            toolCall.function.name,
            parsedArgs,
            context.cwd,
          );
          if (verdict.state === 'warn') {
            pendingSafetyDirective = toSafetyAlertDirective(verdict);
            console.log(
              `${colors.yellow}⚠  [Worker] Semantic loop warning: ` +
              `${verdict.target} accessed ${verdict.count}× ` +
              `in the last ${verdict.windowSize} turns.${colors.reset}`,
            );
          } else if (verdict.state === 'hard-abort') {
            throw new SemanticLoopAbortedError(
              verdict.target,
              verdict.count,
              verdict.windowSize,
            );
          }
        }

        // Stage any pending directive at the top of the messages
        // array so the next LLM call sees it first.
        if (pendingSafetyDirective) {
          injectSafetyDirective(pendingSafetyDirective);
          pendingSafetyDirective = null;
        }

        const toolCallId = toolCall.id;
        await logTelemetry({
          id: toolCallId,
          tool: toolCall.function.name,
          arguments: parsedArgs,
          status: 'started'
        });

        const allowed = await this.askPermission(toolCall.function.name, parsedArgs, rl, context);
        let event: ToolCallEvent;
        if (!allowed) {
          event = {
            tool: toolCall.function.name,
            args: parsedArgs,
            result: `Error: User denied permission to execute ${toolCall.function.name}.`,
            isWrite: false
          };
          await logTelemetry({
            id: toolCallId,
            tool: toolCall.function.name,
            arguments: parsedArgs,
            status: 'failed',
            error: 'User denied permission'
          });
        } else {
          // Resolve lock paths
          const lockPaths: string[] = [];
          if (parsedArgs.path) {
            lockPaths.push(guard.resolve(parsedArgs.path));
          } else if (parsedArgs.from || parsedArgs.to) {
            if (parsedArgs.from) lockPaths.push(guard.resolve(parsedArgs.from));
            if (parsedArgs.to) lockPaths.push(guard.resolve(parsedArgs.to));
          } else if (parsedArgs.patch) {
            const patchPaths = getPatchPaths(parsedArgs.patch);
            for (const p of patchPaths) {
              lockPaths.push(guard.resolve(p));
            }
          }

          const isWriteTool = ['write_file', 'apply_patch', 'replace_range', 'insert_after', 'rename_file', 'delete_file'].includes(toolCall.function.name);
          const lockType = isWriteTool ? 'write' : 'read';

          let locked = true;
          if (lockPaths.length > 0) {
            locked = await acquireLockWithRetryAndTimeout(workspaceLockManager, lockPaths, subtask.id, lockType);
          }

          if (!locked) {
            console.error(`\n${colors.red}[Lock Manager] Failed to acquire lock for agent ${subtask.id} on files: ${lockPaths.join(', ')}. Mark subtask as failed.${colors.reset}`);
            
            await logTelemetry({
              id: toolCallId,
              tool: toolCall.function.name,
              arguments: parsedArgs,
              status: 'failed',
              error: `Lock timeout: failed to acquire ${lockType} lock.`
            });

            return {
              success: false,
              output: `Lock timeout: failed to acquire ${lockType} lock on ${lockPaths.join(', ')}.`,
              tokensUsed,
              toolCallCount
            };
          }

          // Decrement budget on actual execution
          globalBudgetDecrement();

          try {
            event = await executeTool(
              toolCall.function.name,
              parsedArgs,
              context.cwd,
              this.verbose,
              { policy: context.policy, allowWithoutPrompt: context.yes, client: this.client, model: context.model }
            );

            await logTelemetry({
              id: toolCallId,
              tool: toolCall.function.name,
              arguments: parsedArgs,
              status: 'completed',
              newContent: event.result
            });
          } catch (err: any) {
            await logTelemetry({
              id: toolCallId,
              tool: toolCall.function.name,
              arguments: parsedArgs,
              status: 'failed',
              error: err.message || String(err)
            });
            throw err;
          } finally {
            if (lockPaths.length > 0) {
              for (const p of lockPaths) {
                workspaceLockManager.releaseLock(p, subtask.id);
              }
            }
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: event.result
        });

        toolCallCount++;
      }
    }

    return {
      success: false,
      output: `Reached subtask tool call limit (${maxLocalToolCalls}).`,
      tokensUsed,
      toolCallCount
    };
  }

  private async askPermission(
    name: string,
    args: Record<string, string>,
    rl?: readline.Interface,
    context?: AgentContext
  ): Promise<boolean> {
    if (this.allowAll) return true;
    const action = name === 'run_command'
      ? 'command'
      : name === 'read_file' || name === 'search_code' || name === 'list_dir'
        ? 'read'
        : name === 'delete_file'
          ? 'delete'
          : 'write';
    
    const check = checkPermission(name, args as Record<string, unknown>, context?.cwd ?? process.cwd(), context?.policy ?? 'shell-confirm');
    if (check.decision === 'deny') return false;
    if (context?.yes) return true;
    if (check.decision === 'allow') return true;
    if (action === 'read') return true;

    if (!rl) return false; // If needs confirmation but no interactive RL, deny.

    return new Promise((resolve) => {
      rl.question(`[Worker] Allow executing tool "${name}" with args ${JSON.stringify(args)}? (y/n/all) `, (answer) => {
        const cleanAnswer = answer.toLowerCase().trim();
        if (cleanAnswer === 'all' || cleanAnswer === 'a') {
          this.allowAll = true;
          resolve(true);
        } else {
          resolve(cleanAnswer.startsWith('y') || cleanAnswer === '');
        }
      });
    });
  }
}
