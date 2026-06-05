import path from 'path';
import os from 'os';
import { WorkspaceGuard } from '../workspace-guard.js';
import { ParserFactory, type ParsedCommand } from './parser-adapter.js';

export { ParserFactory };
export type { ParsedCommand } from './parser-adapter.js';

/**
 * Parses a shell command string into individual binary and arguments sets.
 *
 * Resolves the active parser via the `ParserFactory` singleton. When the
 * underlying tree-sitter engine is healthy, the AST is used for maximum
 * accuracy. When the WASM is unavailable (architecture mismatch, missing
 * vendor file, etc.) the factory falls back transparently to a pure-JS
 * regex tokenizer — the rest of the safety check pipeline keeps working
 * unchanged.
 */
export async function parseShellCommand(command: string): Promise<ParsedCommand[]> {
  const parser = await ParserFactory.getParser();
  return parser.parseShellCommand ? parser.parseShellCommand(command) : [];
}

export interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
  affectedPath?: string;
}

const DANGEROUS_MODIFIERS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'dd', 'ln', 'rmdir'
]);

const DANGEROUS_READERS = new Set([
  'cat', 'less', 'more', 'grep', 'head', 'tail'
]);

function unquote(str: string): string {
  if (str.length < 2) return str;
  const first = str[0];
  const last = str[str.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return str.slice(1, -1);
  }
  return str;
}

/**
 * Checks whether a shell command is safe to execute based on active path safety rules.
 * Flags modifications outside the workspace root and checks for sensitive file access.
 */
export async function isCommandSafe(command: string, workspaceRoot: string): Promise<CommandSafetyResult> {
  const parsed = await parseShellCommand(command);
  const guard = new WorkspaceGuard(workspaceRoot);

  for (const cmd of parsed) {
    const binaryLower = cmd.binary.toLowerCase();
    
    // Check if the binary itself is a path outside the workspace
    if (binaryLower.startsWith('/') || binaryLower.startsWith('.')) {
      const resolvedBin = path.resolve(workspaceRoot, unquote(binaryLower));
      if (!guard.isInside(resolvedBin)) {
        return {
          safe: false,
          reason: `Attempt to execute an external binary located outside the workspace: ${cmd.binary}`,
          affectedPath: resolvedBin
        };
      }
    }

    for (const arg of cmd.arguments) {
      if (arg.startsWith('-')) continue;

      const cleanArg = unquote(arg);
      const looksLikePath = cleanArg.includes('/') || cleanArg.includes('\\') || cleanArg.includes('.') || cleanArg === '~';
      if (!looksLikePath) continue;

      // Expand home paths
      let targetPath = cleanArg;
      if (cleanArg === '~') {
        targetPath = os.homedir();
      } else if (cleanArg.startsWith('~/') || cleanArg.startsWith('~\\')) {
        targetPath = path.join(os.homedir(), cleanArg.slice(2));
      }

      const resolved = path.resolve(workspaceRoot, targetPath);

      // Check for workspace escaping
      if (DANGEROUS_MODIFIERS.has(binaryLower)) {
        if (!guard.isInside(resolved)) {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to write or delete files outside the workspace root`,
            affectedPath: resolved
          };
        }
      }

      // Check for sensitive credential files
      const filename = path.basename(resolved).toLowerCase();
      const isSensitive = filename === '.env' || 
                          filename.includes('.env.') || 
                          filename === 'id_rsa' || 
                          filename === 'credentials' || 
                          (filename === 'config' && resolved.includes('.aws'));

      if (isSensitive) {
        if (DANGEROUS_MODIFIERS.has(binaryLower)) {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to modify a sensitive credentials file: ${filename}`,
            affectedPath: resolved
          };
        }
        if (DANGEROUS_READERS.has(binaryLower) || binaryLower === 'grep') {
          return {
            safe: false,
            reason: `Command '${cmd.binary}' attempts to read a sensitive credentials file: ${filename}`,
            affectedPath: resolved
          };
        }
      }
    }
  }

  return { safe: true };
}

// ──── Backwards-compatible exports ───────────────────────────────

/**
 * @deprecated Direct tree-sitter initialisation is no longer required.
 * `parseShellCommand` now handles initialisation internally via the
 * `ParserFactory` singleton. This export is kept for callers that still
 * need to explicitly warm the parser at startup; it is a no-op once
 * the factory has already initialised.
 */
export async function initTreeSitter(): Promise<void> {
  await ParserFactory.getParser();
}
