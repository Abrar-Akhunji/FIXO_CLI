import { LspManager } from "../../lsp/lsp-manager.js";
import { LspPreSaveGate, makeLspProvider } from "../../lsp/lsp-pre-save.js";
import { WorkspaceGuard } from "../../workspace-guard.js";
import type { SafetyConfig } from "../../config.js";
import type { ToolExecutionOptions } from "./types.js";

let lspManagerInstance: LspManager | null = null;
let cachedLspGate: LspPreSaveGate | null = null;

export function getLspManager(workspaceRoot: string): LspManager {
  if (!lspManagerInstance) {
    lspManagerInstance = new LspManager(workspaceRoot);
  }
  return lspManagerInstance;
}

export async function stopLspManager(): Promise<void> {
  if (lspManagerInstance) {
    await lspManagerInstance.stopAll();
    lspManagerInstance = null;
  }
}

export function getOrCreateLspGate(
  cwd: string,
  safety: SafetyConfig,
): LspPreSaveGate {
  if (cachedLspGate) return cachedLspGate;
  cachedLspGate = new LspPreSaveGate({
    mode: safety.lspPreSave,
    provider: makeLspProvider(getLspManager(cwd)),
  });
  return cachedLspGate;
}

export function resetLspGate(): void {
  cachedLspGate = null;
}

export async function executeLspGotoDefinition(
  args: { path: string; line: number | string; character: number | string },
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const line = Number(args.line);
  const char = Number(args.character);
  const manager = getLspManager(cwd);
  const resolvedPath = new WorkspaceGuard(
    cwd,
    options?.allowedOutsidePaths,
  ).resolve(args.path, "file");
  const def = await manager.gotoDefinition(resolvedPath, line, char);
  return JSON.stringify(def || null, null, 2);
}

export async function executeLspFindReferences(
  args: { path: string; line: number | string; character: number | string },
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const line = Number(args.line);
  const char = Number(args.character);
  const manager = getLspManager(cwd);
  const resolvedPath = new WorkspaceGuard(
    cwd,
    options?.allowedOutsidePaths,
  ).resolve(args.path, "file");
  const refs = await manager.findReferences(resolvedPath, line, char);
  return JSON.stringify(refs || null, null, 2);
}

export async function executeLspHover(
  args: { path: string; line: number | string; character: number | string },
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  const line = Number(args.line);
  const char = Number(args.character);
  const manager = getLspManager(cwd);
  const resolvedPath = new WorkspaceGuard(
    cwd,
    options?.allowedOutsidePaths,
  ).resolve(args.path, "file");
  const hoverRes = await manager.hover(resolvedPath, line, char);
  return JSON.stringify(hoverRes || null, null, 2);
}
