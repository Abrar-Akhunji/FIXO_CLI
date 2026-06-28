import assert from "node:assert/strict";
import test from "node:test";
import { FILE_WRITING_RULES_BLOCK } from "../agent/file-writing-rules.js";
import { TOOL_DEFINITIONS } from "../agent/tool-executor.js";

test("FILE_WRITING_RULES_BLOCK names every sanctioned write tool", () => {
  for (const tool of [
    "write_file",
    "str_replace",
    "apply_patch",
    "replace_range",
    "insert_after",
    "rename_file",
  ]) {
    assert.ok(
      FILE_WRITING_RULES_BLOCK.includes(tool),
      `block should mention sanctioned tool '${tool}'`,
    );
  }
});

test("FILE_WRITING_RULES_BLOCK names every blocked shell write pattern", () => {
  for (const pattern of [
    "cat > file",
    "tee",
    "sed -i",
    "perl -i",
    "mv",
    "cp",
    "python3 -c",
    "node -e",
    "heredoc",
  ]) {
    assert.ok(
      FILE_WRITING_RULES_BLOCK.toLowerCase().includes(pattern.toLowerCase()),
      `block should warn about '${pattern}'`,
    );
  }
});

test("run_command tool description warns about shell file-writing", () => {
  const def = TOOL_DEFINITIONS.find(
    (t) => t.type === "function" && t.function.name === "run_command",
  );
  assert.ok(def);
  const desc = (def as { function: { description: string } }).function
    .description;
  assert.match(desc, /sandbox-blocked/i);
  assert.match(desc, /cat > file/);
  assert.match(desc, /sed -i/);
  assert.match(desc, /python3 -c|fs\.writeFileSync/);
});

test("write_file description points the agent away from shell heredocs", () => {
  const def = TOOL_DEFINITIONS.find(
    (t) => t.type === "function" && t.function.name === "write_file",
  );
  assert.ok(def);
  const desc = (def as { function: { description: string } }).function
    .description;
  assert.match(desc, /sandbox-blocked|sandbox/i);
  assert.match(desc, /cat > file/);
});
