/**
 * auto-verifier.ts — Phase 2.2 decision helpers for the
 * SingleAgent's automatic post-edit verifier loop.
 *
 * Lives in its own module so the gate ("should this run fire the
 * verifier?") and the output-classification ("did the test runner
 * say pass/fail/no-command?") can be unit-tested without
 * standing up the entire SingleAgent streaming pipeline.
 *
 * The SingleAgent calls into here at the "no more tool calls"
 * boundary; everything network-, IO-, and UI-shaped stays in
 * single-agent.ts so this module remains trivially testable.
 */
import type { AgentContext } from "../types.js";
import type { SafetyConfig } from "../config.js";

/** What the gate decided and why. */
export type AutoVerifyDecision =
  | { run: true }
  | {
      run: false;
      reason: "disabled" | "wrong-mode" | "no-mutation" | "budget-exhausted";
    };

export interface AutoVerifyGateInput {
  safety: SafetyConfig;
  context: AgentContext;
  modifiedFilesCount: number;
  repairsUsed: number;
}

/**
 * Pure function — does NOT touch disk, network, or process state.
 * Returns whether the verifier should fire this turn, along with a
 * short categorical reason for telemetry / logging.
 */
export function decideAutoVerify(
  input: AutoVerifyGateInput,
): AutoVerifyDecision {
  if (input.safety.autoVerify === false) {
    return { run: false, reason: "disabled" };
  }
  if (input.context.mode !== "BUILD") {
    return { run: false, reason: "wrong-mode" };
  }
  if (input.modifiedFilesCount <= 0) {
    return { run: false, reason: "no-mutation" };
  }
  const max = Math.max(0, input.safety.autoVerifyMaxRepairs ?? 1);
  if (input.repairsUsed >= max) {
    return { run: false, reason: "budget-exhausted" };
  }
  return { run: true };
}

/** Outcome of inspecting the test-runner string output. */
export type VerifyOutcome = "passing" | "failing" | "no-command";

/**
 * Classify what runProjectTests() returned. The test runner returns
 * a free-form summary string today — we deliberately do not change
 * its return type because /fix-tests parses it the same way, and a
 * shared signal source means the two paths can't drift.
 *
 *  - `passing`     → the summary starts with `Status: 0`
 *  - `no-command`  → the runner reported there was nothing to run
 *  - `failing`     → anything else (non-zero status / parse fall-through)
 */
export function classifyVerifyOutput(output: string): VerifyOutcome {
  if (output.includes("No test or build command detected")) return "no-command";
  if (output.includes("Status: 0")) return "passing";
  return "failing";
}

/**
 * Build the user-shaped repair-request message we feed back into the
 * conversation when the verifier finds a failure. Format mirrors the
 * /fix-tests slash command's repair-task string so the model sees a
 * familiar shape whether the human or the auto-verifier triggered it.
 */
export function buildRepairMessage(verifyOutput: string): string {
  return (
    `The project's verification command reported failures after your edits. ` +
    `Please inspect the failing output below, fix the underlying issue, and run the verification again to confirm.\n\n` +
    verifyOutput
  );
}
