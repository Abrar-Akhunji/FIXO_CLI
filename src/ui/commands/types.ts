import * as readline from "readline";
import { type FreeLLMConfig } from "../../config.js";
import { type ProjectConfig } from "../../types.js";
import { type ConversationManager } from "../../agent/conversation.js";
import { type SingleAgent } from "../../agent/single-agent.js";
import { type GitManager } from "../../git/git-manager.js";
import { type WorkspaceGuard } from "../../workspace-guard.js";
import { type SessionStats } from "../prompt.js";
import { type ChatContentBlock } from "../../shared/types.js";

export interface CommandState {
  currentModel: string;
  currentMode: string;
  currentSessionId: string;
  currentSessionLabel: string | undefined;
  sessionModifiedFiles: string[];
  pendingAttachments: ChatContentBlock[];
  selectedFiles: string[];
  stats: SessionStats;
  isTaskRunning: boolean;
  currentRunningAgent: SingleAgent | null;
}

export interface CommandContext {
  state: CommandState;
  args: string[];
  config: FreeLLMConfig;
  projectConfig?: ProjectConfig;
  cwd: string;
  verbose: boolean;
  conversation: ConversationManager;
  agent: SingleAgent;
  git: GitManager;
  guard: WorkspaceGuard;
  rl: readline.Interface;

  handleInput: (input: string) => Promise<void>;
  clearSuggestions: () => void;
  refreshModelsForProvider: (name: string) => Promise<void>;

  printStats?: (stats: SessionStats) => void;
  listRuns?: (cwd: string) => void;
  showRun?: (cwd: string, id: string) => void;
  buildIndex?: (cwd: string) => void;
  workspaceFiles?: string[];
  findInIndex?: (cwd: string, q: string) => void;
  explainIndexedTarget?: (cwd: string, q: string) => void;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;
