/**
 * parser-adapter.ts — Unified code-parsing interface for the FixO CLI.
 *
 * Decouples every consumer (indexer, command-parser, repo-map, future
 * callers) from a single concrete parser. Two implementations exist:
 *
 *   - `TreeSitterAdapter` — uses the vendored WebAssembly tree-sitter
 *     engine. Supports shell command parsing via the bundled bash
 *     grammar, and a generic regex fallback for any other language.
 *     If `Parser.init()` throws (WASM architecture mismatch, missing
 *     file, etc.) the adapter catches the error, logs a console
 *     warning, and reports `supported = false`.
 *
 *   - `RegexParserAdapter` — a pure-JS, zero-dependency fallback that
 *     works on every platform. It uses curated per-language regexes
 *     for symbol and import extraction, and a tokeniser-style splitter
 *     for shell commands. Slightly less accurate than tree-sitter but
 *     always available.
 *
 * A double-checked async singleton (`ParserFactory`) ensures only one
 * adapter is ever instantiated per process and that concurrent callers
 * share the same in-flight `init()` promise.
 */

import * as ParserModule from 'web-tree-sitter';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractShellTokens, isCommandSafeShellFallback } from './parsers/shell.js';
import { extractSymbols as regexExtractSymbols } from './parsers/symbols.js';
import { extractImports as regexExtractImports } from './parsers/imports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

/**
 * Returns the first existing, non-empty path for a vendored WASM blob.
 *
 * Resolution order:
 *   1. `<package>/vendor/<file>` (the canonical location written to the
 *      tarball by `npm pack`).
 *   2. `<package>/../vendor/<file>` (handles the dev layout where this
 *      file lives in `src/agent/` rather than `dist/agent/`).
 *   3. For `tree-sitter.wasm` only: the copy shipped inside the
 *      `web-tree-sitter` dependency. This is the safety net that keeps
 *      symbol indexing working even if a future publish accidentally
 *      drops the vendor/ directory again (the regression that caused
 *      the v1.0.x ENOENT crashes).
 *
 * Returns `null` if nothing usable was found; callers fall back to the
 * regex adapter and log a single warning.
 */
function resolveVendorWasm(fileName: string): string | null {
  const candidates = [
    path.resolve(__dirname, '../../vendor', fileName),
    path.resolve(__dirname, '../vendor', fileName),
  ];

  if (fileName === 'tree-sitter.wasm') {
    try {
      const pkg = requireFromHere.resolve('web-tree-sitter/package.json');
      candidates.push(path.resolve(path.dirname(pkg), 'tree-sitter.wasm'));
    } catch {
      // web-tree-sitter not resolvable from this module — ignore.
    }
  }

  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).size > 0) return c;
    } catch {
      /* ignore stat errors and try the next candidate */
    }
  }
  return null;
}

// ──── Local typed shim for web-tree-sitter (no upstream @types) ────

interface TreeSitterParserAPI {
  init(opts?: { locateFile?: (scriptName: string) => string }): Promise<void>;
}

interface TreeSitterLanguageAPI {
  load(path: string): Promise<unknown>;
}

interface TreeSitterParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TreeSitterTree;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  child(index: number): TreeSitterNode;
  namedChild(index: number): TreeSitterNode;
  childForFieldName(name: string): TreeSitterNode | null;
}

const ParserCtor = (ParserModule as unknown as { Parser: TreeSitterParserAPI }).Parser;
const LanguageCtor = (ParserModule as unknown as { Language: TreeSitterLanguageAPI }).Language;

// ──── Public types ────────────────────────────────────────────────

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'bash'
  | 'json'
  | 'markdown'
  | 'generic';

export interface SymbolInfo {
  name: string;
  kind:
    | 'class'
    | 'function'
    | 'interface'
    | 'type'
    | 'const'
    | 'let'
    | 'var'
    | 'enum'
    | 'method'
    | 'variable'
    | 'field'
    | 'module'
    | 'unknown';
  line: number;
  endLine: number;
  exported: boolean;
}

export interface ImportInfo {
  source: string;
  symbols: string[];
  line: number;
  isTypeOnly: boolean;
}

export interface ParsedCommand {
  binary: string;
  arguments: string[];
  raw: string;
}

export interface ParserInitResult {
  ok: boolean;
  reason?: string;
}

export interface ParserAdapter {
  readonly name: 'tree-sitter' | 'regex';
  readonly supported: boolean;

