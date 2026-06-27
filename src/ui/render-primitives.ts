/**
 * render-primitives.ts — High-level UI primitives for the
 * FixO CLI lava-redesign.
 *
 * These functions are pure output — they `process.stdout.write`
 * and return `void`. They never throw. They never mutate global
 * state. The agent calls them; the new `prompt.ts` calls them;
 * tests call them. The existing `Dashboard` / `AnsiRenderer`
 * from `render.ts` is preserved unchanged and continues to back
 * the safety-event fan-out.
 *
 * The primitives are intentionally not in `render.ts` because
 * that file is already 830 lines and growing; isolating the new
 * code here keeps the diff small and the import graph flat.
 */

import { C, lava, snow, dim, green, blue, yellow, purple, red, bold, visLen, padToVisual, providerColor, pill } from './colors.js';

/* ──────────────────────── Public types ──────────────────────── */

export interface CLIState {
  mode: 'PLAN' | 'BUILD' | 'REVIEW';
  routing: 'auto' | 'single' | 'multi';
  model: string;
  branch: string;
  contextPercent: number;
  providersCount: number;
  transport: string;
}

export interface ProviderModel {
  id: string;
  tags?: ReadonlyArray<'fast' | 'smart' | 'free' | 'large' | 'paid' | '128k'>;
  selected?: boolean;
}

export interface Provider {
  name: string;
  hasKey: boolean;
  models: ProviderModel[];
}

export interface ToolCallRender {
  /** The kind of tool. Maps to the icon + colour in the spec. */
  kind:
    | 'read'
    | 'list'
    | 'write'
    | 'create'
    | 'bash'
    | 'search'
    | 'success'
    | 'error'
    | 'thinking';
  /** Display name, e.g. `ReadFile`, `Bash`. */
  name: string;
  /** Path / args / result summary. */
  detail: string;
}

/* ──────────────────────── Helpers ──────────────────────── */

function cols(): number {
  return process.stdout.columns ?? 100;
}

export function safeWrite(s: string): void {
  try {
    process.stdout.write(s);
  } catch {
    // stdout may be closed during teardown.
  }
}

export function safeWriteLine(s: string): void {
  safeWrite(s + '\n');
}

/* ──────────────────────── Status bar ──────────────────────── */

/**
 * Render a single frame of the bottom status bar. The bar is
 * a single line terminated with `\r` (no newline) so subsequent
 * calls overwrite it in place. Safe to call when `stdout` is
 * not a TTY — the bar is still drawn but the caller should
 * ensure the cursor is on its own line first.
 */
export function renderStatusBar(state: CLIState): void {
  const modePill = pill(
    state.mode,
    C.LAVA,
    C.LAVA_BG,
  );
  const routingPill = pill(
    state.routing,
    C.GREEN,
    '\x1b[48;2;15;42;26m',
  );
  const modelPill = pill(
    state.model,
    C.BLUE,
    '\x1b[48;2;10;31;58m',
  );
  const branchPill = pill(
    state.branch,
    C.SNOW3,
    C.VOID3,
  );
  const leftSide = ` ${modePill} ${routingPill} ${modelPill} ${branchPill}`;
  // Clamp defensively — callers in `prompt.ts` already clamp at the
  // source, but the renderer should not assume.
  const usedPct = Math.max(0, Math.min(100, Math.round(state.contextPercent)));
  const remPct = 100 - usedPct;
  const rightSide = `${C.SNOW4}ctx: ${usedPct}% used · ${remPct}% remaining${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW4}${state.providersCount} providers${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW4}${state.transport}${C.RESET} `;
  const width = cols();
  const leftLen = visLen(leftSide);
  const rightLen = visLen(rightSide);
  const gap = Math.max(2, width - leftLen - rightLen);
  const line = leftSide + ' '.repeat(gap) + rightSide;
  safeWrite('\r' + line);
}

/* ──────────────────────── Provider list ──────────────────────── */

function tagColor(tag: string): string {
  switch (tag) {
    case 'fast':  return C.LAVA;
    case 'smart': return C.PURPLE;
    case 'free':  return C.GREEN;
    case 'large':
    case '128k':  return C.YELLOW;
    case 'paid':  return C.RED;
    default:      return C.SNOW3;
  }
}

