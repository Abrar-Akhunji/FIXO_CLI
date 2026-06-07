/**
 * Fixo UI render layer.
 *
 * This module owns:
 *   1. The static, line-by-line helpers used by the REPL welcome /
 *      help screens (preserved verbatim for backwards compatibility).
 *   2. A new type-safe, double-buffered, non-blocking dashboard
 *      renderer used during agent execution.
 *
 * The dashboard is opt-in: the default {@link dashboard} singleton is
 * shared across the tool loop and the prompt REPL, but tests / CI
 * environments that pipe stdout can call {@link Dashboard.deactivate}
 * to force the single-line / off modes without touching the call
 * sites that emit events.
 */
import fs from "fs";
import path from "path";
import { colors, renderStatusLabel, themeMode } from "./colors.js";

const c = { ...colors, renderStatusLabel };

/* ────────────────────────────────────────────────────────────────── */
/*  PILLAR 1 — Static Dashboard Types (Section 1.1 of the spec)      */
/* ────────────────────────────────────────────────────────────────── */

export type ToolState = "thinking" | "executing" | "completed" | "failed";
export type ExecutionMode = "PLAN" | "BUILD";
/** How the renderer should display itself. */
export type RenderMode = "dashboard" | "single-line" | "off";

export interface DashboardActiveTool {
  name: string;
  target: string;
  state: ToolState;
}

export interface DashboardState {
  runId: string;
  activeTask: string;
  executionMode: ExecutionMode;
  activeAgent: string;
  modelId: string;
  status: string;
  elapsedTimeMs: number;
  tokensConsumed: number;
  estimatedCostUsd: number;
  /** 0..100. Use -1 to indicate an indeterminate spinner. */
  progressPercent: number;
  activeTool: DashboardActiveTool | null;
  /** Capped at MAX_LOG_ENTRIES. Oldest entries are evicted FIFO. */
  logs: ReadonlyArray<string>;
}

export type DashboardEvent =
  | { type: "turn-start"; turnIndex: number; task: string }
  | { type: "tool-start"; tool: string; target: string; turnIndex: number }
  | {
      type: "tool-finish";
      tool: string;
      target: string;
      state: "completed" | "failed";
      durationMs: number;
    }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "tokens"; prompt: number; completion: number; total: number }
  | { type: "status"; message: string }
  | { type: "mode"; mode: ExecutionMode }
  | { type: "done"; success: boolean };

export interface DashboardSubscriber {
  /** Called synchronously on every event. Implementations must
   *  not throw — errors are swallowed and counted in the
   *  {@link Dashboard.subscriberErrors} tally. */
  onEvent(event: DashboardEvent): void;
}

const MAX_LOG_ENTRIES = 5;
const DEFAULT_PROMPT_COST_USD_PER_1K = 3 / 1000;
const DEFAULT_COMPLETION_COST_USD_PER_1K = 15 / 1000;

/* ────────────────────────────────────────────────────────────────── */
/*  Dashboard — state holder + typed event fan-out                   */
/* ────────────────────────────────────────────────────────────────── */

export class Dashboard {
  private state: DashboardState;
  private readonly subs = new Set<DashboardSubscriber>();
  /** Errors thrown by subscribers are counted but never propagate. */
  public subscriberErrors = 0;
  /** Wall-clock anchor for elapsedTimeMs. */
  private runStartedAt = Date.now();

  constructor(initial?: Partial<DashboardState>) {
    this.state = {
      runId: initial?.runId ?? `run-${Date.now().toString(36)}`,
      activeTask: initial?.activeTask ?? "",
      executionMode: initial?.executionMode ?? "BUILD",
      activeAgent: initial?.activeAgent ?? "single-agent",
      modelId: initial?.modelId ?? "auto",
      status: initial?.status ?? "Idle",
      elapsedTimeMs: 0,
      tokensConsumed: 0,
      estimatedCostUsd: 0,
      progressPercent: -1,
      activeTool: null,
      logs: [],
    };
  }

