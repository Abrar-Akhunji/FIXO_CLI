import { spawn, ChildProcess } from "child_process";
import path from "path";
import * as rpc from "vscode-jsonrpc/node.js";

export function filePathToUri(filePath: string): string {
  const absolutePath = path.resolve(filePath).replace(/\\/g, "/");
  return `file://${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}`;
}

export function uriToFilePath(uri: string): string {
  if (uri.startsWith("file://")) {
    let p = uri.slice(7);
    if (process.platform === "win32" && p.startsWith("/")) {
      p = p.slice(1);
    }
    return path.resolve(decodeURIComponent(p));
  }
  return uri;
}

export function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    default:
      return "";
  }
}

export class LspClient {
  private childProcess: ChildProcess | null = null;
  private connection: rpc.MessageConnection | null = null;
  private diagnosticsMap = new Map<string, any[]>();
  private openedFiles = new Set<string>();
  private fileVersions = new Map<string, number>();

  constructor(
    public binaryPath: string,
    public args: string[],
    public workspaceRoot: string,
  ) {}

  async start(): Promise<void> {
    this.childProcess = spawn(this.binaryPath, this.args, {
      cwd: this.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.childProcess.stderr?.on("data", () => {
      // For diagnostic logs, can be enabled under verbose configurations
    });

    this.childProcess.on("error", (err) => {
      console.error(`LSP process error for ${this.binaryPath}:`, err);
    });

    const reader = new rpc.StreamMessageReader(this.childProcess.stdout!);
    const writer = new rpc.StreamMessageWriter(this.childProcess.stdin!);

    this.connection = rpc.createMessageConnection(reader, writer);

    // Track incoming compile/type diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: any) => {
        const { uri, diagnostics } = params;
        this.diagnosticsMap.set(uri, diagnostics);
      },
    );

    this.connection.listen();

    const initParams = {
      processId: process.pid,
      rootPath: this.workspaceRoot,
      rootUri: `file://${this.workspaceRoot}`,
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            dynamicRegistration: true,
            willSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          definition: {
            dynamicRegistration: true,
          },
          references: {
            dynamicRegistration: true,
          },
        },
      },
      initializationOptions: {},
    };

    try {
      await this.connection.sendRequest("initialize", initParams);
      await this.connection.sendNotification("initialized", {});
    } catch (err) {
      console.error(
        `LSP client failed to initialize server ${this.binaryPath}:`,
        err,
      );
      this.stop();
      throw err;
    }
  }

  syncFile(filePath: string, content: string): void {
    if (!this.connection) return;
    const uri = filePathToUri(filePath);
    const languageId = getLanguageId(filePath);
    if (!languageId) return;

    const version = (this.fileVersions.get(uri) || 0) + 1;
    this.fileVersions.set(uri, version);

    if (!this.openedFiles.has(uri)) {
      this.openedFiles.add(uri);
      this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version,
          text: content,
        },
      });
    } else {
      this.connection.sendNotification("textDocument/didChange", {
        textDocument: {
          uri,
          version,
        },
        contentChanges: [{ text: content }],
      });
    }
  }

  async gotoDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<any> {
    if (!this.connection) throw new Error("LSP client not connected");
    const uri = filePathToUri(filePath);
    return this.connection.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<any> {
    if (!this.connection) throw new Error("LSP client not connected");
    const uri = filePathToUri(filePath);
    return this.connection.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  async hover(filePath: string, line: number, character: number): Promise<any> {
    if (!this.connection) throw new Error("LSP client not connected");
    const uri = filePathToUri(filePath);
    return this.connection.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  getDiagnostics(filePath: string): any[] {
    const uri = filePathToUri(filePath);
    return this.diagnosticsMap.get(uri) || [];
  }

  getAllDiagnostics(): Map<string, any[]> {
    return this.diagnosticsMap;
  }

  async stop(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.sendRequest("shutdown");
        this.connection.sendNotification("exit");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        // Suppress shutdown issues if process dies early
      }
      try {
        this.connection.dispose();
      } catch {
        // Suppress errors during dispose
      }
      this.connection = null;
    }
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.openedFiles.clear();
    this.fileVersions.clear();
  }

  killSync(): void {
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
  }
}
