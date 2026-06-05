/**
 * shell.ts — Pure-JS shell command tokenizer and safety-check fallback.
 *
 * The Tree-Sitter adapter's `parseShellCommand` is the high-fidelity path
 * for bash; this module is the universal fallback that runs on any host
 * (no WASM, no native code).
 *
 * The tokenizer is a deliberately simple shlex-style splitter that:
 *   1. Splits on top-level `&&`, `||`, `;`, `|`, and newlines.
 *   2. Honours single-quoted, double-quoted, and backslash-escaped
 *      segments.
 *   3. Strips the surrounding quotes from each token.
 *
 * `isCommandSafeShellFallback` is a heuristic mirror of the original
 * `isCommandSafe` policy (modifiers outside the workspace, sensitive
 * file reads). The full-featured safety check still lives in
 * `agent/command-parser.ts`; this fallback is the last line of defence
 * for adapters that do not delegate to that module.
 */

import path from 'node:path';
import os from 'node:os';
import type { ParsedCommand } from '../parser-adapter.js';

const DANGEROUS_MODIFIERS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'dd', 'ln', 'rmdir',
]);
const DANGEROUS_READERS = new Set(['cat', 'less', 'more', 'grep', 'head', 'tail']);

export function extractShellTokens(command: string): ParsedCommand[] {
  const segments = splitTopLevel(command, ['&&', '||', ';', '|', '\n']);
  const out: ParsedCommand[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = shlex(trimmed);
    if (tokens.length === 0) continue;
    const [binary, ...args] = tokens;
    out.push({ binary, arguments: args, raw: trimmed });
  }
  return out;
}

function splitTopLevel(input: string, separators: string[]): string[] {
  // We need to respect quoting while splitting. The implementation is a
  // small state machine that emits the current accumulator every time a
  // separator is encountered at depth 0.
  const result: string[] = [];
  let buf = '';
  let single = false;
  let dquote = false;
  let escape = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (escape) {
      buf += ch;
      escape = false;
      i++;
      continue;
    }
    if (!single && ch === '\\') {
      buf += ch;
      escape = true;
      i++;
      continue;
    }
    if (!single && ch === '"') {
      dquote = !dquote;
      buf += ch;
      i++;
      continue;
    }
    if (!dquote && ch === "'") {
      single = !single;
      buf += ch;
      i++;
      continue;
    }
    if (!single && !dquote) {
      let matchedSep: string | null = null;
      for (const sep of separators) {
        if (input.startsWith(sep, i)) {
          matchedSep = sep;
          break;
        }
      }
      if (matchedSep) {
        result.push(buf);
        buf = '';
        i += matchedSep.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) result.push(buf);
  return result;
}

function shlex(input: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let single = false;
  let dquote = false;
  let escape = false;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      buf += ch;
      escape = false;
      started = true;
      continue;
    }
    if (!single && ch === '\\') {
      escape = true;
      started = true;
      continue;
    }
    if (!dquote && ch === "'") {
      single = !single;
      started = true;
      continue;
    }
    if (!single && ch === '"') {
      dquote = !dquote;
      started = true;
      continue;
    }
    if (!single && !dquote && /\s/.test(ch)) {
      if (started) {
        tokens.push(buf);
        buf = '';
        started = false;
      }
      continue;
    }
    buf += ch;
    started = true;
  }
  if (started) tokens.push(buf);
  return tokens;
}

function unquote(str: string): string {
  if (str.length < 2) return str;
  const first = str[0];
  const last = str[str.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return str.slice(1, -1);
  }
  return str;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isCommandSafeShellFallback(command: string, workspaceRoot: string): boolean {
  const parsed = extractShellTokens(command);
  for (const cmd of parsed) {
    const binaryLower = cmd.binary.toLowerCase();
    if (binaryLower.startsWith('/') || binaryLower.startsWith('.')) {
      const resolvedBin = path.resolve(workspaceRoot, unquote(binaryLower));
      if (!isInside(resolvedBin, workspaceRoot)) return false;
    }
    for (const arg of cmd.arguments) {
      if (arg.startsWith('-')) continue;
      const cleanArg = unquote(arg);
      const looksLikePath = cleanArg.includes('/') || cleanArg.includes('\\') || cleanArg.includes('.') || cleanArg === '~';
      if (!looksLikePath) continue;
      let targetPath = cleanArg;
      if (cleanArg === '~') targetPath = os.homedir();
      else if (cleanArg.startsWith('~/') || cleanArg.startsWith('~\\')) {
        targetPath = path.join(os.homedir(), cleanArg.slice(2));
      }
      const resolved = path.resolve(workspaceRoot, targetPath);
      if (DANGEROUS_MODIFIERS.has(binaryLower) && !isInside(resolved, workspaceRoot)) {
        return false;
      }
      const filename = path.basename(resolved).toLowerCase();
      const isSensitive =
        filename === '.env' ||
        filename.includes('.env.') ||
        filename === 'id_rsa' ||
        filename === 'credentials' ||
        (filename === 'config' && resolved.includes('.aws'));
      if (isSensitive) {
        if (DANGEROUS_MODIFIERS.has(binaryLower)) return false;
        if (DANGEROUS_READERS.has(binaryLower) || binaryLower === 'grep') return false;
      }
    }
  }
  return true;
}
