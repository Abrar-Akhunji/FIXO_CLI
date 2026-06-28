/**
 * Tests for the FIXO.md lookup chain.
 *
 * The loader must respect the documented precedence:
 *   1. <cwd>/.fixo/FIXO.md
 *   2. <cwd>/FIXO.md
 *   3. ~/.fixocli/FIXO.md
 *
 * A missing file or unreadable file must surface as
 * `source: 'none'`, never an exception.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildProjectInstructionsBlock,
  findFixoMdPath,
  loadProjectInstructions,
} from "../context/fixo-md.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

test("findFixoMdPath returns none when no file exists", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    const found = findFixoMdPath(cwd);
    assert.equal(found.source, "none");
    assert.equal(found.path, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadProjectInstructions returns empty when no file exists", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    const r = loadProjectInstructions(cwd);
    assert.equal(r.source, "none");
    assert.equal(r.content, "");
    assert.equal(r.bytes, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadProjectInstructions finds .fixo/FIXO.md first", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    writeFile(path.join(cwd, ".fixo", "FIXO.md"), "A\n");
    writeFile(path.join(cwd, "FIXO.md"), "B\n");
    const r = loadProjectInstructions(cwd);
    assert.equal(r.source, "project-fixo");
    assert.match(r.path ?? "", /\.fixo[\\\/]FIXO\.md$/);
    assert.equal(r.content, "A\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadProjectInstructions falls back to project root FIXO.md", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    writeFile(path.join(cwd, "FIXO.md"), "B\n");
    const r = loadProjectInstructions(cwd);
    assert.equal(r.source, "project-cwd");
    assert.equal(r.content, "B\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildProjectInstructionsBlock wraps the content in labelled fences", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    writeFile(path.join(cwd, "FIXO.md"), "Use semicolons.\n");
    const { block, result } = buildProjectInstructionsBlock(cwd);
    assert.equal(result.source, "project-cwd");
    assert.match(block, /<project-instructions source="project-cwd">/);
    assert.match(block, /Use semicolons\./);
    assert.match(block, /<\/project-instructions>/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildProjectInstructionsBlock returns empty string when missing", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    const { block, result } = buildProjectInstructionsBlock(cwd);
    assert.equal(block, "");
    assert.equal(result.source, "none");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildProjectInstructionsBlock never throws on unreadable files", () => {
  const cwd = mkTmp("fixo-md-test-");
  try {
    const dir = path.join(cwd, ".fixo");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "FIXO.md"), { recursive: true }); // dir, not file
    const { result } = buildProjectInstructionsBlock(cwd);
    // stat() of a directory does not match isFile() and the
    // lookup treats it as "not a file" → falls through.
    assert.equal(result.source, "none");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
