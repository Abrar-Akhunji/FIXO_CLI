import crypto from "crypto";
import fs from "fs";
import path from "path";
import { WorkspaceGuard } from "./workspace-guard.js";
import {
  ParserFactory,
  languageIdFromExtension,
  type SymbolInfo,
  type ImportInfo,
} from "./agent/parser-adapter.js";

export interface IndexedFile {
  path: string;
  hash: string;
  symbols: string[];
  imports: string[];
  resolvedImports?: string[];
  dependents?: string[];
  importance?: number;
}

export interface RepoIndex {
  updatedAt: string;
  files: IndexedFile[];
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

function resolveInternalImport(
  cwd: string,
  sourceFile: string,
  importStr: string,
): string | null {
  if (!importStr.startsWith(".")) return null; // Only resolve relative imports

  const sourceDir = path.dirname(path.join(cwd, sourceFile));
  const resolvedBase = path.resolve(sourceDir, importStr);

  // Possible extensions to check
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".d.ts", ".json"];
  for (const ext of extensions) {
    const fullPath = resolvedBase + ext;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return path.relative(cwd, fullPath);
    }
  }

  // If the import string ends with an extension like .js, .jsx, .mjs, .cjs
  // map it to typescript extensions (.ts, .tsx, .d.ts)
  const extname = path.extname(importStr);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extname)) {
    const baseWithoutExt = path.resolve(
      sourceDir,
      importStr.slice(0, -extname.length),
    );
    const tsExtensions = [".ts", ".tsx", ".d.ts"];
    for (const tsExt of tsExtensions) {
      const fullPath = baseWithoutExt + tsExt;
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return path.relative(cwd, fullPath);
      }
    }
  }

  // Check if it's a directory with an index file
  for (const ext of extensions) {
    const indexPath = path.join(resolvedBase, "index" + ext);
    if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
      return path.relative(cwd, indexPath);
    }
  }

  return null;
}

function calculatePageRank(files: IndexedFile[]): Record<string, number> {
  const ranks: Record<string, number> = {};
  const inEdges: Record<string, string[]> = {};
  const outDegree: Record<string, number> = {};

  for (const f of files) {
    ranks[f.path] = 1.0;
    inEdges[f.path] = [];
    outDegree[f.path] = 0;
  }

  for (const f of files) {
    for (const imp of f.resolvedImports || []) {
      if (inEdges[imp]) {
        inEdges[imp].push(f.path);
      }
      outDegree[f.path]++;
    }
  }

  // Run 10 iterations of PageRank
  const damping = 0.85;
  const numFiles = files.length;
  if (numFiles === 0) return ranks;

  for (let iter = 0; iter < 10; iter++) {
    const nextRanks: Record<string, number> = {};
    for (const f of files) {
      let rankSum = 0;
      for (const parent of inEdges[f.path] || []) {
        rankSum += ranks[parent] / (outDegree[parent] || 1);
      }
      nextRanks[f.path] = (1 - damping) / numFiles + damping * rankSum;
    }
    for (const f of files) {
      ranks[f.path] = nextRanks[f.path];
    }
  }

  return ranks;
}

/**
 * Process-local deduplication map. Concurrent `buildIndex` / `loadIndex`
 * requests for the same `cwd` share a single in-flight promise so we
 * never index the same repo twice in parallel.
 */
const inFlightBuilds = new Map<string, Promise<RepoIndex>>();

/**
 * Builds a fresh `RepoIndex` for the workspace at `cwd` and persists it
 * to `.fixo/index/repo-index.json`. Routes symbol and import extraction
 * through the `ParserFactory` so the same call site transparently uses
 * tree-sitter when the WASM is available and the regex fallback when
 * it is not.
 */
