import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";
import { loadImageAsBlock } from "../image-attach.js";
import { undoRun } from "../../runtime/task-session.js";
import { getHunkTracker } from "../../git/hunk-tracker.js";

import { colors } from "../colors.js";

import { type CommandHandler } from "./types.js";

export const selectCommand: CommandHandler = async (ctx) => {
  if (ctx.args.length === 0) {
    if (ctx.state.selectedFiles.length === 0) {
      console.log(
        `\n${colors.dim}No files selected. Usage: /select <file-path>${colors.reset}`,
      );
    } else {
      console.log(`\n${colors.dim}Selected files:${colors.reset}`);
      for (const f of ctx.state.selectedFiles) {
        console.log(
          `  ${colors.cyan}${path.basename(f)}${colors.reset} ${colors.dim}(${f})${colors.reset}`,
        );
      }
    }
    return;
  }
  let rawPath = ctx.args.join(" ");
  if (
    (rawPath.startsWith("'") && rawPath.endsWith("'")) ||
    (rawPath.startsWith('"') && rawPath.endsWith('"'))
  ) {
    rawPath = rawPath.slice(1, -1);
  }
  let filePath: string;
  try {
    filePath = ctx.guard.ensureFile(rawPath);
  } catch (error) {
    console.log(
      `\n${colors.red}✗ ${error instanceof Error ? error.message : String(error)}${colors.reset}`,
    );
    return;
  }
  if (!fs.existsSync(filePath)) {
    console.log(`\n${colors.red}✗ File not found: ${rawPath}${colors.reset}`);
    return;
  }
  if (!ctx.state.selectedFiles.includes(filePath)) {
    ctx.state.selectedFiles.push(filePath);
  }
  console.log(
    `\n${colors.green}✓ Pinned: ${colors.bold}${path.basename(filePath)}${colors.reset}`,
  );
  return;
};

export const unselectCommand: CommandHandler = async (ctx) => {
  ctx.state.selectedFiles = [];
  console.log(`\n${colors.green}✓ All pinned files cleared${colors.reset}`);
  return;
};

export const diffCommand: CommandHandler = async (ctx) => {
  console.log(`\n${ctx.git.getDiff()}`);
  return;
};

export const undoCommand: CommandHandler = async (ctx) => {
  const arg = ctx.args[0];
  const tracker = getHunkTracker(ctx.cwd);

  if (arg === "list") {
    const hunks = tracker.listHunks();
    if (hunks.length === 0) {
      console.log(`\n${colors.dim}No hunks recorded in this session.${colors.reset}`);
      return;
    }
    console.log(`\n${colors.bold}Recorded Mutation Hunks:${colors.reset}`);
    for (const h of hunks.slice(-10)) {
      const status = h.reverted
        ? `${colors.yellow}[reverted]${colors.reset}`
        : `${colors.green}[active]${colors.reset}`;
      const timeStr = new Date(h.timestamp).toLocaleTimeString();
      console.log(
        `  ${status} ${colors.cyan}${h.id}${colors.reset} ${h.relativePath} ${colors.dim}(${h.description}, ${timeStr})${colors.reset}`,
      );
    }
    return;
  }

  if (arg === "hunk" || arg === "last") {
    const res = tracker.revertLastHunk();
    if (!res.ok) {
      console.log(`\n${colors.yellow}⚠ ${res.message}${colors.reset}`);
    } else {
      console.log(`\n${colors.green}✓ ${res.message}${colors.reset}`);
    }
    return;
  }

  if (arg && arg.startsWith("hunk-")) {
    const res = tracker.revertHunk(arg);
    if (!res.ok) {
      console.log(`\n${colors.yellow}⚠ ${res.message}${colors.reset}`);
    } else {
      console.log(`\n${colors.green}✓ ${res.message}${colors.reset}`);
    }
    return;
  }

  if (arg) {
    console.log(`\n${undoRun(ctx.cwd, arg)}`);
    return;
  }
  const confirmAction = () =>
    p.confirm({
      message:
        "Are you sure you want to completely discard the last automated ctx.agent commit and restore all files?",
      initialValue: false,
    });
  const confirmed = ctx.promptSuspension
    ? await ctx.promptSuspension(confirmAction)
    : await (async () => {
        ctx.rl.pause();
        try {
          while (process.stdin.read() !== null) {
            /* flush buffered input */
          }
        } catch {
          /* ignore error */
        }
        const res = await confirmAction();
        ctx.rl.resume();
        return res;
      })();
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(`\n${colors.yellow}  ⚠ Undo cancelled.${colors.reset}`);
    return;
  }
  ctx.git.undoLastCommit();
  return;
};

