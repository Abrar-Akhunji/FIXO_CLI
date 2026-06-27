import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as p from '@clack/prompts';
import { colors } from '../ui/colors.js';
import { LspClient, getLanguageId } from './lsp-client.js';

function findBinaryInPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(delimiter);

  for (const dir of dirs) {
    const baseNames = [binaryName];
    if (process.platform === 'win32') {
      baseNames.push(`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`);
    }

    for (const name of baseNames) {
      const fullPath = path.join(dir, name);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (process.platform === 'win32' || (stat.mode & 0o111) !== 0) {
            return fullPath;
          }
        }
      } catch {
        // Ignore files we cannot access
      }
    }
  }
  return null;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private failedSearches = new Set<string>();

  constructor(public workspaceRoot: string) {
    process.on('exit', () => this.killAllSync());
    process.on('SIGINT', () => {
      this.killAllSync();
      process.exit(130);
    });
  }

  private killAllSync(): void {
    for (const client of this.clients.values()) {
      client.killSync();
    }
  }

  private async getOrStartClient(filePath: string): Promise<LspClient | null> {
    const ext = path.extname(filePath).toLowerCase();
    let binaryName = '';
    let args: string[] = [];
    const languageId = getLanguageId(filePath);

    if (!languageId) return null;

    if (languageId === 'typescript' || languageId === 'javascript') {
      binaryName = 'typescript-language-server';
      args = ['--stdio'];
    } else if (languageId === 'python') {
      binaryName = 'pyright-langserver';
      args = ['--stdio'];
    } else if (languageId === 'go') {
      binaryName = 'gopls';
      args = [];
    } else if (languageId === 'rust') {
      binaryName = 'rust-analyzer';
      args = [];
    } else {
      return null;
    }

    if (this.clients.has(languageId)) {
      return this.clients.get(languageId)!;
    }

    if (this.failedSearches.has(binaryName)) {
      return null;
    }

    let binaryPath = findBinaryInPath(binaryName);

    if (!binaryPath && (binaryName === 'typescript-language-server')) {
      const s = p.spinner();
      const shouldInstall = await p.confirm({
        message: `${colors.yellow}JS/TS language server not found.${colors.reset} Do you want to automatically install it via npm? (Requires npm)`,
        initialValue: true,
      });
      if (p.isCancel(shouldInstall)) return null;

      if (shouldInstall) {
        s.start('Installing typescript-language-server globally...');
        try {
          execSync('npm install -g typescript-language-server typescript', { stdio: 'ignore' });
          s.stop(`${colors.green}Successfully installed typescript-language-server.${colors.reset}`);
          binaryPath = findBinaryInPath(binaryName);
        } catch (err) {
          s.stop(`${colors.red}Failed to install typescript-language-server.${colors.reset} Please install manually: npm install -g typescript-language-server typescript`);
        }
      }
    }

    if (!binaryPath) {
      this.failedSearches.add(binaryName);
      console.warn(`\n[LSP Manager] Warning: '${binaryName}' not found on PATH. LSP features for '${ext}' files are disabled.`);
      return null;
    }

    const client = new LspClient(binaryPath, args, this.workspaceRoot);
    try {
      await client.start();
      this.clients.set(languageId, client);
      return client;
    } catch (err) {
      console.error(`[LSP Manager] Failed to start LSP client for ${binaryName}:`, err);
      this.failedSearches.add(binaryName);
      return null;
    }
  }

  private syncFileFromDisk(filePath: string, client: LspClient): void {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        client.syncFile(filePath, content);
      }
    } catch (err: any) {
      console.error(`[LSP Manager] Failed to read and sync file: ${filePath}`, err.message);
    }
  }

  async getClientAndSync(filePath: string): Promise<LspClient | null> {
    const client = await this.getOrStartClient(filePath);
    if (client) {
      this.syncFileFromDisk(filePath, client);
    }
    return client;
  }

  async gotoDefinition(filePath: string, line: number, character: number): Promise<any> {
    const client = await this.getClientAndSync(filePath);
    if (!client) return null;
    return client.gotoDefinition(filePath, line, character);
  }

  async findReferences(filePath: string, line: number, character: number): Promise<any> {
    const client = await this.getClientAndSync(filePath);
    if (!client) return null;
    return client.findReferences(filePath, line, character);
  }

  async hover(filePath: string, line: number, character: number): Promise<any> {
    const client = await this.getClientAndSync(filePath);
    if (!client) return null;
    return client.hover(filePath, line, character);
  }

  async getDiagnostics(filePath: string): Promise<any[]> {
    const client = await this.getClientAndSync(filePath);
    if (!client) return [];
    
    // Give LSP a short tick (100ms) to publish diagnostics if this was the first open/sync
    await new Promise((resolve) => setTimeout(resolve, 100));
    return client.getDiagnostics(filePath);
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
    this.failedSearches.clear();
  }
}
