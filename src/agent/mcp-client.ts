import { spawn, type ChildProcess } from "child_process";
import readline from "readline";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpClient {
  private serverName: string;
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  private rl: readline.Interface | null = null;
  private initialized = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  async start(): Promise<boolean> {
    try {
      const env = { ...process.env, ...this.config.env };
      this.process = spawn(this.config.command, this.config.args || [], {
        env,
        stdio: ["pipe", "pipe", "inherit"],
      });

      this.process.on("error", (err) => {
        console.error(
          `[MCP Client] Failed to start server ${this.serverName}:`,
          err,
        );
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.warn(
            `[MCP Client] Server ${this.serverName} exited with code ${code}`,
          );
        }
      });

      this.rl = readline.createInterface({
        input: this.process.stdout!,
        terminal: false,
      });

      this.rl.on("line", (line) => {
        this.handleMessage(line);
      });

      // Initialize connection
      await this.initializeConnection();
      this.initialized = true;
      return true;
    } catch (e) {
      console.error(
        `[MCP Client] Error starting server ${this.serverName}:`,
        e,
      );
      this.stop();
      return false;
    }
  }

  private handleMessage(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(
              new Error(msg.error.message || JSON.stringify(msg.error)),
            );
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch (e) {
      // Ignored / malformed line
    }
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(
          new Error(`MCP server ${this.serverName} process not running`),
        );
      }
      const id = this.nextId++;
      const req = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new Error(
              `MCP request timeout for method ${method} on server ${this.serverName}`,
            ),
          );
        }
      }, 20000);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timeoutId);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });
      this.process.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private sendNotification(method: string, params?: any): void {
    if (!this.process || !this.process.stdin) return;
    const notif = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.process.stdin.write(JSON.stringify(notif) + "\n");
  }

  private async initializeConnection(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fixo-cli", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized");
  }

  async listTools(): Promise<any[]> {
    if (!this.initialized) return [];
    try {
      const res = await this.sendRequest("tools/list", {});
      return res.tools || [];
    } catch (e) {
      console.error(
        `[MCP Client] Failed to list tools for ${this.serverName}:`,
        e,
      );
      return [];
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.initialized)
      throw new Error(`MCP Client ${this.serverName} not initialized`);
    return this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
  }

  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const [, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error(`MCP client ${this.serverName} stopped`));
    }
    this.pendingRequests.clear();
  }
}