  /** Subscribe to the event stream. Returns an unsubscribe fn. */
  subscribe(sub: DashboardSubscriber): () => void {
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** Number of active subscribers. Useful for tests. */
  subscriberCount(): number {
    return this.subs.size;
  }

  /** Type-safe accessor for the current frame. */
  snapshot(): Readonly<DashboardState> {
    return { ...this.state, logs: [...this.state.logs] };
  }

  /** Wipe state and start a fresh run with the given task. */
  reset(task: string, mode: ExecutionMode, modelId: string, agentName = "single-agent"): void {
    this.runStartedAt = Date.now();
    this.state = {
      runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      activeTask: task,
      executionMode: mode,
      activeAgent: agentName,
      modelId,
      status: "Starting",
      elapsedTimeMs: 0,
      tokensConsumed: 0,
      estimatedCostUsd: 0,
      progressPercent: -1,
      activeTool: null,
      logs: [],
    };
    this.notify({ type: "turn-start", turnIndex: 0, task });
  }

  /** Apply a typed event, mutating the state. Pure — never throws. */
  emit(event: DashboardEvent): void {
    try {
      switch (event.type) {
        case "turn-start":
          this.state.activeTask = event.task;
          this.state.status = `Thinking (turn ${event.turnIndex + 1})`;
          this.state.activeTool = null;
          this.state.progressPercent = -1;
          break;
        case "tool-start":
          this.state.activeTool = {
            name: event.tool,
            target: event.target,
            state: "executing",
          };
          this.state.status = `Running ${event.tool}`;
          this.pushLog(`${event.tool} → ${event.target}`);
          break;
        case "tool-finish":
          if (
            this.state.activeTool &&
            this.state.activeTool.name === event.tool
          ) {
            this.state.activeTool = { ...this.state.activeTool, state: event.state };
          }
          this.state.status = event.state === "failed" ? `Failed ${event.tool}` : `Idle`;
          break;
        case "log":
          this.pushLog(`[${event.level}] ${event.message}`);
          break;
        case "tokens":
          this.state.tokensConsumed = event.total;
          this.state.estimatedCostUsd =
            (event.prompt / 1000) * DEFAULT_PROMPT_COST_USD_PER_1K +
            (event.completion / 1000) * DEFAULT_COMPLETION_COST_USD_PER_1K;
          break;
        case "status":
          this.state.status = event.message;
          break;
        case "mode":
          this.state.executionMode = event.mode;
          break;
        case "done":
          this.state.status = event.success ? "Completed" : "Failed";
          this.state.activeTool = null;
          this.state.progressPercent = event.success ? 100 : this.state.progressPercent;
          break;
      }
      this.state.elapsedTimeMs = Date.now() - this.runStartedAt;
    } catch {
      // Defensive — never let a state-mutation error crash the agent.
    }
    this.notify(event);
  }

  /** Same as {@link emit} but synchronous and silent — for hot paths. */
  emitSilent(event: DashboardEvent): void {
    this.emit(event);
  }

  private pushLog(line: string): void {
    const sanitized = line.length > 200 ? `${line.slice(0, 197)}…` : line;
    const next = [...this.state.logs, sanitized];
    this.state.logs =
      next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
  }

  private notify(event: DashboardEvent): void {
    for (const sub of this.subs) {
      try {
        sub.onEvent(event);
      } catch {
        this.subscriberErrors += 1;
      }
    }
  }
}

/** Process-wide default. All call sites emit to this instance. */
export const dashboard = new Dashboard();

/* ────────────────────────────────────────────────────────────────── */
/*  AnsiRenderer — pure double-buffered screen math                   */
/* ────────────────────────────────────────────────────────────────── */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SAVE_CURSOR = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";
const CURSOR_HOME = "\x1b[H";
const CLEAR_DOWN = "\x1b[J";
const CLEAR_LINE = "\x1b[K";
const RESET = "\x1b[0m";

/** Pick the active render mode based on TTY + terminal size. */
export function selectRenderMode(
  isTTY: boolean,
  columns: number,
  rows: number
): RenderMode {
  if (!isTTY) return "off";
  if (columns < 80 || rows < 24) return "single-line";
  return "dashboard";
}

function pad(line: string, width: number): string {
  const visible = stripAnsi(line).length;
  if (visible >= width) return line;
  return line + " ".repeat(width - visible);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function shortStatus(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m}m${r}s`;
}

function fmtUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export class AnsiRenderer {
  private mode: RenderMode = "off";
  private lastRenderedHeight = 0;
  private lastEventLine = "";
  private mounted = false;
  private readonly exitHandlers: Array<() => void> = [];

  constructor(
    private readonly isTTY: () => boolean = () => Boolean(process.stdout.isTTY),
    private readonly columns: () => number = () => process.stdout.columns ?? 80,
    private readonly rows: () => number = () => process.stdout.rows ?? 24
  ) {}

  setMode(mode: RenderMode): void {
    if (this.mode === mode) return;
    // Wipe any prior dashboard surface so the new mode starts clean.
    this.wipePrevious();
    this.mode = mode;
  }

  getMode(): RenderMode {
    return this.mode;
  }

  /** Draw a single frame from the given dashboard state. */
  render(state: Readonly<DashboardState>): void {
    this.mode = selectRenderMode(this.isTTY(), this.columns(), this.rows());
    if (this.mode === "off") {
      // Emit nothing — stdout is being captured (CI, tests, pipes).
      this.lastRenderedHeight = 0;
      return;
    }
    if (this.mode === "single-line") {
      this.renderSingleLine(state);
      return;
    }
    this.renderDashboard(state);
  }

  /** Render a transient event line (e.g. tool call progress) without
   *  re-painting the full dashboard. */
  renderEventLine(line: string): void {
    if (this.mode === "off" || !this.isTTY()) return;
    const trimmed = shortStatus(stripAnsi(line).replace(/\n/g, " ⏎ "), 200);
    this.lastEventLine = trimmed;
    if (this.mode === "single-line") {
      this.write(`${HIDE_CURSOR}${SAVE_CURSOR}${trimmed}${RESET}${RESTORE_CURSOR}${SHOW_CURSOR}`);
    }
  }

  /** Mount: install exit hooks that restore the cursor. Idempotent. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const restore = (): void => {
      try {
        process.stdout.write(`${SHOW_CURSOR}${RESET}`);
      } catch {
        // ignore — process may already be tearing down
      }
    };
    this.exitHandlers.push(restore);
    process.on("exit", restore);
    process.on("SIGINT", () => {
      restore();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      restore();
      process.exit(143);
    });
  }

  /** Unmount: remove the exit hooks we installed and reset the
   *  `mounted` flag. Idempotent — safe to call twice. Primarily
   *  useful in tests so process.on() listeners don't pile up. */
  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const handler of this.exitHandlers) {
      process.removeListener("exit", handler);
    }
    this.exitHandlers.length = 0;
  }

  /** Force-clear whatever was previously painted (e.g. on shutdown). */
  wipePrevious(): void {
    if (this.lastRenderedHeight === 0 || !this.isTTY()) return;
    const out: string[] = [SAVE_CURSOR];
    for (let i = 0; i < this.lastRenderedHeight; i++) {
      out.push("\x1b[1A", CLEAR_LINE);
    }
    out.push(RESTORE_CURSOR, SHOW_CURSOR);
    this.write(out.join(""));
    this.lastRenderedHeight = 0;
  }

  /* ── private renderers ──────────────────────────────────────── */

  private renderSingleLine(state: Readonly<DashboardState>): void {
    const tool = state.activeTool
      ? `[${state.activeTool.name}:${state.activeTool.state}] ${state.activeTool.target}`
      : "—";
    const tokens =
      state.tokensConsumed > 0 ? `${state.tokensConsumed} tok` : "—";
    const line = `${colors.cyan}[${state.executionMode}]${RESET} ` +
      `${colors.bold}${shortStatus(state.activeTask, 60)}${RESET} ` +
      `${colors.dim}${state.modelId}${RESET} · ${state.status} · ${tool} · ` +
      `${tokens} · ${fmtMs(state.elapsedTimeMs)}`;
    this.write(`${SAVE_CURSOR}${CLEAR_LINE}${line}${RESET}${RESTORE_CURSOR}`);
    this.lastRenderedHeight = 1;
  }

  private renderDashboard(state: Readonly<DashboardState>): void {
    const cols = Math.max(80, this.columns());
    const width = Math.min(cols, 110);
    const inner = width - 2; // for the two box characters
    const out: string[] = [];
    out.push(HIDE_CURSOR, SAVE_CURSOR, CURSOR_HOME, CLEAR_DOWN);
    out.push(this.box(width, "─", "─", "─"));
    out.push(
      `${colors.cyan}│${RESET}` +
        ` ${this.modeBadge(state.executionMode)} ` +
        `${colors.bold}${shortStatus(state.activeTask, inner - 30)}${RESET}` +
        ` ${colors.dim}· run ${state.runId.slice(-8)} · ${state.modelId}${RESET}` +
        `${" ".repeat(Math.max(0, inner - 50 - state.activeTask.length))}` +
        `${colors.cyan}│${RESET}\n`
    );
    out.push(this.box(width, "─", "─", "─"));

    // Diagnostic metrics
    out.push(
      `${colors.cyan}│${RESET}  ${colors.dim}tokens${RESET}  ${bold(
        String(state.tokensConsumed)
      )}` +
        `   ${colors.dim}cost${RESET}  ${bold(fmtUsd(state.estimatedCostUsd))}` +
        `   ${colors.dim}elapsed${RESET}  ${bold(fmtMs(state.elapsedTimeMs))}` +
        `   ${colors.dim}progress${RESET}  ${bold(this.progressLabel(state.progressPercent))}` +
        `${" ".repeat(Math.max(0, inner - 65))}` +
        `${colors.cyan}│${RESET}\n`
    );

    // Action stream (single dynamic spinner line)
    const tool = state.activeTool;
    const actionText = tool
      ? `${spinnerFor(tool.state)} ${colors.cyan}[${tool.name.toUpperCase()}]${RESET} ` +
        `${shortStatus(tool.target, inner - 24)} ${colors.dim}(${tool.state})${RESET}`
      : `${colors.dim}${spinnerFor("thinking")} ${state.status}${RESET}`;
    out.push(
      `${colors.cyan}│${RESET}  ${actionText}` +
        `${" ".repeat(Math.max(0, inner - stripAnsi(actionText).length - 2))}` +
        `${colors.cyan}│${RESET}\n`
    );
    out.push(this.box(width, "─", "─", "─"));

    // Recent events box (5 entries)
    out.push(
      `${colors.cyan}│${RESET}  ${colors.dim}Recent events${RESET}` +
        `${" ".repeat(Math.max(0, inner - 15))}` +
        `${colors.cyan}│${RESET}\n`
    );
    const logs = state.logs;
    for (let i = 0; i < MAX_LOG_ENTRIES; i++) {
      const line = logs[i] ?? "";
      out.push(
        `${colors.cyan}│${RESET}  ${pad(
          line ? `${colors.dim}•${RESET} ${shortStatus(line, inner - 4)}` : "",
          inner - 2
        )}  ${colors.cyan}│${RESET}\n`
      );
    }
    out.push(this.box(width, "─", "─", "─"));
    out.push(RESTORE_CURSOR, SHOW_CURSOR);
    this.write(out.join(""));
    this.lastRenderedHeight = 7 + MAX_LOG_ENTRIES;
  }

  private modeBadge(mode: ExecutionMode): string {
    return mode === "BUILD"
      ? `${colors.bgCyan}${colors.bold} ${mode} ${RESET}`
      : `${colors.bgLiquidLava}${colors.bold} ${mode} ${RESET}`;
  }

  private progressLabel(p: number): string {
    if (p < 0) return "—";
    if (p > 100) return "100%";
    return `${p}%`;
  }

  private box(width: number, _l: string, _m: string, _r: string): string {
    return `${colors.cyan}┌${"─".repeat(width - 2)}┐${RESET}\n`;
  }

  private write(buf: string): void {
    try {
      process.stdout.write(buf);
    } catch {
      // pipe closed mid-write — nothing we can do
    }
  }
}

function bold(s: string): string {
  return `${colors.bold}${s}${RESET}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTick = 0;
function spinnerFor(state: ToolState | "thinking"): string {
  spinnerTick = (spinnerTick + 1) % SPINNER_FRAMES.length;
  const frame = SPINNER_FRAMES[spinnerTick] ?? "*";
  switch (state) {
    case "executing":
      return `${colors.cyan}${frame}${RESET}`;
    case "completed":
      return `${colors.green}✓${RESET}`;
    case "failed":
      return `${colors.red}✗${RESET}`;
    case "thinking":
    default:
      return `${colors.dim}${frame}${RESET}`;
  }
}

/* ────────────────────────────────────────────────────────────────── */
/*  Default renderer instance + auto-mount                            */
/* ────────────────────────────────────────────────────────────────── */

export const renderer = new AnsiRenderer();
renderer.mount();

/* ────────────────────────────────────────────────────────────────── */
/*  Backwards-compatible exports (originals preserved verbatim)      */
/* ────────────────────────────────────────────────────────────────── */

export const COMMANDS_WITH_DESC = [
  // Core
  { cmd: '/help', desc: 'Show all commands and usage' },
  { cmd: '/exit', desc: 'Exit FixO CLI' },
  { cmd: '/quit', desc: 'Exit FixO CLI' },
  // Model & Providers
  { cmd: '/model', desc: 'Interactive model picker or set model' },
  { cmd: '/providers', desc: 'Manage AI provider API keys (add/list/remove/test)' },
  // Files & Context
  { cmd: '/select', desc: 'Pin a file for agent context' },
  { cmd: '/unselect', desc: 'Clear all pinned files' },
  { cmd: '/index', desc: 'Build the local repo index' },
  { cmd: '/find', desc: 'Search the repo index' },
  { cmd: '/explain', desc: 'Explain a file or symbol from index' },
  // Conversation
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/compact', desc: 'Summarise & compress conversation (frees context tokens)' },
  { cmd: '/stats', desc: 'Show session token usage statistics' },
  { cmd: '/session', desc: 'Manage sessions: list | load <uuid> | new' },
  { cmd: '/todo', desc: 'Manage todo list: list | add <text> | done <id> | remove <id> | clear' },
  { cmd: '/mcp', desc: 'Manage MCP servers: list | add <name> <cmd> [args] | remove <name> | test <name>' },
  // Agent modes & plans
  { cmd: '/mode', desc: 'Toggle or set PLAN / BUILD execution mode' },
  { cmd: '/plan', desc: 'Generate a task execution plan' },
  { cmd: '/run-plan', desc: 'Execute the last generated plan' },
  // Git
  { cmd: '/diff', desc: 'Show git diff of workspace' },
  { cmd: '/undo', desc: 'Undo last AI change' },
  { cmd: '/log', desc: 'Show recent git commits' },
  { cmd: '/snapshot', desc: 'Create a named git snapshot' },
  // Quality & review
  { cmd: '/review', desc: 'Review the current workspace diff' },
  { cmd: '/test', desc: 'Run detected project checks' },
  { cmd: '/fix-tests', desc: 'Run tests and auto-fix failures' },
  { cmd: '/fix-ci', desc: 'Fix CI failures (paste logs)' },
  // Runs & memory
  { cmd: '/runs', desc: 'List task run ledgers' },
  { cmd: '/show-run', desc: 'Show details of a specific run' },
  { cmd: '/memory', desc: 'Show project memory facts' },
  { cmd: '/remember', desc: 'Add a project fact to memory' },
  { cmd: '/forget', desc: 'Clear all project memory' },
  // Tools & skills
  { cmd: '/skills', desc: 'List all registered skill profiles' },
  { cmd: '/doctor', desc: 'Run FixO diagnostics / doctor checks' },
  // Privacy
  { cmd: '/telemetry', desc: 'Toggle telemetry on/off or view status' },
  // Theme
  { cmd: '/theme', desc: 'Toggle Dark Void / Inverted theme' },
  { cmd: '/variant', desc: 'Toggle theme color variant' },
];

export function printHelp(): void {
  const w = 72;
  const line = (cmd: string, args: string, desc: string) => {
    const left = `  ${c.cyan}${cmd}${c.reset} ${c.dim}${args}${c.reset}`;
    const stripped = `  ${cmd} ${args}`;
    const pad = Math.max(1, 32 - stripped.length);
    console.log(`${left}${' '.repeat(pad)}${desc}`);
  };

  console.log('');
  console.log(`${c.bold}${c.cyan}FixO CLI — All Commands${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(w)}${c.reset}`);

  console.log(`\n${c.snow}${c.bold}🤖 Model & Providers${c.reset}`);
  line('/model',     '[name|list]',   'Interactive model picker, or set model by name');
  line('/providers', '<sub-command>', 'Manage provider API keys: list | add <name> | remove <name> | test <name>');

  console.log(`\n${c.snow}${c.bold}📂 Files & Context${c.reset}`);
  line('/select',    '[file]',        'Pin a file for focused agent context');
  line('/unselect',  '',              'Clear all pinned files');
  line('/index',     '',              'Build / refresh the local repo index');
  line('/find',      '<query>',       'Search the repo index for symbols or files');
  line('/explain',   '<target>',      'Explain a file, symbol, or function from the index');

  console.log(`\n${c.snow}${c.bold}💬 Conversation${c.reset}`);
  line('/clear',     '',              'Clear conversation history');
  line('/compact',   '',              'Summarise & compress conversation (frees context tokens)');
  line('/stats',     '',              'Show session token usage and cost savings');
  line('/session',   '<sub-command>', 'Manage sessions: list | load <uuid> | new');

  console.log(`\n${c.snow}${c.bold}⚙️  Agent Modes & Plans${c.reset}`);
  line('/mode',      '[PLAN|BUILD]',  'Toggle or set execution mode (PLAN = read-only, BUILD = write)');
  line('/plan',      '<task>',        'Generate a structured multi-phase execution plan');
  line('/run-plan',  '',              'Execute the last saved plan via the Agent Pool');

  console.log(`\n${c.snow}${c.bold}🌳 Git Operations${c.reset}`);
  line('/diff',      '',              'Show git diff of the workspace');
  line('/undo',      '',              'Undo the last FixO auto-committed change');
  line('/log',       '',              'Show recent git commits');
  line('/snapshot',  '[label]',       'Create a named git snapshot commit of current workspace');

  console.log(`\n${c.snow}${c.bold}🔍 Quality & Review${c.reset}`);
  line('/review',    '',              'Review the current diff for issues');
  line('/test',      '',              'Run detected project tests');
  line('/fix-tests', '',              'Run tests and automatically fix failures');
  line('/fix-ci',    '',              'Fix CI failures (paste CI logs into the task)');

  console.log(`\n${c.snow}${c.bold}📋 Runs & Memory${c.reset}`);
  line('/runs',      '',              'List all recorded task run ledgers');
  line('/show-run',  '<id>',          'Show details of a specific run');
  line('/memory',    '',              'Show all project memory facts');
  line('/remember',  '<fact>',        'Add a project fact to persistent memory');
  line('/forget',    '',              'Clear all project memory');

  console.log(`\n${c.snow}${c.bold}🛠  Tools & Skills${c.reset}`);
  line('/skills',    '',              'List all registered and auto-detected skill profiles');
  line('/doctor',    '',              'Run FixO diagnostics and troubleshooting checks');

  console.log(`\n${c.snow}${c.bold}🔒 Privacy${c.reset}`);
  line('/telemetry', '<on|off>',      'View or toggle telemetry collection');

  console.log(`\n${c.snow}${c.bold}🎨 Theme${c.reset}`);
  line('/theme',     '',              'Toggle Dark Void Minimalist / High-Contrast Inverted theme');
  line('/variant',   '',              'Toggle theme color variant');

  console.log(`\n${c.snow}${c.bold}🚪 Exit${c.reset}`);
  line('/exit',      '',              'Exit FixO CLI cleanly');
  line('/quit',      '',              'Alias for /exit');

  console.log(`\n${c.dim}${'─'.repeat(w)}${c.reset}`);
  console.log(`${c.dim}  Shell commands   prefix with !  e.g. !npm test, !ls -la${c.reset}`);
  console.log(`${c.dim}  Autocomplete     type / for commands, @ for files & agents${c.reset}`);
  console.log(`${c.dim}  Mode toggle      press [TAB] on an empty line to switch PLAN ↔ BUILD${c.reset}`);
  console.log('');
}

export function buildPromptString(cwd: string, model: string, branch: string): string {
  const dirName = path.basename(cwd);
  const dirLabel = c.renderStatusLabel(`📂 ${dirName}`);
  const branchLabel = branch ? ` ${c.renderStatusLabel(`🌳 ${branch}`)}` : '';
  const modelLabel = ` ${c.renderStatusLabel(`🤖 ${model}`)}`;
  return `\n${dirLabel}${branchLabel}${modelLabel}\n${c.cyan}❯${c.reset} `;
}

export function formatInputPaths(input: string, cwd: string): string {
  const commands = COMMANDS_WITH_DESC.map((item) => item.cmd);

  return input.replace(/(?:\/[\w.-]+)+/g, (match) => {
    if (match.startsWith('/')) {
      const commandName = match.split(/\s+/)[0];
      if (commands.includes(commandName) || commandName.length <= 4) {
        return match;
      }
    }
    const resolved = path.isAbsolute(match) ? match : path.resolve(cwd, match);
    if (fs.existsSync(resolved)) {
      const basename = path.basename(match);
      return `${c.cyan}${c.bold}${basename}${c.reset}`;
    }
    return match;
  });
}