  /** Performs any one-time async work (e.g. loading WASM grammars). */
  init(): Promise<ParserInitResult>;

  /**
   * Extracts symbol declarations from `source` for the given language.
   * Synchronous: callers may invoke this from inside a tight loop.
   */
  extractSymbols(source: string, language: LanguageId): SymbolInfo[];

  /**
   * Extracts import statements from `source` for the given language.
   * Synchronous: callers may invoke this from inside a tight loop.
   */
  extractImports(source: string, language: LanguageId): ImportInfo[];

  /**
   * Parses a shell command string into individual `binary`/`arguments`
   * tuples. Optional — adapters that do not understand shell may omit it.
   */
  parseShellCommand?(command: string): ParsedCommand[];

  /** Frees any held resources. */
  dispose(): void;
}

// ──── Helpers ─────────────────────────────────────────────────────

/** Maps a file extension (including the leading dot) to a `LanguageId`. */
export function languageIdFromExtension(ext: string): LanguageId {
  const lower = ext.toLowerCase();
  if (lower === '.ts' || lower === '.tsx' || lower === '.mts' || lower === '.cts') {
    return 'typescript';
  }
  if (lower === '.js' || lower === '.jsx' || lower === '.mjs' || lower === '.cjs') {
    return 'javascript';
  }
  if (lower === '.py' || lower === '.pyi') return 'python';
  if (lower === '.go') return 'go';
  if (lower === '.rs') return 'rust';
  if (lower === '.sh' || lower === '.bash') return 'bash';
  if (lower === '.json') return 'json';
  if (lower === '.md' || lower === '.markdown') return 'markdown';
  return 'generic';
}

// ──── TreeSitterAdapter ──────────────────────────────────────────

export class TreeSitterAdapter implements ParserAdapter {
  public readonly name = 'tree-sitter' as const;
  public supported = true;
  private parser: TreeSitterParser | null = null;
  private initialised = false;
  /** Lazily-loaded language grammars, keyed by LanguageId. The `bash`
   *  grammar is loaded eagerly in {@link init} because the shell-
   *  command parser path runs on virtually every tool call. The other
   *  languages are loaded on demand by {@link loadLanguage}. */
  private languages = new Map<LanguageId, unknown>();

  async init(): Promise<ParserInitResult> {
    if (this.initialised) {
      return { ok: this.supported };
    }
    this.initialised = true;

    try {
      const coreWasm = resolveVendorWasm('tree-sitter.wasm');
      if (!coreWasm) {
        throw new Error(
          'tree-sitter.wasm not found in vendor/ or web-tree-sitter package',
        );
      }
      const bashWasm = resolveVendorWasm('tree-sitter-bash.wasm');
      if (!bashWasm) {
        throw new Error('tree-sitter-bash.wasm not found in vendor/');
      }

      await ParserCtor.init({
        locateFile: (scriptName: string): string => {
          if (scriptName === 'tree-sitter.wasm') return coreWasm;
          return resolveVendorWasm(scriptName) ?? scriptName;
        },
      });
      const Bash = await LanguageCtor.load(bashWasm);
      this.parser = new (ParserCtor as unknown as { new (): TreeSitterParser })();
      this.parser.setLanguage(Bash);
      this.languages.set('bash', Bash);
      this.supported = true;
      return { ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);

      console.warn(
        `\u26A0  Tree-Sitter WASM unavailable (${reason}). Falling back to regex parser. ` +
          `Performance reduced; accuracy may vary.`,
      );
      this.parser = null;
      this.supported = false;
      return { ok: false, reason };
    }
  }

  /**
   * Lazily load a language grammar from the vendored WASM. Idempotent.
   * Returns `true` if the language is ready for tree-sitter-based
   * extraction; `false` if the WASM is missing or fails to load
   * (callers will fall back to the regex extractor).
   *
   * Pre-warm a language before calling {@link extractSymbols} in
   * hot paths \u2014 extractSymbols itself is synchronous (see why in
   * the {@link ParserAdapter} interface) and will silently fall
   * through to the regex path if the grammar isn't loaded yet.
   */
  async loadLanguage(lang: LanguageId): Promise<boolean> {
    if (!this.parser || !this.supported) return false;
    if (this.languages.has(lang)) return true;
    const wasmFile = wasmFileForLanguage(lang);
    if (!wasmFile) return false;
    const wasmPath = resolveVendorWasm(wasmFile);
    if (!wasmPath) return false;
    try {
      const grammar = await LanguageCtor.load(wasmPath);
      this.languages.set(lang, grammar);
      return true;
    } catch {
      // safe: a single missing/incompatible grammar must not break
      // unrelated languages or the shell path.
      return false;
    }
  }

