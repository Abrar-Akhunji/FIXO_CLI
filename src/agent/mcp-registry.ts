/**
 * mcp-registry.ts — Unified view of MCP server config across
 * 3 sources: global (~/.freellmapi/mcp.json), project
 * (.fixo.yml / .fixo.yaml), and local (in-memory runtime
 * additions made via /mcp add).
 *
 * Phase 3.3 invariant: when the same server name appears in
 * both global and project, the project definition wins.
 * Local entries shadow both.
 *
 * The registry is read-only on disk; mutating actions
 * (add/remove) are kept in an in-memory layer that is
 * consumed by /mcp add and /mcp remove.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/** Shape of a single MCP server config entry (matches MCP spec). */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "sse";
  [key: string]: unknown;
}

/** A single source of MCP servers. */
export interface McpSourceView {
  name: "global" | "project" | "local";
  configPath: string | null;
  servers: Record<string, McpServerConfig>;
}

export interface McpRegistryView {
  global: McpSourceView;
  project: McpSourceView;
  local: McpSourceView;
}

/** In-memory local additions, keyed by cwd. */
const localByCwd = new Map<string, Record<string, McpServerConfig>>();

function getLocal(cwd: string): Record<string, McpServerConfig> {
  let m = localByCwd.get(cwd);
  if (!m) {
    m = {};
    localByCwd.set(cwd, m);
  }
  return m;
}

/** Read the global MCP config from `~/.freellmapi/mcp.json`. */
export function readGlobalMcpConfig(): {
  configPath: string | null;
  servers: Record<string, McpServerConfig>;
} {
  const configPath = path.join(os.homedir(), ".freellmapi", "mcp.json");
  if (!fs.existsSync(configPath)) {
    return { configPath: null, servers: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
    return { configPath, servers: raw.mcpServers ?? {} };
  } catch {
    return { configPath, servers: {} };
  }
}

/** Read the project MCP config from `<cwd>/.fixo.yml` or `.fixo.yaml`. */
export function readProjectMcpConfig(cwd: string): {
  configPath: string | null;
  servers: Record<string, McpServerConfig>;
} {
  const yml = path.join(cwd, ".fixo.yml");
  const yamlAlt = path.join(cwd, ".fixo.yaml");
  const configPath = fs.existsSync(yml)
    ? yml
    : fs.existsSync(yamlAlt)
      ? yamlAlt
      : null;
  if (!configPath) {
    return { configPath: null, servers: {} };
  }
  try {
    const raw = yaml.load(fs.readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, McpServerConfig>;
    } | null;
    return { configPath, servers: raw?.mcpServers ?? {} };
  } catch {
    return { configPath, servers: {} };
  }
}

/** Build a unified view of all MCP sources for `cwd`. */
export function listAllMcpSources(cwd: string): McpRegistryView {
  const g = readGlobalMcpConfig();
  const p = readProjectMcpConfig(cwd);
  return {
    global: { name: "global", configPath: g.configPath, servers: g.servers },
    project: { name: "project", configPath: p.configPath, servers: p.servers },
    local: { name: "local", configPath: null, servers: { ...getLocal(cwd) } },
  };
}

/** Add a server to the in-memory local layer for `cwd`. */
export function addLocalMcpServer(
  cwd: string,
  name: string,
  config: McpServerConfig,
): void {
  getLocal(cwd)[name] = config;
}

/** Remove a server from the in-memory local layer. */
export function removeLocalMcpServer(cwd: string, name: string): boolean {
  const local = getLocal(cwd);
  if (!(name in local)) return false;
  delete local[name];
  return true;
}

/** Clear all local entries (test-only). */
export function _resetLocalMcpServers(): void {
  localByCwd.clear();
}

/**
 * Build a merged server map for runtime use. Precedence
 * (highest → lowest): local > project > global. Project
 * shadows global on name conflict; local shadows both.
 */
export function mergedMcpServers(cwd: string): Record<string, McpServerConfig> {
  const view = listAllMcpSources(cwd);
  return {
    ...view.global.servers,
    ...view.project.servers,
    ...view.local.servers,
  };
}
