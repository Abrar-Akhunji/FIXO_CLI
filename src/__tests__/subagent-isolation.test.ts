/**
 * Tests for the subagent isolation contract.
 *
 * The subagent driver is a thin wrapper around WorkerAgent
 * with two locked invariants:
 *   1. `cleanHistory: true` — the parent's selectedFiles,
 *      systemPromptOverride, and checkCommand do not leak.
 *   2. `summaryOnly: true` — the result's `transcript` field
 *      carries only the final summary, not the raw tool log.
 *
 * We exercise the public surface (`spawnSubagent`,
 * `buildSubagentContext`, `getBackgroundSubagentResult`)
 * and assert on the deterministic parts. The actual LLM
 * round-trip is out of scope; the subagent calls into
 * WorkerAgent.run which would hit the live API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentContext,
  getBackgroundSubagentResult,
  spawnSubagent,
  _resetBackgroundSubagents,
} from "../agent/subagent.js";
import type { AgentContext } from "../types.js";

function makeParent(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    task: "parent",
    model: "gpt-test",
    cwd: "/tmp/parent-cwd",
    verbose: false,
    selectedFiles: ["parent-a.ts", "parent-b.ts"],
    systemPromptOverride: "PARENT OVERRIDE — must not leak",
    checkCommand: "parent-check",
    policy: "shell-confirm",
    yes: false,
    mode: "PLAN",
    ...overrides,
  };
}

test("buildSubagentContext forces mode to BUILD regardless of parent mode", () => {
  for (const parentMode of ["PLAN", "BUILD", "EXPLORE", "SCOUT"] as const) {
    const parent = makeParent({ mode: parentMode });
    const sub = buildSubagentContext(
      { task: "t", type: "general-purpose" },
      parent,
    );
    assert.equal(sub.mode, "BUILD", `parent mode ${parentMode} leaked`);
  }
});

test("buildSubagentContext replaces selectedFiles with contextFiles", () => {
  const parent = makeParent();
  const sub = buildSubagentContext(
    { task: "t", type: "general-purpose", contextFiles: ["only-this.ts"] },
    parent,
  );
  assert.deepEqual(sub.selectedFiles, ["only-this.ts"]);
});

test("buildSubagentContext drops parent systemPromptOverride and checkCommand", () => {
  const parent = makeParent();
  const sub = buildSubagentContext(
    { task: "t", type: "general-purpose" },
    parent,
  );
  assert.equal(sub.systemPromptOverride, undefined);
  assert.equal(sub.checkCommand, undefined);
});

test("buildSubagentContext inherits cwd, model, policy, verbose, yes", () => {
  const parent = makeParent({
    cwd: "/var/tmp/cwd-x",
    model: "claude-test",
    policy: "trusted-project",
    verbose: true,
    yes: true,
  });
  const sub = buildSubagentContext({ task: "t", type: "Explore" }, parent);
  assert.equal(sub.cwd, "/var/tmp/cwd-x");
  assert.equal(sub.model, "claude-test");
  assert.equal(sub.policy, "trusted-project");
  assert.equal(sub.verbose, true);
  assert.equal(sub.yes, true);
});

test("buildSubagentContext with no contextFiles gets an empty selectedFiles", () => {
  const parent = makeParent();
  const sub = buildSubagentContext(
    { task: "t", type: "general-purpose" },
    parent,
  );
  assert.deepEqual(sub.selectedFiles, []);
});

test("buildSubagentContext does NOT mutate the parent context", () => {
  const parent = makeParent();
  const snapshot = JSON.stringify(parent);
  void buildSubagentContext(
    { task: "t", type: "general-purpose", contextFiles: ["x"] },
    parent,
  );
  assert.equal(JSON.stringify(parent), snapshot);
});

test("spawnSubagent with runInBackground returns immediately with a jobId", async () => {
  _resetBackgroundSubagents();
  const parent = makeParent();
  // Even though we don't have an LLM, the background spawn
  // returns synchronously before the worker hits the network.
  // We test the *contract*: it returns a jobId and the result
  // is cached shortly after.
  const result = await spawnSubagent(
    { task: "noop", type: "general-purpose", runInBackground: true },
    parent,
  );
  assert.equal(result.success, true);
  assert.ok(result.jobId);
  assert.match(result.jobId ?? "", /^subagent_/);
  // The placeholder summary is intentionally empty so the
  // parent cannot confuse it with a real result.
  assert.match(result.summary, /background/);
});

test("getBackgroundSubagentResult returns null for unknown id", () => {
  _resetBackgroundSubagents();
  assert.equal(getBackgroundSubagentResult("not-real"), null);
});

test("SubagentResult transcript is a string (not undefined) and bounded", async () => {
  _resetBackgroundSubagents();
  const parent = makeParent();
  const result = await spawnSubagent(
    { task: "noop", type: "general-purpose", runInBackground: true },
    parent,
  );
  assert.equal(typeof result.transcript, "string");
  // The transcript must be bounded — it cannot include the
  // raw tool log. We don't enforce a numeric cap here, but
  // the type is a string and it carries the summary only.
  assert.ok(result.transcript.length < 10_000);
});

test("parent context is not mutated by spawnSubagent", async () => {
  _resetBackgroundSubagents();
  const parent = makeParent();
  const snapshot = JSON.stringify(parent);
  await spawnSubagent(
    { task: "noop", type: "general-purpose", runInBackground: true },
    parent,
  );
  assert.equal(JSON.stringify(parent), snapshot);
});

test("SubagentRequest type accepts all four canonical subagent types", () => {
  const types: Array<
    "general-purpose" | "statusline-setup" | "Explore" | "Plan"
  > = ["general-purpose", "statusline-setup", "Explore", "Plan"];
  for (const t of types) {
    const req: { task: string; type: typeof t } = { task: "t", type: t };
    // Type-only assertion — compiling this is the test.
    assert.equal(req.type, t);
  }
});
