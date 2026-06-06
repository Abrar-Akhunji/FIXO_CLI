/**
 * session-header.ts — The boxed session summary rendered once
 * when a session starts or is resumed.
 *
 * The header uses the lava top/bottom border and a SNOW4 side
 * border so it sits inside the same visual family as the AI
 * response frame and the plan renderer.
 */

import { C, providerColor } from './colors.js';
import { visLen } from './colors.js';

export interface SessionHeaderOptions {
  /** `New session` / `Resumed session` / `Imported session`. */
  status: 'new' | 'resumed' | 'imported';
  /** ISO-8601 timestamp. */
  startedAt: string;
  /** Provider display name (`Google (Gemini)`). */
  provider: string;
  /** Model id (`gemini-2.5-flash`). */
  model: string;
  /** `BUILD` / `PLAN` / `REVIEW`. */
  mode: 'BUILD' | 'PLAN' | 'REVIEW';
  /** `auto` / `single` / `multi`. */
  routing: 'auto' | 'single' | 'multi';
  /** Context window, e.g. `200k`. */
  contextWindow: string;
}

function frameWidth(): number {
  return Math.max(40, Math.min(100, (process.stdout.columns ?? 100) - 4));
}

function modeColor(mode: SessionHeaderOptions['mode']): string {
  switch (mode) {
    case 'BUILD':  return C.LAVA;
    case 'PLAN':   return C.PURPLE;
    case 'REVIEW': return C.YELLOW;
  }
}

function padInside(s: string, width: number): string {
  const v = visLen(s);
  if (v >= width) return s;
  return s + ' '.repeat(width - v);
}

function statusLabel(s: SessionHeaderOptions['status']): string {
  switch (s) {
    case 'new':      return 'New session';
    case 'resumed':  return 'Resumed session';
    case 'imported': return 'Imported session';
  }
}

/**
 * Print the session header box. The box width is `columns - 4`,
 * capped at 100. Safe to call on a non-TTY.
 */
export function renderSessionHeader(opts: SessionHeaderOptions): void {
  const w = frameWidth();
  const inner = w - 4; // account for the `│ ` and ` │` side padding
  const top = `  ${C.LAVA}┌── SESSION ${'─'.repeat(Math.max(0, inner - 14))}┐${C.RESET}`;
  const bottom = `  ${C.LAVA}└${'─'.repeat(w - 2)}┘${C.RESET}`;

  const line1 = `${C.SNOW3}${statusLabel(opts.status)}${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW2}${formatDate(opts.startedAt)}${C.RESET}`;
  const line2 = `${C.SNOW4}Provider:${C.RESET} ${C.SNOW}${providerColor(opts.provider)}${opts.provider}${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW4}Model:${C.RESET} ${C.BLUE}${opts.model}${C.RESET}`;
  const line3 = `${C.SNOW4}Mode:${C.RESET} ${modeColor(opts.mode)}${opts.mode}${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW4}Routing:${C.RESET} ${C.SNOW2}${opts.routing}${C.RESET}  ${C.SNOW4}·${C.RESET}  ${C.SNOW4}Context:${C.RESET} ${C.SNOW2}${opts.contextWindow}${C.RESET}`;

  try {
    process.stdout.write(top + '\n');
    process.stdout.write(`  ${C.SNOW4}│${C.RESET}  ${padInside(line1, inner)}${C.SNOW4}│${C.RESET}\n`);
    process.stdout.write(`  ${C.SNOW4}│${C.RESET}  ${padInside(line2, inner)}${C.SNOW4}│${C.RESET}\n`);
    process.stdout.write(`  ${C.SNOW4}│${C.RESET}  ${padInside(line3, inner)}${C.SNOW4}│${C.RESET}\n`);
    process.stdout.write(bottom + '\n');
  } catch {
    // stdout may be closed during teardown
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
