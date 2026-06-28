export type PolicyProfile =
  | "read-only"
  | "workspace-write"
  | "shell-confirm"
  | "trusted-project"
  | "dangerous-deny";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export interface PolicyDecision {
  allowed: boolean;
  needsConfirmation: boolean;
  risk: RiskLevel;
  reason: string;
}

export interface AllowRuleStore {
  commands: string[];
}

const SAFE_COMMANDS = [
  /^npm\s+(run\s+)?(test|build|lint|typecheck|check)(\s|$)/,
  /^npm\s+run\s+build:cli(\s|$)/,
  /^git\s+(status|diff|log|show)(\s|$)/,
  /^node\s+--version$/,
];

export const DANGEROUS_COMMANDS = [
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bchmod\s+-R\b/,
  /\bchown\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bcurl\b.*\|\s*(sh|bash)/,
  /\bwget\b.*\|\s*(sh|bash)/,
  /(^|\s)env(\s|$)/,
  /(^|\s)printenv(\s|$)/,
  /\b(?:cat|less|more|tail|head)\s+.*(\.env|id_rsa|credentials|passwd|shadow)/,
  /[;&|`$<>]/,
];

export function classifyCommand(command: string): RiskLevel {
  const trimmed = command.trim();
  if (!trimmed) return "blocked";
  if (DANGEROUS_COMMANDS.some((pattern) => pattern.test(trimmed)))
    return "high";
  if (SAFE_COMMANDS.some((pattern) => pattern.test(trimmed))) return "low";
  if (/^(npm|pnpm|yarn)\s+(install|add|remove|update)\b/.test(trimmed))
    return "high";
  if (
    /^git\s+(add|commit|reset|checkout|clean|push|pull|merge|rebase)\b/.test(
      trimmed,
    )
  )
    return "high";
  return "medium";
}

export function decidePolicy(
  profile: PolicyProfile,
  action: "read" | "write" | "delete" | "command",
  detail = "",
  allowRules: AllowRuleStore = { commands: [] },
): PolicyDecision {
  if (profile === "dangerous-deny") {
    return {
      allowed: false,
      needsConfirmation: false,
      risk: "blocked",
      reason: "Dangerous actions are denied by policy.",
    };
  }
  if (profile === "read-only" && action !== "read") {
    return {
      allowed: false,
      needsConfirmation: false,
      risk: "blocked",
      reason: "Read-only policy blocks mutations and commands.",
    };
  }
  if (action === "command") {
    const risk = classifyCommand(detail);
    if (allowRules.commands.includes(detail.trim()) && risk === "low") {
      return {
        allowed: true,
        needsConfirmation: false,
        risk,
        reason: "Command allowed by project policy.",
      };
    }
    if (risk === "high" && profile !== "trusted-project") {
      return {
        allowed: true,
        needsConfirmation: true,
        risk,
        reason: "High-risk command requires explicit confirmation.",
      };
    }
    if (risk === "low" && profile === "trusted-project") {
      return {
        allowed: true,
        needsConfirmation: false,
        risk,
        reason: "Safe command allowed by trusted project policy.",
      };
    }
    return {
      allowed: true,
      needsConfirmation: true,
      risk,
      reason: "Shell command requires confirmation.",
    };
  }
  if (action === "write" || action === "delete") {
    return {
      allowed: true,
      needsConfirmation: profile !== "trusted-project",
      risk: "medium",
      reason: "Workspace mutation requires confirmation unless trusted.",
    };
  }
  return {
    allowed: true,
    needsConfirmation: false,
    risk: "low",
    reason: "Read action allowed.",
  };
}
