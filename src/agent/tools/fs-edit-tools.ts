import fs from "node:fs";
import path from "node:path";
import { WorkspaceGuard } from "../../workspace-guard.js";
import { AtomicStagingManager } from "../../runtime/staging.js";
import { cascadingReplace } from "../replacer.js";
import { getHunkTracker } from "../../git/hunk-tracker.js";
import { getOrCreateLspGate } from "./lsp-tools.js";
import type { ToolExecutionOptions } from "./types.js";
import { getOrCreateRunId } from "./fs-support.js";

/* ──────────────────── str_replace contract & error ──────────────────── */

export interface StrReplaceArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  expectUnique?: boolean;
}

export class SurgicalReplaceError extends Error {
  public readonly code:
    | "old_string_not_found"
    | "old_string_ambiguous"
    | "plan_mode_rejected"
    | "platform_path_locked"
    | "workspace_escape"
    | "binary_file"
    | "invalid_args";
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SurgicalReplaceError["code"],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SurgicalReplaceError";
    this.code = code;
    this.details = details;
  }
}

export async function executeStrReplace(
  args: StrReplaceArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const guard = new WorkspaceGuard(cwd, options?.allowedOutsidePaths);

  if (typeof args.path !== "string" || args.path.length === 0) {
    return `Error: str_replace: "path" is required.`;
  }
  if (typeof args.oldString !== "string") {
    return `Error: str_replace: "oldString" is required.`;
  }
  if (typeof args.newString !== "string") {
    return `Error: str_replace: "newString" is required.`;
  }

  if (options.mode === "PLAN") {
    const err = new SurgicalReplaceError(
      `str_replace is not allowed in PLAN mode (read-only). Switch to BUILD mode and retry.`,
      "plan_mode_rejected",
      { mode: options.mode },
    );
    return `Error: ${err.message}`;
  }

  let resolved: string;
  try {
    resolved = guard.resolve(args.path, "str_replace target", true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: str_replace: ${msg}`;
  }

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

  const content = fs.readFileSync(resolved, "utf-8");
  const replaceAll = args.replaceAll === true;
  const expectUnique = !replaceAll && args.expectUnique !== false;

  const replaceResult = cascadingReplace(content, args.oldString, args.newString, {
    replaceAll,
    expectUnique,
  });

  if (!replaceResult.success || !replaceResult.newContent) {
    return `Error: str_replace: ${replaceResult.error ?? "oldString not found in " + args.path}`;
  }

  const newContent = replaceResult.newContent;
  const occurrences = replaceResult.occurrences ?? 1;

  // Pillar 3 — LSP pre-save compilation gate. The gate's
  // `enforce` throws on `block`-mode failures; we surface the
  // diagnostics to the LLM as a structured error.
  if (options.safety?.lspPreSave && options.safety.lspPreSave !== "off") {
    try {
      const gate = getOrCreateLspGate(cwd, options.safety);
      const synthetic = {
        id: "surgical-" + Date.now().toString(36),
        targetPath: resolved,
        pendingPath: "<surgical>",
        metaPath: "<surgical>",
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
      reason: "str_replace",
      actorId: options.session?.id ?? "tool-executor",
    });

    try {
      const { recordTelemetry, telemetry } = await import("../telemetry.js");
      recordTelemetry(
        telemetry.surgicalEdit({
          path: args.path,
          occurrences: replaceAll ? occurrences : 1,
          mode: options.safety?.lspPreSave ?? "off",
          bytes: result.bytes,
        }),
      );
    } catch {
      // Telemetry must never break a tool call.
    }

    options.session?.noteChange(resolved);
    getHunkTracker(cwd).recordHunk({
      cwd,
      filePath: resolved,
      beforeContent: content,
      afterContent: newContent,
      description: `Updated (surgical) ${args.path}`,
    });
    return JSON.stringify({
      ok: true,
      path: args.path,
      occurrences: replaceAll ? occurrences : 1,
      mode: options.safety?.lspPreSave ?? "off",
      bytes: result.bytes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: str_replace: ${msg}`;
  }
}

/* ──────────────────── glob_files contract & error ──────────────────── */

export interface GlobArgs {
  pattern: string;
  cwd?: string;
  ignore?: string;
  maxResults?: number;
  includeHidden?: boolean;
  followSymlinks?: boolean;
}

export class GlobFilesError extends Error {
  public readonly code:
    "invalid_pattern" | "workspace_escape" | "traversal_failed";
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: GlobFilesError["code"],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GlobFilesError";
    this.code = code;
    this.details = details;
  }
}

const GLOB_DEFAULT_MAX_RESULTS = 1000;
const GLOB_HARD_MAX_RESULTS = 5000;
const GLOB_DEFAULT_SKIP_DIRS: ReadonlyArray<string> = [
  "node_modules",
  ".git",
  "dist",
  ".fixo",
  ".fixocli",
];

function splitIgnoreSpec(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function executeGlobFiles(
  args: GlobArgs,
  cwd: string,
  _options: ToolExecutionOptions = {},
): Promise<string> {
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    return `Error: glob_files: "pattern" is required.`;
  }

  const guard = new WorkspaceGuard(cwd, _options?.allowedOutsidePaths);
  let scope: string;
  try {
    scope = args.cwd ? guard.resolve(args.cwd, "glob scope", false) : cwd;
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

  try {
    const { recordTelemetry, telemetry } = await import("../telemetry.js");
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
    return JSON.stringify({
      pattern: args.pattern,
      matches: [],
      total: 0,
      truncated: false,
    });
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

async function collectGlobMatches(opts: CollectOptions): Promise<string[]> {
  const {
    pattern,
    scope,
    skipDirs,
    includeHidden,
    followSymlinks,
    maxResults,
  } = opts;
  const results: string[] = [];

  const fsPromises = fs.promises as typeof fs.promises & {
    glob?: (
      pattern: string,
      options?: { cwd?: string; exclude?: string[]; withFileTypes?: boolean },
    ) => Promise<unknown>;
  };

  if (typeof fsPromises.glob === "function") {
    const exclude = Array.from(skipDirs).map((d) => `**/${d}/**`);
    const out = (await fsPromises.glob(pattern, {
      cwd: scope,
      exclude,
      withFileTypes: false,
    })) as unknown;
    if (Array.isArray(out)) {
      for (const entry of out) {
        if (typeof entry !== "string") continue;
        const absolute = path.resolve(scope, entry);
        if (results.length >= maxResults) break;
        try {
          if (!includeHidden && path.basename(absolute).startsWith("."))
            continue;
        } catch {
          continue;
        }
        results.push(absolute);
      }
      return results;
    }
  }

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
      if (!includeHidden && entry.name.startsWith(".")) continue;
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
        if (!includeHidden && entry.name.startsWith(".")) continue;
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

function compileGlob(pattern: string): (relPath: string) => boolean {
  const normalised = pattern.replace(/\\/g, "/");
  const re = globToRegExp(normalised);
  return (rel: string) => re.test(rel.replace(/\\/g, "/"));
}

function globToRegExp(pattern: string): RegExp {
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        body += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      body += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      body += "\\" + ch;
      i += 1;
    } else {
      body += ch;
      i += 1;
    }
  }
  return new RegExp("^" + body + "$");
}

