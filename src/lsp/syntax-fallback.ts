/**
 * syntax-fallback.ts — Pure-JS brace/paren/bracket balance check
 * used as a fallback when no real language server is on the PATH.
 *
 * Why this exists
 * ---------------
 * The LspPreSaveGate calls into `LspManager` to ask the local
 * language server for diagnostics. On a freshly-installed system
 * there is no `tsserver` / `gopls` / `rust-analyzer` on the PATH —
 * the user has a working FixO CLI but no editor infrastructure.
 * In that case the pre-save gate would silently fall through and
 * commit syntactically broken edits.
 *
 * This module provides a *very* cheap structural sanity check
 * (brace/paren/bracket/quote balance) that runs in microseconds
 * and catches the most common form of "LLM forgot a closing
 * brace" corruption. It is intentionally not a real parser — it
 * is a smoke detector, not a smoke alarm. If the syntax check
 * reports `ok`, the real LSP may still surface semantic errors;
 * if it reports `unbalanced`, the file is almost certainly
 * broken and we should refuse the write.
 *
 * The check is env-gated behind `FIXO_LSP_FALLBACK=syntax-only`
 * so a developer who *does* have a language server is never
 * bothered by it.
 */

import fs from "node:fs";
import path from "node:path";

export type SyntaxHealthVerdict =
  | { readonly state: "ok" }
  | {
      readonly state: "unbalanced";
      /** The first unclosed delimiter, in document order. */
      readonly opener: "{" | "(" | "[";
      /** 1-based line where the imbalance was detected. */
      readonly line: number;
    }
  | {
      readonly state: "unterminated-string";
      /** 1-based line where the runaway string starts. */
      readonly line: number;
    }
  | {
      readonly state: "unterminated-comment";
      /** 1-based line where the block comment starts. */
      readonly line: number;
    };

/**
 * Run the structural sanity check on a source string. Pure,
 * sync, and allocation-light. The output is stable so tests can
 * pin the verdict exactly.
 */
export function syntaxHealthCheck(source: string): SyntaxHealthVerdict {
  const stack: Array<{ ch: "{" | "(" | "["; line: number }> = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockCommentStartLine = 1;
  let singleStartLine = 0;
  let doubleStartLine = 0;
  let templateStartLine = 0;
  let prevCh = "";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const code = source.charCodeAt(i);
    const nextCh = i + 1 < source.length ? source[i + 1]! : "";
    const line = lineNumberAt(lineStarts, i);

    if (inLineComment) {
      if (code === 10) inLineComment = false;
      prevCh = ch;
      continue;
    }
    if (inBlockComment) {
      if (prevCh === "*" && ch === "/") {
        inBlockComment = false;
      }
      prevCh = ch;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") {
        // Skip the next char. (No need to handle surrogate pairs
        // separately — `\\u{1F600}` etc. still consume 2 source
        // chars; the skip-i+1 below handles it.)
        i++;
        prevCh = "";
        continue;
      }
      if (ch === "'" && prevCh !== "\\") {
        inSingle = false;
      } else if (code === 10) {
        return { state: "unterminated-string", line: singleStartLine };
      }
      prevCh = ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i++;
        prevCh = "";
        continue;
      }
      if (ch === '"' && prevCh !== "\\") {
        inDouble = false;
      } else if (code === 10) {
        return { state: "unterminated-string", line: doubleStartLine };
      }
      prevCh = ch;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        i++;
        prevCh = "";
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
      } else if (code === 10) {
        return { state: "unterminated-string", line: templateStartLine };
      }
      prevCh = ch;
      continue;
    }

    // Not in any string/comment — check for new states.
    if (ch === "/" && nextCh === "/") {
      inLineComment = true;
      prevCh = ch;
      i++;
      continue;
    }
    if (ch === "/" && nextCh === "*") {
      inBlockComment = true;
      blockCommentStartLine = line;
      prevCh = ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      singleStartLine = line;
      prevCh = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      doubleStartLine = line;
      prevCh = ch;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      templateStartLine = line;
      prevCh = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ ch: ch as "{" | "(" | "[", line });
    } else if (ch === "}" || ch === ")" || ch === "]") {
      const expected = ch === "}" ? "{" : ch === ")" ? "(" : "[";
      const top = stack.pop();
      if (!top || top.ch !== expected) {
        // The first missing closer tells us the first unclosed
        // opener, which is what we report. If the stack is empty
        // we still report a synthetic 'unbalanced' so the caller
        // sees a verdict.
        if (top) {
          return { state: "unbalanced", opener: top.ch, line: top.line };
        }
        return { state: "unbalanced", opener: expected, line };
      }
    }
    prevCh = ch;
  }

  if (inBlockComment) {
    return { state: "unterminated-comment", line: blockCommentStartLine };
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    return { state: "unbalanced", opener: top.ch, line: top.line };
  }
  return { state: "ok" };
}

