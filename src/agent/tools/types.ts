import type readline from "node:readline";
import type { TaskSession } from "../../runtime/task-session.js";
import type { PolicyProfile, RiskLevel } from "../../runtime/policy.js";
import { classifyCommand } from "../../runtime/policy.js";
import type { PermissionCheckResult } from "../permissions.js";
import { checkPermission } from "../permissions.js";
import type { SafetyConfig } from "../../config.js";
import type { AgentClient } from "../agent-client.js";
import type { AgentContext } from "../../types.js";

export interface ToolCallEvent {
  tool: string;
  args: Record<string, string>;
  result: string;
  /** False when the tool failed, timed out, or was cancelled. */
  ok: boolean;
  isWrite: boolean;
  affectedPath?: string;
}

export interface ToolExecutionOptions {
  session?: TaskSession;
  policy?: PolicyProfile;
  allowWithoutPrompt?: boolean;
  client?: AgentClient;
  model?: string;
  safety?: SafetyConfig;
  mode?: "PLAN" | "BUILD" | "EXPLORE" | "SCOUT";
  allowedOutsidePaths?: Set<string>;
  getConversationTokens?: () => number;
  signal?: AbortSignal;
  rl?: readline.Interface;
  subagentDepth?: number;
  permissionRules?: AgentContext["permissionRules"];
  context?: AgentContext;
  onModeChange?: (newMode: "PLAN" | "BUILD" | "EXPLORE" | "SCOUT") => void;
}

export interface ToolDispatchResult {
  result: string;
  isWrite?: boolean;
  affectedPath?: string;
}

export interface ToolExecutionContext {
  readonly cwd: string;
  readonly verbose: boolean;
  readonly options: ToolExecutionOptions;
  spinner?: (tool: { kind: string; name: string; detail?: string }) => void;
}

export interface ToolSpecification<
  TArgs extends Record<string, any> = Record<string, any>,
  TResult = string,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, any>;
    readonly required: string[];
  };
  execute(
    args: TArgs,
    context: ToolExecutionContext,
  ): Promise<TResult | ToolDispatchResult>;
}

export type GateAction = "read" | "write" | "delete" | "command";

export function riskOf(action: GateAction, detail: string): RiskLevel {
  if (action === "command") return classifyCommand(detail);
  if (action === "delete") return "high";
  if (action === "write") return "medium";
  return "low";
}

export interface GateOutcome {
  allowed: boolean;
  needsConfirmation: boolean;
  reason: string;
  risk: RiskLevel;
  source: PermissionCheckResult["source"];
  matchedRule: string | null;
}

export function evaluateToolGate(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  policy: PolicyProfile,
  action: GateAction,
  detail: string,
): GateOutcome {
  const check = checkPermission(toolName, args, cwd, policy);
  const risk = riskOf(action, detail);
  if (check.decision === "deny") {
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
    needsConfirmation: check.decision === "ask",
    reason: check.reason,
    risk,
    source: check.source,
    matchedRule: check.matchedRule,
  };
}
