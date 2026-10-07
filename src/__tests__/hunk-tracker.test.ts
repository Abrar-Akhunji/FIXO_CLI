import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getHunkTracker } from "../git/hunk-tracker.js";

test("HunkTracker records mutation hunks with before and after content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-hunk-test-"));
  try {
    const tracker = getHunkTracker(tmpDir);
    tracker.clear();
    const filePath = path.join(tmpDir, "sample.txt");
    const record = tracker.recordHunk({
      cwd: tmpDir,
      filePath,
      beforeContent: "hello",
      afterContent: "hello world",
      description: "Appended world",
    });

    assert.match(record.id, /^hunk-/);
    assert.equal(record.beforeContent, "hello");
    assert.equal(record.afterContent, "hello world");
    assert.equal(record.reverted, false);

    const hunks = tracker.listHunks();
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].id, record.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HunkTracker reverts an updated file hunk back to beforeContent", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-hunk-test-"));
  try {
    const tracker = getHunkTracker(tmpDir);
    tracker.clear();
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "original content", "utf-8");

    const record = tracker.recordHunk({
      cwd: tmpDir,
      filePath,
      beforeContent: "original content",
      afterContent: "modified content",
    });

    fs.writeFileSync(filePath, "modified content", "utf-8");

    const revertRes = tracker.revertHunk(record.id);
    assert.equal(revertRes.ok, true);
    assert.equal(fs.readFileSync(filePath, "utf-8"), "original content");
    assert.equal(tracker.getHunk(record.id)?.reverted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HunkTracker unlinks newly created file when reverting creation hunk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-hunk-test-"));
  try {
    const tracker = getHunkTracker(tmpDir);
    tracker.clear();
    const filePath = path.join(tmpDir, "newfile.txt");
    fs.writeFileSync(filePath, "brand new content", "utf-8");

    tracker.recordHunk({
      cwd: tmpDir,
      filePath,
      beforeContent: "",
      afterContent: "brand new content",
      description: "Created newfile.txt",
    });

    assert.equal(fs.existsSync(filePath), true);
    const revertRes = tracker.revertLastHunk();
    assert.equal(revertRes.ok, true);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HunkTracker returns error when no active hunks are available to revert", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-hunk-test-"));
  try {
    const tracker = getHunkTracker(tmpDir);
    tracker.clear();
    const res = tracker.revertLastHunk();
    assert.equal(res.ok, false);
    assert.match(res.message, /No active hunks/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