  extractSymbols(source: string, language: LanguageId): SymbolInfo[] {
    const grammar = this.languages.get(language);
    if (!grammar || !this.parser) {
      return regexExtractSymbols(source, language);
    }
    try {
      this.parser.setLanguage(grammar);
      const tree = this.parser.parse(source);
      const out = extractSymbolsFromTree(tree.rootNode, language);
      // Restore the parser to its eagerly-loaded bash grammar so the
      // command-parser path stays correct after a symbol extraction.
      const bash = this.languages.get('bash');
      if (bash) this.parser.setLanguage(bash);
      // Empty result on a successful parse usually means the source
      // had no top-level declarations \u2014 but it's also the failure
      // mode of an unfamiliar dialect. Fall through to the regex
      // extractor in that case as a belt-and-braces safety net; if
      // the regex agrees there are none, we still return an empty
      // array.
      if (out.length === 0) return regexExtractSymbols(source, language);
      return out;
    } catch {
      // safe: any tree-sitter failure (mismatched dialect, corrupt
      // source, etc.) falls back to the regex extractor.
      return regexExtractSymbols(source, language);
    }
  }

  extractImports(source: string, language: LanguageId): ImportInfo[] {
    return regexExtractImports(source, language);
  }

  parseShellCommand(command: string): ParsedCommand[] {
    if (this.parser) {
      try {
        return this.parseShellWithTreeSitter(command);
      } catch {
        // Fall through to the regex splitter on any tree-sitter failure.
      }
    }
    return extractShellTokens(command);
  }

  private parseShellWithTreeSitter(command: string): ParsedCommand[] {
    if (!this.parser) return extractShellTokens(command);
    const tree = this.parser.parse(command);
    const commandNodes = findCommandNodes(tree.rootNode);
    const out: ParsedCommand[] = [];
    for (const node of commandNodes) {
      let binary = '';
      const args: string[] = [];
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const t = child.type;
        if (t === 'command_name') {
          binary = child.text.trim();
        } else if (t === 'word' || t === 'string' || t === 'concatenation') {
          if (!binary) binary = child.text.trim();
          else args.push(child.text.trim());
        }
      }
      if (binary) {
        out.push({ binary, arguments: args, raw: node.text.trim() });
      }
    }
    return out;
  }

  dispose(): void {
    this.parser = null;
    this.initialised = false;
    this.supported = false;
  }
}

function findCommandNodes(node: TreeSitterNode): TreeSitterNode[] {
  const list: TreeSitterNode[] = [];
  if (node.type === 'command') list.push(node);
  for (let i = 0; i < node.childCount; i++) {
    list.push(...findCommandNodes(node.child(i)));
  }
  return list;
}

/* ──────────────────────── Language → WASM file ──────────────────────── */

/**
 * Maps a {@link LanguageId} to the vendored WASM file the grammar
 * lives in. Returns `null` for languages that don't have a vendored
 * grammar (regex fallback only).
 */
function wasmFileForLanguage(lang: LanguageId): string | null {
  switch (lang) {
    case 'typescript': return 'tree-sitter-typescript.wasm';
    case 'javascript': return 'tree-sitter-javascript.wasm';
    case 'python':     return 'tree-sitter-python.wasm';
    case 'go':         return 'tree-sitter-go.wasm';
    case 'rust':       return 'tree-sitter-rust.wasm';
    case 'bash':       return 'tree-sitter-bash.wasm';
    default:           return null;
  }
}

/* ──────────────────────── AST → SymbolInfo[] ──────────────────────── */

/**
 * Walks a parsed root node and emits symbol records for top-level
 * declarations. Per-language conventions for "exported":
 *   - TS/JS: wrapped in an `export_statement` (or `export default`).
 *   - Python: top-level name whose first char is not `_`.
 *   - Go: top-level name whose first char is uppercase.
 *   - Rust: declaration carries a `visibility_modifier` child whose
 *     text starts with `pub`.
 *
 * The function caps at 100 symbols per file to mirror the regex
 * extractor and protect downstream context budgets.
 */
