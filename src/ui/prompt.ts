import { commandRegistry } from "./commands/index.js";
import type { CommandContext } from "./commands/types.js";
/**
 * Interactive REPL shell for FixO CLI.
 * Provides command handling, file pinning, model selection,
 * and routes user input to the SingleAgent.
 */
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import * as p from "@clack/prompts";
import { SingleAgent } from "../agent/single-agent.js";
import { ConversationManager } from "../agent/conversation.js";
import { GitManager } from "../git/git-manager.js";
import type { AgentContext, ProjectConfig } from "../types.js";
import type { ChatContentBlock } from "../shared/types.js";
import type { FreeLLMConfig } from "../config.js";
import { WorkspaceGuard } from "../workspace-guard.js";
import { listRuns, showRun } from "../runtime/task-session.js";
import { checkPermission } from "../agent/permissions.js";
import { redactedEnv, redactSecrets } from "../runtime/redaction.js";
import { buildIndex, explainIndexedTarget, findInIndex } from "../indexer.js";
import { mcpManager, mcpBridgeManager } from "../agent/tool-executor.js";
import { ProvidersManager } from "../agent/providers-manager.js";

import { C, colors } from "./colors.js";
import { COMMANDS_WITH_DESC, printHelp, formatInputPaths } from "./render.js";
import { renderStatusBar, type CLIState } from "./render-primitives.js";

const c = colors;

/* ──────────────────────── Stats Tracker ──────────────────────── */

export interface SessionStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalToolCalls: number;
  totalTasks: number;
  totalDurationMs: number;
}

/* ──────────────────────── REPL ──────────────────────── */

export interface PromptOptions {
  config: FreeLLMConfig;
  projectConfig?: ProjectConfig;
  cwd: string;
  verbose: boolean;
  resume?: string;
}

