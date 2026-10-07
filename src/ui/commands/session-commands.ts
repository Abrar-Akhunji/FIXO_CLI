import path from "node:path";
import { colors } from "../colors.js";

import { type CommandHandler } from "./types.js";

export const sessionCommand: CommandHandler = async (ctx) => {
  const sub = ctx.args[0];
  const { SessionManager } = await import("../../agent/conversation.js");
  if (sub === "rename") {
    const id = ctx.args[1];
    const rawLabel = ctx.args.slice(2).join(" ").trim();
    const { isValidSessionLabel, MAX_LABEL_LENGTH } =
      await import("../../runtime/session-snapshots.js");
    if (!id || !rawLabel) {
      console.log(
        `\n${colors.yellow}Usage: /session rename <id> <label>${colors.reset}`,
      );
      return;
    }
    if (!isValidSessionLabel(rawLabel)) {
      console.log(
        `\n${colors.red}✗ Invalid label.${colors.reset} ${colors.dim}Max ${MAX_LABEL_LENGTH} chars; letters, digits, space, dash, underscore, dot only.${colors.reset}`,
      );
      return;
    }
    const ok = SessionManager.renameSession(id, rawLabel);
    if (!ok) {
      console.log(`\n${colors.red}✗ Session not found: ${id}${colors.reset}`);
      return;
    }
    if (id === ctx.state.currentSessionId)
      ctx.state.currentSessionLabel = rawLabel;
    console.log(
      `\n${colors.green}✓ Renamed${colors.reset} ${colors.dim}${id}${colors.reset} → ${colors.cyan}${rawLabel}${colors.reset}`,
    );
    return;
  }
  if (sub === "list") {
    const list = SessionManager.listSessions();
    if (list.length === 0) {
      console.log(`\n${colors.dim}No saved sessions found.${colors.reset}`);
    } else {
      console.log(
        `\n${colors.cyan}${colors.bold}Saved Sessions:${colors.reset}`,
      );
      for (const s of list) {
        const date = new Date(s.timestamp).toLocaleString();
        const labelDisplay = s.label
          ? `${colors.cyan}${s.label}${colors.reset} ${colors.dim}(${s.sessionId.slice(0, 8)})${colors.reset}`
          : `${colors.cyan}${s.sessionId}${colors.reset}`;
        console.log(
          `  ${labelDisplay} - ${colors.bold}${s.model}${colors.reset} (${s.messageCount} msgs)`,
        );
        console.log(
          `    ${colors.dim}Created: ${date} | Tokens: ${s.totalTokens.toLocaleString()}${colors.reset}`,
        );
        if (s.summary) {
          console.log(
            `    ${colors.dim}Summary: ${s.summary.slice(0, 80)}...${colors.reset}`,
          );
        }
      }
    }
  } else if (sub === "load") {
    const uuid = ctx.args[1];
    if (!uuid) {
      console.log(
        `\n${colors.yellow}Usage: /session load <uuid>${colors.reset}`,
      );
      return;
    }
    try {
      const data = SessionManager.loadSession(uuid);
      ctx.conversation.clear();
      ctx.conversation.importHistory(data.history);
      ctx.conversation.setSummary(data.summary || "");
      ctx.state.currentModel = data.model;
      ctx.conversation.setContextLimit(ctx.state.currentModel);
      ctx.state.sessionModifiedFiles = data.modifiedFiles || [];
      ctx.state.currentSessionId = data.sessionId;
      ctx.state.currentSessionLabel = data.label;
      ctx.state.stats.totalPromptTokens = data.tokenUsage?.prompt_tokens || 0;
      ctx.state.stats.totalCompletionTokens =
        data.tokenUsage?.completion_tokens || 0;
      console.log(
        `\n${colors.green}✓ Session restored successfully: ${colors.bold}${uuid}${colors.reset}`,
      );
      console.log(
        `${colors.dim}  Model set to: ${colors.cyan}${ctx.state.currentModel}${colors.reset}`,
      );
    } catch (err: any) {
      console.log(
        `\n${colors.red}✗ Failed to load session: ${err.message}${colors.reset}`,
      );
    }
  } else if (sub === "new") {
    ctx.conversation.clear();
    ctx.state.sessionModifiedFiles = [];
    ctx.state.stats.totalPromptTokens = 0;
    ctx.state.stats.totalCompletionTokens = 0;
    ctx.state.stats.totalToolCalls = 0;
    ctx.state.stats.totalTasks = 0;
    ctx.state.stats.totalDurationMs = 0;
    const { randomUUID } = await import("node:crypto");
    ctx.state.currentSessionId = randomUUID();
    ctx.state.currentSessionLabel = undefined;
    SessionManager.saveSession(
      ctx.conversation,
      ctx.state.currentModel,
      ctx.state.sessionModifiedFiles,
      {
        prompt_tokens: ctx.state.stats.totalPromptTokens,
        completion_tokens: ctx.state.stats.totalCompletionTokens,
        total_tokens:
          ctx.state.stats.totalPromptTokens +
          ctx.state.stats.totalCompletionTokens,
      },
      ctx.state.currentSessionId,
      ctx.state.currentSessionLabel,
    );
    try {
      const { saveSnapshot } =
        await import("../../runtime/session-snapshots.js");
      saveSnapshot({
        cwd: ctx.cwd,
        conversation: [],
        tokens: 0,
        model: ctx.state.currentModel,
        mode: ctx.state.currentMode as any,
        selectedFiles: [],
        summary: "",
        label: undefined,
        id: ctx.state.currentSessionId,
        fixedInstructions: ctx.projectConfig?.systemPrompt,
      });
    } catch {
      // Ignore snapshot save errors on new session
    }
    console.log(
      `\n${colors.green}✓ Active ctx.conversation memory purged. New session initialized: ${colors.bold}${ctx.state.currentSessionId}${colors.reset}`,
    );
  } else {
    console.log(
      `\n${colors.yellow}Usage: /session [list | load <uuid> | new | rename <id> <label>]${colors.reset}`,
    );
  }
  return;
};

