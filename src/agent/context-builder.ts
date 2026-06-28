/**
 * context-builder.ts — Phase 3.2 automatic LSP-driven context.
 *
 * Before: `lsp_find_references` was a model-callable tool. The agent
 * had to *think* to call it before editing a function — meaning that
 * unless the prompt explicitly asked for "find all callers", the
 * model would happily rename `foo()` in one file and leave the three
 * other call sites broken.
 *
 * After: when the agent is about to edit a known set of files
 * (user-pinned via /select, or planner-identified as mutation
 * targets), this module proactively asks the LSP for the references
 * of each top-level symbol and prepends a compact "Cross-file
 * references" block to the first system prompt. The model now sees
 * the call sites without having to think to ask.
 *
 * Graceful degradation:
 *  - No LSP server on $PATH (typescript-language-server / pyright /
 *    gopls / rust-analyzer) → returns empty string, scan continues.
 *  - Target file doesn't exist → skip, no error.
 *  - Parser adapter unavailable → skip the symbol pre-extraction
 *    step; the function caller falls back to silent no-op.
 *  - LSP call times out or errors → skip that target, continue.
 *
 * In all failure modes the caller can prepend the returned string
 * unconditionally; an empty string is a clean no-op for the system
 * prompt.
 */
import fs from "node:fs";
import path from "node:path";

import {
  ParserFactory,
  languageIdFromExtension,
  type LanguageId,
  type SymbolInfo,
  type ParserAdapter,
} from "./parser-adapter.js";
import type { LspManager } from "../lsp/lsp-manager.js";

/** A file the run intends to mutate; symbols may be left implicit. */
export interface ReferenceTarget {
  /** Absolute path to the file to inspect. */
  file: string;
  /**
   * Optional explicit list of symbol names to look up. When omitted,
   * the helper extracts top-level exported symbols from the file
   * (capped at {@link MAX_SYMBOLS_PER_FILE}) and uses those.
   */
  symbols?: string[];
}

/** Default caps tuned to keep the context block compact. */
const MAX_SYMBOLS_PER_FILE = 4;
const MAX_REFS_PER_SYMBOL = 6;
const MAX_TARGETS = 8;
const MAX_LSP_WAIT_MS = 1500;

/**
 * Returns framework-specific guidance to inject into the system prompt.
 * Currently detects Vite and provides Vite 8 / Rolldown manualChunks rules.
 */
export function getFrameworkGuidance(cwd: string): string {
  const hasVite =
    fs.existsSync(path.join(cwd, "vite.config.ts")) ||
    fs.existsSync(path.join(cwd, "vite.config.js")) ||
    fs.existsSync(path.join(cwd, "vite.config.mjs")) ||
    fs.existsSync(path.join(cwd, "vite.config.cjs"));

  if (!hasVite) return "";

  return [
    "## Vite 8 / Rolldown Guidance",
    "This project uses Vite. Note that Vite 8 relies on Rolldown as the underlying bundler.",
    "When configuring `manualChunks`, follow Rolldown's chunking conventions.",
    "Keep chunking logic simple and avoid aggressive over-splitting to prevent circular dependencies or chunking errors.",
  ].join("\n");
}

/**
 * Build a markdown block describing cross-file references for the
 * given targets. Returns an empty string when no targets, no LSP
 * support, or no references were found — making this safe to splice
 * unconditionally into a system prompt.
 *
 * `getLspManager` is taken as a callable rather than imported
 * directly so this module stays out of the tool-executor's import
 * cycle and is testable with a stub.
 */