function renderTag(tag: string): string {
  return `${tagColor(tag)}[${tag}]${C.RESET}`;
}

/**
 * Render the provider list as it appears under `/providers` and
 * `/model list`. Provider groups are separated by a blank line;
 * the selected model is marked with a lava `◉` dot.
 */
export function renderProviderList(providers: ReadonlyArray<Provider>): void {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!;
    const color = providerColor(p.name);
    const bullet = `${color}●${C.RESET}`;
    const keyBadge = p.hasKey
      ? `${C.GREEN}[key ✓]${C.RESET}`
      : `${C.SNOW4}[no key]${C.RESET}`;
    safeWriteLine(`  ${bullet} ${C.BOLD}${color}${p.name}${C.RESET}  ${keyBadge}`);
    for (const m of p.models) {
      const dot = m.selected
        ? `${C.LAVA}◉${C.RESET}`
        : `${C.SNOW4}○${C.RESET}`;
      const nameColor = m.selected ? C.SNOW : C.SNOW3;
      const tags = (m.tags ?? []).map(renderTag).join(' ');
      const line = `    ${dot} ${nameColor}${m.id}${C.RESET}${tags ? '  ' + tags : ''}`;
      safeWriteLine(line);
    }
    if (i < providers.length - 1) safeWriteLine('');
  }
  safeWriteLine('');
  safeWriteLine(`  ${C.SNOW4}/providers add <name>  ·  /model <id> to switch${C.RESET}`);
}

/* ──────────────────────── Tool call ──────────────────────── */

const TOOL_ICON: Record<ToolCallRender['kind'], { icon: string; color: string }> = {
  read:     { icon: '✦', color: C.BLUE },
  list:     { icon: '✦', color: C.BLUE },
  write:    { icon: '✎', color: C.LAVA },
  create:   { icon: '✎', color: C.LAVA },
  bash:     { icon: '$', color: C.YELLOW },
  search:   { icon: '⌕', color: C.PURPLE },
  success:  { icon: '✓', color: C.GREEN },
  error:    { icon: '✗', color: C.RED },
  thinking: { icon: '◈', color: C.SNOW3 },
};

/**
 * Render a single tool call line. All tool names are
 * left-padded to 12 chars for column alignment. The detail
 * (path / args / result) is rendered dim.
 */
export function renderToolCall(tool: ToolCallRender): void {
  const meta = TOOL_ICON[tool.kind];
  const padded = padToVisual(tool.name, 12);
  safeWriteLine(`  ${meta.color}${meta.icon}${C.RESET}  ${C.SNOW3}${padded}${C.RESET}  ${C.SNOW4}${tool.detail}${C.RESET}`);
}

/* ──────────────────────── Inline tool spinner ──────────────────────── */

const SPINNER_DOTS: ReadonlyArray<string> = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface InlineSpinnerHandle {
  /** Stop and replace the spinner with a ✔ success summary. */
  succeed(summary: string): void;
  /** Stop and replace the spinner with a ✗ failure summary. */
  fail(summary: string): void;
  /** Stop and clear the spinner with no replacement (rare). */
  clear(): void;
}

/**
 * Start a single-line tool spinner. The line is `⠋ <name>: <detail>...`
 * rendered with carriage-return so subsequent ticks overwrite in place.
 * Call `.succeed()` / `.fail()` on the returned handle when the work
 * completes — the spinner is erased and replaced by a one-line summary.
 *
 * Non-TTY callers (tests, redirected pipes) get a single static line
 * with no ticking, and the summary replaces it via `\r\x1b[K` on the
 * same line. This keeps test snapshots deterministic.
 */
