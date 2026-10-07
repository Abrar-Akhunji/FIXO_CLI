import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TruncationManager } from "../runtime/truncation-manager.js";

describe("TruncationManager", () => {
  it("does not truncate small outputs", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const result = TruncationManager.format(text, { maxLines: 10, maxBytes: 1000 });
    assert.equal(result.truncated, false);
    assert.equal(result.content, text);
    assert.equal(result.totalLines, 3);
  });

  it("truncates output exceeding maxLines and persists spill file", () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-trunc-test-"));
    try {
      const lines = Array.from({ length: 50 }, (_, i) => `Output line ${i + 1}`);
      const text = lines.join("\n");

      const result = TruncationManager.format(text, {
        maxLines: 10,
        cwd: tempCwd,
        toolName: "run_command",
      });

      assert.equal(result.truncated, true);
      assert.ok(result.spillPath);
      assert.ok(fs.existsSync(result.spillPath));
      assert.equal(fs.readFileSync(result.spillPath, "utf-8"), text);

      // Check head and tail presence in formatted content
      assert.ok(result.content.includes("Output line 1"));
      assert.ok(result.content.includes("Output line 50"));
      assert.ok(result.content.includes("Full output saved to:"));
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it("cleans up expired spill files", () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-cleanup-test-"));
    try {
      const spillDir = TruncationManager.getSpillDir(tempCwd);
      const oldFile = path.join(spillDir, "tool_old.log");
      fs.writeFileSync(oldFile, "old logs", "utf-8");

      // Set mtime to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

      const removed = TruncationManager.cleanupOldSpills(tempCwd);
      assert.equal(removed, 1);
      assert.equal(fs.existsSync(oldFile), false);
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
