import { C, visLen } from "./colors.js";
import { reportActivity, setActivitySink } from "./activity.js";
import { sessionScreenOwnsActivity } from "./session-screen.js";
import { safeWrite, safeWriteLine } from "./render-primitives.js";
import { renderDotMark, type DotMotion } from "./dotmatrix.js";

export { renderDotMark } from "./dotmatrix.js";

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

    if (this.isTTY && process.env.FIXO_REDUCED_MOTION !== "1") {
      // Hide cursor
      safeWrite("\x1b[?25l");
      this.timer = setInterval(() => this.draw(), 90);
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
    if ((!this.isTTY || process.env.FIXO_REDUCED_MOTION === "1") && this.timer === null) {
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

    const motion: DotMotion = this.phase.id === "reasoning" || this.phase.id === "writing"
      ? "bloom" : "orbit";
    const mark = `${C.LAVA}${renderDotMark(this.frame, motion)}${C.RESET}`;
    this.frame++;

    // Calculate available width to guarantee single-line sticky rendering
    const cols = Math.max(40, process.stdout.columns ?? 100);
    const elapsedSecs = (elapsedMs / 1000).toFixed(1);
    const meta = `${C.SNOW4}(turn ${this.turnCount}) ${elapsedSecs}s${C.RESET}`;
    const metaLen = visLen(meta);

    // Base text before detail
    const phaseColor = C.LAVA;
    const icon = `${phaseColor}${this.phase.icon}${C.RESET}`;
    const label = `${C.BOLD}${phaseColor}${this.phase.label}${C.RESET}`;
    const baseText = `  ${mark}  ${icon} ${label}`;
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