export function startInlineToolSpinner(tool: ToolCallRender): InlineSpinnerHandle {
  const meta = TOOL_ICON[tool.kind];
  const isTTY = process.stdout.isTTY === true;
  let frame = 0;
  const draw = (icon: string, color: string): void => {
    safeWrite(
      `\r\x1b[K  ${color}${icon}${C.RESET}  ${C.SNOW3}${tool.name}${C.RESET}  ${C.SNOW4}${tool.detail}…${C.RESET}`,
    );
  };
  draw(SPINNER_DOTS[0]!, meta.color);
  let timer: NodeJS.Timeout | null = null;
  if (isTTY) {
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_DOTS.length;
      draw(SPINNER_DOTS[frame]!, meta.color);
    }, 80);
  }
  let stopped = false;
  const finish = (icon: string, color: string, summary: string): void => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    safeWrite(
      `\r\x1b[K  ${color}${icon}${C.RESET}  ${C.SNOW3}${tool.name}${C.RESET}  ${C.SNOW4}${summary}${C.RESET}\n`,
    );
  };
  return {
    succeed(summary: string): void { finish('✔', C.GREEN, summary); },
    fail(summary: string): void { finish('✗', C.RED, summary); },
    clear(): void {
      if (stopped) return;
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      safeWrite('\r\x1b[K');
    },
  };
}

/* ──────────────────────── Routing banner ──────────────────────── */

/**
 * One-line banner that precedes the agent's first LLM call.
 * Rendered with a lava-tinted background to set the visual
 * "the routing engine has decided" mood.
 */
export function renderRoutingBanner(routingType: string, reason: string): void {
  safeWriteLine(`  ${C.LAVA_BG}${C.LAVA}  ⇢  Routing Engine: ${reason} → ${bold(routingType)}  ${C.RESET}`);
}

/* ──────────────────────── Thinking indicator ──────────────────────── */

const LAVA_GLOW = '\x1b[38;2;255;160;60m';

const FIXO_PULSE_FRAMES: ReadonlyArray<string> = [
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${LAVA_GLOW}◉${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${C.LAVA}●${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.LAVA}●${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.LAVA}●${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.LAVA}●${C.RESET} ${LAVA_GLOW}◉${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.LAVA}●${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.LAVA}●${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.LAVA}●${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${C.SNOW4}•${C.RESET} ${LAVA_GLOW}◉${C.RESET} ${C.LAVA}●${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
  `${LAVA_GLOW}◉${C.RESET} ${C.LAVA}●${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET} ${C.SNOW4}•${C.RESET}`,
];
let spinnerTimer: NodeJS.Timeout | null = null;
let spinnerFrame = 0;

/**
 * @deprecated Use the new LoadingAnimation class from `loading-animation.ts` instead.
 * 
 * Start (or stop) a pulsing lava dot that signals the agent
 * is thinking. Uses a 400ms tick. Safe to call repeatedly —
 * the timer is a module-scoped singleton, so the indicator
 * can be started/stopped by different call sites without
 * leaving a stray interval behind.
 */
export function renderThinkingIndicator(active: boolean): void {
  if (active) {
    if (spinnerTimer) return; // already running
    safeWriteLine(`  ${FIXO_PULSE_FRAMES[0]!}  ${C.SNOW3}agent working…${C.RESET}`);
    spinnerFrame = 0;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % FIXO_PULSE_FRAMES.length;
      const frame = FIXO_PULSE_FRAMES[spinnerFrame]!;
      safeWrite(`\r  ${frame}  ${C.SNOW3}agent working…${C.RESET}`);
    }, 80);
  } else {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    safeWrite('\r' + ' '.repeat(40) + '\r');
  }
}

/**
 * @deprecated Use the new LoadingAnimation class from `loading-animation.ts` instead.
 * 
 * A three-frame ASCII spinner for in-band task progress.
 *
 * Used by SingleAgent to show the user that the agent is working
 * and indicate that Escape will cancel.  Call `.start()` before
 * the tool loop, `.stop()` on normal completion, and
 * `.markCancelled()` when the user aborts.
 */
export class TaskStatusIndicator {
  private timer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private readonly frames = FIXO_PULSE_FRAMES;
  private readonly intervalMs = 80;
  private static readonly HINT = `${C.SNOW3}Press Escape to cancel${C.RESET}`;

  start(): void {
    if (this.timer) return;
    safeWrite(`${this.frames[0]!}  agent working…  ${TaskStatusIndicator.HINT}`);
    this.frameIndex = 0;
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      const frame = this.frames[this.frameIndex]!;
      safeWrite(`\r${frame}  agent working…  ${TaskStatusIndicator.HINT}`);
    }, this.intervalMs);
  }

  stop(): void {
    this.clear();
    safeWrite('\r' + ' '.repeat(60) + '\r');
  }

  /** Print a clean "cancelled" message and stop the spinner. */
  markCancelled(): void {
    this.clear();
    safeWriteLine(`\r${C.YELLOW}⚠ Task cancelled${C.RESET}`);
  }

  private clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/* ──────────────────────── AI response ──────────────────────── */

