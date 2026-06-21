/**
 * repo-map.ts — Compact workspace snapshot for LLM context injection.
 *
 * Instead of sending the full codebase content to the LLM (~8000 tokens),
 * this produces a compact directory tree + export signatures (~500
 * tokens). The model can then selectively read specific files via the
 * read_file tool.
 *
 * Phase 3.1 — export extraction is now driven by the shared
 * {@link ParserFactory} adapter. When the vendored tree-sitter WASM
 * grammars are available (the npm package ships them; CI gates the
 * publish on their presence), real AST extraction is used per
 * language. When a grammar is missing or the parser fails to load
 * for any reason, the call gracefully falls back to the pre-existing
 * regex extractor in src/agent/parsers/symbols.ts — so output is
 * never worse than before.
 *
 * Adds Rust as a first-class language for the first time (the old
 * regex-only path did not extract Rust symbols at all).
 */
import fs from 'fs';
import path from 'path';
import { ParserFactory, languageIdFromExtension, type ParserAdapter, type LanguageId } from './parser-adapter.js';

/* ──────────────────────── Config ──────────────────────── */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', 'coverage', '.turbo',
  '.vercel', '.output', '.cache', '.parcel-cache', 'vendor',
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lockb', '.env', '.env.local',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.kt', '.swift', '.rb', '.php', '.c', '.cpp',
  '.h', '.cs', '.vue', '.svelte',
]);

const MAX_DEPTH = 4;
const MAX_FILES = 200;

/** Tree-sitter languages we pre-warm before scanning. Anything not in
 *  this list falls back to the regex extractor — that's the existing
 *  behaviour for Java/Kotlin/Swift/Ruby/etc. */
const PREWARM_LANGUAGES: LanguageId[] = ['typescript', 'javascript', 'python', 'go', 'rust'];

/* ──────────────────────── Types ──────────────────────── */

interface TreeEntry {
  name: string;
  isDir: boolean;
  children?: TreeEntry[];
  sizeBytes?: number;
  exports?: string[];
}

/* ──────────────────────── Main ──────────────────────── */

/**
 * Build a compact repo map string suitable for LLM context injection.
 * Returns ~200-500 tokens of structured information about the workspace.
 *
 * Async because the parser adapter loads language grammars lazily on
 * first use. The cost is paid once per process; subsequent calls hit
 * the {@link ParserFactory} cache and resolve immediately.
 */
export async function buildRepoMap(cwd: string, additionalExcludes?: string[]): Promise<string> {
  const excludes = new Set([...IGNORE_DIRS, ...(additionalExcludes ?? [])]);

  // Pre-warm the parser + language grammars we plan to use. Failures
  // here are non-fatal: scanDirectory below falls back to the regex
  // extractor on any extractSymbols failure.
  let adapter: ParserAdapter | null = null;
  try {
    adapter = await ParserFactory.getParser();
    if (adapter.name === 'tree-sitter') {
      const ts = adapter as ParserAdapter & {
        loadLanguage?: (lang: LanguageId) => Promise<boolean>;
      };
      if (ts.loadLanguage) {
        await Promise.all(PREWARM_LANGUAGES.map((l) => ts.loadLanguage!(l)));
      }
    }
  } catch {
    // safe: any parser-init failure leaves `adapter` null; the regex
    // path inside extractExports handles that case.
    adapter = null;
  }

  const tree = scanDirectory(cwd, excludes, 0, adapter);
  if (!tree) return '(empty workspace)';

  const lines: string[] = ['## Workspace Structure'];
  renderTree(tree, '', lines, true);

  // Count stats
  let fileCount = 0;
  let dirCount = 0;
  countEntries(tree, { files: 0, dirs: 0 }, (stats) => {
    fileCount = stats.files;
    dirCount = stats.dirs;
  });

  lines.push('');
  lines.push(`_${fileCount} files, ${dirCount} directories_`);

  return lines.join('\n');
}

/* ──────────────────────── Tree Scanner ──────────────────────── */