export const resumeCommand: CommandHandler = async (ctx) => {
  const { SessionManager } = await import("../../agent/conversation.js");
  const query = ctx.args.join(" ").trim();
  if (!query) {
    const list = SessionManager.listSessions(ctx.cwd);
    if (list.length === 0) {
      console.log(
        `\n${colors.dim}No saved sessions for this workspace.${colors.reset}`,
      );
      console.log(
        `${colors.dim}A session is saved after each REPL task and each one-shot run.${colors.reset}`,
      );
      return;
    }
    console.log(
      `\n${colors.cyan}${colors.bold}Sessions for this workspace:${colors.reset}`,
    );
    for (const s of list) {
      const date = new Date(s.timestamp).toLocaleString();
      const label = s.label
        ? `${colors.cyan}${s.label}${colors.reset} `
        : "";
      console.log(
        `  ${label}${colors.bold}${s.sessionId}${colors.reset} ${colors.dim}${s.model} · ${s.messageCount} msgs · ${date}${colors.reset}`,
      );
    }
    console.log(
      `${colors.dim}Reload with /resume <id>. The conversation comes back in BUILD. Files on disk stay as they are.${colors.reset}`,
    );
    console.log(
      `${colors.dim}/rewind <turn> drops later conversation turns. /undo rolls files back.${colors.reset}`,
    );
    return;
  }

  try {
    const data = SessionManager.findSession(query);
    if (data.cwd && path.resolve(data.cwd) !== path.resolve(ctx.cwd)) {
      console.log(
        `\n${colors.red}✗ That session belongs to another workspace.${colors.reset}`,
      );
      return;
    }
    ctx.conversation.clear();
    ctx.conversation.importHistory(data.history);
    ctx.conversation.setSummary(data.summary || "");
    ctx.state.currentModel = data.model;
    ctx.conversation.setContextLimit(ctx.state.currentModel);
    ctx.state.sessionModifiedFiles = [...(data.modifiedFiles || [])];
    ctx.state.currentSessionId = data.sessionId;
    ctx.state.currentSessionLabel = data.label;
    ctx.state.currentMode = "BUILD";
    ctx.state.stats.totalPromptTokens = data.tokenUsage?.prompt_tokens || 0;
    ctx.state.stats.totalCompletionTokens =
      data.tokenUsage?.completion_tokens || 0;
    console.log(
      `\n${colors.green}✓ Resumed ${colors.bold}${data.sessionId}${colors.reset} ${colors.dim}in BUILD${colors.reset}`,
    );
    console.log(
      `${colors.dim}  ${data.history.length} messages. Files on disk were not changed.${colors.reset}`,
    );
    console.log(
      `${colors.dim}  /rewind <turn> drops later turns. /undo rolls files back.${colors.reset}`,
    );
  } catch (err: any) {
    console.log(
      `\n${colors.red}✗ Failed to resume session: ${err.message}${colors.reset}`,
    );
  }
};