const FRAME_WIDTH_FALLBACK = 76;

function frameWidth(): number {
  return Math.max(20, Math.min(100, (process.stdout.columns ?? 100) - 4));
}

function wrapToWidth(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      out.push('');
      continue;
    }
    // Simple greedy word-wrap. We don't try to honour
    // in-paragraph formatting — the line-level inline
    // colouring pass below re-runs on the wrapped output.
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const w of words) {
      if (line.length === 0) {
        line = w;
      } else if (line.length + 1 + w.length <= width) {
        line += ' ' + w;
      } else {
        out.push(line);
        line = w;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Apply inline colouring to a single line:
 *   - backtick-wrapped markdown: PURPLE
 *   - paths with `/` or `.ts/.js/.py/...`: BLUE
 *   - error / race / failed keywords: LAVA
 *   - arrow-prefix lines (`→`): arrow in LAVA, rest dim
 */
function colouriseLine(line: string): string {
  let out = line;

  // Backtick-wrapped inline code → purple.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `${C.PURPLE}${code}${C.RESET}`);

  // File paths → blue. Heuristic: any token containing a `/`
  // and a known extension, OR a bare filename with an extension.
  out = out.replace(
    /\b([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|md|yml|yaml|toml|sh|bash))\b/g,
    (m) => `${C.BLUE}${m}${C.RESET}`,
  );
  out = out.replace(
    /(^|\s)([A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+)/g,
    (m, pre: string, path: string) => {
      // Don't re-colour what we already coloured above.
      if (path.includes('\x1b[')) return m;
      return `${pre}${C.BLUE}${path}${C.RESET}`;
    },
  );

  // Warning keywords → lava.
  out = out.replace(/\b(error|errors|failed|race condition|warning|warn)\b/gi, (m) => `${C.LAVA}${m}${C.RESET}`);

  // Arrow-prefix lines: render arrow in lava, the rest dim.
  out = out.replace(/^(\s*)(→\s*)(.*)$/m, (_m, sp: string, arr: string, rest: string) => {
    if (rest.length === 0) return `${sp}${C.LAVA}${arr}${C.RESET}`;
    return `${sp}${C.LAVA}${arr}${C.RESET}${C.SNOW4}${rest}${C.RESET}`;
  });

  return out;
}

/**
 * Render the AI's text response inside a lava-topped box.
 * The body is word-wrapped to the frame width, line-coloured
 * for inline code / file paths / warning keywords / arrows.
 */
export function renderAIResponse(text: string): void {
  const w = frameWidth();
  const top = `  ${C.LAVA}┌${'─'.repeat(w)}┐${C.RESET}`;
  const bottom = `  ${C.SNOW4}└${'─'.repeat(w)}┘${C.RESET}`;
  safeWriteLine(top);
  for (const line of wrapToWidth(text, w - 2)) {
    // Pad with spaces to keep the side border flush.
    const coloured = colouriseLine(line) || ' ';
    const pad = Math.max(0, w - 2 - visLen(line));
    safeWriteLine(`  ${C.SNOW4}│${C.RESET}  ${coloured}${' '.repeat(pad)}${C.SNOW4}│${C.RESET}`);
  }
  safeWriteLine(bottom);
}

/* ──────────────────────── Cost line ──────────────────────── */

/**
 * Render the dim cost/timing footer that appears after every
 * completed agent turn.
 */
export function renderCostLine(model: string, tokens: number, toolCalls: number, durationMs: number): void {
  const tokensStr = tokens.toLocaleString('en-US');
  const durStr = `${(durationMs / 1000).toFixed(1)}s`;
  safeWriteLine(`  ${C.SNOW4}${model}  ·  ${tokensStr} tokens  ·  ${toolCalls} tool calls  ·  ${durStr}${C.RESET}`);
}

/* ──────────────────────── Command grid ──────────────────────── */

interface CommandEntry {
  cmd: string;
  desc: string;
}

const DEFAULT_COMMANDS: ReadonlyArray<CommandEntry> = [
  { cmd: '/help',      desc: 'all commands' },
  { cmd: '/model',     desc: 'pick model' },
  { cmd: '/plan',      desc: 'create plan' },
  { cmd: '/providers', desc: 'manage keys' },
  { cmd: '/mode',      desc: 'plan / build' },
  { cmd: '/tests',     desc: 'run tests' },
  { cmd: '/diff',      desc: 'git diff' },
  { cmd: '/compact',   desc: 'compress ctx' },
  { cmd: '/memory',    desc: 'edit memory' },
  { cmd: '/skills',    desc: 'list skills' },
  { cmd: '/runs',      desc: 'list runs' },
  { cmd: '/diagnose',  desc: 'health check' },
];

/**
 * Render the slash-command quick-reference grid shown on
 * startup. Two-column layout, 3 rows. Title in SNOW4
 * letter-spaced caps, commands in LAVA, descriptions in
 * SNOW3.
 */
export function renderCommandGrid(commands: ReadonlyArray<CommandEntry> = DEFAULT_COMMANDS): void {
  const w = Math.min(100, cols() - 4);
  const titleText = 'QUICK REFERENCE';
  safeWriteLine('');
  safeWriteLine(`  ${C.SNOW4}${titleText}${C.RESET}  ${C.VOID4_FG}${'─'.repeat(Math.max(0, w - titleText.length - 4))}${C.RESET}`);
  safeWriteLine('');
  const cmdW = 14;
  const descW = Math.max(20, Math.floor((w - 8) / 2) - cmdW);
  for (let i = 0; i < commands.length; i += 2) {
    const left = commands[i]!;
    const right = commands[i + 1];
    const leftStr = `  ${C.LAVA}${padToVisual(left.cmd, cmdW, ' ')}${C.RESET}${C.SNOW3}${padToVisual(left.desc, descW, ' ')}${C.RESET}`;
    const rightStr = right
      ? `${C.LAVA}${padToVisual(right.cmd, cmdW, ' ')}${C.RESET}${C.SNOW3}${right.desc}${C.RESET}`
      : '';
    safeWriteLine(leftStr + rightStr);
  }
  safeWriteLine('');
  safeWriteLine(`  ${C.VOID4_FG}${'─'.repeat(w)}${C.RESET}`);
  safeWriteLine('');
}

/* ──────────────────────── Mode selector ──────────────────────── */

export interface ModeOption {
  id: string;
  label: string;
  description: string;
}

export interface ModeGroup {
  title: string;
  modes: ModeOption[];
  selected: string;
}

/**
 * Render the mode-selector block as a static, non-interactive
 * display. (The interactive variant in the spec uses raw-mode
 * keyboard input which is implemented in `prompt.ts`; this
 * function is the printer it calls into.)
 */
export function renderModeSelector(group: ModeGroup): void {
  const w = Math.min(100, cols() - 4);
  safeWriteLine('');
  safeWriteLine(`  ${C.SNOW4}${group.title}${C.RESET}  ${C.VOID4_FG}${'─'.repeat(Math.max(0, w - group.title.length - 4))}${C.RESET}`);
  safeWriteLine('');
  for (const mode of group.modes) {
    const isSelected = mode.id === group.selected;
    const dot = isSelected ? `${C.LAVA}◉${C.RESET}` : `${C.SNOW4}○${C.RESET}`;
    const label = isSelected
      ? `${C.SNOW}${C.BOLD}${mode.label}${C.RESET}`
      : `${C.SNOW3}${mode.label}${C.RESET}`;
    const desc = isSelected ? `${C.SNOW3}${mode.description}${C.RESET}` : `${C.SNOW4}${mode.description}${C.RESET}`;
    const badge = isSelected
      ? `  ${C.LAVA_BG}${C.LAVA} active ${C.RESET}`
      : '';
    safeWriteLine(`  ${dot}  ${label}  ${desc}${badge}`);
  }
  safeWriteLine('');
}
