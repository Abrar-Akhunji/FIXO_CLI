import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  isWorkspaceTrusted,
  trustWorkspace,
  untrustWorkspace,
  loadDiscoveredRules,
  formatProjectRulesBlock,
} from "../agent/project-rules.js";
import { getProjectRulesGuidance } from "../agent/context-builder.js";

test("folder trust store can trust and untrust workspaces", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-trust-home-"));
  const prevHome = process.env.FIXO_HOME;
  process.env.FIXO_HOME = tmpHome;

  const testWs = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-test-ws-"));
  try {
    assert.equal(isWorkspaceTrusted(testWs), false);

    trustWorkspace(testWs);
    assert.equal(isWorkspaceTrusted(testWs), true);

    untrustWorkspace(testWs);
    assert.equal(isWorkspaceTrusted(testWs), false);
  } finally {
    if (prevHome !== undefined) process.env.FIXO_HOME = prevHome;
    else delete process.env.FIXO_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(testWs, { recursive: true, force: true });
  }
});

test("loadDiscoveredRules isolates untrusted workspaces", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-rules-home-"));
  const prevHome = process.env.FIXO_HOME;
  process.env.FIXO_HOME = tmpHome;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-untrusted-ws-"));
  try {
    // Create an AGENTS.md in the workspace
    fs.writeFileSync(
      path.join(ws, "AGENTS.md"),
      "# Untrusted Rules\nDo something malicious.",
      "utf-8",
    );

    // Untrusted scan must ignore workspace AGENTS.md
    const untrustedRules = loadDiscoveredRules(ws, false);
    assert.equal(
      untrustedRules.some((r) => r.name === "AGENTS.md"),
      false,
    );

    // Trusted scan must find AGENTS.md
    const trustedRules = loadDiscoveredRules(ws, true);
    assert.equal(
      trustedRules.some((r) => r.name === "AGENTS.md"),
      true,
    );
  } finally {
    if (prevHome !== undefined) process.env.FIXO_HOME = prevHome;
    else delete process.env.FIXO_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("loadDiscoveredRules scans AGENTS.md, CLAUDE.md, .cursor/rules, and .fixo/rules", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-rules-home-"));
  const prevHome = process.env.FIXO_HOME;
  process.env.FIXO_HOME = tmpHome;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-trusted-ws-"));
  try {
    fs.writeFileSync(
      path.join(ws, "AGENTS.md"),
      "Always use TypeScript strict mode.",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(ws, "CLAUDE.md"),
      "Keep functions under 50 lines.",
      "utf-8",
    );

    fs.mkdirSync(path.join(ws, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".cursor", "rules", "formatting.md"),
      "Use 2 spaces for indentation.",
      "utf-8",
    );

    fs.mkdirSync(path.join(ws, ".fixo", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".fixo", "rules", "testing.md"),
      "Write unit tests for new modules.",
      "utf-8",
    );

    const rules = loadDiscoveredRules(ws, true);
    assert.equal(rules.length, 4);

    const names = rules.map((r) => r.name);
    assert.ok(names.includes("AGENTS.md"));
    assert.ok(names.includes("CLAUDE.md"));
    assert.ok(names.includes("formatting.md"));
    assert.ok(names.includes("testing.md"));

    const block = formatProjectRulesBlock(rules);
    assert.match(block, /## Project Rules & Agent Instructions/);
    assert.match(block, /Always use TypeScript strict mode/);
    assert.match(block, /Keep functions under 50 lines/);
    assert.match(block, /Use 2 spaces for indentation/);
    assert.match(block, /Write unit tests for new modules/);

    const guidance = getProjectRulesGuidance(ws, true);
    assert.equal(guidance, block);
  } finally {
    if (prevHome !== undefined) process.env.FIXO_HOME = prevHome;
    else delete process.env.FIXO_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
