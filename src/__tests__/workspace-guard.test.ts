import { test } from "node:test";
import * as assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceGuard } from "../workspace-guard.js";

test("WorkspaceGuard Boundary and Symlink Tests", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-guard-test-"));
  const root = path.join(parent, "workspace");
  fs.mkdirSync(root);

  const guard = new WorkspaceGuard(root);

  await t.test("resolves relative and absolute paths inside root", () => {
    const fileRaw = path.join(root, "file.txt");
    fs.writeFileSync(fileRaw, "hello", "utf-8");
    const file = fs.realpathSync(fileRaw);

    assert.equal(guard.resolve("file.txt"), file);
    assert.equal(guard.resolve(file), file);
    assert.equal(guard.isInside(file), true);
  });

  await t.test("rejects path traversal escaping root", () => {
    assert.throws(() => {
      guard.resolve("../escaped", "path", true);
    }, /escapes workspace/);

    assert.equal(guard.isInside(path.join(parent, "escaped.txt")), false);
  });

  await t.test("handles symlink escape detection", () => {
    const outsideFile = path.join(parent, "outside.txt");
    fs.writeFileSync(outsideFile, "secret content", "utf-8");

    const linkPath = path.join(root, "symlink.txt");
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch (e) {
      // Windows git bash/compatibility fallback
      return;
    }

    // WorkspaceGuard should resolve the symlink real path and detect that it is outside root
    assert.equal(guard.isInside(linkPath), false);
    assert.throws(() => {
      guard.resolve("symlink.txt", "path", true);
    }, /escapes workspace/);
  });

  await t.test("ensureFile throws correctly", () => {
    // Missing file should throw
    assert.throws(() => {
      guard.ensureFile("missing-file.txt");
    }, /File does not exist/);

    // Directory path should throw
    assert.throws(() => {
      guard.ensureFile(".");
    }, /Not a file/);
  });

  await t.test("isBinaryFile detects NUL bytes correctly", () => {
    const textFile = path.join(root, "text.txt");
    fs.writeFileSync(textFile, "Just some text here.", "utf-8");

    const binFile = path.join(root, "binary.bin");
    fs.writeFileSync(
      binFile,
      Buffer.from([104, 101, 108, 108, 111, 0, 119, 111, 114, 108, 100]),
    );

    assert.equal(guard.isBinaryFile(textFile), false);
    assert.equal(guard.isBinaryFile(binFile), true);
  });
});