function extractSymbolsFromTree(root: TreeSitterNode, language: LanguageId): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const seen = new Set<string>();
  const MAX = 100;

  const push = (
    name: string | undefined,
    kind: SymbolInfo['kind'],
    node: TreeSitterNode,
    exported: boolean,
  ): void => {
    if (!name || seen.has(name) || out.length >= MAX) return;
    seen.add(name);
    out.push({
      name,
      kind,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported,
    });
  };

  /** First identifier-shaped descendant; used as a fallback when the
   *  grammar exposes the name via a positional child instead of a
   *  named field. */
  const firstIdentText = (node: TreeSitterNode): string | undefined => {
    const named = node.childForFieldName('name');
    if (named) return named.text;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier') {
        return c.text;
      }
    }
    return undefined;
  };

  const hasPub = (node: TreeSitterNode): boolean => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'visibility_modifier' && c.text.startsWith('pub')) return true;
    }
    return false;
  };

  const visitTopLevel = (node: TreeSitterNode, exportedFromWrapper: boolean): void => {
    const t = node.type;
    if (language === 'typescript' || language === 'javascript') {
      // Unwrap `export_statement` → emit the inner declaration as exported.
      if (t === 'export_statement') {
        for (let i = 0; i < node.namedChildCount; i++) {
          visitTopLevel(node.namedChild(i), true);
        }
        return;
      }
      if (t === 'class_declaration')    return push(firstIdentText(node), 'class', node, exportedFromWrapper);
      if (t === 'interface_declaration') return push(firstIdentText(node), 'interface', node, exportedFromWrapper);
      if (t === 'function_declaration') return push(firstIdentText(node), 'function', node, exportedFromWrapper);
      if (t === 'function_signature')   return push(firstIdentText(node), 'function', node, exportedFromWrapper);
      if (t === 'enum_declaration')     return push(firstIdentText(node), 'enum', node, exportedFromWrapper);
      if (t === 'type_alias_declaration') return push(firstIdentText(node), 'type', node, exportedFromWrapper);
      if (t === 'lexical_declaration' || t === 'variable_declaration') {
        // `const a = 1, b = 2;` → walk declarators.
        for (let i = 0; i < node.namedChildCount; i++) {
          const decl = node.namedChild(i);
          if (decl.type === 'variable_declarator') {
            push(firstIdentText(decl), 'const', decl, exportedFromWrapper);
          }
        }
        return;
      }
      return;
    }
    if (language === 'python') {
      if (t === 'class_definition' || t === 'function_definition' || t === 'decorated_definition') {
        // Decorated wraps the real definition as a named child.
        let target = node;
        if (t === 'decorated_definition') {
          for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c.type === 'class_definition' || c.type === 'function_definition') {
              target = c;
              break;
            }
          }
        }
        const name = firstIdentText(target);
        const kind: SymbolInfo['kind'] = target.type === 'class_definition' ? 'class' : 'function';
        push(name, kind, target, name !== undefined && !name.startsWith('_'));
      }
      return;
    }
    if (language === 'go') {
      const isUpper = (s: string | undefined): boolean => !!s && s[0] >= 'A' && s[0] <= 'Z';
      if (t === 'function_declaration' || t === 'method_declaration') {
        const name = firstIdentText(node);
        push(name, 'function', node, isUpper(name));
        return;
      }
      if (t === 'type_declaration' || t === 'var_declaration' || t === 'const_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const spec = node.namedChild(i);
          const name = firstIdentText(spec);
          let kind: SymbolInfo['kind'] = 'type';
          if (t === 'var_declaration') kind = 'var';
          else if (t === 'const_declaration') kind = 'const';
          else if (spec.type === 'type_spec') {
            // Look at the type definition body to refine the kind.
            for (let j = 0; j < spec.namedChildCount; j++) {
              const def = spec.namedChild(j);
              if (def.type === 'struct_type') { kind = 'type'; break; }
              if (def.type === 'interface_type') { kind = 'interface'; break; }
            }
          }
          push(name, kind, spec, isUpper(name));
        }
        return;
      }
      return;
    }
    if (language === 'rust') {
      const exported = hasPub(node);
      if (t === 'function_item')   return push(firstIdentText(node), 'function', node, exported);
      if (t === 'struct_item')     return push(firstIdentText(node), 'type', node, exported);
      if (t === 'enum_item')       return push(firstIdentText(node), 'enum', node, exported);
      if (t === 'trait_item')      return push(firstIdentText(node), 'interface', node, exported);
      if (t === 'mod_item')        return push(firstIdentText(node), 'module', node, exported);
      if (t === 'const_item')      return push(firstIdentText(node), 'const', node, exported);
      if (t === 'static_item')     return push(firstIdentText(node), 'const', node, exported);
      // type_item → `type Alias = …;`
      if (t === 'type_item')       return push(firstIdentText(node), 'type', node, exported);
      return;
    }
  };

  for (let i = 0; i < root.namedChildCount; i++) {
    visitTopLevel(root.namedChild(i), false);
    if (out.length >= MAX) break;
  }
  return out;
}

