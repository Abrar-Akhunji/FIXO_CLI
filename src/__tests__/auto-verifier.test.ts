/**
 * auto-verifier.test.ts — Phase 2.2 unit coverage.
 *
 * The verifier integration in SingleAgent is intentionally a thin
 * glue layer: gate decision + output classification + repair-message
 * shape all live in `auto-verifier.ts` so they can be tested without
 * standing up the LLM streaming pipeline. Full integration coverage
 * (real model self-repairs a real failing test) is documented as
 * the manual end-to-end smoke step in the Phase 2 plan acceptance.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideAutoVerify,
  classifyVerifyOutput,
  buildRepairMessage,
} from "../agent/auto-verifier.js";
import type { SafetyConfig } from "../config.js";
import type { AgentContext } from "../types.js";

const baseSafety: SafetyConfig = {
  atomicStaging: true,
  stagingTtlMs: 24 * 60 * 60 * 1000,
  lspPreSave: "warn",
  loopTrap: {
    triggerCount: 3,
    hardAbortCount: 6,
    toolResultTailBytes: 1024,
    maxHistory: 64,
    enabled: true,
  },
  semanticLoopTrap: {
    enabled: true,
    windowSize: 5,
    triggerCount: 3,
    hardAbortCount: 6,
  },
  largeFileGateBytes: 15 * 1024,
  largeFileGateLines: 350,
  toolCalls: {
    softLimit: 50,
    hardLimit: 100,
    autoExtend: true,
    investigationMultiplier: 3,
  },
  sandboxMode: "guard",
  autoVerify: true,
  autoVerifyMaxRepairs: 1,
};

const baseContext: AgentContext = {
  task: "edit foo.ts",
  model: "gpt-4o-mini",
  cwd: "/tmp",
  verbose: false,
  selectedFiles: [],
  policy: "shell-confirm",
  mode: "BUILD",
};

/* ──────────────────────── decideAutoVerify ──────────────────────── */

test("decideAutoVerify — fires on BUILD mode with mutations and budget remaining", () => {
  const d = decideAutoVerify({
    safety: baseSafety,
    context: baseContext,
    modifiedFilesCount: 1,
    repairsUsed: 0,
  });
  assert.equal(d.run, true);
});

test("decideAutoVerify — opt-out via safety.autoVerify = false", () => {
  const d = decideAutoVerify({
    safety: { ...baseSafety, autoVerify: false },
    context: baseContext,
    modifiedFilesCount: 1,
    repairsUsed: 0,
  });
  assert.deepEqual(d, { run: false, reason: "disabled" });
});

test("decideAutoVerify — skipped outside BUILD mode (PLAN/EXPLORE/SCOUT)", () => {
  for (const mode of ["PLAN", "EXPLORE", "SCOUT"] as const) {
    const d = decideAutoVerify({
      safety: baseSafety,
      context: { ...baseContext, mode },
      modifiedFilesCount: 1,
      repairsUsed: 0,
    });
    assert.deepEqual(
      d,
      { run: false, reason: "wrong-mode" },
      `expected skip for mode=${mode}`,
    );
  }
});

test("decideAutoVerify — skipped when no file mutations occurred", () => {
  const d = decideAutoVerify({
    safety: baseSafety,
    context: baseContext,
    modifiedFilesCount: 0,
    repairsUsed: 0,
  });
  assert.deepEqual(d, { run: false, reason: "no-mutation" });
});

test("decideAutoVerify — skipped once repair budget is exhausted", () => {
  const d = decideAutoVerify({
    safety: { ...baseSafety, autoVerifyMaxRepairs: 1 },
    context: baseContext,
    modifiedFilesCount: 3,
    repairsUsed: 1,
  });
  assert.deepEqual(d, { run: false, reason: "budget-exhausted" });
});

test("decideAutoVerify — autoVerifyMaxRepairs = 0 means the verifier never fires", () => {
  const d = decideAutoVerify({
    safety: { ...baseSafety, autoVerifyMaxRepairs: 0 },
    context: baseContext,
    modifiedFilesCount: 5,
    repairsUsed: 0,
  });
  assert.deepEqual(d, { run: false, reason: "budget-exhausted" });
});

/* ──────────────────────── classifyVerifyOutput ──────────────────────── */

test("classifyVerifyOutput — Status: 0 maps to passing", () => {
  assert.equal(
    classifyVerifyOutput("Status: 0\nOutput:\nAll 12 tests passed"),
    "passing",
  );
});

test("classifyVerifyOutput — non-zero status maps to failing", () => {
  assert.equal(
    classifyVerifyOutput("Status: 1\nRelevant output:\nFAIL src/foo.test.ts"),
    "failing",
  );
});

test('classifyVerifyOutput — "No test or build command detected" maps to no-command', () => {
  assert.equal(
    classifyVerifyOutput("No test or build command detected."),
    "no-command",
  );
});

test("classifyVerifyOutput — empty / unrecognized output defaults to failing (conservative)", () => {
  assert.equal(classifyVerifyOutput(""), "failing");
  assert.equal(
    classifyVerifyOutput("weird output that doesnt match any known shape"),
    "failing",
  );
});

/* ──────────────────────── buildRepairMessage ──────────────────────── */

test("buildRepairMessage — includes the test output verbatim and a fix directive", () => {
  const out = "Status: 1\nRelevant output:\n  TS2345: Argument of type ...";
  const msg = buildRepairMessage(out);
  assert.match(msg, /verification command reported failures/);
  assert.match(msg, /inspect the failing output/i);
  assert.match(msg, /run the verification again/i);
  assert.ok(
    msg.includes(out),
    "repair message must include the test output verbatim",
  );
});
