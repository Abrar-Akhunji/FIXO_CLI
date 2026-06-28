import * as fs from "fs";
import * as path from "path";
import * as p from "@clack/prompts";
import { loadImageAsBlock } from "../image-attach.js";
import { undoRun } from "../../runtime/task-session.js";

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
  if (ctx.args[0]) {
    console.log(`\n${undoRun(ctx.cwd, ctx.args[0])}`);
    return;
  }
  ctx.rl.pause();
  const confirmed = await p.confirm({
    message:
      "Are you sure you want to completely discard the last automated ctx.agent commit and restore all files?",
    initialValue: false,
  });
  ctx.rl.resume();
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
