import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WorkspaceGuard } from "../../workspace-guard.js";
import type { TaskSession } from "../../runtime/task-session.js";
import {
  ParserFactory,
  languageIdFromExtension,
  type ImportInfo,
  type SymbolInfo,
} from "../parser-adapter.js";
import { getRunInventory } from "../../runtime/run-inventory.js";
import {
  getOrCreateRunId,
  countLines,
  buildContextBudgetGuardDirective,
  formatSize,
  isSensitiveCredentialPath,
} from "./fs-support.js";

export function executeReadFile(
  filePath: string,
  cwd: string,
  session?: TaskSession,
  largeFileGateBytes: number = 15 * 1024,
  largeFileGateLines: number = 350,
): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", false);

  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }

  if (isSensitiveCredentialPath(resolved)) {
    return `Error: Access to sensitive file "${filePath}" is blocked for security reasons.`;
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${filePath}" is a directory, not a file. Use list_dir instead.`;
  }

  if (stat.size > 500_000) {
    return `Error: File is too large (${(stat.size / 1024).toFixed(0)} KB). Read a smaller file or search for specific content.`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }

  if (
    stat.size > largeFileGateBytes ||
    countLines(resolved) > largeFileGateLines
  ) {
    return buildContextBudgetGuardDirective(
      resolved,
      stat.size,
      largeFileGateBytes,
      largeFileGateLines,
    );
  }

  const content = fs.readFileSync(resolved, "utf-8");
  session?.noteRead(resolved);
  return content;
}

function resolveLanguageId(filePath: string) {
  return languageIdFromExtension(path.extname(filePath));
}

export async function executeExtractSymbols(
  filePath: string,
  cwd: string,
  session?: TaskSession,
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", true);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const language = resolveLanguageId(resolved);
  const parser = await ParserFactory.getParser();
  const symbols: SymbolInfo[] = parser.extractSymbols(content, language);
  session?.noteStructuralMap?.(resolved, { symbols: true, imports: false });
  if (symbols.length === 0) {
    return `No symbols detected in '${filePath}' (language=${language}).`;
  }
  const lines = symbols.map(
    (s) =>
      `- [${s.kind}${s.exported ? ", exported" : ""}] ${s.name} (line ${s.line})`,
  );
  return `Symbols in '${filePath}' (${symbols.length}):\n${lines.join("\n")}`;
}

export async function executeExtractImports(
  filePath: string,
  cwd: string,
  session?: TaskSession,
): Promise<string> {
  const guard = new WorkspaceGuard(cwd);
  const resolved = guard.resolve(filePath, "file", true);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${filePath}`;
  }
  if (guard.isBinaryFile(resolved)) {
    return `Error: File appears to be binary: ${filePath}`;
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const language = resolveLanguageId(resolved);
  const parser = await ParserFactory.getParser();
  const imports: ImportInfo[] = parser.extractImports(content, language);
  session?.noteStructuralMap?.(resolved, { symbols: false, imports: true });
  if (imports.length === 0) {
    return `No imports detected in '${filePath}' (language=${language}).`;
  }
  const lines = imports.map((i) => {
    const tag = i.isTypeOnly ? " [type-only]" : "";
    const syms = i.symbols.length > 0 ? ` {${i.symbols.join(", ")}}` : "";
    return `- '${i.source}'${tag}${syms} (line ${i.line})`;
  });
  return `Imports in '${filePath}' (${imports.length}):\n${lines.join("\n")}`;
}

export function executeSearchCode(
  query: string | undefined | null,
  searchPath: string | undefined,
  filePattern: string | undefined,
  cwd: string,
): string {
  try {
    if (!query || query?.length === 0) {
      return `No matches found for query '${query}'. Try different search terms or use the List tool to explore the directory structure instead.`;
    }
    const guard = new WorkspaceGuard(cwd);
    const targetDir = searchPath
      ? guard.resolve(searchPath, "search path", false)
      : cwd;

    let hasRg = false;
    try {
      const which = spawnSync("which", ["rg"], { encoding: "utf-8" });
      if (which?.status === 0 && which?.stdout && which?.stdout?.trim?.()) {
        hasRg = true;
      }
    } catch {
      /* fallback */
    }

    let output = "";
    if (hasRg) {
      const args = ["-n", "--no-heading", "--color", "never", query];
      if (filePattern) {
        args.push("-g", filePattern);
      }
      args.push(targetDir);

      const result = spawnSync("rg", args, {
        encoding: "utf-8",
        cwd,
        maxBuffer: 512 * 1024,
        timeout: 15000,
      });
      output = result?.stdout ?? "";
    } else {
      const args = ["-rn", query];
      if (filePattern) {
        args.push(`--include=${filePattern}`);
      }
      args.push(targetDir);

      const result = spawnSync("grep", args, {
        encoding: "utf-8",
        cwd,
        maxBuffer: 512 * 1024,
        timeout: 15000,
      });
      output = result?.stdout ?? "";
    }

    if (!output || !output?.trim?.() || output?.length === 0) {
      return `No matches found for query '${query}'. Try different search terms or use the List tool to explore the directory structure instead.`;
    }

    const lines = output
      ?.trim?.()
      ?.split?.("\n")
      ?.slice?.(0, 50)
      ?.map?.((line) => {
        if (cwd && line?.startsWith?.(cwd)) {
          return line?.slice?.((cwd?.length ?? 0) + 1);
        }
        return line;
      });

    if (!lines || lines?.length === 0) {
      return `No matches found for query '${query}'. Try different search terms or use the List tool to explore the directory structure instead.`;
    }

    return (
      lines?.join?.("\n") ??
      `No matches found for query '${query}'. Try different search terms or use the List tool to explore the directory structure instead.`
    );
  } catch (error: any) {
    return `search_code encountered an error: ${error?.message || String(error)}. Try a different query or use List/Read tools instead.`;
  }
}

export function executeListDir(dirPath: string | undefined, cwd: string): string {
  const guard = new WorkspaceGuard(cwd);
  const resolved = dirPath ? guard.resolve(dirPath, "directory", false) : cwd;

  if (!fs.existsSync(resolved)) {
    return `Error: Directory not found: ${dirPath ?? "."}`;
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

  const filtered = entries
    .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
    .filter((e) => e.name !== "node_modules")
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
      let size = "";
      try {
        const s = inv.fileStats(path.join(resolved, entry.name));
        size = formatSize(s.size);
      } catch {
        // Ignore
      }
      lines.push(`   ${entry.name}${size ? `  (${size})` : ""}`);
    }
  }

  return lines.join("\n") || "(empty directory)";
}
