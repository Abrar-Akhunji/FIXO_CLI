/**
 * CLI-specific type definitions extending the shared types.
 */
import type { ChatContentBlock, ChatMessage, ChatToolDefinition } from './shared/types.js';
import type { PolicyProfile } from './runtime/policy.js';

/** Runtime context for a single agent invocation. */
export interface AgentContext {
  /** The user's task or prompt. */
  task: string;
  /** Target LLM model ID (or "auto" for smart routing). */
  model: string;
  /** Working directory for file operations. */
  cwd: string;
  /** Whether to print verbose API debug logs. */
  verbose: boolean;
  /** Pinned/selected files for context focus. */
  selectedFiles: string[];
  /** Project-level system prompt override (from .freellmapi.yml). */
  systemPromptOverride?: string;
  /** Custom build/test verification command. */
  checkCommand?: string;
  /** Permission policy for this invocation. */
  policy?: PolicyProfile;
  /** Allow low-risk actions without repeated prompts. */
  yes?: boolean;
  /** Execution mode: PLAN (read-only), BUILD (mutating allowed), EXPLORE (read+lsp), or SCOUT (web only) */
  mode?: 'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT';
  /**
   * Image (or future non-text) blocks attached to the next user
   * message. Populated by the REPL's `/image` slash command. The
   * SingleAgent merges these into the user-message content array
   * along with `task`, so vision-capable providers can see them.
   * Cleared after each agent run by the caller.
   */
  pendingAttachments?: ChatContentBlock[];
}

/** Result of a single agent run. */
export interface AgentResult {
  /** Whether the task was completed successfully. */
  success: boolean;
  /** Text response to display to the user. */
  response: string;
  /** List of files that were modified during this run. */
  modifiedFiles: string[];
  /** Total token usage for this run. */
  tokensUsed: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Number of tool calls made during this run. */
  toolCallCount: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Model name from which model we got the output. */
  model?: string;
}

/** Project-level configuration from .freellmapi.yml */
export interface ProjectConfig {
  model?: string;
  checkCommand?: string;
  autoCommit?: boolean;
  systemPrompt?: string;
  include?: string[];
  exclude?: string[];
  policy?: PolicyProfile;
  executionMode?: 'host' | 'container';
  maxAttempts?: number;
  plugins?: string[];
  trustedPlugins?: string[];
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  persona: 'code' | 'test' | 'doc' | 'reviewer';
  dependencies: string[]; // ids of subtasks that must complete first
  files: string[]; // files relevant to this task
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
}

export interface TaskDAG {
  subtasks: Subtask[];
}

