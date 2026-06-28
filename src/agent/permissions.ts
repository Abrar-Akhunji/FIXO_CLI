/**
 * permissions.ts — Pattern-based permission rules.
 *
 * Phase 3.5 spec:
 *   - Each rule is a glob-style pattern over
 *     `Tool(arg-glob)`. Examples:
 *       Bash(npm test:star) — any run_command with the
 *         "npm test..." shell text.
 *       Edit(src/dstar/star.ts) — any tool whose args.path
 *         matches the glob.
 *   - First-match-wins: rules are evaluated top-to-bottom;
 *     the first match returns the decision.
 *   - Decision values: allow (auto), ask (default — prompt
 *     the user), deny (block).
 *   - Fallback: when no rule matches, call
 *     decidePolicy(profile, action, detail, allowRules)
 *     from runtime/policy.ts.
 *   - Storage: <cwd>/.fixo/permissions.json.
 *   - Default rules: every tool introduced in Phases 1–3
 *     defaults to ask if no rule is configured.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type PolicyDecision,
  type PolicyProfile,
  decidePolicy,
} from "../runtime/policy.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** Glob pattern in the form `Tool(pattern)`. */
  pattern: string;
  decision: PermissionDecision;
  /** Optional human-readable reason (shown when denying). */
  reason?: string;
}

export interface PermissionsFile {
  version: 1;
  rules: PermissionRule[];
}

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
  matchedRule: string | null;
  source: "rule" | "default-ask" | "fallback-policy";
}

const PERMISSIONS_PATH_FOR = (cwd: string) =>
  path.join(cwd, ".fixo", "permissions.json");

/**
 * Tools introduced in Phases 1–3. When the user runs one of
 * these with no matching rule, we force `ask` (rather than
 * letting `decidePolicy` quietly return `allow`).
 */
export const NEW_TOOL_DEFAULT_ASK: ReadonlySet<string> = new Set([
  "str_replace",
  "glob_files",
  "todo_write",
  "run_command_async",
  "poll_command_status",
  "kill_command",
]);

/** Read `.fixo/permissions.json` from cwd. */
export function loadPermissionsFile(cwd: string): PermissionsFile | null {
  const p = PERMISSIONS_PATH_FOR(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as PermissionsFile;
    if (raw.version !== 1 || !Array.isArray(raw.rules)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Save the permissions file. */
export function savePermissionsFile(
  cwd: string,
  file: PermissionsFile,
): { ok: boolean; error?: string } {
  const p = PERMISSIONS_PATH_FOR(cwd);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(file, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Get the permissions file path (test-only introspection). */
export function getPermissionsPath(cwd: string): string {
  return PERMISSIONS_PATH_FOR(cwd);
}

/**
 * Convert a glob pattern to a RegExp anchored at both ends.
 * - `*` matches any chars except `/`
 * - `**` matches any chars including `/`
 * - `?` matches any single char except `/`
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // dstar: matches zero or more path segments. If a
        // slash follows, the slash is optional (so the
        // pattern matches a/b/c as well as a).
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+()[]{}|^$\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

/** Parse `Tool(pattern)` into `{tool, argPattern}`. */
export function parseRulePattern(pattern: string): {
  tool: string;
  argPattern: string | null;
} {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.+)\))?$/.exec(pattern);
  if (!m) return { tool: pattern, argPattern: null };
  return { tool: m[1], argPattern: m[2] ?? null };
}

/**
 * Build the input string that the rule's argPattern matches
 * against. We pick a sensible string projection of args
 * for the tool at hand. For most tools, that's the joined
 * string of all arg values. This is intentionally simple —
 * it lets users write rules like Edit(src/dstar/star.ts)
 * and have them work.
 */
export function buildArgString(
  _tool: string,
  args: Record<string, unknown>,
): string {
  // For path-shaped tools, prefer the `path` / `filePath` /
  // `cmd` field so globs land where users expect.
  const pathField =
    typeof args.path === "string"
      ? args.path
      : typeof args.filePath === "string"
        ? args.filePath
        : typeof args.cmd === "string"
          ? args.cmd
          : typeof args.command === "string"
            ? args.command
            : null;
  if (pathField !== null) return pathField;
  return Object.values(args)
    .filter(
      (v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    )
    .map((v) => String(v))
    .join(" ");
}

/** Match a tool call against the rule list (first match wins). */
export function matchPermission(
  tool: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): PermissionRule | null {
  for (const rule of rules) {
    const { tool: ruleTool, argPattern } = parseRulePattern(rule.pattern);
    if (ruleTool !== tool) continue;
    if (argPattern === null) return rule;
    const argString = buildArgString(tool, args);
    try {
      const re = globToRegExp(argPattern);
      if (re.test(argString)) return rule;
    } catch {
      // Malformed glob — skip the rule rather than crashing.
      continue;
    }
  }
  return null;
}

/**
 * Top-level check: try a rule match, then fall back to
 * `decidePolicy` for the legacy policy logic, then apply
 * the default-ask rule for new tools. Returns a unified
 * `PermissionCheckResult`.
 */
export function checkPermission(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  profile: PolicyProfile,
): PermissionCheckResult {
  const file = loadPermissionsFile(cwd);
  const rules = file?.rules ?? [];
  // 1. First-match-wins rule check.
  const match = matchPermission(tool, args, rules);
  if (match) {
    return {
      decision: match.decision,
      reason: match.reason ?? `${tool} matched rule ${match.pattern}`,
      matchedRule: match.pattern,
      source: "rule",
    };
  }
  // 2. Default-ask for tools introduced in Phases 1–3.
  if (NEW_TOOL_DEFAULT_ASK.has(tool)) {
    return {
      decision: "ask",
      reason: `${tool} is a new tool with no rule — default-ask applies`,
      matchedRule: null,
      source: "default-ask",
    };
  }
  // 3. Fallback to legacy decidePolicy.
  const action: "read" | "write" | "delete" | "command" =
    tool === "run_command" || tool === "run_command_async"
      ? "command"
      : MUTATION_TOOLS.has(tool)
        ? "write"
        : "read";
  const detail = buildArgString(tool, args);
  const policyDecision: PolicyDecision = decidePolicy(profile, action, detail);
  return {
    decision: policyDecision.allowed
      ? policyDecision.needsConfirmation
        ? "ask"
        : "allow"
      : "deny",
    reason: policyDecision.reason,
    matchedRule: null,
    source: "fallback-policy",
  };
}

const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "apply_patch",
  "replace_range",
  "insert_after",
  "rename_file",
  "delete_file",
  "create_branch",
  "commit_changes",
  "push_branch",
  "create_pull_request",
  "str_replace",
  "todo_write",
]);
