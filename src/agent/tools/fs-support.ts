import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WorkspaceGuard } from "../../workspace-guard.js";
import type { TaskSession } from "../../runtime/task-session.js";
import type { SafetyConfig } from "../../config.js";
import { AtomicStagingManager } from "../../runtime/staging.js";
import {
  syntaxHealthCheck,
  formatSyntaxVerdict,
} from "../../lsp/syntax-fallback.js";
import { getHunkTracker } from "../../git/hunk-tracker.js";
import { getOrCreateLspGate } from "./lsp-tools.js";

/* ──────────────────────── Run ID ──────────────────────── */

let cachedRunId: string | null = null;

export function getOrCreateRunId(): string {
  if (cachedRunId) return cachedRunId;
  cachedRunId =
    randomBytes(6).toString("hex") + Date.now().toString(36).slice(-6);
  return cachedRunId;
}

export function resetRunId(): void {
  cachedRunId = null;
}

/* ──────────────────────── Sensitive File Blocklist ──────────────────────── */

export function isSensitiveCredentialPath(resolved: string): boolean {
  const baseName = path.basename(resolved).toLowerCase();
  const lowerPath = resolved.replace(/\\/g, "/").toLowerCase();
  if (lowerPath.includes("/.ssh/")) return true;
  if (baseName === ".env" || baseName.startsWith(".env.")) return true;
  if (baseName === "id_rsa" || baseName.startsWith("id_rsa.")) return true;
  if (baseName === "credentials" || baseName === "credentials.json") return true;
  if (baseName === "providers.json") return true;
  if (baseName === "authorized_keys" || baseName === "authorized_keys2") {
    return true;
  }
  if (baseName.endsWith(".pem") || baseName.endsWith(".key")) return true;
  return false;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function applyAtomicWrite(
  cwd: string,
  filePath: string,
  content: string,
  safety: SafetyConfig | undefined,
  session: TaskSession | undefined,
): Promise<{ result: string; staged: boolean; created: boolean }> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", true);
  const existed = fs.existsSync(resolved);
  const beforeContent = existed ? fs.readFileSync(resolved, "utf-8") : "";

  if (!safety?.atomicStaging) {
    const parentDir = path.dirname(resolved);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
    session?.noteChange(resolved);
    getHunkTracker(cwd).recordHunk({
      cwd,
      filePath: resolved,
      beforeContent,
      afterContent: content,
      description: existed ? `Updated ${filePath}` : `Created ${filePath}`,
    });
    return {
      result: existed
        ? `File updated: ${filePath}`
        : `File created: ${filePath}`,
      staged: false,
      created: !existed,
    };
  }

  const mgr = new AtomicStagingManager(cwd, getOrCreateRunId(), {
    ttlMs: safety.stagingTtlMs,
    preCommitHook: async (e) => {
      const gate = getOrCreateLspGate(cwd, safety);
      const result = await gate.check(e);
      gate.enforce(result, e);
    },
    syntaxHealthCheck: async (e, content) => {
      const lower = e.targetPath.toLowerCase();
      const isJs =
        lower.endsWith(".js") ||
        lower.endsWith(".cjs") ||
        lower.endsWith(".mjs");
      const isTs = lower.endsWith(".ts") || lower.endsWith(".tsx");
      if (!isJs && !isTs) return;
      const verdict = syntaxHealthCheck(content);
      if (verdict.state === "ok") return;
      const e2 = new Error(
        `Structural syntax check failed for ${path.basename(e.targetPath)}: ` +
          `${formatSyntaxVerdict(verdict)} ` +
          `The staged write was rejected to protect the target file.`,
      );
      (e2 as Error & { code?: string }).code = "FIXO_STRUCTURAL_SYNTAX";
      throw e2;
    },
  });
  const entry = mgr.stage(filePath, content, 0o644);
  const commit = await mgr.commit(entry.id);
  if (commit.committed) {
    session?.noteChange(resolved);
    getHunkTracker(cwd).recordHunk({
      cwd,
      filePath: resolved,
      beforeContent,
      afterContent: content,
      description: existed ? `Updated (atomic) ${filePath}` : `Created (atomic) ${filePath}`,
    });
  }
  return {
    result: existed
      ? `File updated (atomic): ${filePath}`
      : `File created (atomic): ${filePath}`,
    staged: commit.committed,
    created: !existed,
  };
}

/* ──────────────────────── Tool Implementations ──────────────────────── */

export function countLines(filePath: string): number {
  let count = 0;
  let lastCharWasNewline = true;
  const stream = fs.openSync(filePath, "r");
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

export function buildContextBudgetGuardDirective(
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
