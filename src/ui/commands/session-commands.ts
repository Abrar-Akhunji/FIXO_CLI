import path from "node:path";
import { colors } from "../colors.js";
import * as p from "../prompts.js";

import { type CommandHandler } from "./types.js";

type SessionCommandContext = Parameters<CommandHandler>[0];

function sessionDisplayName(session: {
  sessionId: string;
  label?: string;
  summary?: string;
}): string {
  const summary = session.summary
    ?.replace(/[^\p{L}\p{N}._\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return session.label || (summary ? summary.slice(0, 64) : `Session ${session.sessionId.slice(0, 8)}`);
}

async function chooseSession(ctx: SessionCommandContext, message: string): Promise<string | null> {
  const { SessionManager } = await import("../../agent/conversation.js");
  const sessions = SessionManager.listSessions(ctx.cwd);
  if (sessions.length === 0) {
    console.log(`\n${colors.dim}No saved sessions for this workspace yet.${colors.reset}`);
    return null;
  }
  const choice = await p.select({
    message,
    maxItems: 12,
    options: sessions.map((session) => ({
      value: session.sessionId,
      label: `${session.sessionId === ctx.state.currentSessionId ? "● " : ""}${sessionDisplayName(session)}`,
      hint: `${new Date(session.timestamp).toLocaleString()} · ${session.model} · ${session.messageCount} msgs · ${session.totalTokens.toLocaleString()} tokens`,
    })),
  });
  return p.isCancel(choice) ? null : choice;
}

async function persistActiveSession(ctx: SessionCommandContext): Promise<void> {
  if (ctx.conversation.getMessageCount() === 0) return;
  const { SessionManager, suggestSessionLabel } = await import("../../agent/conversation.js");
  const { saveSnapshot } = await import("../../runtime/session-snapshots.js");
  ctx.state.currentSessionLabel ||= suggestSessionLabel(ctx.conversation.exportHistory());
  const totalTokens = ctx.state.stats.totalPromptTokens + ctx.state.stats.totalCompletionTokens;
  SessionManager.saveSession(
    ctx.conversation,
    ctx.state.currentModel,
    ctx.state.sessionModifiedFiles,
    {
      prompt_tokens: ctx.state.stats.totalPromptTokens,
      completion_tokens: ctx.state.stats.totalCompletionTokens,
      total_tokens: totalTokens,
    },
    ctx.state.currentSessionId,
    ctx.state.currentSessionLabel,
    ctx.cwd,
  );
  saveSnapshot({
    cwd: ctx.cwd,
    conversation: ctx.conversation.exportHistory().map((message, index) => ({
      role: message.role as any,
      content: message.content || "",
      name: message.name,
      index,
    })),
    tokens: totalTokens,
    model: ctx.state.currentModel,
    mode: ctx.state.currentMode as any,
    selectedFiles: [...ctx.state.selectedFiles],
    summary: ctx.conversation.getSummary(),
    label: ctx.state.currentSessionLabel,
    id: ctx.state.currentSessionId,
    fixedInstructions: ctx.projectConfig?.systemPrompt,
  });
}

async function restoreSession(ctx: SessionCommandContext, rawQuery: string): Promise<void> {
  const { SessionManager, countUserTurns } = await import("../../agent/conversation.js");
  const query = rawQuery.trim();
  const labelMatches = SessionManager.listSessions(ctx.cwd).filter(
    (session) => session.label?.toLowerCase() === query.toLowerCase(),
  );
  const data = labelMatches.length === 1
    ? SessionManager.loadSession(labelMatches[0].sessionId)
    : SessionManager.findSession(query);
  if (data.cwd && path.resolve(data.cwd) !== path.resolve(ctx.cwd)) {
    throw new Error("That session belongs to another workspace.");
  }
  await persistActiveSession(ctx);
  ctx.conversation.restoreFromSnapshot(data.history, data.summary || "", data.tokenUsage?.total_tokens || 0);
  ctx.state.currentModel = data.model;
  ctx.conversation.setContextLimit(ctx.state.currentModel);
  ctx.state.sessionModifiedFiles = [...(data.modifiedFiles || [])];
  ctx.state.currentSessionId = data.sessionId;
  ctx.state.currentSessionLabel = data.label;
  ctx.state.currentMode = "BUILD";
  ctx.state.stats.totalPromptTokens = data.tokenUsage?.prompt_tokens || 0;
  ctx.state.stats.totalCompletionTokens = data.tokenUsage?.completion_tokens || 0;
  ctx.state.stats.totalToolCalls = data.history.filter((message) => message.role === "tool").length;
  ctx.state.stats.totalTasks = countUserTurns(data.history);
  ctx.state.stats.totalDurationMs = 0;
  console.log(
    `\n${colors.green}✓ Resumed ${colors.bold}${sessionDisplayName(data)}${colors.reset} ${colors.dim}· ${data.history.length} messages · BUILD${colors.reset}`,
  );
}

async function startNewSession(ctx: SessionCommandContext): Promise<void> {
  await persistActiveSession(ctx);
  ctx.conversation.clear();
  ctx.state.sessionModifiedFiles = [];
  ctx.state.selectedFiles = [];
  ctx.state.stats = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalToolCalls: 0,
    totalTasks: 0,
    totalDurationMs: 0,
  };
  const { randomUUID } = await import("node:crypto");
  ctx.state.currentSessionId = randomUUID();
  ctx.state.currentSessionLabel = undefined;
  console.log(`\n${colors.green}✓ New session ready.${colors.reset} ${colors.dim}Your previous session is saved and resumable.${colors.reset}`);
}

async function renameSession(ctx: SessionCommandContext, id: string, initialLabel = ""): Promise<void> {
  const { isValidSessionLabel, MAX_LABEL_LENGTH, renameSnapshot } = await import("../../runtime/session-snapshots.js");
  const { SessionManager } = await import("../../agent/conversation.js");
  const entered = initialLabel || await p.text({
    message: "Rename session",
    placeholder: "e.g. Fix provider model picker",
    initialValue: id === ctx.state.currentSessionId ? ctx.state.currentSessionLabel : undefined,
    validate: (value) => isValidSessionLabel(value) ? undefined : `Use 1–${MAX_LABEL_LENGTH} letters, numbers, spaces, dash, underscore, or dot.`,
  });
  if (p.isCancel(entered)) return;
  const label = String(entered).trim();
  if (!isValidSessionLabel(label)) {
    console.log(`\n${colors.red}✗ Invalid session name.${colors.reset}`);
    return;
  }
  const persisted = SessionManager.renameSession(id, label);
  const snapshot = renameSnapshot(ctx.cwd, id, label);
  if (!persisted && id !== ctx.state.currentSessionId && !snapshot.ok) {
    console.log(`\n${colors.red}✗ Session not found: ${id}${colors.reset}`);
    return;
  }
  if (id === ctx.state.currentSessionId) ctx.state.currentSessionLabel = label;
  console.log(`\n${colors.green}✓ Session renamed:${colors.reset} ${colors.cyan}${label}${colors.reset}`);
}

export const sessionCommand: CommandHandler = async (ctx) => {
  const sub = ctx.args[0];
  const { SessionManager } = await import("../../agent/conversation.js");
  if (!sub) {
    const action = await p.select({
      message: "Sessions — saved per workspace and safe to resume repeatedly",
      options: [
        { value: "resume", label: "Resume session", hint: "Search saved conversations" },
        { value: "new", label: "New session", hint: "Save this chat and start clean" },
        { value: "rename", label: "Rename current session", hint: ctx.state.currentSessionLabel ?? ctx.state.currentSessionId.slice(0, 8) },
        { value: "delete", label: "Delete saved session", hint: "Requires confirmation" },
      ],
    });
    if (p.isCancel(action)) return;
    if (action === "new") return startNewSession(ctx);
    if (action === "rename") return renameSession(ctx, ctx.state.currentSessionId);
    const id = await chooseSession(ctx, action === "resume" ? "Resume session" : "Delete saved session");
    if (!id) return;
    if (action === "resume") {
      try { await restoreSession(ctx, id); }
      catch (err) { console.log(`\n${colors.red}✗ Failed to resume: ${(err as Error).message}${colors.reset}`); }
      return;
    }
    const confirmed = await p.confirm({ message: `Delete “${sessionDisplayName(SessionManager.loadSession(id))}”? This cannot be undone.`, initialValue: false });
    if (p.isCancel(confirmed) || !confirmed) return;
    const { deleteSnapshot } = await import("../../runtime/session-snapshots.js");
    const removed = SessionManager.deleteSession(id);
    const removedSnapshot = deleteSnapshot(ctx.cwd, id).ok;
    if (id === ctx.state.currentSessionId) {
      const { randomUUID } = await import("node:crypto");
      ctx.state.currentSessionId = randomUUID();
      ctx.state.currentSessionLabel = undefined;
    }
    console.log(removed || removedSnapshot ? `\n${colors.green}✓ Session deleted.${colors.reset}` : `\n${colors.red}✗ Session not found.${colors.reset}`);
    return;
  }
  if (sub === "rename") {
    const id = ctx.args[1] || ctx.state.currentSessionId;
    const rawLabel = ctx.args.slice(2).join(" ").trim();
    return renameSession(ctx, id, rawLabel);
  }
  if (sub === "list") {
    const list = SessionManager.listSessions(ctx.cwd);
    if (list.length === 0) {
      console.log(`\n${colors.dim}No saved sessions found.${colors.reset}`);
    } else {
      console.log(
        `\n${colors.cyan}${colors.bold}Saved Sessions:${colors.reset}`,
      );
      for (const s of list) {
        const date = new Date(s.timestamp).toLocaleString();
        const labelDisplay = `${colors.cyan}${sessionDisplayName(s)}${colors.reset} ${colors.dim}(${s.sessionId.slice(0, 8)})${colors.reset}`;
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
      await restoreSession(ctx, uuid);
    } catch (err: any) {
      console.log(
        `\n${colors.red}✗ Failed to load session: ${err.message}${colors.reset}`,
      );
    }
  } else if (sub === "new") {
    await startNewSession(ctx);
  } else {
    console.log(
      `\n${colors.yellow}Usage: /session [list | load <id> | new | rename <id> <label>]${colors.reset}`,
    );
  }
  return;
};

export const resumeCommand: CommandHandler = async (ctx) => {
  let query = ctx.args.join(" ").trim();
  if (!query) {
    query = await chooseSession(ctx, "Resume a saved session") ?? "";
    if (!query) return;
  }

  try {
    await restoreSession(ctx, query);
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
  await renameSession(ctx, ctx.state.currentSessionId, rawLabel);
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