export async function startREPL(options: PromptOptions): Promise<void> {
  const { config, projectConfig, cwd, verbose, resume } = options;

  // ──── Initialize components ────
  const agent = new SingleAgent(verbose);
  const conversation = new ConversationManager();
  const git = new GitManager(cwd);
  const guard = new WorkspaceGuard(cwd);

  // Initialize local skills and local MCP bridge
  const { skillsManager } = await import("../agent/skills.js");
  skillsManager.initialize(cwd);
  await mcpBridgeManager.initialize(cwd);

  const { randomUUID } = await import("node:crypto");
  let currentSessionId: string = randomUUID();
  let currentSessionLabel: string | undefined;
  let sessionModifiedFiles: string[] = [];
  let currentMode: "PLAN" | "BUILD" | "EXPLORE" | "SCOUT" = "BUILD";

  let currentModel = projectConfig?.model ?? config.defaultModel ?? "auto";
  conversation.setContextLimit(currentModel);
  let selectedFiles: string[] = [];
  // Image (or future non-text) blocks the user has queued with
  // `/image`. Drained into AgentContext.pendingAttachments on the
  // next non-slash input, then cleared.
  let pendingAttachments: ChatContentBlock[] = [];

  // ──── --resume <id> ────
  if (resume) {
    try {
      const { loadSnapshot, listSnapshots } =
        await import("../runtime/session-snapshots.js");
      const result = loadSnapshot(cwd, resume);
      if (!result.ok || !result.snapshot) {
        console.log(
          `\n${c.red}✗ Resume failed: ${result.error ?? "unknown error"}${c.reset}`,
        );
        const available = listSnapshots(cwd);
        if (available.length > 0) {
          console.log(
            `\n${c.dim}Available snapshots for this workspace:${c.reset}`,
          );
          for (const s of available.slice(0, 5)) {
            console.log(
              `  ${c.cyan}${s.id}${c.reset}  ${c.dim}(${s.items} items, ${s.tokens} tokens)${c.reset}`,
            );
          }
        }
        process.exit(1);
      }
      const snap = result.snapshot;
      conversation.restoreFromSnapshot(
        snap.conversation.map((m) => ({
          role: m.role,
          content: m.content,
          name: m.name,
        })),
        snap.summary ?? "",
        snap.tokens,
      );
      currentModel = snap.model;
      conversation.setContextLimit(currentModel);
      currentMode = snap.mode;
      selectedFiles = [...snap.selectedFiles];
      currentSessionId = snap.id;
      currentSessionLabel = snap.label;
      console.log(
        `\n${c.green}✓ Resumed session${c.reset} ${c.dim}${snap.id}${c.reset}`,
      );
      console.log(
        `  ${c.dim}messages=${snap.conversation.length} tokens=${snap.tokens} model=${snap.model} mode=${snap.mode}${c.reset}`,
      );
      if (snap.summary) {
        console.log(`  ${c.dim}summary: ${snap.summary}${c.reset}`);
      }
    } catch (err) {
      console.log(
        `\n${c.red}✗ Resume failed: ${(err as Error).message}${c.reset}`,
      );
      process.exit(1);
    }
  }

  let isPrompting = false;
  let isTaskRunning = false;
  let currentRunningAgent: SingleAgent | null = null;
  let activeSuggestionsCount = 0;
  interface AutocompleteOption {
    display: string;
    value: string;
    desc: string;
  }

  let currentMatches: AutocompleteOption[] = [];
  let highlightedIndex = 0;
  let workspaceFiles: string[] = [];
  import("../indexer.js")
    .then(({ loadIndex }) => loadIndex(cwd))
    .then((index) => {
      workspaceFiles = index.files.map((f) => f.path);
    })
    .catch(() => {
      // Ignore
    });

  let lastPromptRow = 0;
  let mouseReportingEnabled = false;

  let stats: SessionStats = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalToolCalls: 0,
    totalTasks: 0,
    totalDurationMs: 0,
  };

  // ──── Paste State ────
  interface PasteAttachment {
    id: number;
    content: string;
    lines: number;
  }
  let pendingPastes: PasteAttachment[] = [];
  let pasteIdCounter = 1;
  let isPasting = false;
  let pasteBuffer = "";

  /** Builds the inline token string that goes INTO the rl line buffer. */
  function pasteToken(id: number, lineCount: number): string {
    return `[Paste #${id} +${lineCount} lines]`;
  }

  // The welcome screen (lava logo + command grid) is printed by
  // `src/index.ts` before the REPL starts; the startREPL entry
  // point jumps straight into the prompt loop.

  if (projectConfig?.systemPrompt) {
    console.log(`${c.dim}📋 Project config loaded (.freellmapi.yml)${c.reset}`);
  }

  const historyFile = path.join(os.homedir(), ".fixo_history");
  let commandHistory: string[] = [];
  try {
    if (fs.existsSync(historyFile)) {
      commandHistory = fs
        .readFileSync(historyFile, "utf-8")
        .split("\n")
        .filter(Boolean);
    }
  } catch (error: unknown) {
    if (
      process.env.DEBUG ||
      process.env.VERBOSE ||
      process.argv.includes("--verbose")
    ) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Debug Warning] Failed to read command history from ${historyFile}: ${msg}`,
      );
    }
  }

  // ──── Create readline interface ────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: commandHistory,
    historySize: 1000,
    completer: (line: string) => {
      const list = COMMANDS_WITH_DESC.map((c) => c.cmd);
      if (line.startsWith("/")) {
        const matches = list.filter((cmd) => cmd.startsWith(line));
        return [matches, line];
      }
      return [[], line];
    },
  });

  // ──── Lava status bar ────
  // The new lava-redesign status bar lives directly above the REPL
  // prompt. It re-renders on every mode change and every model
  // change, plus whenever the user starts a new turn (via
  // `promptForInput` below).
  //
  // We map our internal 4-mode enum onto the 3-mode `CLIState`
  // contract that the renderer expects: EXPLORE/SCOUT collapse to
  // BUILD (the default lava-coloured pill). This keeps the
  // existing /mode command semantics intact while still letting
  // the new bar visualise the live mode.
  const buildLavaStatusState = (): CLIState => {
    const modeForState: CLIState["mode"] =
      currentMode === "PLAN" ? "PLAN" : "BUILD";
    let contextPercent = 0;
    try {
      const used = conversation.getTotalTokens();
      const limit = conversation.getContextLimit();
      if (limit > 0) {
        contextPercent = Math.min(100, Math.round((used / limit) * 100));
      }
    } catch {
      // Conversation not yet hydrated — show 0% rather than NaN.
    }
    let providersCount = 0;
    try {
      providersCount = ProvidersManager.list().length;
    } catch {
      // Vault not yet available — show 0.
    }
    const currentBranch = git.isGitRepo() ? git.getCurrentBranch() : "";
    return {
      mode: modeForState,
      routing: "auto",
      model: currentModel,
      // Show '(detached HEAD)' instead of bare 'detached' so the
      // status bar is unambiguous — the previous label read as "the
      // CLI is detached from the API server" to several users.
      branch: currentBranch || "(detached HEAD)",
      contextPercent,
      providersCount,
      transport: config.provider_mode === "direct" ? "direct" : "freellmapi",
    };
  };

  const drawLavaStatusBar = (): void => {
    // renderStatusBar writes a single `\r` line (no newline) so the
    // REPL prompt can sit on the same row as a redo. For the
    // normal "above the prompt" layout we want a full line of its
    // own, so we manually append a newline after the renderer
    // returns.
    renderStatusBar(buildLavaStatusState());
    process.stdout.write("\n");
    if (pendingPastes.length > 0) {
      const tokens = pendingPastes
        .map((p) => pasteToken(p.id, p.lines))
        .join("  ");
      process.stdout.write(`${c.dim}  ${tokens}${c.reset}\n`);
    }
  };

  // Surface the result of a live model fetch as a one-line status.
  // Invoked from /providers add and /providers test so the user
  // immediately sees whether the live API was reachable or whether
  // the picker will fall back to the cached / registry list.
  const refreshModelsForProvider = async (name: string): Promise<void> => {
    try {
      const result = await ProvidersManager.fetchRemoteModels(name);
      if (result.source === "live") {
        console.log(
          `${c.green}✓ Fetched ${result.models.length} models from live API.${c.reset}`,
        );
      } else if (result.source === "cache") {
        const ageHours = Math.max(
          0,
          Math.round(
            (Date.now() - Date.parse(result.fetchedAt)) / (60 * 60 * 1000),
          ),
        );
        console.log(
          `${c.yellow}⚠ Live fetch unavailable — using cached list (~${ageHours}h old).${c.reset}`,
        );
      } else {
        console.log(
          `${c.yellow}⚠ Live fetch failed — using built-in registry list (marked [unverified] in /model).${c.reset}`,
        );
      }
    } catch (err: any) {
      console.log(
        `${c.dim}  (model list refresh skipped: ${err?.message ?? err})${c.reset}`,
      );
    }
  };

  // ──── Mouse Reporting Helpers ────
  function enableMouseReporting() {
    if (process.stdout.isTTY && !mouseReportingEnabled) {
      process.stdout.write("\x1b[?1003h\x1b[?1006h");
      mouseReportingEnabled = true;
    }
  }

  function disableMouseReporting() {
    if (process.stdout.isTTY && mouseReportingEnabled) {
      process.stdout.write("\x1b[?1003l\x1b[?1006l");
      mouseReportingEnabled = false;
    }
  }

  function disableMouseReportingSync() {
    try {
      if (process.stdout.isTTY && mouseReportingEnabled) {
        fs.writeSync(1, "\x1b[?1003l\x1b[?1006l");
        mouseReportingEnabled = false;
      }
    } catch (e: any) {
      if (
        process.env.DEBUG ||
        process.env.VERBOSE ||
        process.argv.includes("--verbose")
      ) {
        console.warn(
          `[Debug Warning] Failed to disable mouse reporting: ${e.message || e}`,
        );
      }
    }
  }

  // Register synchronous exit cleanups
  const exitCleanup = () => {
    try {
      if (process.stdout.isTTY) {
        fs.writeSync(1, "\x1b[?2004l");
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.VERBOSE) {
        console.warn("[exit] writeSync failed:", e);
      }
    }
    try {
      const hist = (rl as any).history;
      if (Array.isArray(hist)) {
        fs.writeFileSync(historyFile, hist.join("\n"), "utf-8");
      }
    } catch (error: unknown) {
      if (
        process.env.DEBUG ||
        process.env.VERBOSE ||
        process.argv.includes("--verbose")
      ) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Debug Warning] Failed to write history file on exit: ${msg}`,
        );
      }
    }
    disableMouseReportingSync();
    mcpManager.shutdown();
    mcpBridgeManager.shutdown();
    // Restore the original `process.stdin.emit` so a Ctrl-C or
    // uncaught-exit doesn't leave the monkey-patch installed.
    // Previously this was only done on `/exit`, so SIGINT and
    // SIGTERM corrupted subsequent stdin listeners.
    try {
      (process.stdin as { emit: unknown }).emit = originalEmit;
      process.stdin.off("keypress", keypressHandler);
    } catch {
      // ignore — process may already be tearing down
    }
  };
  process.on("exit", exitCleanup);

  // ──── Double-Ctrl+C (and task-abort) handler ────
  const SIGINT_RESET_MS = 2000;

  let lastSigintTime = 0;
  let sigintResetTimer: NodeJS.Timeout | null = null;
  // Dedup guard: prevents double-firing when both `rl` and `process` SIGINT listeners fire.
  let sigintHandling = false;

  const sigintHandler = () => {
    if (sigintHandling) return;
    sigintHandling = true;
    try {
      if (isTaskRunning && currentRunningAgent) {
        // A task is running — cancel it instead of exiting
        currentRunningAgent.abort();
        return;
      }

      const now = Date.now();
      if (now - lastSigintTime > SIGINT_RESET_MS) {
        // First press (or after reset window)

        lastSigintTime = now;
        // Write hint and redraw the prompt
        const promptStr = `> `;
        process.stdout.write(
          `\n${c.yellow}⚠ Press Ctrl+C again to exit${c.reset}\n`,
        );
        drawLavaStatusBar();
        process.stdout.write(
          `${c.dim}─────────────────────────────────────────────────────────────────${c.reset}\n`,
        );
        process.stdout.write(promptStr);
        // Auto-reset after the window expires
        if (sigintResetTimer) clearTimeout(sigintResetTimer);
        sigintResetTimer = setTimeout(() => {
          sigintResetTimer = null;
        }, SIGINT_RESET_MS);
        return;
      }

      // Second press within the window — exit
      if (sigintResetTimer) clearTimeout(sigintResetTimer);
      sigintResetTimer = null;

      exitCleanup();
      console.log("\n\n👋 FixO CLI session ended safely. Core engine offline.");
      process.exit(0);
    } finally {
      sigintHandling = false;
    }
  };
  // Listen on both the readline interface (catches Ctrl+C during rl.question())
  // and the process (fallback for non-readline scenarios).
  rl.on("SIGINT", sigintHandler);
  process.on("SIGINT", sigintHandler);

  const sigtermHandler = () => {
    exitCleanup();
    process.exit(0);
  };
  process.on("SIGTERM", sigtermHandler);

  const uncaughtExceptionHandler = (err: Error) => {
    exitCleanup();
    console.error("\n🔥 Uncaught Exception:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  };
  process.on("uncaughtException", uncaughtExceptionHandler);

  // ──── Suggestion Box Helpers ────
  function clearSuggestions() {
    if (activeSuggestionsCount > 0) {
      disableMouseReporting();
      const currentCursor = rl.cursor;
      readline.moveCursor(process.stdout, 0, 1);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write("\x1b[J");
      readline.moveCursor(process.stdout, 0, -1);
      readline.cursorTo(process.stdout, 2 + currentCursor);
      activeSuggestionsCount = 0;
    }
  }

  function drawSuggestions(matches: AutocompleteOption[]) {
    clearSuggestions();
    if (matches.length === 0) return;

    enableMouseReporting();

    const currentCursor = rl.cursor;
    let output = "\n";

    const borderTop = `${c.snow}┌────────────────────────────────────────────────────────┐${c.reset}\n`;
    const borderBottom = `${c.snow}└────────────────────────────────────────────────────────┘${c.reset}`;
    output += borderTop;

    let startIndex = 0;
    if (highlightedIndex >= 8) {
      startIndex = highlightedIndex - 7;
    }
    const visibleMatches = matches.slice(startIndex, startIndex + 8);

    visibleMatches.forEach((item, index) => {
      const actualIndex = startIndex + index;
      const isHighlighted = actualIndex === highlightedIndex;
      const prefix = isHighlighted ? "❯ " : "  ";

      const displayStr = item.display;
      const descStr = item.desc || "";

      const displayLimit = 25;
      const descLimit = 28;

      let dispText = displayStr;
      if (dispText.length > displayLimit) {
        dispText = dispText.slice(0, displayLimit - 3) + "...";
      }
      dispText = dispText.padEnd(displayLimit);

      let descText = descStr;
      if (descText.length > descLimit) {
        descText = descText.slice(0, descLimit - 3) + "...";
      }
      descText = descText.padEnd(descLimit);

      if (isHighlighted) {
        output += `${c.snow}│${c.reset} \x1b[48;5;236m\x1b[38;5;208m${prefix}${dispText} ${c.dim}${descText}\x1b[0m ${c.snow}│${c.reset}\n`;
      } else {
        output += `${c.snow}│${c.reset} ${prefix}${dispText} ${c.dim}${descText}${c.reset} ${c.snow}│${c.reset}\n`;
      }
    });

    if (matches.length > 8) {
      const remaining = matches.length - 8;
      const moreStr = `... and ${remaining} more matches`.padEnd(54);
      output += `${c.snow}│${c.reset} ${c.dim}${moreStr}${c.reset} ${c.snow}│${c.reset}\n`;
    }
    output += borderBottom;

    activeSuggestionsCount =
      visibleMatches.length + (matches.length > 8 ? 1 : 0) + 2;
    process.stdout.write(output);

    readline.moveCursor(process.stdout, 0, -activeSuggestionsCount);
    readline.cursorTo(process.stdout, 2 + currentCursor);

    // Request cursor position asynchronously
    process.stdout.write("\x1b[6n");
  }

  function getActiveToken(lineStr: string, cursorOffset: number) {
    const beforeCursor = lineStr.slice(0, cursorOffset);
    const lastSlash = beforeCursor.lastIndexOf("/");
    const lastAt = beforeCursor.lastIndexOf("@");

    const lastTriggerIdx = Math.max(lastSlash, lastAt);
    if (lastTriggerIdx === -1) {
      return { trigger: null, query: "", index: -1 };
    }

    if (lastTriggerIdx > 0 && !/\s/.test(beforeCursor[lastTriggerIdx - 1])) {
      return { trigger: null, query: "", index: -1 };
    }

    const trigger = lastTriggerIdx === lastSlash ? "/" : "@";
    const query = beforeCursor.slice(lastTriggerIdx + 1);

    if (/\s/.test(query)) {
      return { trigger: null, query: "", index: -1 };
    }

    return { trigger, query, index: lastTriggerIdx };
  }

  function getSuggestions(
    lineStr: string,
    cursorOffset: number,
  ): {
    options: AutocompleteOption[];
    trigger: "/" | "@" | null;
    query: string;
    triggerIndex: number;
  } {
    const active = getActiveToken(lineStr, cursorOffset);
    if (!active.trigger) {
      return { options: [], trigger: null, query: "", triggerIndex: -1 };
    }

    const q = active.query.toLowerCase();

    if (active.trigger === "/") {
      const matches = COMMANDS_WITH_DESC.filter((c) =>
        c.cmd
          .toLowerCase()
          .startsWith(
            active.query.toLowerCase() ? "/" + active.query.toLowerCase() : "/",
          ),
      );
      const options = matches.map((m) => ({
        display: m.cmd,
        value: m.cmd + " ",
        desc: m.desc,
      }));
      return {
        options,
        trigger: "/",
        query: active.query,
        triggerIndex: active.index,
      };
    } else {
      const options: AutocompleteOption[] = [];

      const subagents = [
        { name: "code", desc: "Code Agent: read and modify workspace files" },
        { name: "test", desc: "Test Agent: write, run, or fix tests" },
        {
          name: "doc",
          desc: "Documentation Agent: edit markdown and docstrings",
        },
        {
          name: "reviewer",
          desc: "Reviewer Agent: audit diffs and code modifications",
        },
      ];
      for (const sa of subagents) {
        const key = "@" + sa.name;
        if (!active.query || sa.name.toLowerCase().startsWith(q)) {
          options.push({
            display: key,
            value: key + " ",
            desc: sa.desc,
          });
        }
      }

      try {
        const list = skillsManager.getSkills();
        for (const s of list) {
          const key = "@" + s.name;
          if (!active.query || s.name.toLowerCase().startsWith(q)) {
            options.push({
              display: key,
              value: key + " ",
              desc: s.description || "Skill profile",
            });
          }
        }
      } catch (error: unknown) {
        if (
          process.env.DEBUG ||
          process.env.VERBOSE ||
          process.argv.includes("--verbose")
        ) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[Debug Warning] Failed to load skills list: ${msg}`);
        }
      }

      const matchingFiles = workspaceFiles.filter(
        (f) =>
          f.toLowerCase().includes(q) ||
          path.basename(f).toLowerCase().startsWith(q),
      );
      matchingFiles.sort((a, b) => {
        const baseA = path.basename(a).toLowerCase();
        const baseB = path.basename(b).toLowerCase();
        const aStarts = baseA.startsWith(q);
        const bStarts = baseB.startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.localeCompare(b);
      });

      for (const file of matchingFiles.slice(0, 12)) {
        const key = "@" + file;
        options.push({
          display: "@" + path.basename(file),
          value: key + " ",
          desc: file,
        });
      }

      return {
        options,
        trigger: "@",
        query: active.query,
        triggerIndex: active.index,
      };
    }
  }

  // ──── Keypress registration ────
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h");
  }

  const keypressHandler = (_char: any, key: any) => {
    if (!isPrompting) return;
    // Intercept Escape to cancel a running task even when readline is in a question state
    if (key && key.name === "escape") {
      if (isTaskRunning && currentRunningAgent) {
        currentRunningAgent.abort();
        return;
      }
      return;
    }
    if (
      key &&
      (key.name === "up" ||
        key.name === "down" ||
        key.name === "tab" ||
        key.name === "enter" ||
        key.name === "return")
    ) {
      return;
    }
    process.nextTick(() => {
      if (!isPrompting) return;
      const line = rl.line;
      const cursor = rl.cursor;
      const suggs = getSuggestions(line, cursor);
      if (suggs.trigger) {
        const oldMatchesCount = currentMatches.length;
        currentMatches = suggs.options;
        if (currentMatches.length !== oldMatchesCount) {
          highlightedIndex = 0;
        }
        drawSuggestions(currentMatches);
      } else {
        clearSuggestions();
        currentMatches = [];
      }
    });
  };

  process.stdin.on("keypress", keypressHandler);

  let mouseBuffer = "";

  function getPasteTokenAtCursorForBackspace(line: string, cursor: number) {
    const regex = /\[Paste #(\d+) \+\d+ lines\]/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = regex.lastIndex;
      if (cursor > start && cursor <= end) {
        return { id: parseInt(match[1], 10), start, end };
      }
    }
    return null;
  }

  function getPasteTokenAtCursorForDelete(line: string, cursor: number) {
    const regex = /\[Paste #(\d+) \+\d+ lines\]/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = regex.lastIndex;
      if (cursor >= start && cursor < end) {
        return { id: parseInt(match[1], 10), start, end };
      }
    }
    return null;
  }

  // Monkey-patch process.stdin.emit to intercept keypress and mouse events
  const originalEmit = process.stdin.emit as any;
  (process.stdin as any).emit = function (event: string, ...args: any[]) {
    if (event === "data") {
      const rawData = args[0];
      if (rawData) {
        let str = mouseBuffer + rawData.toString();
        mouseBuffer = "";

        // ── Bracketed Paste Interception ──────────────────────────────
        // This fires when the terminal supports bracketed paste mode
        // (\x1b[?2004h is enabled in promptForInput on every render).
        if (str.includes("\x1b[200~")) {
          const parts = str.split("\x1b[200~");
          // Any characters before the paste-start marker are real keystrokes
          if (parts[0]) {
            originalEmit.apply(this, ["data", Buffer.from(parts[0])]);
          }
          isPasting = true;
          pasteBuffer = "";
          str = parts.slice(1).join("\x1b[200~");
        }

        if (isPasting) {
          if (str.includes("\x1b[201~")) {
            const parts = str.split("\x1b[201~");
            pasteBuffer += parts[0];
            isPasting = false;

            const rawLines = pasteBuffer.split(/\r\n|\r|\n/);
            // Trim a single trailing empty line that terminals often append
            if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
              rawLines.pop();
            }

            if (rawLines.length > 1) {
              // Multi-line paste → attachment
              const id = pasteIdCounter++;
              pendingPastes.push({
                id,
                content: pasteBuffer.replace(/\r\n/g, "\n"),
                lines: rawLines.length,
              });
              injectTokenIntoPrompt(pasteToken(id, rawLines.length));
            } else {
              // Single line → let it flow into rl normally
              rl.write(pasteBuffer);
            }

            pasteBuffer = "";
            str = parts.slice(1).join("\x1b[201~");
            if (str.length === 0) return true;
          } else {
            // Still accumulating paste data
            pasteBuffer += str;
            return true;
          }
        }

        // ── Heuristic Paste Fallback ──────────────────────────────────
        // For terminals that strip bracketed paste codes, multi-line
        // pastes arrive as a single large data chunk containing \n chars.
        // Humans cannot produce this pattern; only paste events do.
        //
        // Guards:
        //   1. Not already in isPasting mode (handled above).
        //   2. The chunk is NOT a bare Enter keypress.
        //   3. At least 3 non-empty lines AND total length > 80 chars.
        //      (Prevents firing on "2\n" or any short accidental newline.)
        if (!isPasting && str.includes("\n")) {
          const isJustEnter = str === "\r" || str === "\n" || str === "\r\n";
          if (!isJustEnter && str.length > 80) {
            const rawLines = str.split(/\r\n|\r|\n/);
            // Remove a single trailing empty line
            if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
              rawLines.pop();
            }
            const nonEmptyLines = rawLines.filter((l) => l.trim().length > 0);
            if (nonEmptyLines.length >= 3) {
              const id = pasteIdCounter++;
              pendingPastes.push({
                id,
                content: str.replace(/\r\n/g, "\n"),
                lines: rawLines.length,
              });
              injectTokenIntoPrompt(pasteToken(id, rawLines.length));
              // Swallow the chunk so readline never sees the \n characters
              return true;
            }
          }
        }

        // Intercept cursor position response
        if (str.startsWith("\x1b[") && str.endsWith("R")) {
          const match = str.match(/\x1b\[(\d+);(\d+)R/);
          if (match) {
            lastPromptRow = parseInt(match[1], 10);
            return true;
          }
        }

        // Remove fully-formed SGR mouse events
        str = str.replace(/\x1b\[<[0-9;]+[Mm]/g, "");

        // Buffer any trailing partial SGR mouse event
        const partialIdx = str.lastIndexOf("\x1b[<");
        if (partialIdx !== -1) {
          const remaining = str.slice(partialIdx);
          if (!/[Mm]/.test(remaining)) {
            mouseBuffer = remaining;
            str = str.slice(0, partialIdx);
          }
        }

        // Process mouse events for suggestions list if present in raw data
        const mouseMatches = rawData
          .toString()
          .match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g);
        if (mouseMatches) {
          for (const rawMatch of mouseMatches) {
            const m = rawMatch.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
            if (m) {
              const [_, buttonStr, _colStr, rowStr, action] = m;
              const button = parseInt(buttonStr, 10);
              const clickRow = parseInt(rowStr, 10);
              const isPressed = action === "M";

              if (activeSuggestionsCount > 0 && lastPromptRow > 0) {
                // Mouse Scroll UP
                if (button === 64) {
                  highlightedIndex =
                    (highlightedIndex - 1 + currentMatches.length) %
                    currentMatches.length;
                  drawSuggestions(currentMatches);
                }
                // Mouse Scroll DOWN
                else if (button === 65) {
                  highlightedIndex =
                    (highlightedIndex + 1) % currentMatches.length;
                  drawSuggestions(currentMatches);
                } else {
                  const boxStartRow = lastPromptRow + 1;
                  let startIndex = 0;
                  if (highlightedIndex >= 8) {
                    startIndex = highlightedIndex - 7;
                  }
                  const clickedItemIndex = clickRow - boxStartRow - 1;
                  const actualHoveredIndex = startIndex + clickedItemIndex;

                  if (
                    actualHoveredIndex >= 0 &&
                    actualHoveredIndex < currentMatches.length &&
                    clickedItemIndex < Math.min(currentMatches.length, 8)
                  ) {
                    // Mouse hover/motion
                    if (button === 35 || button === 32) {
                      if (highlightedIndex !== actualHoveredIndex) {
                        highlightedIndex = actualHoveredIndex;
                        drawSuggestions(currentMatches);
                      }
                    }
                    // Left click press
                    else if (button === 0 && isPressed) {
                      highlightedIndex = actualHoveredIndex;
                      const selected = currentMatches[highlightedIndex];
                      if (selected) {
                        const line = rl.line;
                        const cursor = rl.cursor;
                        const active = getActiveToken(line, cursor);
                        if (active.index !== -1) {
                          const beforeTrigger = line.slice(0, active.index);
                          const afterCursor = line.slice(cursor);
                          const newLine =
                            beforeTrigger + selected.value + afterCursor;

                          rl.write(null, { ctrl: true, name: "u" });
                          rl.write(newLine);
                          const moveCount =
                            newLine.length -
                            (beforeTrigger.length + selected.value.length);
                          for (let i = 0; i < moveCount; i++) {
                            rl.write(null, { name: "left" });
                          }
                        }
                        clearSuggestions();
                      }
                      return true;
                    }
                  }
                }
              }
            }
          }
        }

        // If the remaining string is empty, forward an empty buffer rather than swallowing
        args[0] = str.length > 0 ? Buffer.from(str) : Buffer.alloc(0);
      }
    }

    if (event === "keypress") {
      const [_char, key] = args;

      if (isPrompting && key) {
        if (key.name === "backspace") {
          const line = rl.line;
          const cursor = rl.cursor;
          const tokenMatch = getPasteTokenAtCursorForBackspace(line, cursor);
          if (tokenMatch) {
            const { id, start, end } = tokenMatch;
            pendingPastes = pendingPastes.filter((p) => p.id !== id);
            const newLine = line.slice(0, start) + line.slice(end);
            const newCursor = start;
            (rl as any).line = newLine;
            (rl as any).cursor = newCursor;

            (rl as any)._refreshLine();
            return true;
          }
        } else if (key.name === "delete") {
          const line = rl.line;
          const cursor = rl.cursor;
          const tokenMatch = getPasteTokenAtCursorForDelete(line, cursor);
          if (tokenMatch) {
            const { id, start, end } = tokenMatch;
            pendingPastes = pendingPastes.filter((p) => p.id !== id);
            const newLine = line.slice(0, start) + line.slice(end);
            const newCursor = start;
            (rl as any).line = newLine;
            (rl as any).cursor = newCursor;

            (rl as any)._refreshLine();
            return true;
          }
        }
      }

      // Intercept Escape or Ctrl+C to cancel a running task (when not prompting)
      if (
        key &&
        key.name === "escape" &&
        isTaskRunning &&
        currentRunningAgent
      ) {
        currentRunningAgent.abort();
        return true;
      }
      if (
        key &&
        key.name === "c" &&
        key.ctrl &&
        isTaskRunning &&
        currentRunningAgent
      ) {
        currentRunningAgent.abort();
        return true;
      }

      // Tab on empty line → cycle mode (BEFORE suggestion handling, so it always works)
      if (isPrompting && key && key.name === "tab" && rl.line.trim() === "") {
        const modes: Array<"PLAN" | "BUILD" | "EXPLORE" | "SCOUT"> = [
          "BUILD",
          "EXPLORE",
          "SCOUT",
          "PLAN",
        ];
        const nextIndex = (modes.indexOf(currentMode) + 1) % modes.length;
        currentMode = modes[nextIndex];

        // Clear readline state
        (rl as any).line = "";
        (rl as any).cursor = 0;

        // Clear current prompt line:
        process.stdout.write("\r\x1b[K");

        // Re-draw the lava status bar with the new mode. The
        // legacy dirLabel/branchLabel/modelLabel/modeLabel row
        // is gone — the new bar carries all of that information.
        drawLavaStatusBar();
        process.stdout.write(
          `${c.dim}─────────────────────────────────────────────────────────────────${c.reset}\n> `,
        );
        return true; // swallow keypress
      }
    }
    return originalEmit.apply(this, [event, ...args]);
  };

  /**
   * Injects `token` into the readline line buffer and redraws the prompt line.
   * Any text already in rl.line is preserved and appended after the token
   * with a space separator.
   *
   * This produces the Claude Code / Antigravity pattern:
   *   > [Paste #1 +45 lines] <any pre-paste text the user was typing>
   */
  function injectTokenIntoPrompt(token: string): void {
    // 1. Capture whatever the user had typed before pasting
    const preTyped = (rl.line ?? "").trimEnd();

    // 2. Clear the entire current line visually
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    // 3. Wipe rl's internal buffer with Ctrl-U so readline tracks zero length
    rl.write(null, { ctrl: true, name: "u" });

    // 4. Write the token (+ pre-typed text if any) back into rl
    const newLine = preTyped.length > 0 ? `${token} ${preTyped}` : token;
    rl.write(newLine);
    // rl.write() both updates rl.line and echoes the characters to stdout,
    // so the user sees:   > [Paste #1 +45 lines] Refactor th
    // with the cursor positioned after the last character.
  }

  // ──── REPL loop ────
  const promptForInput = (): void => {
    // Restore raw mode and resume streams to recover from any clack/spinner interactions
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      // Explicitly re-enable Bracketed Paste Mode just in case a spinner disabled it
      process.stdout.write("\x1b[?2004h");
    }
    process.stdin.resume();
    rl.resume();

    // The new lava status bar is the ONLY status surface — it
    // replaces the legacy dirLabel/branchLabel/modelLabel/modeLabel
    // row entirely. Mode + model + branch + context usage are all
    // visible in the bar; the prompt itself is the lava `›` glyph.
    drawLavaStatusBar();

    isPrompting = true;
    const promptPrefix = `\n${C.SNOW4}╭─${C.RESET} 👤 ${C.LAVA}${C.BOLD}User${C.RESET}\n${C.SNOW4}╰─❯${C.RESET} `;
    rl.question(promptPrefix, async (input) => {
      isPrompting = false;
      disableMouseReporting();
      clearSuggestions();
      const trimmed = input.trim();

      if (!trimmed) {
        promptForInput();
        return;
      }

      try {
        await handleInput(trimmed);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isAbort =
          msg.includes("aborted") ||
          msg.includes("cancelled") ||
          msg.includes("cancel");
        if (!isAbort) {
          console.log(`\n${c.red}✗ Error: ${msg}${c.reset}`);
        }

        // Actionable error suggestions
        if (msg.includes("ECONNREFUSED")) {
          console.log(
            `${c.dim}  → Proxy server is down. Restart with: npm run dev${c.reset}`,
          );
        } else if (msg.includes("413")) {
          console.log(
            `${c.dim}  → Reduce context: /unselect to clear pinned files${c.reset}`,
          );
        } else if (msg.includes("429")) {
          console.log(
            `${c.dim}  → Rate limited. Wait a moment or add more API keys.${c.reset}`,
          );
        } else if (
          msg.includes("404") ||
          msg.toLowerCase().includes("model not found")
        ) {
          rl.pause();
          const fallback = await p.confirm({
            message: `Model '${currentModel}' not found or unavailable. Switch to default 'auto' model and retry?`,
            initialValue: true,
          });
          rl.resume();
          if (fallback && !p.isCancel(fallback)) {
            console.log(
              `\n${c.dim}Switching to 'auto' and retrying...${c.reset}`,
            );
            currentModel = "auto";
            try {
              await handleInput(trimmed);
            } catch (retryError) {
              console.log(
                `\n${c.red}✗ Retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}${c.reset}`,
              );
            }
          }
        }
      }

      promptForInput();
    });
  };

  // ──── Input handler ────
  async function handleInput(rawInput: string): Promise<void> {
    // ── Payload assembly ─────────────────────────────────────────────
    // Strip paste tokens from the user's typed text so the LLM only
    // sees the clean question, not "[Paste #1 +45 lines]" literally.
    const tokenPattern = /\[Paste #\d+ \+\d+ lines\]\s*/g;
    const cleanRawInput = rawInput.replace(tokenPattern, "").trim();

    // Build final LLM payload: question first, context blocks after.
    let input = cleanRawInput;
    if (pendingPastes.length > 0) {
      const contextBlocks = pendingPastes
        .map(
          (p) =>
            `<pasted_context id="${p.id}">\n${p.content}\n</pasted_context>`,
        )
        .join("\n\n");
      input =
        cleanRawInput.length > 0
          ? `${cleanRawInput}\n\n${contextBlocks}`
          : contextBlocks;
    }

    // ─── Slash commands ───
    if (input.startsWith("/")) {
      const parts = input.split(/\s+/).filter(Boolean);
      const cmd = parts[0];
      const args = parts.slice(1);

      switch (cmd) {
        case "/exit":
        case "/quit":
          disableMouseReporting();
          console.log(`\n${c.dim}👋 Goodbye!${c.reset}`);
          process.stdin.off("keypress", keypressHandler);
          (process.stdin as any).emit = originalEmit;
          process.off("exit", exitCleanup);
          process.off("SIGINT", sigintHandler);
          process.off("SIGTERM", sigtermHandler);
          process.off("uncaughtException", uncaughtExceptionHandler);
          rl.close();
          process.exit(0);

        case "/help":
          printHelp();
          return;

        case "/view": {
          const id = parseInt(args[0] ?? "", 10);
          if (isNaN(id)) {
            console.log(`\n${c.yellow}⚠ Usage: /view <paste-id>${c.reset}`);
            promptForInput();
            return;
          }
          const paste = pendingPastes.find((p) => p.id === id);
          if (!paste) {
            console.log(
              `\n${c.yellow}⚠ Paste #${id} not found. Active pastes: ${
                pendingPastes.length > 0
                  ? pendingPastes.map((p) => `#${p.id}`).join(", ")
                  : "none"
              }${c.reset}`,
            );
            promptForInput();
            return;
          }
          const border = `${c.dim}${"─".repeat(60)}${c.reset}`;
          console.log(`\n${border}`);
          console.log(
            `${c.cyan}Paste #${paste.id} — ${paste.lines} lines${c.reset}`,
          );
          console.log(border);
          console.log(paste.content);
          console.log(border);
          promptForInput();
          return;
        }

        case "/edit": {
          const id = parseInt(args[0] ?? "", 10);
          if (isNaN(id)) {
            console.log(`\n${c.yellow}⚠ Usage: /edit <paste-id>${c.reset}`);
            promptForInput();
            return;
          }
          const paste = pendingPastes.find((p) => p.id === id);
          if (!paste) {
            console.log(`\n${c.yellow}⚠ Paste #${id} not found.${c.reset}`);
            promptForInput();
            return;
          }
          const tmpFile = path.join(
            os.tmpdir(),
            `fixo-paste-${id}-${Date.now()}.txt`,
          );
          try {
            fs.writeFileSync(tmpFile, paste.content, "utf-8");

            // Release the terminal before handing it to the external editor
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdout.write("\x1b[?2004l"); // disable bracketed paste while editor is open

            const editor =
              process.env.VISUAL ??
              process.env.EDITOR ??
              (os.platform() === "win32" ? "notepad" : "nano");
            const { spawnSync } = await import("child_process");
            spawnSync(editor, [tmpFile], { stdio: "inherit" });

            const edited = fs.readFileSync(tmpFile, "utf-8");
            fs.unlinkSync(tmpFile);

            if (edited.trim().length === 0) {
              console.log(
                `\n${c.yellow}⚠ Editor returned empty content — paste #${id} unchanged.${c.reset}`,
              );
            } else {
              paste.content = edited;
              paste.lines = edited
                .split(/\r?\n/)
                .filter((l) => l.length > 0).length;
              console.log(
                `\n${c.green}✓ Updated Paste #${id} (${paste.lines} lines)${c.reset}`,
              );
            }
          } catch (err: any) {
            console.log(`\n${c.red}✗ /edit failed: ${err.message}${c.reset}`);
            try {
              fs.unlinkSync(tmpFile);
            } catch {
              /* already gone */
            }
          } finally {
            // Reclaim raw mode and bracketed paste before returning to REPL
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdout.write("\x1b[?2004h");
          }
          promptForInput();
          return;
        }

        case "/pastes": {
          if (pendingPastes.length === 0) {
            console.log(`\n${c.dim}No active paste attachments.${c.reset}`);
          } else {
            console.log(`\n${c.cyan}Active paste attachments:${c.reset}`);
            for (const p of pendingPastes) {
              console.log(
                `  ${c.bold}#${p.id}${c.reset}  ${p.lines} lines  /view ${p.id} · /edit ${p.id}`,
              );
            }
          }
          promptForInput();
          return;
        }

        default: {
          const handler = commandRegistry[cmd];
          if (handler) {
            const ctx: CommandContext = {
              state: {
                currentModel,
                currentMode,
                currentSessionId,
                currentSessionLabel,
                sessionModifiedFiles,
                pendingAttachments,
                selectedFiles,
                stats,
                isTaskRunning,
                currentRunningAgent,
              },
              args,
              config,
              projectConfig,
              cwd,
              verbose,
              conversation,
              agent,
              git,
              guard,
              rl,
              handleInput,
              clearSuggestions,
              refreshModelsForProvider,
              printStats,
              listRuns,
              showRun,
              buildIndex,
              workspaceFiles,
              findInIndex,
              explainIndexedTarget,
            };
            await handler(ctx);

            // Sync state back
            currentModel = ctx.state.currentModel;
            currentMode = ctx.state.currentMode as any;
            currentSessionId = ctx.state.currentSessionId;
            currentSessionLabel = ctx.state.currentSessionLabel;
            sessionModifiedFiles = ctx.state.sessionModifiedFiles;
            pendingAttachments = ctx.state.pendingAttachments;
            selectedFiles = ctx.state.selectedFiles;
            stats = ctx.state.stats;
            isTaskRunning = ctx.state.isTaskRunning;
            currentRunningAgent = ctx.state.currentRunningAgent;

            if (ctx.workspaceFiles) {
              workspaceFiles = ctx.workspaceFiles;
            }
            return;
          }

          console.log(
            `\n${c.yellow}Unknown command: ${cmd}. Type /help for available commands.${c.reset}`,
          );
          return;
        }
      }
    }

    // ─── Shell commands (! prefix) ───
    if (input.startsWith("!")) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      const check = checkPermission(
        "run_command",
        { command: cmd },
        process.cwd(),
        config.preferences.policy ?? "shell-confirm",
      );
      if (check.decision === "deny") {
        console.log(`\n${c.red}✗ ${check.reason}${c.reset}`);
        return;
      }
      if (check.decision === "ask") {
        rl.pause();
        const confirmed = await p.confirm({
          message: `Allow execution of local shell command: ${c.cyan}${cmd}${c.reset}? (${check.reason})`,
          initialValue: false,
        });
        rl.resume();
        if (p.isCancel(confirmed) || !confirmed) {
          console.log(`\n${c.cyan}  ⚠ Execution cancelled.${c.reset}`);
          return;
        }
      }
      console.log(`${c.dim}⚙️ Running: ${cmd}${c.reset}`);
      try {
        const { spawnSync } = await import("child_process");
        const result = spawnSync(cmd, {
          shell: true,
          cwd,
          encoding: "utf-8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: redactedEnv(),
        });
        const output = redactSecrets(
          [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n"),
        );
        if (output.trim()) console.log(output);
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string };
        if (err.stdout) console.log(err.stdout);
        if (err.stderr) console.error(`${c.red}${err.stderr}${c.reset}`);
      }
      return;
    }

    // ─── Conversation echo (paste expansion) ──────────────────────────
    // When the submitted input contains paste attachments, overwrite the
    // readline-echoed `> [Paste #N +M lines]` line with a proper
    // conversation block so the user can see what they sent.
    // Mirrors the Claude Code / Antigravity transcript pattern.
    if (pendingPastes.length > 0) {
      // Step 1: reconstruct the original input as it would have looked without folding
      let unfoldedInput = rawInput;
      for (const paste of pendingPastes) {
        const token = `[Paste #${paste.id} +${paste.lines} lines]`;
        unfoldedInput = unfoldedInput.replace(token, paste.content);
      }

      // Step 2: move up ONE line and erase it — this erases the readline-
      // echoed token line ("> [Paste #2 +4 lines]") that is already on screen.
      process.stdout.write("\x1b[1A\x1b[2K");

      // Step 3: print the prompt and the unfolded input
      const lines = unfoldedInput.split(/\r\n|\r|\n/);
      if (lines.length > 0) {
        console.log(`> ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
          console.log(lines[i]);
        }
      }

      // Blank line before the agent spinner starts
      console.log("");
    }
    // ─────────────────────────────────────────────────────────────────

    // ─── Agent task ───
    // Format any paths in the input for display
    const displayInput = formatInputPaths(input, cwd);
    if (displayInput !== input) {
      // Re-display with highlighted paths
      process.stdout.write(`\x1b[1A\x1b[2K`); // Move up and clear line
      console.log(`> ${displayInput}`);
    }

    // Extract any file paths from input for automatic pinning
    const pathsInInput = extractFilePaths(input, cwd);

    const dirtyBefore = git.isGitRepo() ? git.getDirtyFiles() : [];

    const context: AgentContext = {
      task: input,
      model: currentModel,
      cwd,
      verbose,
      selectedFiles: [...selectedFiles, ...pathsInInput],
      systemPromptOverride: projectConfig?.systemPrompt,
      checkCommand: projectConfig?.checkCommand,
      policy: projectConfig?.policy ?? config.preferences.policy,
      mode: currentMode,
      pendingAttachments:
        pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
    };
    // Drain the queue — attachments are one-shot. The agent has its
    // own copy via context above.
    pendingAttachments = [];

    // Phase 2.1 — routing decision + execution lives in
    // task-router.ts so it can be unit-tested independently of the
    // REPL and reused by future non-TUI entry points (--headless,
    // web backend, IDE extension). Console output is byte-identical
    // to the pre-extraction inline path. The rollback inside the
    // complex path uses git.discardChangesIn() (Phase 0.0 — scoped).
    const { routeAndExecute } = await import("../agent/task-router.js");
    const routed = await routeAndExecute(input, context, {
      agent,
      conversation,
      rl,
      projectConfig,
      verbose,
      onSimplePathStart: (a) => {
        isTaskRunning = true;
        currentRunningAgent = a;
      },
      onSimplePathEnd: () => {
        isTaskRunning = false;
        currentRunningAgent = null;
      },
    });
    if (routed.route === "plan-mode-deferred") {
      pendingPastes = [];
      return;
    }
    const result = routed.result;

    pendingPastes = [];

    // Print result summary
    console.log("");
    const modelPart = result.model ? `${result.model} · ` : "";
    const tokenInfo = `${c.dim}${modelPart}${result.tokensUsed.total_tokens} tokens · ${result.toolCallCount} tool calls · ${(result.durationMs / 1000).toFixed(1)}s${c.reset}`;
    console.log(tokenInfo);

    // Auto-commit if enabled
    if (
      config.preferences.autoCommit &&
      projectConfig?.autoCommit !== false &&
      result.modifiedFiles.length > 0
    ) {
      const gitModified = result.modifiedFiles.map((f) => guard.relative(f));
      const preExistingEdits = gitModified.filter((f) =>
        dirtyBefore.includes(f),
      );
      let allowed = true;
      if (preExistingEdits.length > 0) {
        rl.pause();
        const confirmed = await p.confirm({
          message: `The agent modified files with pre-existing uncommitted edits: ${preExistingEdits.join(", ")}. Allow auto-commit?`,
          initialValue: false,
        });
        rl.resume();
        if (p.isCancel(confirmed) || !confirmed) {
          allowed = false;
          console.log(
            `\n${c.yellow}  ⚠ Auto-commit skipped due to pre-existing edits.${c.reset}`,
          );
        }
      }
      if (allowed) {
        git.autoCommit(input, result.modifiedFiles);
      }
    }

    // Update stats
    stats.totalPromptTokens += result.tokensUsed.prompt_tokens;
    stats.totalCompletionTokens += result.tokensUsed.completion_tokens;
    stats.totalToolCalls += result.toolCallCount;
    stats.totalTasks++;
    stats.totalDurationMs += result.durationMs;

    // Token budget warning → replaced with auto-compact
    const currentContextTokens = conversation.getTotalTokens();
    const contextLimit = conversation.getContextLimit();
    const contextPct = Math.round((currentContextTokens / contextLimit) * 100);

    // Auto-compact after each turn if context is getting large
    if (conversation.shouldCompact()) {
      console.log(
        `\n${c.yellow}🔄 Context at ${contextPct}% (${(currentContextTokens / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k) — auto-compacting...${c.reset}`,
      );
      try {
        const compacted = await conversation.compact(
          agent.getClient(),
          currentModel,
        );
        if (compacted) {
          const info = conversation.getLastCompactionInfo();
          const newTokens = conversation.getTotalTokens();
          console.log(
            `${c.green}✓ Compacted: ${info?.messagesBefore ?? "?"} messages → summary + ${conversation.getMessageCount()} recent. ${(currentContextTokens / 1000).toFixed(0)}k → ${(newTokens / 1000).toFixed(0)}k tokens.${c.reset}`,
          );
        }
      } catch (err) {
        // Don't let compaction errors crash the REPL
        console.log(
          `${c.dim}[Context] Auto-compact failed, continuing with current context.${c.reset}`,
        );
      }
    } else if (contextPct > 50) {
      console.log(
        `\n${c.dim}📊 Context: ${(currentContextTokens / 1000).toFixed(0)}k / ${(contextLimit / 1000).toFixed(0)}k tokens (${contextPct}%)${c.reset}`,
      );
    }

    // Save stateful session persistence
    try {
      const { SessionManager } = await import("../agent/conversation.js");
      // Merge modified files from this run
      for (const file of result.modifiedFiles) {
        if (!sessionModifiedFiles.includes(file)) {
          sessionModifiedFiles.push(file);
        }
      }
      SessionManager.saveSession(
        conversation,
        currentModel,
        sessionModifiedFiles,
        {
          prompt_tokens: stats.totalPromptTokens,
          completion_tokens: stats.totalCompletionTokens,
          total_tokens: stats.totalPromptTokens + stats.totalCompletionTokens,
        },
        currentSessionId,
        currentSessionLabel,
      );
      const { saveSnapshot } = await import("../runtime/session-snapshots.js");
      saveSnapshot({
        cwd,
        conversation: conversation.exportHistory().map((m, idx) => ({
          role: m.role as any,
          content: m.content || "",
          name: m.name,
          index: idx,
        })),
        tokens: stats.totalPromptTokens + stats.totalCompletionTokens,
        model: currentModel,
        mode: currentMode,
        selectedFiles: [...selectedFiles],
        summary: conversation.getSummary(),
        label: currentSessionLabel,
        id: currentSessionId,
        fixedInstructions: projectConfig?.systemPrompt,
      });
    } catch (err) {
      // Ignore session save errors
    }
  }

  // Start the loop
  promptForInput();
}

/* ──────────────────────── Helpers ──────────────────────── */

function extractFilePaths(input: string, cwd: string): string[] {
  const paths: string[] = [];
  const guard = new WorkspaceGuard(cwd);
  // Only match paths that look like real file references:
  // - Quoted paths with extensions
  // - Unquoted paths with a directory separator AND a code/doc extension
  const extensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".rb",
    ".php",
    ".css",
    ".scss",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".env",
    ".sh",
    ".bash",
    ".txt",
    ".html",
    ".vue",
    ".svelte",
  ]);
  const extensionPattern = Array.from(extensions)
    .join("|")
    .replace(/\./g, "\\.");
  const patterns = [
    new RegExp(`'([^']+${extensionPattern})'`, "g"),
    new RegExp(`"([^"]+${extensionPattern})"`, "g"),
    new RegExp(`\\b([\\w.-]+\\/${extensionPattern})\\b`, "g"),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      let filePath: string;
      try {
        filePath = guard.ensureFile(match[1]);
      } catch {
        continue;
      }
      if (fs.existsSync(filePath) && !paths.includes(filePath)) {
        paths.push(filePath);
      }
    }
  }

  return paths;
}

function printStats(stats: SessionStats): void {
  const totalTokens = stats.totalPromptTokens + stats.totalCompletionTokens;
  const avgDuration =
    stats.totalTasks > 0
      ? (stats.totalDurationMs / stats.totalTasks / 1000).toFixed(1)
      : "0";

  // Rough cost estimation: $3/M input + $15/M output tokens (average across providers)
  const estimatedCost =
    (stats.totalPromptTokens / 1_000_000) * 3 +
    (stats.totalCompletionTokens / 1_000_000) * 15;

  console.log("");
  console.log(`${c.cyan}${c.bold}📊 Session Statistics${c.reset}`);
  console.log(`${c.dim}${"─".repeat(40)}${c.reset}`);
  console.log(`  Tasks completed:     ${c.bold}${stats.totalTasks}${c.reset}`);
  console.log(
    `  Tool calls:          ${c.bold}${stats.totalToolCalls}${c.reset}`,
  );
  console.log(
    `  Input tokens:        ${c.bold}${stats.totalPromptTokens.toLocaleString()}${c.reset}`,
  );
  console.log(
    `  Output tokens:       ${c.bold}${stats.totalCompletionTokens.toLocaleString()}${c.reset}`,
  );
  console.log(
    `  Total tokens:        ${c.bold}${totalTokens.toLocaleString()}${c.reset}`,
  );
  console.log(`  Avg task duration:   ${c.bold}${avgDuration}s${c.reset}`);
  console.log(
    `  Cost savings:        ${c.green}${c.bold}~$${estimatedCost.toFixed(2)} saved${c.reset} ${c.dim}(free models!)${c.reset}`,
  );
  console.log("");
}
