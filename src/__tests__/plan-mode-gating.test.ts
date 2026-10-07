import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  planModeBlock,
  planModeError,
  isPlanFilePath,
} from "../agent/plan-gate.js";
import { TOOL_DEFINITIONS } from "../agent/tool-definitions.js";
import { executeTool } from "../agent/tool-executor.js";
import type { AgentContext } from "../types.js";

test("TOOL_DEFINITIONS exposes enter_plan_mode and exit_plan_mode", () => {
  const enterTool = TOOL_DEFINITIONS.find(
    (t) => t.function.name === "enter_plan_mode",
  );
  const exitTool = TOOL_DEFINITIONS.find(
    (t) => t.function.name === "exit_plan_mode",
  );

  assert.ok(enterTool, "enter_plan_mode must be present");
  assert.ok(exitTool, "exit_plan_mode must be present");
  assert.match(enterTool.function.description, /PLAN mode/i);
  assert.match(exitTool.function.description, /BUILD mode/i);
});

test("isPlanFilePath identifies .fixo/plan.md, plan.md, and .fixo/last-plan.json", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-plan-test-"));
  try {
    assert.equal(isPlanFilePath(cwd, ".fixo/last-plan.json"), true);
    assert.equal(isPlanFilePath(cwd, ".fixo/plan.md"), true);
    assert.equal(isPlanFilePath(cwd, "plan.md"), true);
    assert.equal(isPlanFilePath(cwd, path.join(cwd, ".fixo", "plan.md")), true);
    assert.equal(isPlanFilePath(cwd, path.join(cwd, "plan.md")), true);

    // Code files must NOT match
    assert.equal(isPlanFilePath(cwd, "src/index.ts"), false);
    assert.equal(isPlanFilePath(cwd, "package.json"), false);
    assert.equal(isPlanFilePath(cwd, ".fixo/other.md"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("planModeBlock permits plan files and plan mode tools, blocks mutations", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-plan-gate-test-"));
  try {
    // enter_plan_mode and exit_plan_mode must never be blocked
    assert.equal(await planModeBlock("enter_plan_mode", {}, cwd), null);
    assert.equal(await planModeBlock("exit_plan_mode", {}, cwd), null);

    // Allowed plan file writes
    assert.equal(
      await planModeBlock("write_file", { path: ".fixo/plan.md" }, cwd),
      null,
    );
    assert.equal(
      await planModeBlock("write_file", { path: "plan.md" }, cwd),
      null,
    );
    assert.equal(
      await planModeBlock(
        "write_file",
        { path: ".fixo/last-plan.json" },
        cwd,
      ),
      null,
    );
    assert.equal(
      await planModeBlock("str_replace", { path: ".fixo/plan.md" }, cwd),
      null,
    );

    // Blocked writes
    assert.equal(
      await planModeBlock("write_file", { path: "src/app.ts" }, cwd),
      planModeError("write_file"),
    );
    assert.equal(
      await planModeBlock("str_replace", { path: "src/app.ts" }, cwd),
      planModeError("str_replace"),
    );
    assert.equal(
      await planModeBlock("apply_patch", {}, cwd),
      planModeError("apply_patch"),
    );
    assert.equal(
      await planModeBlock("delete_file", { path: "src/app.ts" }, cwd),
      planModeError("delete_file"),
    );

    // Shell gating
    assert.equal(
      await planModeBlock("run_command", { command: "rm src/app.ts" }, cwd),
      planModeError("run_command"),
    );
    assert.equal(
      await planModeBlock("run_command", { command: "git commit -m 'wip'" }, cwd),
      planModeError("run_command"),
    );
    assert.equal(
      await planModeBlock("run_command", { command: "npm install foo" }, cwd),
      planModeError("run_command"),
    );
    assert.equal(
      await planModeBlock("run_command", { command: "cat README.md" }, cwd),
      null,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool transitions mode with enter_plan_mode and exit_plan_mode", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-mode-exec-"));
  try {
    const fakeContext: AgentContext = {
      task: "Test plan mode",
      model: "auto",
      cwd,
      verbose: false,
      selectedFiles: [],
      mode: "BUILD",
    };

    let modeChangedTo = "";
    const options = {
      context: fakeContext,
      mode: fakeContext.mode,
      onModeChange: (m: any) => {
        modeChangedTo = m;
        fakeContext.mode = m;
      },
    };

    // 1. Enter plan mode
    const enterRes = await executeTool(
      "enter_plan_mode",
      { reason: "Architecture design" },
      cwd,
      false,
      options,
    );
    assert.equal(enterRes.ok, true);
    assert.match(enterRes.result, /Switched to PLAN mode/i);
    assert.equal(fakeContext.mode, "PLAN");
    assert.equal(modeChangedTo, "PLAN");
    assert.equal(fs.existsSync(path.join(cwd, ".fixo", "plan.md")), true);

    // 2. In PLAN mode, writing to src/code.ts must fail
    const blockedRes = await executeTool(
      "write_file",
      { path: "src/code.ts", content: "console.log('fail')" },
      cwd,
      false,
      { ...options, mode: "PLAN" },
    );
    assert.equal(blockedRes.ok, false);
    assert.match(blockedRes.result, /blocked in PLAN mode/i);

    // 3. In PLAN mode, writing to .fixo/plan.md must succeed
    const planWriteRes = await executeTool(
      "write_file",
      { path: ".fixo/plan.md", content: "# Updated Plan" },
      cwd,
      false,
      { ...options, mode: "PLAN" },
    );
    assert.equal(planWriteRes.ok, true);
    assert.match(fs.readFileSync(path.join(cwd, ".fixo", "plan.md"), "utf-8"), /Updated Plan/);

    // 4. In PLAN mode, writing to plan.md must succeed
    const rootPlanWriteRes = await executeTool(
      "write_file",
      { path: "plan.md", content: "# Root Plan" },
      cwd,
      false,
      { ...options, mode: "PLAN" },
    );
    assert.equal(rootPlanWriteRes.ok, true);
    assert.match(fs.readFileSync(path.join(cwd, "plan.md"), "utf-8"), /Root Plan/);

    // 5. Exit plan mode
    const exitRes = await executeTool(
      "exit_plan_mode",
      { planSummary: "Architecture decided" },
      cwd,
      false,
      options,
    );
    assert.equal(exitRes.ok, true);
    assert.match(exitRes.result, /Exited PLAN mode/i);
    assert.match(exitRes.result, /Architecture decided/i);
    assert.equal(fakeContext.mode, "BUILD");
    assert.equal(modeChangedTo, "BUILD");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
