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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractShellTokens, isCommandSafeShellFallback } from './parsers/shell.js';
import { extractSymbols as regexExtractSymbols } from './parsers/symbols.js';
import { extractImports as regexExtractImports } from './parsers/imports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  child(index: number): TreeSitterNode;
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

  async init(): Promise<ParserInitResult> {
    if (this.initialised) {
      return { ok: this.supported };
    }
    this.initialised = true;

    try {
      await ParserCtor.init({
        locateFile: (scriptName: string): string => {
          if (scriptName === 'tree-sitter.wasm') {
            return path.resolve(__dirname, '../../vendor/tree-sitter.wasm');
          }
          return path.resolve(__dirname, '../../vendor', scriptName);
        },
      });
      const Bash = await LanguageCtor.load(
        path.resolve(__dirname, '../../vendor/tree-sitter-bash.wasm'),
      );
      this.parser = new (ParserCtor as unknown as { new (): TreeSitterParser })();
      this.parser.setLanguage(Bash);
      this.supported = true;
      return { ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `\u26A0  Tree-Sitter WASM unavailable (${reason}). Falling back to regex parser. ` +
          `Performance reduced; accuracy may vary.`,
      );
      this.parser = null;
      this.supported = false;
      return { ok: false, reason };
    }
  }

  extractSymbols(source: string, language: LanguageId): SymbolInfo[] {
    return regexExtractSymbols(source, language);
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