function scanDirectory(
  dirPath: string,
  excludes: Set<string>,
  depth: number,
  adapter: ParserAdapter | null,
): TreeEntry | null {
  if (depth > MAX_DEPTH) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const children: TreeEntry[] = [];
  let filesSeen = 0;

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    // Hardcoded global structural blacklist to prevent token explosion
    const blacklist = ['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'package-lock.json', 'yarn.lock'];
    if (blacklist.includes(entry.name)) continue;

    if (excludes.has(entry.name)) continue;
    if (IGNORE_FILES.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.isFile()) continue;

    if (entry.isDirectory()) {
      const subtree = scanDirectory(
        path.join(dirPath, entry.name),
        excludes,
        depth + 1,
        adapter,
      );
      if (subtree) {
        children.push(subtree);
      }
    } else if (entry.isFile()) {
      if (filesSeen >= MAX_FILES) continue;
      filesSeen++;

      const ext = path.extname(entry.name);
      const filePath = path.join(dirPath, entry.name);
      let sizeBytes: number | undefined;

      try {
        const stat = fs.statSync(filePath);
        sizeBytes = stat.size;
      } catch {
        // safe: stat failures (permissions, race) just leave size undefined
      }

      const treeEntry: TreeEntry = {
        name: entry.name,
        isDir: false,
        sizeBytes,
      };

      if (CODE_EXTENSIONS.has(ext) && sizeBytes && sizeBytes < 100_000) {
        const exports = extractExports(filePath, ext, adapter);
        if (exports.length > 0) {
          treeEntry.exports = exports;
        }
      }

      children.push(treeEntry);
    }
  }

  if (children.length === 0) return null;

  return {
    name: path.basename(dirPath),
    isDir: true,
    children,
  };
}

/* ──────────────────────── Export Extraction ──────────────────────── */

/**
 * Extract top-level exported symbol names from a single file.
 *
 * Tries the shared parser adapter first (real tree-sitter AST walk
 * when the language grammar is loaded; otherwise the curated regex
 * patterns in parsers/symbols.ts). On any failure — file read, parse,
 * adapter error — returns an empty list rather than crashing the
 * scan.
 */
function extractExports(filePath: string, ext: string, adapter: ParserAdapter | null): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const language = languageIdFromExtension(ext);

  // Adapter path — used whenever the parser factory has produced a
  // working adapter. The adapter itself decides whether to use
  // tree-sitter (if the grammar loaded) or the regex extractor.
  if (adapter) {
    try {
      const symbols = adapter.extractSymbols(content, language);
      const names = symbols
        .filter((s) => s.exported)
        .map((s) => s.name);
      // Dedupe while preserving order — repo-map only renders the
      // first ~8 anyway, but stable ordering keeps cached output
      // diffs minimal.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const n of names) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (out.length >= 15) break;
      }
      if (out.length > 0) return out;
    } catch {
      // safe: fall through to the inline regex below
    }
  }

  // Final safety net — the pre-Phase-3.1 inline regex. Kept verbatim
  // so the worst-case behaviour matches the v1.0.4 baseline exactly.
  return inlineRegexExports(content, ext);
}

function inlineRegexExports(content: string, ext: string): string[] {
  const exports: string[] = [];

  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const patterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+class\s+(\w+)/g,
      /export\s+(?:const|let|var)\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+type\s+(\w+)/g,
      /export\s+enum\s+(\w+)/g,
      /export\s+default\s+(?:class|function)\s+(\w+)/g,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }
  } else if (ext === '.py') {
    const patterns = [/^def\s+(\w+)/gm, /^class\s+(\w+)/gm];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }
  } else if (ext === '.go') {
    const pattern = /^func\s+([A-Z]\w*)/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      exports.push(match[1]);
    }
  }

  return [...new Set(exports)].slice(0, 15);
}

/* ──────────────────────── Tree Rendering ──────────────────────── */

function renderTree(entry: TreeEntry, prefix: string, lines: string[], isRoot: boolean): void {
  if (isRoot) {
    lines.push(`📁 ${entry.name}/`);
  }

  if (!entry.children) return;

  for (let i = 0; i < entry.children.length; i++) {
    const child = entry.children[i];
    const isLast = i === entry.children.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');

    if (child.isDir) {
      lines.push(`${prefix}${connector}📁 ${child.name}/`);
      renderTree(child, nextPrefix, lines, false);
    } else {
      let line = `${prefix}${connector}${child.name}`;

      if (child.exports && child.exports.length > 0) {
        const exportStr = child.exports.slice(0, 8).join(', ');
        const suffix = child.exports.length > 8 ? ', …' : '';
        line += `  → {${exportStr}${suffix}}`;
      }

      lines.push(line);
    }
  }
}

/* ──────────────────────── Helpers ──────────────────────── */

function countEntries(
  entry: TreeEntry,
  stats: { files: number; dirs: number },
  callback: (stats: { files: number; dirs: number }) => void,
  depth = 0
): void {
  if (depth > 20) return;
  if (entry.isDir) {
    stats.dirs++;
    if (entry.children) {
      for (const child of entry.children) {
        countEntries(child, stats, () => {}, depth + 1);
      }
    }
  } else {
    stats.files++;
  }
  if (depth === 0) {
    callback(stats);
  }
}
