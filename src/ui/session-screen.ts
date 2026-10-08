/** Alternate-screen session with a scrollable transcript and anchored composer. */
import { setActivitySink } from "./activity.js";
import { C } from "./colors.js";
import { renderDotMark } from "./dotmatrix.js";
import { SessionDialog, type DialogSpec, DIALOG_CANCEL } from "./session-dialog.js";
import { cellWidth, clipStyledText, layoutComposer, safeTerminalText, wrapStyledText } from "./terminal-text.js";

export function fitCell(text: string, cols: number): string {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t]/g, " ");
  const width = Math.max(1, cols);
  if (clean.length <= width) return clean;
  if (width === 1) return "…";
  return `${clean.slice(0, width - 1)}…`;
}

/** Wrap logical output into terminal rows without changing the stored transcript. */
export function wrapTranscriptLine(text: string, cols: number): string[] {
  const width = Math.max(1, cols);
  const chars = Array.from(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  if (chars.length === 0) return [""];
  const rows: string[] = [];
  for (let start = 0; start < chars.length; start += width) {
    rows.push(chars.slice(start, start + width).join(""));
  }
  return rows;
}

export function composerViewport(line: string, cursor: number, cols: number): {
  text: string;
  cursor: number;
} {
  const width = Math.max(1, cols);
  if (line.length <= width) return { text: line, cursor: Math.min(cursor, width) };
  const start = Math.max(0, Math.min(cursor - width + 2, line.length - width + 1));
  const end = Math.min(line.length, start + width - (start > 0 ? 1 : 0));
  const text = `${start > 0 ? "…" : ""}${line.slice(start, end)}`;
  return { text: end < line.length ? `${text.slice(0, -1)}…` : text, cursor: cursor - start + (start > 0 ? 1 : 0) };
}

export function renderSessionFrame(opts: {
  mode: string;
  model: string;
  activity: string;
  cols: number;
}): { title: string; rule: string; activity: string } {
  const cols = Math.max(20, opts.cols);
  return {
    title: fitCell(`FIXO  ${opts.mode}  ${opts.model}`, cols),
    rule: "─".repeat(cols),
    activity: fitCell(opts.activity || "idle", cols),
  };
}

export interface ScreenIO {
  write(chunk: string): void;
  rows: number;
  cols: number;
}

export interface ScreenMeta {
  mode: string;
  model: string;
  provider?: string;
  session?: string;
  contextUsed?: number;
  contextLimit?: number;
  sessionTokens?: number;
  turns?: number;
  toolCalls?: number;
}

export interface ScrollbarGeometry {
  thumbStart: number;
  thumbSize: number;
  maxOffset: number;
}

/** Convert FIXO's bottom-relative scroll offset into a conventional top-relative rail thumb. */
export function scrollbarGeometry(total: number, viewport: number, offset: number): ScrollbarGeometry {
  const safeViewport = Math.max(1, viewport);
  const maxOffset = Math.max(0, total - safeViewport);
  if (maxOffset === 0) return { thumbStart: 0, thumbSize: safeViewport, maxOffset };
  const thumbSize = Math.max(1, Math.floor((safeViewport * safeViewport) / total));
  const travel = Math.max(0, safeViewport - thumbSize);
  const clamped = Math.max(0, Math.min(maxOffset, offset));
  const thumbStart = Math.round(((maxOffset - clamped) / maxOffset) * travel);
  return { thumbStart, thumbSize, maxOffset };
}

type MessageRole = "user" | "assistant" | "system";
interface TranscriptRow { text: string; role: MessageRole; heading?: boolean }

let activeScreen: SessionScreen | null = null;
function setActiveScreen(screen: SessionScreen): void { activeScreen = screen; }
export function getActiveSessionScreen(): SessionScreen | null {
  return activeScreen?.ownsActivity() ? activeScreen : null;
}
export function beginAssistantMessage(): void { getActiveSessionScreen()?.beginAssistantMessage(); }
export function endAssistantMessage(): void { getActiveSessionScreen()?.endAssistantMessage(); }

function clearActiveScreen(screen: SessionScreen): void {
  if (activeScreen === screen) activeScreen = null;
}

export function sessionScreenOwnsActivity(): boolean {
  return activeScreen?.ownsActivity() ?? false;
}

export function holdSessionScreen(): void {
  activeScreen?.suspend();
}

export function releaseSessionScreen(): void {
  activeScreen?.resume();
}

export class SessionScreen {
  private opened = false;
  private suspended = false;
  private painting = false;
  private capturing = false;
  private activity = "idle";
  private busy = false;
  private queuedCount = 0;
  private frame = 0;
  private animation: NodeJS.Timeout | null = null;
  private meta: ScreenMeta;
  private lines: TranscriptRow[] = [];
  private outputRole: MessageRole = "system";
  private partial = "";
  private visualCache: { cols: number; rows: TranscriptRow[]; lineCount: number } | null = null;
  private dialog: SessionDialog<unknown> | null = null;
  private dialogQueue: Array<() => void> = [];
  private composer = "";
  private composerCursor = 0;
  private suggestions: string[] = [];
  private highlighted = 0;
  private scrollOffset = 0;
  private originalWrite: typeof process.stdout.write | null = null;
  private originalErrorWrite: typeof process.stderr.write | null = null;
  private paintHandle: NodeJS.Immediate | null = null;
  private lastRows = new Map<number, string>();
  private resizeHandler = () => {
    this.lastRows.clear();
    this.paint();
  };

  constructor(
    meta: ScreenMeta,
    private io: ScreenIO,
    private captureOutput = false,
  ) {
    this.meta = { ...meta };
  }

  static openIfEnabled(meta: ScreenMeta): SessionScreen | null {
    if (process.env.NODE_ENV === "test") return null;
    if (process.env.FIXO_UI === "inline") return null;
    if (!process.stdout.isTTY || !process.stdin.isTTY) return null;
    const screen = new SessionScreen(meta, {
      write(chunk: string) {
        process.stdout.write(chunk);
      },
      get rows() {
        return process.stdout.rows || 24;
      },
      get cols() {
        return process.stdout.columns || 80;
      },
    }, true);
    activeScreen = screen;
    screen.open();
    return screen;
  }

  ownsActivity(): boolean {
    return this.opened && !this.suspended;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    setActiveScreen(this);
    this.suspended = false;
    this.lastRows.clear();
    this.raw("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J");
    if (this.captureOutput) {
      this.startCapture();
      process.stdout.on("resize", this.resizeHandler);
    }
    this.paint();
    setActivitySink((line) => {
      this.setActivity(line);
    });
  }

  setMeta(meta: Partial<ScreenMeta>): void {
    this.meta = { ...this.meta, ...meta };
    this.requestPaint();
  }

  setActivity(line: string): void {
    this.activity = line;
    this.requestPaint();
  }

  setQueuedCount(count: number): void { this.queuedCount = count; this.requestPaint(); }

  setConversationHistory(history: ReadonlyArray<{ role: string; content: unknown }>): void {
    this.partial = "";
    this.lines = [];
    this.outputRole = "system";
    for (const message of history) {
      const role: MessageRole = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system";
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.flatMap((part) => typeof part === "object" && part && "text" in part ? [String(part.text)] : []).join("\n")
          : String(message.content ?? "");
      if (!content) continue;
      if (role !== "system") {
        this.lines.push({ text: "", role: "system" }, {
          text: role === "user" ? "You" : "FIXO",
          role,
          heading: true,
        });
      }
      for (const line of content.split(/\r?\n/)) this.lines.push({ text: line, role });
      this.lines.push({ text: "", role: "system" });
    }
    this.visualCache = null;
    this.scrollOffset = 0;
    this.requestPaint();
  }

  transcriptWidth(): number { return Math.max(1, this.io.cols - 8); }

  beginTask(): void {
    if (!this.ownsActivity()) return;
    this.busy = true;
    this.activity = "Routing request…";
    this.frame = 0;
    if (!this.animation && process.env.FIXO_REDUCED_MOTION !== "1") {
      this.animation = setInterval(() => {
        this.frame++;
        this.requestPaint();
      }, 120);
    }
    this.requestPaint();
  }

  endTask(): void {
    this.endAssistantMessage();
    this.busy = false;
    if (this.animation) clearInterval(this.animation);
    this.animation = null;
    this.activity = "Ready";
    this.requestPaint();
  }

  setComposer(line: string, cursor = line.length): void {
    this.composer = line;
    this.composerCursor = Math.max(0, Math.min(cursor, line.length));
    this.requestPaint();
  }

  setSuggestions(items: readonly string[], highlighted = 0): void {
    this.suggestions = [...items].slice(0, 6);
    this.highlighted = highlighted;
    this.requestPaint();
  }

  appendMessage(text: string): void {
    const before = this.transcriptLength();
    this.flushPartial();
    for (const line of text.split(/\r?\n/)) this.lines.push({ text: line, role: "system" });
    if (this.scrollOffset > 0) this.scrollOffset += this.transcriptLength() - before;
    this.requestPaint();
  }

  appendUserMessage(text: string): void {
    if (this.partial) this.flushPartial();
    this.lines.push({ text: "", role: "system" }, { text: "You", role: "user", heading: true });
    for (const line of text.split(/\r?\n/)) this.lines.push({ text: line, role: "user" });
    this.lines.push({ text: "", role: "system" });
    this.scrollOffset = 0;
    this.requestPaint();
  }

  beginAssistantMessage(): void {
    if (this.outputRole === "assistant") return;
    if (this.partial) this.flushPartial();
    this.lines.push({ text: "", role: "system" }, { text: "FIXO", role: "assistant", heading: true });
    this.outputRole = "assistant";
    this.requestPaint();
  }

  endAssistantMessage(): void {
    if (this.partial) this.flushPartial();
    this.outputRole = "system";
  }

  hasDialog(): boolean { return this.dialog !== null; }

  inputDialog(chunk: string): boolean {
    if (!this.dialog) return false;
    this.dialog.input(chunk);
    this.requestPaint();
    return true;
  }

  ask<T>(spec: DialogSpec<T>): Promise<T | symbol> {
    return new Promise((resolve) => {
      const show = () => {
        if (!this.opened) { resolve(DIALOG_CANCEL); return; }
        this.dialog = new SessionDialog(spec, (value) => {
          this.dialog = null;
          resolve(value);
          this.dialogQueue.shift()?.();
          this.requestPaint();
        }) as SessionDialog<unknown>;
        this.requestPaint();
      };
      if (this.dialog) this.dialogQueue.push(show);
      else show();
    });
  }

  /** Lines of this session. Wheel scroll reads this, not the terminal scrollback. */
  transcriptLength(): number {
    return this.visualRows().length;
  }

  scrollBy(delta: number): void {
    if (!this.opened || this.suspended) return;
    const window = this.windowSize();
    const maxOffset = Math.max(0, this.transcriptLength() - window);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    this.requestPaint();
  }

  scrollPage(direction: -1 | 1): void {
    this.scrollBy(direction * Math.max(1, this.windowSize() - 2));
  }

  /** Handle wheel and scrollbar pointer input. Returns true when the event belongs to the session surface. */
  handleMouse(button: number, column: number, row: number, action: "M" | "m"): boolean {
    if (!this.opened || this.suspended || this.dialog) return false;
    if (button === 64 || button === 65) {
      this.scrollBy(button === 64 ? 4 : -4);
      return true;
    }
    const firstBodyRow = this.io.rows >= 8 ? 3 : 2;
    const viewport = this.windowSize();
    if (column < this.io.cols - 1 || row < firstBodyRow || row >= firstBodyRow + viewport) return false;
    if (action === "m" || (button !== 0 && button !== 32)) return false;
    const total = this.transcriptLength();
    const { maxOffset } = scrollbarGeometry(total, viewport, this.scrollOffset);
    if (maxOffset === 0) return true;
    const trackPosition = Math.max(0, Math.min(viewport - 1, row - firstBodyRow));
    const fromTop = viewport <= 1 ? 0 : trackPosition / (viewport - 1);
    this.scrollOffset = Math.round((1 - fromTop) * maxOffset);
    this.requestPaint();
    return true;
  }

  suspend(): void {
    if (!this.opened || this.suspended) return;
    if (this.paintHandle) {
      clearImmediate(this.paintHandle);
      this.paintHandle = null;
      this.paint();
    }
    this.stopCapture();
    this.suspended = true;
    this.lastRows.clear();
    this.raw("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1b[?25h");
  }

  resume(): void {
    if (!this.opened || !this.suspended) return;
    this.suspended = false;
    this.lastRows.clear();
    this.raw("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    if (this.captureOutput) this.startCapture();
    this.paint();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.dialog?.cancel();
    for (const show of this.dialogQueue.splice(0)) show();
    if (this.paintHandle) clearImmediate(this.paintHandle);
    this.paintHandle = null;
    this.stopCapture();
    if (this.animation) clearInterval(this.animation);
    this.animation = null;
    if (this.captureOutput) process.stdout.off("resize", this.resizeHandler);
    setActivitySink(null);
    this.raw("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1b[?25h");
    this.opened = false;
    this.suspended = false;
    clearActiveScreen(this);
  }

  private windowSize(): number {
    return Math.max(0, this.io.rows < 8 ? this.io.rows - 3 : this.io.rows - (this.io.rows >= 16 ? 11 : 6));
  }

  private startCapture(): void {
    if (this.capturing || this.originalWrite) return;
    const native = process.stdout.write.bind(process.stdout);
    this.originalWrite = process.stdout.write;
    this.capturing = true;
    process.stdout.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      if (this.painting || this.suspended) {
        return native(chunk, encoding as BufferEncoding, cb);
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.pushText(text);
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stdout.write;
    this.originalErrorWrite = process.stderr.write;
    // Warnings/errors share the transcript instead of scribbling over the input.
    process.stderr.write = process.stdout.write;
  }

  private stopCapture(): void {
    if (this.originalWrite) {
      process.stdout.write = this.originalWrite;
      this.originalWrite = null;
    }
    if (this.originalErrorWrite) {
      process.stderr.write = this.originalErrorWrite;
      this.originalErrorWrite = null;
    }
    this.capturing = false;
  }

  private pushText(text: string): void {
    const before = this.transcriptLength();
    const clean = safeTerminalText(text);
    for (let index = 0; index < clean.length; index++) {
      const char = clean[index];
      if (char === "\x1b") {
        const style = /^\x1b\[[0-9;]*m/.exec(clean.slice(index))?.[0];
        if (style) { this.partial += style; index += style.length - 1; }
      } else if (char === "\r") {
        if (clean[index + 1] === "\n") {
          index++;
          this.flushPartial();
        } else {
          this.partial = "";
        }
      } else if (char === "\n") {
        this.flushPartial();
      } else if (char === "\b") {
        this.partial = this.partial.slice(0, -1);
      } else if (char >= " ") {
        this.partial += char;
      }
    }
    if (this.lines.length > 5000) {
      this.lines.splice(0, this.lines.length - 5000);
      this.visualCache = null;
    }
    if (this.scrollOffset > 0) {
      this.scrollOffset += Math.max(0, this.transcriptLength() - before);
    }
    this.requestPaint();
  }

  private requestPaint(): void {
    if (!this.ownsActivity() || this.paintHandle) return;
    this.paintHandle = setImmediate(() => {
      this.paintHandle = null;
      this.paint();
    });
  }

  private flushPartial(): void {
    this.lines.push({ text: this.partial, role: this.outputRole });
    this.partial = "";
  }

  private visualRows(): TranscriptRow[] {
    const cols = this.transcriptWidth();
    if (!this.visualCache || this.visualCache.cols !== cols) {
      this.visualCache = { cols, rows: [], lineCount: 0 };
    }
    const cache = this.visualCache;
    for (const line of this.lines.slice(cache.lineCount)) {
      cache.rows.push(...wrapStyledText(line.text, cols).map((text) => ({ ...line, text })));
    }
    cache.lineCount = this.lines.length;
    // Only the unfinished line changes during token streaming. Completed rows
    // are measured once per terminal width, not once per token.
    return this.partial
      ? cache.rows.concat(wrapStyledText(this.partial, cols).map((text) => ({ text, role: this.outputRole })))
      : cache.rows;
  }

  private paint(): void {
    if (!this.opened || this.suspended) return;
    this.painting = true;
    try {
      const frame = renderSessionFrame({
        mode: this.meta.mode,
        model: `${this.meta.provider ? `${this.meta.provider} / ` : ""}${this.meta.model}`,
        activity: this.activity,
        cols: this.io.cols,
      });
      const rows = Math.max(1, this.io.rows);
      const cols = Math.max(1, this.io.cols);
      const window = this.windowSize();
      const content = this.visualRows();
      const maxOffset = Math.max(0, content.length - window);
      if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
      const start = Math.max(0, content.length - window - this.scrollOffset);
      const visible = content.slice(start, start + window);
      const scrollbar = scrollbarGeometry(content.length, window, this.scrollOffset);
      let body = "\x1b[?25l";
      const nextRows = new Map<number, string>();
      const row = (index: number, value: string, color = C.SNOW2) => {
        if (index < 1 || index > rows) return;
        nextRows.set(index, `${color}${clipStyledText(value, cols - 1)}${C.RESET}`);
      };
      if (rows >= 2) row(1, `  ◈  ${frame.title}`, C.LAVA);
      if (rows >= 8) row(2, `  ${"─".repeat(Math.max(1, cols - 4))}`, C.VOID4_FG);
      const firstBodyRow = rows >= 8 ? 3 : 2;
      for (let i = 0; i < window; i++) {
        const item = visible[i];
        const prefix = item?.heading ? (item.role === "user" ? "  ╭─ " : "  ◈  ") : item?.role === "user" ? "  │  " : "     ";
        const value = item?.text ? `${prefix}${item.text}` : "";
        const rail = scrollbar.maxOffset > 0 && i >= scrollbar.thumbStart && i < scrollbar.thumbStart + scrollbar.thumbSize ? "█" : "│";
        const withRail = `${value}${" ".repeat(Math.max(1, cols - 2 - cellWidth(value)))}${rail}`;
        row(firstBodyRow + i, withRail,
          item?.heading || item?.role === "user" ? C.LAVA : item?.role === "assistant" ? C.SNOW : C.SNOW4);
      }
      if (content.length === 0 && rows >= 14) {
        const center = Math.max(3, Math.floor((window - 3) / 2));
        row(center, "       ● ● ●", C.LAVA);
        row(center + 1, "       ● ● ·   FIXO", C.LAVA);
        row(center + 2, "       ● · ·   Your coding workspace", C.SNOW2);
        row(center + 4, "       /help  commands     Tab  mode     Enter  send", C.SNOW4);
      }
      if (this.suggestions.length > 0 && rows >= 8) {
        const first = Math.max(3, firstBodyRow + window - this.suggestions.length);
        this.suggestions.forEach((suggestion, index) => {
          row(first + index, `  ${index === this.highlighted ? "›" : " "} ${suggestion}`,
            index === this.highlighted ? C.LAVA : C.SNOW3);
        });
      }
      const activity = this.busy
        ? `${renderDotMark(this.frame, this.activity.toLowerCase().includes("reason") ? "bloom" : "orbit")}  ${frame.activity}`
        : frame.activity;
      if (rows >= 8 && rows < 16) {
        row(rows - 3, `  ${activity}`, this.busy ? C.LAVA_DIM : C.SNOW4);
        row(rows - 2, `  ${"─".repeat(Math.max(1, cols - 4))}`, C.VOID4_FG);
      }
      const prompt = this.composer || (this.busy ? "Type a follow-up; Enter queues it" : "Ask FIXO anything, or type / for commands");
      const view = composerViewport(prompt, this.composerCursor, cols - 6);
      let composerRow = rows >= 16 ? rows - 4 : rows >= 3 ? rows - 1 : rows;
      let cursorColumn = Math.min(cols - 1, 5 + (this.composer ? view.cursor : 0));
      if (rows >= 16) {
        row(rows - 8, "");
        const context = this.meta.contextLimit
          ? `ctx ${(this.meta.contextUsed ?? 0).toLocaleString()} / ${this.meta.contextLimit.toLocaleString()} (${Math.min(100, Math.round(((this.meta.contextUsed ?? 0) / this.meta.contextLimit) * 100))}%)`
          : "ctx —";
        const activityLine = this.busy || !["idle", "Ready"].includes(this.activity)
          ? `  ${activity}  ·  ${context}`
          : this.scrollOffset
            ? `  Scrollback — scroll down to return to the latest reply  ·  ${context}`
            : `  ${context}`;
        row(rows - 7, activityLine, this.busy ? C.LAVA_DIM : C.SNOW4);
        const boxWidth = Math.max(1, cols - 5);
        row(rows - 6, `  ╭${"─".repeat(boxWidth)}╮`, C.VOID4_FG);
        row(rows - 5, `  │${" ".repeat(boxWidth)}│`, C.VOID4_FG);
        row(rows - 3, `  │${" ".repeat(boxWidth)}│`, C.VOID4_FG);
        row(rows - 2, `  ╰${"─".repeat(boxWidth)}╯`, C.VOID4_FG);
        const telemetry = [
          this.meta.session ? `session ${this.meta.session}` : undefined,
          `${(this.meta.sessionTokens ?? 0).toLocaleString()} tokens`,
          `${this.meta.turns ?? 0} turns`,
          `${this.meta.toolCalls ?? 0} tools`,
          "Enter send",
          "/ commands",
        ].filter(Boolean).join("  ·  ");
        const queueState = this.queuedCount ? `  ·  ${this.queuedCount} queued` : this.busy ? "  ·  Ctrl+C stop" : "";
        row(rows - 1, `  ${telemetry}${queueState}`, C.SNOW4);
        row(rows, "");
      } else if (rows >= 3) {
        row(rows, `  Enter send  / commands${this.busy ? "  Ctrl+C stop" : ""}`, C.SNOW4);
      }
      if (rows >= 16) {
        const draft = layoutComposer(prompt, this.composerCursor, cols - 8);
        const first = draft.lines.length === 1 ? rows - 4 : rows - 5;
        draft.lines.forEach((text, index) => row(first + index,
          `  │ ${text}${" ".repeat(Math.max(0, cols - 6 - cellWidth(text)))}│`, this.composer ? C.SNOW : C.SNOW4));
        composerRow = first + draft.cursorRow;
        cursorColumn = 5 + (this.composer ? draft.cursorColumn : 0);
      } else row(composerRow, `  › ${view.text}`, this.composer ? C.SNOW : C.SNOW4);
      if (this.dialog) {
        const maxHeight = Math.max(1, Math.min(22, rows - 2));
        const width = Math.max(1, Math.min(88, cols - 5));
        const margin = " ".repeat(Math.max(0, Math.floor((cols - width - 2) / 2)));
        const dialogRows = this.dialog.view(maxHeight - 2, Math.max(1, width - 4));
        const first = Math.max(2, Math.floor((rows - dialogRows.length - 2) / 2));
        // Dialogs own the surface, including the bottom input, until dismissed.
        for (let index = 2; index <= rows; index++) row(index, "");
        row(first, `${margin}╭${"─".repeat(width)}╮`, C.LAVA_DIM);
        dialogRows.forEach((item, index) => {
          const text = clipStyledText(item.text, Math.max(1, width - 4));
          row(first + index + 1, `${margin}│  ${text}${" ".repeat(Math.max(0, width - 2 - cellWidth(text)))}│`,
            item.tone === "selected" ? C.LAVA_BG + C.LAVA : item.tone === "title" ? C.LAVA : item.tone === "muted" ? C.SNOW4 : item.tone === "error" ? C.RED : C.SNOW);
        });
        row(first + dialogRows.length + 1, `${margin}╰${"─".repeat(width)}╯`, C.LAVA_DIM);
      }
      for (const [index, cell] of nextRows) {
        if (this.lastRows.get(index) !== cell) body += `\x1b[${index};1H\x1b[2K${cell}`;
      }
      this.lastRows = nextRows;
      if (!this.dialog) body += `\x1b[${composerRow};${Math.max(1, cursorColumn)}H\x1b[?25h`;
      this.raw(body);
    } finally {
      this.painting = false;
    }
  }

  endCapture(): void {
    if (!this.captureOutput) this.stopCapture();
  }

  private raw(chunk: string): void {
    if (this.originalWrite) {
      this.originalWrite.call(process.stdout, chunk);
      return;
    }
    this.io.write(chunk);
  }
}
