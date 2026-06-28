/**
 * Tests for the worktree engine and annotation parser (§3.6).
 *
 * We exercise the parser on synthetic text and the git
 * operations against a real on-disk git repo. Each test
 * builds a fresh `git init` + a couple of commits so
 * `git worktree` has something to fork from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyWorktreeAnnotations,
  createWorktree,
  mergeWorktree,
  parseWorktreeAnnotations,
  removeWorktree,
  stripWorktreeAnnotations,
} from "../runtime/worktree.js";

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Initialize a real git repo with one commit. */
function makeRepo(cwd: string): void {
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.email", "t@t"]);
  git(cwd, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Test\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-m", "initial"]);
}

/* ──────────────────── Parser tests ──────────────────── */

test("parseWorktreeAnnotations: returns empty for no annotations", () => {
  assert.deepEqual(parseWorktreeAnnotations("Hello, world!"), []);
  assert.deepEqual(parseWorktreeAnnotations(""), []);
});

test("parseWorktreeAnnotations: extracts create with branch and base", () => {
  const r = parseWorktreeAnnotations(
    "foo [worktree:create branch=feat-x base=main] bar",
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].op, "create");
  assert.equal((r[0] as { branch: string }).branch, "feat-x");
  assert.equal((r[0] as { base?: string }).base, "main");
});

test("parseWorktreeAnnotations: extracts create with quoted path", () => {
  const r = parseWorktreeAnnotations(
    '[worktree:create branch=foo path="/tmp/my wt"]',
  );
  assert.equal(r.length, 1);
  assert.equal((r[0] as { path?: string }).path, "/tmp/my wt");
});

test("parseWorktreeAnnotations: extracts merge", () => {
  const r = parseWorktreeAnnotations("[worktree:merge branch=feat-x]");
  assert.equal(r.length, 1);
  assert.equal(r[0].op, "merge");
  assert.equal((r[0] as { branch: string }).branch, "feat-x");
});

test("parseWorktreeAnnotations: extracts remove with deleteBranch flag", () => {
  const r = parseWorktreeAnnotations(
    "[worktree:remove path=/tmp/wt deleteBranch=true branch=feat-x]",
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].op, "remove");
  const rem = r[0] as { path: string; deleteBranch?: boolean; branch?: string };
  assert.equal(rem.path, "/tmp/wt");
  assert.equal(rem.deleteBranch, true);
  assert.equal(rem.branch, "feat-x");
});

test("parseWorktreeAnnotations: extracts multiple annotations in order", () => {
  const text =
    "[worktree:create branch=a] ... [worktree:create branch=b] ... [worktree:merge branch=a]";
  const r = parseWorktreeAnnotations(text);
  assert.equal(r.length, 3);
  assert.equal((r[0] as { branch: string }).branch, "a");
  assert.equal((r[1] as { branch: string }).branch, "b");
  assert.equal((r[2] as { branch: string }).branch, "a");
});

test("parseWorktreeAnnotations: skips malformed annotations (missing required key)", () => {
  const r = parseWorktreeAnnotations("[worktree:create] [worktree:merge]");
  // Both are malformed: create needs branch, merge needs branch.
  assert.equal(r.length, 0);
});

test("parseWorktreeAnnotations: unknown op is skipped", () => {
  const r = parseWorktreeAnnotations("[worktree:bogus branch=x]");
  assert.equal(r.length, 0);
});

test("stripWorktreeAnnotations: removes the annotation tokens", () => {
  const text = "Hello [worktree:create branch=x] world";
  const stripped = stripWorktreeAnnotations(text);
  assert.ok(!/\[worktree:/.test(stripped));
  assert.match(stripped, /Hello/);
  assert.match(stripped, /world/);
});

test("stripWorktreeAnnotations: idempotent on text without annotations", () => {
  const text = "Just a normal response.";
  assert.equal(stripWorktreeAnnotations(text), text.trim());
});

/* ──────────────────── Git operation tests ──────────────────── */

test("createWorktree: returns error when branch is empty", () => {
  const cwd = mkTmpCwd();
  try {
    const r = createWorktree(cwd, { branch: "" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /branch is required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("createWorktree: actually creates a worktree on a real repo", () => {
  const cwd = mkTmpCwd();
  try {
    makeRepo(cwd);
    const r = createWorktree(cwd, { branch: "feat-x" });
    assert.equal(r.ok, true, r.error);
    assert.match(r.detail, /\.fixo\/worktrees\/feat-x$/);
    // The new worktree directory should exist and contain a
    // checked-out copy of the branch.
    assert.equal(fs.existsSync(r.detail), true);
    const branch = git(r.detail, ["branch", "--show-current"]);
    assert.equal(branch, "feat-x");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("createWorktree: uses explicit path when supplied", () => {
  const cwd = mkTmpCwd();
  try {
    makeRepo(cwd);
    const customPath = path.join(cwd, "my-custom-wt");
    const r = createWorktree(cwd, { branch: "feat-y", path: customPath });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.detail, customPath);
    assert.equal(fs.existsSync(customPath), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("createWorktree: defaults to HEAD when base is omitted", () => {
  const cwd = mkTmpCwd();
  try {
    makeRepo(cwd);
    const r = createWorktree(cwd, { branch: "feat-default" });
    assert.equal(r.ok, true, r.error);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("createWorktree: returns error when not in a git repo", () => {
  const cwd = mkTmpCwd();
  try {
    // Plain dir, no .git inside.
    fs.writeFileSync(path.join(cwd, "not-a-repo"), "x");
    const r = createWorktree(cwd, { branch: "feat-z" });
    assert.equal(r.ok, false);
    assert.ok(r.error, "should include an error message");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("mergeWorktree: returns error when branch is empty", () => {
  const cwd = mkTmpCwd();
  try {
    const r = mergeWorktree(cwd, "");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /branch is required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("removeWorktree: returns error when path is empty", () => {
  const cwd = mkTmpCwd();
  try {
    const r = removeWorktree(cwd, "");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /worktreePath is required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyWorktreeAnnotations: full create→merge chain on a real repo", () => {
  const cwd = mkTmpCwd();
  try {
    makeRepo(cwd);
    const annotations = [{ op: "create" as const, branch: "feat-chain" }];
    const r = applyWorktreeAnnotations(cwd, annotations);
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, true, r[0].error);
    // The worktree should exist on disk.
    assert.equal(fs.existsSync(r[0].detail), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyWorktreeAnnotations: stops gracefully on error in chain", () => {
  const cwd = mkTmpCwd();
  try {
    makeRepo(cwd);
    const annotations = [
      // Bad: missing required field.
      { op: "create" as const, branch: "" },
      { op: "create" as const, branch: "good" },
    ];
    const r = applyWorktreeAnnotations(cwd, annotations);
    assert.equal(r.length, 2);
    assert.equal(r[0].ok, false);
    assert.equal(r[1].ok, true, r[1].error);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("applyWorktreeAnnotations: empty list returns empty results", () => {
  const cwd = mkTmpCwd();
  try {
    const r = applyWorktreeAnnotations(cwd, []);
    assert.deepEqual(r, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
