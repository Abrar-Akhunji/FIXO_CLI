import { test } from "node:test";
import * as assert from "node:assert";
import { getActiveTools } from "../agent/tool-executor.js";

test("tool filtering works for different modes", async (t) => {
  await t.test("PLAN mode restricts to read-only tools", () => {
    const tools = getActiveTools("PLAN");
    const toolNames = tools.map((t) => t.function.name);
    // PLAN mode should only allow read-only tools
    assert.ok(toolNames.includes("read_file"));
    assert.ok(toolNames.includes("search_code"));
    assert.ok(toolNames.includes("web_fetch"));
    // Write and command tools must be excluded
    assert.ok(!toolNames.includes("write_file"));
    assert.ok(!toolNames.includes("run_command"));
    assert.ok(!toolNames.includes("delete_file"));
  });

  await t.test("BUILD mode includes standard tools", () => {
    const tools = getActiveTools("BUILD");
    const toolNames = tools.map((t) => t.function.name);
    assert.ok(toolNames.includes("run_command"));
    assert.ok(toolNames.includes("write_file"));
    assert.ok(toolNames.includes("read_file"));
  });

  await t.test("EXPLORE mode filters strictly to read and lsp tools", () => {
    const tools = getActiveTools("EXPLORE");
    const toolNames = tools.map((t) => t.function.name);

    // Allowed tools for explore
    const allowed = [
      "read_file",
      "list_dir",
      "search_code",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_hover",
    ];

    // Check that there are no extra tools
    for (const name of toolNames) {
      assert.ok(
        allowed.includes(name),
        `EXPLORE mode should not include ${name}`,
      );
    }

    // Check that the core tools are present
    assert.ok(toolNames.includes("read_file"));
    assert.ok(toolNames.includes("list_dir"));
    assert.ok(toolNames.includes("lsp_goto_definition"));
  });

  await t.test("SCOUT mode filters strictly to web tools", () => {
    const tools = getActiveTools("SCOUT");
    const toolNames = tools.map((t) => t.function.name);

    // Allowed tools for scout
    const allowed = ["web_fetch", "web_search"];

    // Check that there are no extra tools
    for (const name of toolNames) {
      assert.ok(
        allowed.includes(name),
        `SCOUT mode should not include ${name}`,
      );
    }

    // Check that the core tools are present
    assert.ok(toolNames.includes("web_fetch"));
    assert.ok(toolNames.includes("web_search"));
  });
});
