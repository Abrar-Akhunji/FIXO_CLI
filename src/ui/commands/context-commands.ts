import { colors } from "../colors.js";
import {
  addItem,
  loadTodoList,
  removeItem,
  renderTodoList,
  saveTodoList,
  setItemStatus,
  summariseTodoList,
} from "../../context/todo.js";

import { type CommandHandler } from "./types.js";

export const todoCommand: CommandHandler = async (ctx) => {
  const sub = ctx.args[0]?.toLowerCase();
  if (!sub || sub === "list" || sub === "ls") {
    const list = loadTodoList(ctx.cwd);
    const summary = summariseTodoList(list);
    console.log("");
    console.log(renderTodoList(list));
    if (summary.length > 0) {
      console.log(`\n${colors.dim}(${summary})${colors.reset}`);
    }
    return;
  }
  if (sub === "add") {
    const text = ctx.args.slice(1).join(" ").trim();
    if (text.length === 0) {
      console.log(`\n${colors.yellow}Usage: /todo add <text>${colors.reset}`);
      return;
    }
    const list = addItem(loadTodoList(ctx.cwd), { content: text });
    const result = saveTodoList(ctx.cwd, list);
    if (!result.ok) {
      console.log(
        `\n${colors.red}✗ Failed to save todo: ${result.error}${colors.reset}`,
      );
      return;
    }
    console.log(`\n${colors.green}✓ Added todo:${colors.reset} ${text}`);
    return;
  }
  if (sub === "done" || sub === "complete" || sub === "cancel") {
    const id = ctx.args[1];
    if (!id) {
      console.log(`\n${colors.yellow}Usage: /todo ${sub} <id>${colors.reset}`);
      return;
    }
    const status = sub === "cancel" ? "cancelled" : "done";
    let list = loadTodoList(ctx.cwd);
    const exists = list.items.some((it) => it.id === id);
    if (!exists) {
      console.log(`\n${colors.red}✗ No todo with id "${id}"${colors.reset}`);
      return;
    }
    list = setItemStatus(list, { id, status });
    const result = saveTodoList(ctx.cwd, list);
    if (!result.ok) {
      console.log(
        `\n${colors.red}✗ Failed to save todo: ${result.error}${colors.reset}`,
      );
      return;
    }
    console.log(`\n${colors.green}✓ Marked ${status}${colors.reset}`);
    return;
  }
  if (sub === "start" || sub === "progress") {
    const id = ctx.args[1];
    if (!id) {
      console.log(`\n${colors.yellow}Usage: /todo ${sub} <id>${colors.reset}`);
      return;
    }
    let list = loadTodoList(ctx.cwd);
    const exists = list.items.some((it) => it.id === id);
    if (!exists) {
      console.log(`\n${colors.red}✗ No todo with id "${id}"${colors.reset}`);
      return;
    }
    list = setItemStatus(list, { id, status: "in_progress" });
    const result = saveTodoList(ctx.cwd, list);
    if (!result.ok) {
      console.log(
        `\n${colors.red}✗ Failed to save todo: ${result.error}${colors.reset}`,
      );
      return;
    }
    console.log(`\n${colors.green}✓ Marked in_progress${colors.reset}`);
    return;
  }
  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const id = ctx.args[1];
    if (!id) {
      console.log(`\n${colors.yellow}Usage: /todo remove <id>${colors.reset}`);
      return;
    }
    let list = loadTodoList(ctx.cwd);
    const exists = list.items.some((it) => it.id === id);
    if (!exists) {
      console.log(`\n${colors.red}✗ No todo with id "${id}"${colors.reset}`);
      return;
    }
    list = removeItem(list, { id });
    const result = saveTodoList(ctx.cwd, list);
    if (!result.ok) {
      console.log(
        `\n${colors.red}✗ Failed to save todo: ${result.error}${colors.reset}`,
      );
      return;
    }
    console.log(`\n${colors.green}✓ Removed todo${colors.reset}`);
    return;
  }
  if (sub === "clear") {
    const list = loadTodoList(ctx.cwd);
    const kept = list.items.filter(
      (it) => it.status !== "done" && it.status !== "cancelled",
    );
    const result = saveTodoList(ctx.cwd, {
      ...list,
      items: kept,
      updatedAt: Date.now(),
    });
    if (!result.ok) {
      console.log(
        `\n${colors.red}✗ Failed to save todo: ${result.error}${colors.reset}`,
      );
      return;
    }
    const cleared = list.items.length - kept.length;
    console.log(
      `\n${colors.green}✓ Cleared ${cleared} completed todo(s)${colors.reset}`,
    );
    return;
  }
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`\n${colors.bold}Usage: /todo <subcommand>${colors.reset}`);
    console.log(`  list                  List all todo items`);
    console.log(`  add <text>            Add a new todo`);
    console.log(`  start <id>            Mark a todo as in-progress`);
    console.log(`  done <id>             Mark a todo as done`);
    console.log(`  cancel <id>           Cancel a todo`);
    console.log(`  remove <id>           Remove a todo entirely`);
    console.log(`  clear                 Remove all done/cancelled todos`);
    return;
  }
  console.log(
    `\n${colors.yellow}Unknown /todo subcommand "${sub}". Try /todo help.${colors.reset}`,
  );
  return;
};

