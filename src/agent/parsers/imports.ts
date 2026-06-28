/**
 * imports.ts — Per-language import extraction using pure regex.
 *
 * Returns a structured `ImportInfo` for each `import` (JS/TS),
 * `import` / `from ... import` (Python), and `import` block (Go)
 * statement found. The output is capped at `MAX_IMPORTS_PER_FILE`
 * matches.
 */

import type { ImportInfo, LanguageId } from "../parser-adapter.js";

const MAX_IMPORTS_PER_FILE = 100;

const JS_TS_PATTERNS: RegExp[] = [
  // import x from 'y'  /  import {a,b as c} from 'y'  /  import * as X from 'y'
  /\bimport\s+(?:type\s+)?(?:[^'"`]+?\s+from\s+)?['"`]([^'"`]+)['"`]/g,
  // export ... from 'y'
  /\bexport\s+(?:[^'"`]+?\s+from\s+)?['"`]([^'"`]+)['"`]/g,
  // const x = require('y')  (best-effort)
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
];

const PYTHON_PATTERNS: RegExp[] = [
  // from x import a, b
  /^[ \t]*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm,
  // import x, y as z
  /^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm,
];

const GO_PATTERNS: RegExp[] = [
  // import "x"  (single-line)
  /^[ \t]*import\s+(?:[a-zA-Z_][\w]*\s+)?["']([^"']+)["']/gm,
  // inside a parenthesised block: "x"
  /^[ \t]*["']([^"']+)["']/gm,
];

const RUST_PATTERNS: RegExp[] = [
  // use foo::bar::{baz, qux};
  /\buse\s+([\w:]+)(?:\s*::\s*\{([^}]+)\})?\s*;/g,
];

const PATTERNS: Record<LanguageId, RegExp[]> = {
  typescript: JS_TS_PATTERNS,
  javascript: JS_TS_PATTERNS,
  python: PYTHON_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  bash: [],
  json: [],
  markdown: [],
  generic: [],
};

export function extractImports(
  source: string,
  language: LanguageId,
): ImportInfo[] {
  const patterns = PATTERNS[language] ?? [];
  if (patterns.length === 0) return [];

  const out: ImportInfo[] = [];
  const seen = new Set<string>();

  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (out.length >= MAX_IMPORTS_PER_FILE) return out;
      const source_ = match[1];
      if (!source_ || seen.has(source_)) continue;
      seen.add(source_);
      const line = indexToLine(source, match.index);
      const isTypeOnly = /\bimport\s+type\b/.test(match[0]);
      const symbols = extractImportedSymbols(match[0], language);
      out.push({ source: source_, symbols, line, isTypeOnly });
    }
  }
  return out;
}

function indexToLine(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractImportedSymbols(raw: string, language: LanguageId): string[] {
  if (language === "python") {
    // match[2] is the symbol list in a `from x import a, b` statement.
    return [];
  }
  if (language === "go" || language === "rust") {
    return [];
  }
  // JS/TS: try to pull out `{ a, b as c }`.
  const named = /\{([^}]+)\}\s*from\s*['"`]/.exec(raw);
  if (!named || !named[1]) return [];
  return named[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0])
    .filter((s) => s.length > 0);
}
