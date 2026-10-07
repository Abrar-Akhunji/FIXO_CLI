/**
 * Full-screen session chrome for an interactive TTY.
 *
 * The transcript scrolls in the middle. The header and the activity
 * row stay put. Slash commands and questions leave this screen so
 * their prompts can use the normal terminal, then come back.
 */
import { setActivitySink } from "./activity.js";

export function fitCell(text: string, cols: number): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  const width = Math.max(1, cols);
  if (clean.length <= width) return clean;
  if (width === 1) return "…";
  return `${clean.slice(0, width - 1)}…`;
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

interface ScreenMeta {
  mode: string;
  model: string;
}

let activeScreen: SessionScreen | null = null;

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
  private activity = "idle";
  private meta: ScreenMeta;

  constructor(
    meta: ScreenMeta,
    private io: ScreenIO,
  ) {
    this.meta = { ...meta };
  }

  static openIfEnabled(meta: ScreenMeta): SessionScreen | null {
    if (process.env.NODE_ENV === "test") return null;
    if (process.env.FIXO_UI === "readline") return null;
    if (!process.stdout.isTTY) return null;
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
    });
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
    this.suspended = false;
    this.raw("\x1b[?1049h\x1b[2J");
    this.paintChrome();
    this.enterScrollRegion();
    setActivitySink((line) => {
      this.setActivity(line);
    });
  }

  setMeta(meta: Partial<ScreenMeta>): void {
    this.meta = { ...this.meta, ...meta };
    if (this.ownsActivity()) this.paintChrome();
  }

  setActivity(line: string): void {
    this.activity = line;
    if (this.ownsActivity()) this.paintChrome();
  }

  beginTask(): void {
    if (!this.ownsActivity()) return;
    const end = this.scrollEnd();
    this.raw(`\x1b[${end};1H`);
  }

  suspend(): void {
    if (!this.opened || this.suspended) return;
    this.suspended = true;
    this.raw("\x1b[r\x1b[?1049l\x1b[?25h");
  }

  resume(): void {
    if (!this.opened || !this.suspended) return;
    this.suspended = false;
    this.raw("\x1b[?1049h");
    this.paintChrome();
    this.enterScrollRegion();
    this.raw(`\x1b[${this.io.rows};1H`);
  }

  close(): void {
    if (!this.opened) return;
    setActivitySink(null);
    this.raw("\x1b[r\x1b[?1049l\x1b[?25h");
    this.opened = false;
    this.suspended = false;
    clearActiveScreen(this);
  }

  private scrollEnd(): number {
    return Math.max(3, this.io.rows - 2);
  }

  private enterScrollRegion(): void {
    const end = this.scrollEnd();
    this.raw(`\x1b[3;${end}r\x1b[${end};1H`);
  }

  private paintChrome(): void {
    const frame = renderSessionFrame({
      mode: this.meta.mode,
      model: this.meta.model,
      activity: this.activity,
      cols: this.io.cols,
    });
    const activityRow = Math.max(1, this.io.rows - 1);
    this.raw(
      `\x1b[s\x1b[1;1H\x1b[2K${frame.title}\x1b[2;1H\x1b[2K${frame.rule}\x1b[${activityRow};1H\x1b[2K${frame.activity}\x1b[u`,
    );
  }

  private raw(chunk: string): void {
    this.io.write(chunk);
  }
}