export const mcpCommand: CommandHandler = async (ctx) => {
  const sub = ctx.args[0]?.toLowerCase();
  if (!sub || sub === "list") {
    const { listAllMcpSources, mergedMcpServers } =
      await import("../../agent/mcp-registry.js");
    const view = listAllMcpSources(ctx.cwd);
    console.log(
      `\n${colors.bold}${colors.cyan}MCP Servers${colors.reset} ${colors.dim}(project-wins precedence: local > project > global)${colors.reset}`,
    );
    console.log(`${colors.dim}${"─".repeat(60)}${colors.reset}`);
    const renderSource = (
      label: string,
      s: { configPath: string | null; servers: Record<string, unknown> },
    ) => {
      const names = Object.keys(s.servers);
      if (names.length === 0) {
        console.log(
          `  ${colors.dim}${label}: (empty)${s.configPath ? ` ${colors.dim}${s.configPath}${colors.reset}` : ""}`,
        );
        return;
      }
      console.log(
        `  ${colors.bold}${label}${colors.reset}${s.configPath ? ` ${colors.dim}${s.configPath}${colors.reset}` : ""}`,
      );
      for (const n of names) {
        console.log(`    ${colors.cyan}•${colors.reset} ${n}`);
      }
    };
    renderSource("global", view.global);
    renderSource("project", view.project);
    renderSource("local", view.local);
    const merged = mergedMcpServers(ctx.cwd);
    const mergedCount = Object.keys(merged).length;
    console.log(
      `\n${colors.dim}merged total: ${mergedCount} server(s)${colors.reset}`,
    );
    return;
  }
  if (sub === "add") {
    const name = ctx.args[1];
    if (!name || ctx.args.length < 3) {
      console.log(
        `\n${colors.yellow}Usage: /mcp add <name> <command> [ctx.args...]${colors.reset}`,
      );
      return;
    }
    const cmd = ctx.args[2];
    const cmdArgs = ctx.args.slice(3);
    const { addLocalMcpServer } = await import("../../agent/mcp-registry.js");
    addLocalMcpServer(ctx.cwd, name, {
      command: cmd,
      args: cmdArgs,
      type: "stdio",
    });
    console.log(
      `\n${colors.green}✓ Added local MCP server:${colors.reset} ${name} ${colors.dim}(command=${cmd} ctx.args=${JSON.stringify(cmdArgs)})${colors.reset}`,
    );
    return;
  }
  if (sub === "remove" || sub === "rm") {
    const name = ctx.args[1];
    if (!name) {
      console.log(`\n${colors.yellow}Usage: /mcp remove <name>${colors.reset}`);
      return;
    }
    const { removeLocalMcpServer } =
      await import("../../agent/mcp-registry.js");
    const removed = removeLocalMcpServer(ctx.cwd, name);
    if (removed) {
      console.log(
        `\n${colors.green}✓ Removed local MCP server:${colors.reset} ${name}`,
      );
    } else {
      console.log(
        `\n${colors.yellow}No local MCP server named ${name}${colors.reset}`,
      );
    }
    return;
  }
  if (sub === "test") {
    const name = ctx.args[1];
    if (!name) {
      console.log(`\n${colors.yellow}Usage: /mcp test <name>${colors.reset}`);
      return;
    }
    const { mergedMcpServers } = await import("../../agent/mcp-registry.js");
    const all = mergedMcpServers(ctx.cwd);
    const cfg = all[name];
    if (!cfg) {
      console.log(
        `\n${colors.yellow}No MCP server named ${name} (in any source)${colors.reset}`,
      );
      return;
    }
    const hasCommand =
      typeof (cfg as { command?: string }).command === "string";
    const hasUrl = typeof (cfg as { url?: string }).url === "string";
    if (hasCommand || hasUrl) {
      console.log(
        `\n${colors.green}✓ ${name}${colors.reset} — ctx.config looks valid (${hasCommand ? "stdio" : "sse"})`,
      );
    } else {
      console.log(
        `\n${colors.red}✗ ${name}${colors.reset} — missing 'command' or 'url'`,
      );
    }
    return;
  }
  console.log(
    `\n${colors.yellow}Unknown /mcp subcommand: ${sub}. Use: list | add | remove | test${colors.reset}`,
  );
  return;
};