export async function gatherReferencesForTargets(
  cwd: string,
  targets: ReferenceTarget[],
  getLspManager: () => LspManager | null,
): Promise<string> {
  if (targets.length === 0) return "";
  const limited = targets.slice(0, MAX_TARGETS);

  const lsp = getLspManager();
  if (!lsp) return "";

  // Load the parser adapter once. Used for symbol-line lookup when
  // the caller didn't pre-specify symbols.
  let adapter: ParserAdapter | null = null;
  try {
    adapter = await ParserFactory.getParser();
  } catch {
    // safe: parser unavailable → we can still proceed if the caller
    // pre-specified explicit symbols, otherwise we'll produce nothing.
    adapter = null;
  }

  const blocks: string[] = [];

  for (const target of limited) {
    if (!fs.existsSync(target.file)) continue;

    const ext = path.extname(target.file);
    const language = languageIdFromExtension(ext);
    if (language === "generic") continue;

    let symbolsForTarget: Array<{ name: string; line: number }> = [];
    if (target.symbols && target.symbols.length > 0) {
      symbolsForTarget = target.symbols
        .slice(0, MAX_SYMBOLS_PER_FILE)
        .map((name) => ({
          name,
          line: locateSymbolLine(target.file, name) ?? 1,
        }));
    } else if (adapter) {
      try {
        if (adapter.name === "tree-sitter") {
          // The parser may not have pre-loaded this language yet.
          // We load it best-effort; failure just means the regex
          // extractor runs instead.
          const ts = adapter as ParserAdapter & {
            loadLanguage?: (lang: LanguageId) => Promise<boolean>;
          };
          if (ts.loadLanguage) await ts.loadLanguage(language);
        }
        const source = fs.readFileSync(target.file, "utf-8");
        const symbols = adapter.extractSymbols(source, language);
        symbolsForTarget = pickTopSymbols(symbols).map((s) => ({
          name: s.name,
          line: s.line,
        }));
      } catch {
        // safe: this target gets no symbols → skipped below
        continue;
      }
    } else {
      continue;
    }

    if (symbolsForTarget.length === 0) continue;

    const fileRel = path.relative(cwd, target.file) || target.file;
    const symbolLines: string[] = [];
    for (const sym of symbolsForTarget) {
      const refs = await callWithTimeout(
        lsp.findReferences(target.file, sym.line - 1, 0),
        MAX_LSP_WAIT_MS,
      );
      const formatted = formatReferences(cwd, target.file, refs);
      if (formatted.length === 0) continue;
      symbolLines.push(
        `- \`${sym.name}\` (${fileRel}:${sym.line}) → ${formatted.slice(0, MAX_REFS_PER_SYMBOL).join(", ")}`,
      );
    }

    if (symbolLines.length > 0) {
      blocks.push(`### ${fileRel}\n${symbolLines.join("\n")}`);
    }
  }

  if (blocks.length === 0) return "";
  return [
    "## Cross-file references (LSP-derived, auto-collected)",
    "These are symbols defined in files this run is likely to mutate, with their other call sites. Update all sites when renaming or changing a signature.",
    "",
    ...blocks,
  ].join("\n");
}

/* ──────────────────────── Helpers ──────────────────────── */

/** Pick the most likely "important" symbols: exported first, then by source order. */
function pickTopSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const exported = symbols.filter((s) => s.exported);
  const pool = exported.length > 0 ? exported : symbols;
  return pool.slice(0, MAX_SYMBOLS_PER_FILE);
}

/** Find the 1-based line where `symbolName` is declared. Returns null on miss. */
function locateSymbolLine(filePath: string, symbolName: string): number | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    // Look for a word boundary match preceded by a likely declaration
    // keyword. This is a heuristic — the LSP only needs a line/column
    // anywhere inside the identifier to resolve references.
    const re = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
  } catch {
    // safe: file unreadable → no line, caller skips
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number } };
}

function formatReferences(
  cwd: string,
  originFile: string,
  refs: unknown,
): string[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs as LspLocation[]) {
    if (!ref?.uri || !ref.range?.start) continue;
    let abs = ref.uri;
    if (abs.startsWith("file://")) abs = decodeURIComponent(abs.slice(7));
    // Skip the origin file itself — those references are local and
    // already obvious to the model from the file it's about to edit.
    if (path.resolve(abs) === path.resolve(originFile)) continue;
    const rel = path.relative(cwd, abs) || abs;
    const key = `${rel}:${ref.range.start.line + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function callWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