// ──── RegexParserAdapter ─────────────────────────────────────────

export class RegexParserAdapter implements ParserAdapter {
  public readonly name = 'regex' as const;
  public supported = true;

  async init(): Promise<ParserInitResult> {
    return { ok: true };
  }

  extractSymbols(source: string, language: LanguageId): SymbolInfo[] {
    return regexExtractSymbols(source, language);
  }

  extractImports(source: string, language: LanguageId): ImportInfo[] {
    return regexExtractImports(source, language);
  }

  parseShellCommand(command: string): ParsedCommand[] {
    return extractShellTokens(command);
  }

  /** Convenience: re-uses the safety heuristic so callers can stay pure. */
  isCommandSafeShell(command: string, workspaceRoot: string): boolean {
    return isCommandSafeShellFallback(command, workspaceRoot);
  }

  dispose(): void {
    /* no-op */
  }
}

// ──── ParserFactory (double-checked async singleton) ─────────────

interface FactoryState {
  parser: ParserAdapter | null;
  initPromise: Promise<ParserAdapter> | null;
  force: 'tree-sitter' | 'regex' | 'auto';
}

const STATE: FactoryState = {
  parser: null,
  initPromise: null,
  force: 'auto',
};

export class ParserFactory {
  /**
   * Returns a fully-initialised parser adapter. The first caller pays
   * the (potential) WASM-init cost; subsequent callers share the same
   * adapter instance.
   *
   * `force = 'tree-sitter'` rejects the call with the underlying
   * error if WASM init fails (use this when WASM is required by the
   * caller). `force = 'regex'` skips tree-sitter entirely.
   */
  static async getParser(
    force: 'tree-sitter' | 'regex' | 'auto' = STATE.force,
  ): Promise<ParserAdapter> {
    if (STATE.parser && force === STATE.force) {
      return STATE.parser;
    }
    if (STATE.initPromise && force === STATE.force) {
      return STATE.initPromise;
    }

    // First-time (or force-change) initialisation.
    const promise = (async (): Promise<ParserAdapter> => {
      let adapter: ParserAdapter;
      if (force === 'regex') {
        adapter = new RegexParserAdapter();
      } else {
        const ts = new TreeSitterAdapter();
        const result = await ts.init();
        if (result.ok) {
          adapter = ts;
        } else if (force === 'tree-sitter') {
          throw new Error(`Tree-Sitter initialisation failed: ${result.reason ?? 'unknown'}`);
        } else {
          adapter = new RegexParserAdapter();
          await adapter.init();
        }
      }
      STATE.parser = adapter;
      STATE.force = force;
      STATE.initPromise = null;
      return adapter;
    })();

    STATE.initPromise = promise;
    try {
      return await promise;
    } finally {
      STATE.initPromise = null;
    }
  }

  /**
   * Returns the currently cached parser synchronously, or `null` if
   * the factory has not been initialised yet. Use this only when you
   * cannot await — e.g. inside a sync extraction loop on a hot path.
   */
  static getCachedParser(): ParserAdapter | null {
    return STATE.parser;
  }

  /** Resets the factory. Intended for tests only. */
  static reset(): void {
    if (STATE.parser) {
      try {
        STATE.parser.dispose();
      } catch {
        /* ignore */
      }
    }
    STATE.parser = null;
    STATE.initPromise = null;
    STATE.force = 'auto';
  }

  /**
   * Configures the factory's force policy. The next `getParser()` call
   * after this method will re-initialise with the new policy.
   */
  static setForce(force: 'tree-sitter' | 'regex' | 'auto'): void {
    if (STATE.force !== force) {
      STATE.force = force;
      STATE.parser = null;
    }
  }
}