export const rewindCommand: CommandHandler = async (ctx) => {
  const { SessionManager, rewindToTurn, countUserTurns } =
    await import("../../agent/conversation.js");
  const raw = ctx.args[0];
  const turn = Number(raw);
  if (!raw || !Number.isInteger(turn) || turn < 1) {
    console.log(
      `\n${colors.yellow}Usage: /rewind <turn>${colors.reset}\n` +
        `${colors.dim}  Keeps conversation turns 1 through N and drops the rest. Does not change files. /undo rolls files back.${colors.reset}`,
    );
    return;
  }
  const history = ctx.conversation.exportHistory();
  const total = countUserTurns(history);
  if (total === 0) {
    console.log(
      `\n${colors.dim}No conversation turns to rewind. Files were not changed.${colors.reset}`,
    );
    return;
  }
  if (turn >= total) {
    console.log(
      `\n${colors.yellow}This session has ${total} turn${total === 1 ? "" : "s"}. No later turns to drop. Files were not changed.${colors.reset}`,
    );
    return;
  }
  ctx.conversation.replaceHistory(rewindToTurn(history, turn));
  try {
    SessionManager.saveSession(
      ctx.conversation,
      ctx.state.currentModel,
      ctx.state.sessionModifiedFiles,
      {
        prompt_tokens: ctx.state.stats.totalPromptTokens,
        completion_tokens: ctx.state.stats.totalCompletionTokens,
        total_tokens:
          ctx.state.stats.totalPromptTokens +
          ctx.state.stats.totalCompletionTokens,
      },
      ctx.state.currentSessionId,
      ctx.state.currentSessionLabel,
      ctx.cwd,
    );
  } catch {
    // The in-memory rewind still stands when the save fails.
  }
  const dropped = total - turn;
  console.log(
    `\n${colors.green}✓ Rewound to turn ${turn}.${colors.reset} ${colors.dim}${dropped} later turn${dropped === 1 ? "" : "s"} dropped.${colors.reset}`,
  );
  console.log(
    `${colors.dim}  Conversation only. Files were not changed. /undo rolls files back.${colors.reset}`,
  );
};

export const renameCommand: CommandHandler = async (ctx) => {
  // Renames the *active* session. Accepts the rest of the
  // input as a free-form label (so spaces don't need quoting).
  const rawLabel = ctx.args.join(" ").trim();
  const { isValidSessionLabel, MAX_LABEL_LENGTH } =
    await import("../../runtime/session-snapshots.js");
  const { SessionManager } = await import("../../agent/conversation.js");
  if (!rawLabel) {
    console.log(
      `\n${colors.yellow}Usage: /rename <label>${colors.reset}\n` +
        `${colors.dim}  Labels are 1..${MAX_LABEL_LENGTH} chars: letters, digits, space, dash, underscore, dot.${colors.reset}`,
    );
    return;
  }
  if (!isValidSessionLabel(rawLabel)) {
    console.log(
      `\n${colors.red}✗ Invalid label.${colors.reset} ${colors.dim}Allowed: letters, digits, space, dash, underscore, dot — max ${MAX_LABEL_LENGTH} chars.${colors.reset}`,
    );
    return;
  }
  // Persist if the session has already been saved at least
  // once; otherwise just remember the label in memory until
  // the next save fires.
  try {
    SessionManager.renameSession(ctx.state.currentSessionId, rawLabel);
  } catch {
    /* tolerate first-rename-before-save */
  }
  ctx.state.currentSessionLabel = rawLabel;
  console.log(
    `\n${colors.green}✓ Session renamed:${colors.reset} ${colors.cyan}${rawLabel}${colors.reset} ${colors.dim}(id: ${ctx.state.currentSessionId})${colors.reset}`,
  );
  return;
};

export const snapshotCommand: CommandHandler = async (ctx) => {
  const label = ctx.args.join(" ").trim() || `snapshot-${Date.now()}`;
  if (!ctx.git.isGitRepo()) {
    console.log(
      `\n${colors.yellow}⚠ Not a ctx.git repository — cannot create snapshot.${colors.reset}`,
    );
    return;
  }
  const hash = ctx.git.createSnapshot(label);
  if (hash) {
    console.log(
      `\n${colors.green}✓ Workspace snapshot created: ${colors.bold}${hash}${colors.reset}${colors.dim} (label: ${label})${colors.reset}`,
    );
    console.log(
      `${colors.dim}  Use /undo or ctx.git revert to roll back to this point.${colors.reset}`,
    );
  }
  return;
};
