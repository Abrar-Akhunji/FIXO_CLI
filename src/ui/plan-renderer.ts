/**
 * plan-renderer.ts — Renders an agent execution plan as the
 * numbered step list the user sees during PLAN mode (and as
 * the first phase of BUILD mode if the planner produced a
 * plan).
 *
 * Steps advance through four states: `pending`, `active`,
 * `done`, `failed`. The renderer draws a top rule, the steps,
 * a bottom rule, and an approval prompt.
 */

import { C, visLen } from './colors.js';

export type PlanStepState = 'pending' | 'active' | 'done' | 'failed';

export interface PlanStep {
  /** Display text for the step, e.g. `Analyze src/auth/provider.ts with ReadFile`. */
  text: string;
  state: PlanStepState;
}

const DOT_BY_STATE: Record<PlanStepState, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: C.SNOW4 },
  active:  { glyph: '◉', color: C.LAVA },
  done:    { glyph: '✓', color: C.GREEN },
  failed:  { glyph: '✗', color: C.RED },
};

function frameWidth(): number {
  return Math.max(40, Math.min(100, (process.stdout.columns ?? 100) - 4));
}

function safeWriteLine(s: string): void {
  try {
    process.stdout.write(s + '\n');
  } catch {
    // stdout may be closed during teardown
  }
}

function safeWrite(s: string): void {
  try {
    process.stdout.write(s);
  } catch {
    // stdout may be closed during teardown
  }
}

/**
 * Render the full plan block: title, steps, bottom rule, and
 * approval prompt. The prompt's `[Y/n]` portion is lava so the
 * user knows where to type.
 */
export function renderPlan(steps: ReadonlyArray<PlanStep>): void {
  const w = frameWidth();
  const title = 'PLAN';
  safeWriteLine('');
  safeWriteLine(`  ${C.SNOW4}${title}${C.RESET}  ${C.VOID4_FG}${'─'.repeat(Math.max(0, w - title.length - 4))}${C.RESET}`);
  safeWriteLine('');

  steps.forEach((step, i) => {
    const num = `${i + 1}`.padStart(2, ' ');
    const meta = DOT_BY_STATE[step.state];
    const textColor = step.state === 'pending' ? C.SNOW2 : C.SNOW;
    safeWriteLine(`    ${C.SNOW4}${num}${C.RESET}  ${meta.color}${meta.glyph}${C.RESET}  ${textColor}${step.text}${C.RESET}`);
  });

  safeWriteLine('');
  safeWriteLine(`  ${C.VOID4_FG}${'─'.repeat(w)}${C.RESET}`);
  safeWriteLine('');
  safeWriteLine(`  ${C.SNOW3}Approve plan?${C.RESET} ${C.LAVA}[Y/n]${C.RESET}  ${C.LAVA}›${C.RESET} `);
}

/**
 * Re-render a single step in-place. Useful when an agent's
 * step state changes (e.g. just transitioned from `active` to
 * `done`) and the rest of the plan is still on screen. Returns
 * the ANSI sequence to write; the caller decides whether to
 * print it on the current line or after a clear.
 */
export function renderStepUpdate(step: PlanStep, index: number): string {
  const num = `${index + 1}`.padStart(2, ' ');
  const meta = DOT_BY_STATE[step.state];
  const textColor = step.state === 'pending' ? C.SNOW2 : C.SNOW;
  return `    ${C.SNOW4}${num}${C.RESET}  ${meta.color}${meta.glyph}${C.RESET}  ${textColor}${step.text}${C.RESET}`;
}

/**
 * The approval prompt line, in case the agent wants to ask
 * for plan confirmation outside the `renderPlan` flow.
 */
export function renderApprovalPrompt(): void {
  safeWrite(`  ${C.SNOW3}Approve plan?${C.RESET} ${C.LAVA}[Y/n]${C.RESET}  ${C.LAVA}›${C.RESET} `);
}
