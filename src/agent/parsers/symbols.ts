/**
 * symbols.ts — Per-language symbol extraction using pure regex.
 *
 * Output is intentionally limited to the first `MAX_SYMBOLS_PER_FILE`
 * matches so we never blow up the LLM's context window on a single
 * oversized file. Coordinates are 1-based, line-inclusive, end-inclusive
 * to match the LSP convention.
 */

import type { LanguageId, SymbolInfo } from "../parser-adapter.js";

const MAX_SYMBOLS_PER_FILE = 100;

interface SymbolPattern {
  re: RegExp;
  kind: SymbolInfo["kind"];
}

const JS_TS_PATTERNS: SymbolPattern[] = [
  // export class Foo / class Foo
  {
    re: /^[ \t]*(?:export\s+(?:default\s+)?|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    kind: "class",
  },
  // export interface Foo
  {
    re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
    kind: "interface",
  },
  // export type Foo
  { re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gm, kind: "type" },
  // export enum Foo
  { re: /^[ \t]*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm, kind: "enum" },
  // function foo(...)
  {
    re: /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    kind: "function",
  },
  // const/let/var foo = ...
  {
    re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    kind: "const",
  },
];

const PYTHON_PATTERNS: SymbolPattern[] = [
  { re: /^[ \t]*class\s+([A-Za-z_][\w]*)/gm, kind: "class" },
  { re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm, kind: "function" },
];

const GO_PATTERNS: SymbolPattern[] = [
  { re: /^[ \t]*type\s+([A-Za-z_][\w]*)\s+struct/gm, kind: "type" },
  { re: /^[ \t]*type\s+([A-Za-z_][\w]*)\s+interface/gm, kind: "interface" },
  { re: /^[ \t]*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/gm, kind: "function" },
  { re: /^[ \t]*(?:var|const)\s+([A-Za-z_][\w]*)/gm, kind: "const" },
];

const RUST_PATTERNS: SymbolPattern[] = [
  {
    re: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm,
    kind: "function",
  },
  { re: /^[ \t]*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/gm, kind: "type" },
  { re: /^[ \t]*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/gm, kind: "enum" },
  { re: /^[ \t]*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/gm, kind: "interface" },
];

const GENERIC_PATTERNS: SymbolPattern[] = [
  {
    re: /\b(?:export\s+)?(?:class|function|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g,
    kind: "unknown",
  },
];

const PATTERNS: Record<LanguageId, SymbolPattern[]> = {
  typescript: JS_TS_PATTERNS,
  javascript: JS_TS_PATTERNS,
  python: PYTHON_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  bash: [],
  json: [],
  markdown: [],
  generic: GENERIC_PATTERNS,
};

/**
 * Extracts symbol declarations from `source`. The result is capped at
 * `MAX_SYMBOLS_PER_FILE` entries and deduped by name; the first
 * occurrence wins so an `export class Foo` is preferred over a later
 * `class Foo` reference.
 */
export function extractSymbols(
  source: string,
  language: LanguageId,
): SymbolInfo[] {
  const patterns = PATTERNS[language] ?? GENERIC_PATTERNS;
  if (patterns.length === 0) return [];

  const out: SymbolInfo[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");
  const totalLines = lines.length;

  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (out.length >= MAX_SYMBOLS_PER_FILE) return out;
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const startIndex = match.index;
      const line = indexToLine(source, startIndex);
      const exported = /^\s*export\b/m.test(match[0]);
      out.push({
        name,
        kind,
        line,
        endLine: Math.min(totalLines, line + 5),
        exported,
      });
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