export const compactCommand: CommandHandler = async (ctx) => {
  const msgCount = ctx.conversation.getMessageCount();
  if (msgCount === 0) {
    console.log(
      `\n${colors.dim}Nothing to compact — ctx.conversation is empty.${colors.reset}`,
    );
    return;
  }
  const tokensBefore = ctx.conversation.getTotalTokens();
  const contextLimit = ctx.conversation.getContextLimit();
  console.log(
    `\n${colors.cyan}[Compact] Summarising ${msgCount} messages to free context tokens...${colors.reset}`,
  );
  console.log(
    `${colors.dim}  Current context: ${(tokensBefore / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k tokens${colors.reset}`,
  );
  try {
    const compacted = await ctx.conversation.compact(
      ctx.agent.getClient(),
      ctx.state.currentModel,
    );
    if (compacted) {
      const info = ctx.conversation.getLastCompactionInfo();
      const tokensAfter = ctx.conversation.getTotalTokens();
      console.log(
        `${colors.green}✓ Compacted: ${info?.messagesBefore ?? msgCount} messages → summary + ${ctx.conversation.getMessageCount()} recent messages.${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Context: ${(tokensBefore / 1000).toFixed(0)}k → ${(tokensAfter / 1000).toFixed(0)}k tokens (~${((info?.tokensFreed ?? 0) / 1000).toFixed(0)}k freed).${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.dim}Not enough messages to compact (need more than 4 messages).${colors.reset}`,
      );
    }
  } catch (err: any) {
    console.log(`${colors.red}✗ Compact failed: ${err.message}${colors.reset}`);
  }
  return;
};

export const clearCommand: CommandHandler = async (ctx) => {
  ctx.conversation.clear();
  ctx.state.pendingAttachments = [];
  console.log(`\n${colors.green}✓ Conversation cleared${colors.reset}`);
  return;
};

export const variantCommand: CommandHandler = async () => {
  const { themeMode, setThemeMode } = await import("../colors.js");
  const newMode = themeMode === "dark" ? "inverted" : "dark";
  setThemeMode(newMode);
  console.log(
    `\n${colors.cyan}✓ Theme set to: ${newMode === "dark" ? "Dark Void Minimalist" : "High-Contrast Inverted"}${colors.reset}`,
  );
  return;
};
