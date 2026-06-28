/**
 * large-file-gate.test.ts — Pillar 3 (Context-Budget Guard) + the
 * `extract_symbols` / `extract_imports` structural pre-scan tools.
 *
 * These tests exercise the read_file large-file gate (15 KiB / 350
 * line thresholds) and the two new structural tools end-to-end
 * through the public `executeTool` dispatch. They also cover the
 * `TaskSession.structuralMaps` tracking that the LLM uses to know
 * whether a file has been pre-scanned.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeTool } from "../agent/tool-executor.js";
import { TaskSession } from "../runtime/task-session.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-gate-"));
  return root;
}

function writeFixture(root: string, name: string, content: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

test("executeReadFile returns content for a small file", async () => {
  const cwd = makeWorkspace();
  writeFixture(cwd, "small.ts", "export const x = 1;\n");
  const ev = await executeTool("read_file", { path: "small.ts" }, cwd);
  assert.equal(ev.result, "export const x = 1;\n");
  assert.equal(ev.tool, "read_file");
});

test("executeReadFile returns [Context-Budget Guard] when bytes exceed gate", async () => {
  const cwd = makeWorkspace();
  // 20 KiB of comments — well over the 15 KiB default gate.
  const big = "// " + "a".repeat(20 * 1024) + "\n";
  writeFixture(cwd, "big.ts", big);
  const ev = await executeTool("read_file", { path: "big.ts" }, cwd);
  assert.match(ev.result, /\[Context-Budget Guard\]/);
  assert.match(ev.result, /extract_symbols/);
  assert.match(ev.result, /extract_imports/);
});

test("executeReadFile returns [Context-Budget Guard] when line count exceeds gate", async () => {
  const cwd = makeWorkspace();
  // 400 short lines — under 15 KiB but over 350 lines.
  const lines =
    Array.from({ length: 400 }, (_, i) => `// line ${i}`).join("\n") + "\n";
  assert.ok(
    Buffer.byteLength(lines, "utf-8") < 15 * 1024,
    "precondition: under byte gate",
  );
  writeFixture(cwd, "tall.ts", lines);
  const ev = await executeTool("read_file", { path: "tall.ts" }, cwd);
  assert.match(ev.result, /\[Context-Budget Guard\]/);
});

test("executeReadFile returns a clear error for missing files", async () => {
  const cwd = makeWorkspace();
  const ev = await executeTool("read_file", { path: "nope.ts" }, cwd);
  assert.match(ev.result, /File not found/);
});

test("executeExtractSymbols returns symbols for a TypeScript file", async () => {
  const cwd = makeWorkspace();
  writeFixture(
    cwd,
    "mod.ts",
    [
      "export class Foo {}",
      "export interface Bar { x: number }",
      "export function baz() {}",
      "export const Q = 1;",
    ].join("\n"),
  );
  const ev = await executeTool("extract_symbols", { path: "mod.ts" }, cwd);
  assert.match(ev.result, /Symbols in/);
  assert.match(ev.result, /Foo/);
  assert.match(ev.result, /Bar/);
  assert.match(ev.result, /baz/);
  assert.match(ev.result, /Q/);
});

test("executeExtractImports returns imports for a TypeScript file", async () => {
  const cwd = makeWorkspace();
  writeFixture(
    cwd,
    "im.ts",
    [
      "import x from 'alpha';",
      "import { beta, gamma as g } from 'beta';",
      "import type * as T from 'types';",
    ].join("\n"),
  );
  const ev = await executeTool("extract_imports", { path: "im.ts" }, cwd);
  assert.match(ev.result, /Imports in/);
  assert.match(ev.result, /'alpha'/);
  assert.match(ev.result, /'beta'/);
  assert.match(ev.result, /'types'/);
  assert.match(ev.result, /type-only/);
});

test("executeExtractSymbols returns an error for a missing file", async () => {
  const cwd = makeWorkspace();
  const ev = await executeTool("extract_symbols", { path: "missing.ts" }, cwd);
  assert.match(ev.result, /File not found/);
});

test("executeExtractImports returns an error for a missing file", async () => {
  const cwd = makeWorkspace();
  const ev = await executeTool("extract_imports", { path: "missing.ts" }, cwd);
  assert.match(ev.result, /File not found/);
});

test("TaskSession.structuralMaps tracks per-file pre-scan flags", () => {
  const cwd = makeWorkspace();
  const session = new TaskSession({ cwd, task: "t", model: "m" });
  // Pre-condition: no structural map yet.
  assert.equal(session.hasStructuralMap("mod.ts"), null);
  session.noteStructuralMap("mod.ts", { symbols: true, imports: false });
  let flags = session.hasStructuralMap("mod.ts");
  assert.ok(flags);
  assert.equal(flags!.symbols, true);
  assert.equal(flags!.imports, false);
  // Merging should be OR — recording imports later keeps symbols=true.
  session.noteStructuralMap("mod.ts", { symbols: false, imports: true });
  flags = session.hasStructuralMap("mod.ts");
  assert.ok(flags);
  assert.equal(flags!.symbols, true);
  assert.equal(flags!.imports, true);
});

test("TaskSession hasStructuralMap returns null for untracked files", () => {
  const cwd = makeWorkspace();
  const session = new TaskSession({ cwd, task: "t", model: "m" });
  assert.equal(session.hasStructuralMap("unrelated.ts"), null);
});