export const imageCommand: CommandHandler = async (ctx) => {
  // `/image <path>` — queue a local image for the next turn.
  // `/image clear` — drop the queue.
  // `/image list` — show what's queued.
  const sub = ctx.args[0];
  if (sub === "clear") {
    const n = ctx.state.pendingAttachments.length;
    ctx.state.pendingAttachments = [];
    console.log(
      `\n${colors.green}✓ Cleared ${n} pending image(s)${colors.reset}`,
    );
    return;
  }
  if (sub === "list") {
    if (ctx.state.pendingAttachments.length === 0) {
      console.log(`\n${colors.dim}No pending images.${colors.reset}`);
      return;
    }
    console.log(
      `\n${colors.bold}Pending images (sent on next prompt):${colors.reset}`,
    );
    for (let i = 0; i < ctx.state.pendingAttachments.length; i++) {
      const block = ctx.state.pendingAttachments[i];
      if (block.type === "image" && block.source.kind === "base64") {
        const approxBytes = Math.floor((block.source.data.length * 3) / 4);
        console.log(
          `  ${i + 1}. ${block.source.mediaType} (~${approxBytes} bytes)`,
        );
      }
    }
    return;
  }
  if (!sub) {
    console.log(
      `\n${colors.yellow}Usage: /image <path> | /image list | /image clear${colors.reset}`,
    );
    return;
  }
  const result = loadImageAsBlock(sub, ctx.cwd);
  if (!result.ok) {
    console.log(
      `\n${colors.red}✗ /image: ${(result as any).error}${colors.reset}`,
    );
    return;
  }
  ctx.state.pendingAttachments.push(result.block);
  console.log(
    `\n${colors.green}✓ Attached${colors.reset} ${colors.dim}${result.mediaType}, ${result.bytes} bytes — will be sent with your next prompt${colors.reset}`,
  );
  return;
};

export const modeCommand: CommandHandler = async (ctx) => {
  ctx.rl.pause();
  const selected = await p.select({
    message: "Select execution mode:",
    options: [
      { value: "PLAN", label: "PLAN Mode (Read-only, dry-run simulation)" },
      { value: "BUILD", label: "BUILD Mode (Writing & modifying allowed)" },
      {
        value: "EXPLORE",
        label: "EXPLORE Mode (Code exploration & LSP, no modifying)",
      },
      { value: "SCOUT", label: "SCOUT Mode (Web search & fetch only)" },
    ],
    initialValue: ctx.state.currentMode,
  });
  ctx.rl.resume();
  if (!p.isCancel(selected) && selected) {
    ctx.state.currentMode = selected as "PLAN" | "BUILD" | "EXPLORE" | "SCOUT";
    console.log(
      `\n${colors.green}✓ Execution mode set to: ${colors.bold}${ctx.state.currentMode}${colors.reset}`,
    );
  } else {
    console.log(
      `\n${colors.dim}Execution mode remains: ${colors.cyan}${ctx.state.currentMode}${colors.reset}`,
    );
  }
  return;
};

export const trustCommand: CommandHandler = async (ctx) => {
  const { isWorkspaceTrusted, trustWorkspace, untrustWorkspace } = await import(
    "../../agent/project-rules.js"
  );
  const sub = (ctx.args[0] ?? "").toLowerCase();
  if (sub === "remove" || sub === "revoke" || sub === "no") {
    untrustWorkspace(ctx.cwd);
    console.log(
      `\n${colors.yellow}✓ Revoked trust for workspace: ${ctx.cwd}${colors.reset}`,
    );
    return;
  }
  if (sub === "yes" || sub === "add" || sub === "allow") {
    trustWorkspace(ctx.cwd);
    console.log(
      `\n${colors.green}✓ Trusted workspace: ${ctx.cwd}${colors.reset}`,
    );
    return;
  }
  const trusted = isWorkspaceTrusted(ctx.cwd);
  if (trusted) {
    console.log(
      `\n${colors.green}✓ Workspace is currently TRUSTED: ${ctx.cwd}${colors.reset}`,
    );
    console.log(
      `${colors.dim}Project rules (AGENTS.md / rules/*.md) are loaded. Run /trust revoke to untrust.${colors.reset}`,
    );
  } else {
    console.log(
      `\n${colors.yellow}⚠️  Workspace is currently UNTRUSTED: ${ctx.cwd}${colors.reset}`,
    );
    console.log(
      `${colors.dim}Run /trust allow to trust this folder and load its project rules.${colors.reset}`,
    );
  }
};

