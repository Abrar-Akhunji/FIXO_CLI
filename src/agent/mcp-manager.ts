import os from "os";
import path from "path";
import fs from "fs";
import { McpClient, type McpServerConfig } from "./mcp-client.js";
import type { ChatToolDefinition } from "../shared/types.js";

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolsMap = new Map<
    string,
    { client: McpClient; originalName: string }
  >();
  private registeredTools: ChatToolDefinition[] = [];

  async initialize(): Promise<void> {
    const config = this.loadMcpConfig();
    if (!config || !config.mcpServers) return;

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const client = new McpClient(name, serverConfig as McpServerConfig);
      const ok = await client.start();
      if (ok) {
        this.clients.set(name, client);
        try {
          const tools = await client.listTools();
          for (const tool of tools) {
            const registeredName = `mcp_${name}_${tool.name}`;
            this.toolsMap.set(registeredName, {
              client,
              originalName: tool.name,
            });
            this.registeredTools.push({
              type: "function",
              function: {
                name: registeredName,
                description: tool.description || "",
                parameters: tool.inputSchema || {
                  type: "object",
                  properties: {},
                },
              },
            });
          }
        } catch (e) {
          console.error(
            `[MCP Manager] Failed to load tools for server ${name}:`,
            e,
          );
        }
      }
    }
  }

  private loadMcpConfig(): any {
    const homeDir = os.homedir();
    const configPath = path.join(homeDir, ".freellmapi", "mcp.json");
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch (e) {
        console.warn(`[MCP Manager] Failed to parse MCP config:`, e);
      }
    }
    return null;
  }

  getTools(): ChatToolDefinition[] {
    return this.registeredTools;
  }

  hasTool(name: string): boolean {
    return this.toolsMap.has(name);
  }

  async executeTool(name: string, args: any): Promise<string> {
    const mapping = this.toolsMap.get(name);
    if (!mapping) {
      throw new Error(`MCP tool ${name} not registered`);
    }
    const result = await mapping.client.callTool(mapping.originalName, args);
    if (result && Array.isArray(result.content)) {
      return result.content
        .map((c: any) => {
          if (c.type === "text") return c.text;
          return JSON.stringify(c);
        })
        .join("\n");
    }
    return JSON.stringify(result);
  }

  shutdown(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
    this.toolsMap.clear();
    this.registeredTools = [];
  }
}
