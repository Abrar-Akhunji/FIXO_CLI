import { C, visLen } from "./colors.js";
import { reportActivity, setActivitySink } from "./activity.js";
import { sessionScreenOwnsActivity } from "./session-screen.js";
import { safeWrite, safeWriteLine } from "./render-primitives.js";

export interface LoadingPhase {
  id:
    | "routing"
    | "reasoning"
    | "reading"
    | "executing"
    | "writing"
    | "verifying"
    | "searching"
    | "completed";
  label: string;
  detail?: string;
  icon: string;
}

// Lava Flow Bar gradient
const GRADIENT = ["░", "▒", "▓", "█", "▓", "▒", "░"];
const GRADIENT_COLORS = [
  C.LAVA_DIM,
  C.LAVA,
  "\x1b[38;2;255;160;60m", // LAVA_GLOW
  C.SNOW, // white-hot center
  "\x1b[38;2;255;160;60m", // LAVA_GLOW
  C.LAVA,
  C.LAVA_DIM,
];

const TRACK_LENGTH = 20;
const BAR_LENGTH = GRADIENT.length;
const MAX_OFFSET = TRACK_LENGTH - BAR_LENGTH;

export class LoadingAnimation {
  private phase: LoadingPhase = {
    id: "reasoning",
    label: "Reasoning…",
    icon: "⚡",
  };
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = 0;
  private turnCount = 1;
  private isTTY = process.stdout.isTTY;

  start(): void {
    if (sessionScreenOwnsActivity()) {
      this.startedAt = Date.now();
      return;
    }
    if (this.timer) return;
    this.startedAt = Date.now();
    this.frame = 0;
    setActivitySink((line) => {
      this.phase = { ...this.phase, detail: line };
    });

    if (this.isTTY) {
      // Hide cursor
      safeWrite("\x1b[?25l");
      this.timer = setInterval(() => this.draw(), 60);
    } else {
      // Non-TTY fallback
      safeWriteLine(
        `  ${this.phase.icon} ${this.phase.label} ${this.phase.detail ? `· ${this.phase.detail}` : ""}`,
      );
    }
  }

  setPhase(phase: Partial<LoadingPhase>): void {
    this.phase = { ...this.phase, ...phase };
    if (sessionScreenOwnsActivity()) {
      const detail = this.phase.detail ? ` · ${this.phase.detail}` : "";
      reportActivity(`${this.phase.icon} ${this.phase.label}${detail}`);
      return;
    }
    if (!this.isTTY && this.timer === null) {
      // In non-TTY, we only log when phase changes so the user isn't spammed, but knows it's doing something.
      safeWriteLine(
        `  ${this.phase.icon} ${this.phase.label} ${this.phase.detail ? `· ${this.phase.detail}` : ""}`,
      );
    }
  }

  setTurn(turn: number): void {
    this.turnCount = turn;
  }

  stop(): void {
    if (sessionScreenOwnsActivity()) return;
    setActivitySink(null);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      safeWrite("\r\x1b[K\x1b[?25h");
    }
  }

  markCancelled(): void {
    this.stop();
    safeWriteLine(`\r${C.YELLOW}⚠ Task cancelled${C.RESET}`);
  }

  private draw(): void {
    const elapsedMs = Date.now() - this.startedAt;

    // Calculate slider position (ping-pong)
    const cycle = Math.floor(this.frame / MAX_OFFSET);
    const pos = this.frame % MAX_OFFSET;
    const offset = cycle % 2 === 0 ? pos : MAX_OFFSET - pos;
    this.frame++;

    // Build the animated bar
    let bar = "";
    for (let i = 0; i < TRACK_LENGTH; i++) {
      if (i >= offset && i < offset + BAR_LENGTH) {
        const charIdx = i - offset;
        bar += `${GRADIENT_COLORS[charIdx]}${GRADIENT[charIdx]}${C.RESET}`;
      } else {
        bar += " ";
      }
    }

    // Calculate available width to guarantee single-line sticky rendering
    const cols = Math.max(40, process.stdout.columns ?? 100);
    const elapsedSecs = (elapsedMs / 1000).toFixed(1);
    const meta = `${C.SNOW4}(turn ${this.turnCount}) ${elapsedSecs}s${C.RESET}`;
    const metaLen = visLen(meta);

    // Base text before detail
    const phaseColor = C.LAVA;
    const icon = `${phaseColor}${this.phase.icon}${C.RESET}`;
    const label = `${C.BOLD}${phaseColor}${this.phase.label}${C.RESET}`;
    const baseText = `  ${bar}  ${icon} ${label}`;
    const baseLen = visLen(baseText);

    // Dynamically clamp detail so the total line NEVER exceeds cols - 1
    let detailText = "";
    if (this.phase.detail) {
      const maxDetailLen = Math.max(0, cols - baseLen - metaLen - 6);
      let rawDetail = this.phase.detail.replace(/[\r\n]+/g, " ").trim();
      if (visLen(rawDetail) > maxDetailLen) {
        rawDetail = maxDetailLen > 3 ? rawDetail.slice(0, maxDetailLen - 1) + "…" : "";
      }
      if (rawDetail) {
        detailText = `  ${C.SNOW4}${rawDetail}${C.RESET}`;
      }
    }

    const mainText = `${baseText}${detailText}`;
    const mainLen = visLen(mainText);
    const paddingLen = Math.max(1, cols - mainLen - metaLen - 1);
    const paddedMainLine = mainText + " ".repeat(paddingLen) + meta;

    // Single row, replaced in-place. Never wraps past columns.
    safeWrite(`\r\x1b[K${paddedMainLine}`);
  }
}
