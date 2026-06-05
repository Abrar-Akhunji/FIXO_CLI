import * as ParserModule from 'web-tree-sitter';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WorkspaceGuard } from '../workspace-guard.js';

// Resolve parser ESM named exports
const Parser = (ParserModule as any).Parser;
const Language = (ParserModule as any).Language;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let isInitialized = false;
let parser: any = null;

/**
 * Initializes the Tree-Sitter parser using the bundled tree-sitter.wasm 
 * and tree-sitter-bash.wasm files.
 */
export async function initTreeSitter(): Promise<void> {
  if (isInitialized) return;
  
  await Parser.init({
    locateFile(scriptName: string) {
      if (scriptName === 'tree-sitter.wasm') {
        return path.resolve(__dirname, '../../vendor/tree-sitter.wasm');
      }
      return scriptName;
    }
  });

  const Bash = await Language.load(path.resolve(__dirname, '../../vendor/tree-sitter-bash.wasm'));
  parser = new Parser();
  parser.setLanguage(Bash);
  isInitialized = true;
}

export interface ParsedCommand {
  binary: string;
  arguments: string[];
  raw: string;
}

function findCommandNodes(node: any): any[] {
  const list: any[] = [];
  if (node.type === 'command') {
    list.push(node);
  }
  for (let i = 0; i < node.childCount; i++) {
    list.push(...findCommandNodes(node.child(i)));
  }
  return list;
}

/**
 * Parses a shell command string into individual binary and arguments sets.
 */
export async function parseShellCommand(command: string): Promise<ParsedCommand[]> {
  await initTreeSitter();
  const tree = parser.parse(command);
  const commandNodes = findCommandNodes(tree.rootNode);

  const parsed: ParsedCommand[] = [];
  for (const node of commandNodes) {
    let binary = '';
    const args: string[] = [];

    // Command elements are typically child nodes of type word or string.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'command_name') {
        binary = child.text.trim();
      } else if (child.type === 'word' || child.type === 'string' || child.type === 'concatenation') {
        if (!binary) {
          binary = child.text.trim();
        } else {
          args.push(child.text.trim());
        }
      }
    }

    if (binary) {
      parsed.push({
        binary,
        arguments: args,
        raw: node.text.trim(),
      });
    }
  }

  return parsed;
}

export interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
  affectedPath?: string;
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

const DANGEROUS_MODIFIERS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'dd', 'ln', 'rmdir'
]);

const DANGEROUS_READERS = new Set([
  'cat', 'less', 'more', 'grep', 'head', 'tail'
]);

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
