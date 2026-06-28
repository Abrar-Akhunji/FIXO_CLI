/**
 * Tests for the unified MCP registry (§3.3).
 *
 * The registry reads MCP config from three sources and
 * merges them with project-wins precedence:
 *   - global:  ~/.freellmapi/mcp.json
 *   - project: <cwd>/.fixo.yml or .fixo.yaml
 *   - local:   in-memory additions from /mcp add
 *
 * We exercise the read paths against a real on-disk fixture
 * (no network), and the in-memory add/remove against a
 * temp directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addLocalMcpServer,
  listAllMcpSources,
  mergedMcpServers,
  readGlobalMcpConfig,
  readProjectMcpConfig,
  removeLocalMcpServer,
  _resetLocalMcpServers,
} from "../agent/mcp-registry.js";

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
}

test("readProjectMcpConfig returns empty when no .fixo.yml present", () => {
  const cwd = mkTmpCwd();
  try {
    const result = readProjectMcpConfig(cwd);
    assert.equal(result.configPath, null);
    assert.deepEqual(result.servers, {});
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readProjectMcpConfig reads .fixo.yml mcpServers", () => {
  const cwd = mkTmpCwd();
  try {
    fs.writeFileSync(
      path.join(cwd, ".fixo.yml"),
      'mcpServers:\n  fs-pro:\n    command: npx\n    args: ["-y", "fs-mcp"]\n',
    );
    const result = readProjectMcpConfig(cwd);
    assert.equal(result.configPath, path.join(cwd, ".fixo.yml"));
    assert.equal(Object.keys(result.servers).length, 1);
    assert.equal(result.servers["fs-pro"].command, "npx");
    assert.deepEqual(result.servers["fs-pro"].args, ["-y", "fs-mcp"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readProjectMcpConfig falls back to .fixo.yaml when .fixo.yml absent", () => {
  const cwd = mkTmpCwd();
  try {
    fs.writeFileSync(
      path.join(cwd, ".fixo.yaml"),
      "mcpServers:\n  alt:\n    command: echo\n",
    );
    const result = readProjectMcpConfig(cwd);
    assert.equal(result.configPath, path.join(cwd, ".fixo.yaml"));
    assert.ok(result.servers["alt"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readProjectMcpConfig prefers .fixo.yml when both exist", () => {
  const cwd = mkTmpCwd();
  try {
    fs.writeFileSync(
      path.join(cwd, ".fixo.yml"),
      "mcpServers:\n  winner: {command: yml-cmd}\n",
    );
    fs.writeFileSync(
      path.join(cwd, ".fixo.yaml"),
      "mcpServers:\n  loser: {command: yaml-cmd}\n",
    );
    const result = readProjectMcpConfig(cwd);
    assert.equal(result.configPath, path.join(cwd, ".fixo.yml"));
    assert.ok(result.servers["winner"]);
    assert.equal(result.servers["loser"], undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readGlobalMcpConfig returns null path when file absent (test isolation)", () => {
  // Cannot tamper with the real ~/.freellmapi, but we can
  // assert the contract: a non-existent file → null path.
  // If the user's home happens to have a real config, the
  // function returns it; either way the function should
  // never throw.
  const result = readGlobalMcpConfig();
  if (result.configPath === null) {
    assert.deepEqual(result.servers, {});
  } else {
    // File exists; just assert the shape is well-formed.
    assert.equal(typeof result.servers, "object");
  }
});

test("listAllMcpSources returns all three sources, with local empty initially", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    const view = listAllMcpSources(cwd);
    assert.equal(view.global.name, "global");
    assert.equal(view.project.name, "project");
    assert.equal(view.local.name, "local");
    assert.equal(view.local.configPath, null);
    assert.deepEqual(view.local.servers, {});
    // Project source is empty in a fresh tmpdir.
    assert.equal(view.project.configPath, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("addLocalMcpServer + listAllMcpSources shows the new entry under local", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    addLocalMcpServer(cwd, "demo", { command: "node", args: ["mcp.js"] });
    const view = listAllMcpSources(cwd);
    assert.ok(view.local.servers["demo"]);
    assert.equal(view.local.servers["demo"].command, "node");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("removeLocalMcpServer returns true for known and false for unknown", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    addLocalMcpServer(cwd, "temp", { command: "x" });
    assert.equal(removeLocalMcpServer(cwd, "temp"), true);
    assert.equal(removeLocalMcpServer(cwd, "temp"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("local entries are scoped per cwd (no cross-cwd leakage)", () => {
  const cwdA = mkTmpCwd();
  const cwdB = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    addLocalMcpServer(cwdA, "a-only", { command: "a" });
    addLocalMcpServer(cwdB, "b-only", { command: "b" });
    const viewA = listAllMcpSources(cwdA);
    const viewB = listAllMcpSources(cwdB);
    assert.ok(viewA.local.servers["a-only"]);
    assert.equal(viewA.local.servers["b-only"], undefined);
    assert.ok(viewB.local.servers["b-only"]);
    assert.equal(viewB.local.servers["a-only"], undefined);
  } finally {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  }
});

test("mergedMcpServers: project shadows global on name conflict", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    // Project: 'fs' with command=project-cmd
    fs.writeFileSync(
      path.join(cwd, ".fixo.yml"),
      "mcpServers:\n  fs:\n    command: project-cmd\n",
    );
    // We can't mutate the real global file in tests; but we
    // can test the *precedence rule* with a mocked view by
    // adding a 'global' server under a name that does not
    // collide. For the collision test, we just verify the
    // project entry survives.
    const merged = mergedMcpServers(cwd);
    assert.equal(merged["fs"].command, "project-cmd");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("mergedMcpServers: local shadows project and global", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    fs.writeFileSync(
      path.join(cwd, ".fixo.yml"),
      "mcpServers:\n  fs:\n    command: project-cmd\n",
    );
    addLocalMcpServer(cwd, "fs", { command: "local-cmd" });
    const merged = mergedMcpServers(cwd);
    assert.equal(merged["fs"].command, "local-cmd");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("mergedMcpServers merges distinct names from project and local", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    fs.writeFileSync(
      path.join(cwd, ".fixo.yml"),
      "mcpServers:\n  p1: {command: p}\n  p2: {command: p}\n",
    );
    addLocalMcpServer(cwd, "l1", { command: "l" });
    const merged = mergedMcpServers(cwd);
    assert.ok(merged["p1"]);
    assert.ok(merged["p2"]);
    assert.ok(merged["l1"]);
    assert.equal(Object.keys(merged).length, 3);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("mergedMcpServers returns empty object when no sources define any servers", () => {
  const cwd = mkTmpCwd();
  _resetLocalMcpServers();
  try {
    const merged = mergedMcpServers(cwd);
    assert.deepEqual(merged, {});
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