function lineNumberAt(
  lineStarts: ReadonlyArray<number>,
  index: number,
): number {
  // Binary search would be O(log n) but a linear scan is fine for
  // files up to ~10_000 lines, and the inlined version lets V8
  // keep both arrays hot in the same cache line.
  let line = 1;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i]! > index) break;
    line = i + 1;
  }
  return line;
}

/**
 * Format a {@link SyntaxHealthVerdict} as a single-line summary
 * suitable for the LLM's `tool_result`.
 */
export function formatSyntaxVerdict(verdict: SyntaxHealthVerdict): string {
  switch (verdict.state) {
    case "ok":
      return "Syntax health check: OK (balanced).";
    case "unbalanced":
      return `Syntax health check: unbalanced — '${verdict.opener}' opened on line ${verdict.line} has no matching closer.`;
    case "unterminated-string":
      return `Syntax health check: unterminated string starting on line ${verdict.line}.`;
    case "unterminated-comment":
      return `Syntax health check: unterminated block comment starting on line ${verdict.line}.`;
  }
}

// ---------------------------------------------------------------------------
// Boot-time LSP sanity check
// ---------------------------------------------------------------------------

export interface LspSanityResult {
  /** True when at least one common language server is on the PATH,
   *  or when the syntax-fallback mode is explicitly enabled. */
  ok: boolean;
  /** Human-readable reason. Empty when `ok`. */
  reason: string;
  /** The language servers we looked for. */
  checked: string[];
  /** The ones we actually found on the PATH. */
  found: string[];
  /** Whether `FIXO_LSP_FALLBACK=syntax-only` is set. */
  syntaxOnly: boolean;
}

const COMMON_LANGUAGE_SERVERS = [
  "typescript-language-server",
  "tsserver",
  "vscode-langservers-extracted",
  "gopls",
  "rust-analyzer",
  "pyright",
  "pylsp",
  "clangd",
  "jdtls",
  "solargraph",
] as const;

/**
 * Synchronous PATH check for common language servers. Returns a
 * {@link LspSanityResult} the boot code can use to decide whether
 * to warn the user. Pure — no side effects, no I/O beyond
 * `which`-style PATH scanning.
 *
 * The check is intentionally permissive: a missing language server
 * is a `reason` to warn, not a hard failure. The user can always
 * install one later. The hard fail mode is when neither a
 * language server nor `FIXO_LSP_FALLBACK=syntax-only` is present
 * AND the user has configured `lspPreSave: 'block'` — in that
 * case the pre-save gate would block all writes, which is a much
 * worse experience than a boot-time warning.
 */
export function checkLspSanity(
  env: NodeJS.ProcessEnv = process.env,
): LspSanityResult {
  const syntaxOnly = env.FIXO_LSP_FALLBACK === "syntax-only";
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // `execFileSync('which', ...)` would spawn a child process —
  // expensive and unnecessary. PATH scan is enough: a binary on
  // the PATH is in one of these directories.
  const pathDirs = pathEntries;
  const found: string[] = [];
  for (const server of COMMON_LANGUAGE_SERVERS) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      try {
        if (fs.existsSync(path.join(dir, server))) {
          found.push(server);
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  if (found.length > 0) {
    return {
      ok: true,
      reason: "",
      checked: [...COMMON_LANGUAGE_SERVERS],
      found,
      syntaxOnly,
    };
  }
  if (syntaxOnly) {
    return {
      ok: true,
      reason:
        "FIXO_LSP_FALLBACK=syntax-only; brace-balance check will run instead of a real LSP.",
      checked: [...COMMON_LANGUAGE_SERVERS],
      found: [],
      syntaxOnly: true,
    };
  }
  return {
    ok: false,
    reason:
      "No common language server found on PATH. Pre-save diagnostics will be skipped. " +
      "Install typescript-language-server / gopls / rust-analyzer or set FIXO_LSP_FALLBACK=syntax-only.",
    checked: [...COMMON_LANGUAGE_SERVERS],
    found: [],
    syntaxOnly: false,
  };
}
