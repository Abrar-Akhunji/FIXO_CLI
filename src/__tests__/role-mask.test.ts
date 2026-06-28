/**
 * Pillar 5 / Protection 2 — Strict Runtime Role Isolation.
 *
 * Verifies that {@link classifyExecutionRole} correctly
 * identifies read-only / review / analysis tasks and that
 * {@link getActiveTools} strips mutation tools when the
 * `READ_ONLY` role is requested.
 *
 * The intent is that a request like "review the code for
 * security issues" gives the LLM a tool list that contains
 * no `write_file` / `apply_patch` / `replace_range` /
 * `insert_after` / `rename_file` / `delete_file` etc. The
 * model literally cannot attempt a mutation because the
 * tool definitions were never sent to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyExecutionRole,
  getActiveTools,
  MUTATION_TOOL_NAMES,
} from "../agent/tool-executor.js";

test("classifyExecutionRole flags analysis / review / explanation tasks as READ_ONLY", () => {
  assert.equal(
    classifyExecutionRole("analyze the codebase for security issues"),
    "READ_ONLY",
  );
  assert.equal(
    classifyExecutionRole("review the diff in src/agent/agent-client.ts"),
    "READ_ONLY",
  );
  assert.equal(
    classifyExecutionRole("explain how the staging manager works"),
    "READ_ONLY",
  );
  assert.equal(
    classifyExecutionRole("describe the credential vault"),
    "READ_ONLY",
  );
  assert.equal(
    classifyExecutionRole("find the bugs in this file"),
    "READ_ONLY",
  );
  assert.equal(classifyExecutionRole("list the files in src/"), "READ_ONLY");
  assert.equal(
    classifyExecutionRole("do a security audit of the agent loop"),
    "READ_ONLY",
  );
  assert.equal(
    classifyExecutionRole("read the code without modifying it"),
    "READ_ONLY",
  );
});

test("classifyExecutionRole flags write tasks as BUILD", () => {
  assert.equal(classifyExecutionRole("add a new test for staging.ts"), "BUILD");
  assert.equal(
    classifyExecutionRole("refactor credential-vault.ts to use Set"),
    "BUILD",
  );
  assert.equal(
    classifyExecutionRole("implement the loop trap detector"),
    "BUILD",
  );
  assert.equal(classifyExecutionRole("update the README"), "BUILD");
});

test("getActiveTools(READ_ONLY) strips all mutation tools from the tool list", () => {
  const tools = getActiveTools("READ_ONLY");
  const names = tools.map((t) => t.function.name);
  for (const mutation of MUTATION_TOOL_NAMES) {
    assert.equal(
      names.includes(mutation),
      false,
      `READ_ONLY role must not expose mutation tool "${mutation}"`,
    );
  }
});

test("getActiveTools(BUILD) exposes all mutation tools", () => {
  const tools = getActiveTools("BUILD");
  const names = new Set(tools.map((t) => t.function.name));
  for (const mutation of MUTATION_TOOL_NAMES) {
    if (
      [
        "create_branch",
        "commit_changes",
        "push_branch",
        "create_pull_request",
      ].includes(mutation)
    ) {
      // Some mutation tools are optional / plugin-provided; only
      // assert the core file-mutation tools are present.
      continue;
    }
    assert.equal(
      names.has(mutation),
      true,
      `BUILD role must expose mutation tool "${mutation}"`,
    );
  }
});