export function buildIndex(cwd: string): Promise<RepoIndex> {
  const cached = inFlightBuilds.get(cwd);
  if (cached) return cached;

  const promise = (async (): Promise<RepoIndex> => {
    const files: IndexedFile[] = [];
    const list = listFiles(cwd);

    // Initialise the parser factory once and reuse the resulting adapter
    // for every file in this build.
    const parser = await ParserFactory.getParser();

    // First pass: extract symbols and raw imports via the active adapter.
    for (const file of list) {
      const ext = path.extname(file);
      if (!CODE_EXTENSIONS.has(ext)) continue;
      const absolute = path.join(cwd, file);
      const content = fs.readFileSync(absolute, "utf-8");
      const language = languageIdFromExtension(ext);
      const symbols: SymbolInfo[] = parser.extractSymbols(content, language);
      const imports: ImportInfo[] = parser.extractImports(content, language);
      files.push({
        path: file,
        hash: crypto.createHash("sha256").update(content).digest("hex"),
        symbols: symbols.map((s) => s.name),
        imports: imports.map((i) => i.source),
        resolvedImports: [],
        dependents: [],
        importance: 0,
      });
    }

    // Second pass: resolve internal imports & build dependents
    const fileMap = new Map<string, IndexedFile>();
    for (const f of files) {
      fileMap.set(f.path, f);
    }

    for (const f of files) {
      const resolvedSet = new Set<string>();
      for (const imp of f.imports) {
        const resolved = resolveInternalImport(cwd, f.path, imp);
        if (resolved && fileMap.has(resolved)) {
          resolvedSet.add(resolved);
        }
      }
      f.resolvedImports = Array.from(resolvedSet);
    }

    // Populate dependents lists
    for (const f of files) {
      for (const imp of f.resolvedImports || []) {
        const target = fileMap.get(imp);
        if (target) {
          target.dependents = target.dependents || [];
          if (!target.dependents.includes(f.path)) {
            target.dependents.push(f.path);
          }
        }
      }
    }

    // Third pass: calculate PageRank scores
    const pageRanks = calculatePageRank(files);
    for (const f of files) {
      f.importance = pageRanks[f.path] || 0;
    }

    const index = { updatedAt: new Date().toISOString(), files };
    const dir = path.join(cwd, ".fixo", "index");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "repo-index.json"),
      JSON.stringify(index, null, 2) + "\n",
      "utf-8",
    );
    return index;
  })();

  inFlightBuilds.set(cwd, promise);
  // Once the promise settles, clear the entry so a future rebuild is
  // allowed to re-run (cache files may have been invalidated).
  const cleanup = (): void => {
    inFlightBuilds.delete(cwd);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

/**
 * Loads the cached `RepoIndex` for `cwd`. If no cache exists, builds one
 * first (sharing the in-flight promise with any concurrent caller).
 */
export function loadIndex(cwd: string): Promise<RepoIndex> {
  const file = path.join(cwd, ".fixo", "index", "repo-index.json");
  if (!fs.existsSync(file)) {
    return buildIndex(cwd);
  }
  // Cache hit — read it from disk. Concurrent calls for the same cwd
  // would otherwise stampede the disk; we still dedupe them in the
  // in-flight map so they all see the same JSON.parse result.
  const cached = inFlightBuilds.get(cwd);
  if (cached) return cached;
  const promise = Promise.resolve().then(
    () => JSON.parse(fs.readFileSync(file, "utf-8")) as RepoIndex,
  );
  inFlightBuilds.set(cwd, promise);
  const cleanup = (): void => {
    inFlightBuilds.delete(cwd);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

export async function findInIndex(cwd: string, query: string): Promise<string> {
  const q = query.toLowerCase();
  const index = await loadIndex(cwd);
  const matches = index.files
    .map((file) => {
      const score =
        (file.path.toLowerCase().includes(q) ? 5 : 0) +
        file.symbols.filter((s) => s.toLowerCase().includes(q)).length * 3 +
        file.imports.filter((s) => s.toLowerCase().includes(q)).length;
      return { file, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  if (matches.length === 0) return `No indexed matches for "${query}".`;
  return matches
    .map(
      ({ file, score }) =>
        `${file.path} score=${score} symbols=${file.symbols.slice(0, 6).join(", ")}`,
    )
    .join("\n");
}

export async function explainIndexedTarget(
  cwd: string,
  query: string,
): Promise<string> {
  const q = query.toLowerCase();
  const index = await loadIndex(cwd);
  const file = index.files.find(
    (f) =>
      f.path.toLowerCase() === q ||
      f.path.toLowerCase().includes(q) ||
      f.symbols.some((s) => s.toLowerCase() === q),
  );
  if (!file) return `No indexed file or symbol found for "${query}".`;
  return [
    `Path: ${file.path}`,
    `Hash: ${file.hash.slice(0, 12)}`,
    `Symbols: ${file.symbols.join(", ") || "(none)"}`,
    `Imports: ${file.imports.join(", ") || "(none)"}`,
  ].join("\n");
}

export async function findCodebaseDependencies(
  cwd: string,
  targetPath: string,
): Promise<string> {
  const index = await loadIndex(cwd);
  const guard = new WorkspaceGuard(cwd);
  let relPath: string;
  try {
    relPath = guard.relative(guard.resolve(targetPath));
  } catch {
    const match = index.files.find((f) =>
      f.path.toLowerCase().includes(targetPath.toLowerCase()),
    );
    if (!match) return `No indexed file found for "${targetPath}".`;
    relPath = match.path;
  }

  const file = index.files.find((f) => f.path === relPath);
  if (!file) return `File "${relPath}" is not indexed.`;

  const imports = file.resolvedImports || [];
  const dependents = file.dependents || [];
  const importance =
    file.importance !== undefined ? (file.importance * 100).toFixed(2) : "N/A";

  const output = [
    `File: ${file.path}`,
    `Codebase Importance Score: ${importance}%`,
    `\nDirect Dependencies (Imports ${imports.length} files):`,
    ...imports.map((i) => `  → ${i}`),
    imports.length === 0 ? "  (none)" : "",
    `\nDirect Dependents (Imported by ${dependents.length} files):`,
    ...dependents.map((d) => `  ← ${d}`),
    dependents.length === 0 ? "  (none)" : "",
  ];

  return output.filter(Boolean).join("\n");
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === ".fixo"
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.statSync(full).size <= 300_000)
        result.push(path.relative(root, full));
    }
  };
  walk(root);
  return result;
}
