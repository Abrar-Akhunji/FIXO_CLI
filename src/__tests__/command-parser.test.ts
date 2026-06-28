import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { parseShellCommand, isCommandSafe } from "../agent/command-parser.js";

test("parseShellCommand parses basic and compound commands", async () => {
  const cmds = await parseShellCommand("rm -rf ./dist && cat .env");
  assert.equal(cmds.length, 2);

  assert.equal(cmds[0].binary, "rm");
  assert.deepEqual(cmds[0].arguments, ["-rf", "./dist"]);

  assert.equal(cmds[1].binary, "cat");
  assert.deepEqual(cmds[1].arguments, [".env"]);
});

test("isCommandSafe flags dangerous operations outside workspace", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-test-workspace-"),
  );
  const workspaceRoot = path.join(tempDir, "root");
  fs.mkdirSync(workspaceRoot);

  // Safe commands inside workspace
  const safeRes = await isCommandSafe("rm -rf ./dist", workspaceRoot);
  assert.equal(safeRes.safe, true);

  // Dangerous modifier outside workspace
  const unsafeRes1 = await isCommandSafe(
    "rm -rf ../outside-file.txt",
    workspaceRoot,
  );
  assert.equal(unsafeRes1.safe, false);
  assert.match(
    unsafeRes1.reason || "",
    /attempts to write or delete files outside the workspace root/,
  );

  // Sensitive credentials access (read)
  const unsafeRes2 = await isCommandSafe("cat .env", workspaceRoot);
  assert.equal(unsafeRes2.safe, false);
  assert.match(
    unsafeRes2.reason || "",
    /attempts to read a sensitive credentials file: \.env/,
  );

  // Sensitive credentials access (write)
  const unsafeRes3 = await isCommandSafe("touch .env", workspaceRoot);
  assert.equal(unsafeRes3.safe, false);
  assert.match(
    unsafeRes3.reason || "",
    /attempts to modify a sensitive credentials file: \.env/,
  );

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("isCommandSafe permits trusted global binaries invoked by absolute path", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-test-workspace-"),
  );
  const workspaceRoot = path.join(tempDir, "root");
  fs.mkdirSync(workspaceRoot);

  // Absolute path to git — the binary lives outside the workspace, but
  // git is on the allowlist and the file target stays inside.
  const okGit = await isCommandSafe("/usr/bin/git status", workspaceRoot);
  assert.equal(okGit.safe, true, okGit.reason);

  // Same for node.
  const okNode = await isCommandSafe(
    "/opt/homebrew/bin/node --version",
    workspaceRoot,
  );
  assert.equal(okNode.safe, true, okNode.reason);

  // A non-allowlisted external binary is still rejected.
  const blocked = await isCommandSafe(
    "/usr/bin/curl https://example.com",
    workspaceRoot,
  );
  assert.equal(blocked.safe, false);
  assert.match(blocked.reason || "", /external binary/);

  // Allowlist does not weaken file containment: `rm` on the allowlist,
  // but the target escapes the workspace.
  const stillBlocked = await isCommandSafe(
    "/bin/rm ../outside.txt",
    workspaceRoot,
  );
  assert.equal(stillBlocked.safe, false);
  assert.match(stillBlocked.reason || "", /outside the workspace root/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("isCommandSafe blocks scaffolding outside workspace and heuristics prompt", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-test-workspace-"),
  );
  const workspaceRoot = path.join(tempDir, "root");
  fs.mkdirSync(workspaceRoot);

  // Safe npx create inside workspace
  const safeRes = await isCommandSafe(
    "npx create-next-app@latest ./my-app",
    workspaceRoot,
  );
  assert.equal(safeRes.safe, true);

  // Dangerous npx create outside workspace
  const unsafeRes1 = await isCommandSafe(
    "npx create-next-app@latest ../my-app",
    workspaceRoot,
  );
  assert.equal(unsafeRes1.safe, false);
  assert.match(
    unsafeRes1.reason || "",
    /attempts to create a project outside the workspace root/,
  );

  // Dangerous npm create outside workspace
  const unsafeRes2 = await isCommandSafe(
    "npm create vite@latest ~/Desktop/my-app",
    workspaceRoot,
  );
  assert.equal(unsafeRes2.safe, false);
  assert.match(
    unsafeRes2.reason || "",
    /attempts to create a project outside the workspace root/,
  );

  // Dangerous git clone outside workspace
  const unsafeRes3 = await isCommandSafe(
    "git clone https://github.com/foo/bar.git ../bar",
    workspaceRoot,
  );
  assert.equal(unsafeRes3.safe, false);
  assert.match(
    unsafeRes3.reason || "",
    /attempts to create a project outside the workspace root/,
  );

  // Heuristic blocking for unknown directory-creating tool
  const unsafeRes4 = await isCommandSafe("rails new my-app", workspaceRoot);
  assert.equal(unsafeRes4.safe, false);
  assert.match(
    unsafeRes4.reason || "",
    /looks like it might create a new directory/,
  );

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Phase 1a — sandbox heuristic must not flag `find -type f` and friends.
// Reproduces the false positive observed in the June 22, 2026 log session.
test("isCommandSafe: find with value-taking flags is not a false-positive directory create", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-test-workspace-"),
  );
  const workspaceRoot = path.join(tempDir, "root");
  fs.mkdirSync(workspaceRoot);

  // The exact scenario from the log session: `find "test folder" -type f`.
  // Before Phase 1a this was rejected because `f` (the value of -type)
  // matched the directory-creation heuristic regex.
  const findTypeF = await isCommandSafe("find . -type f", workspaceRoot);
  assert.equal(findTypeF.safe, true, findTypeF.reason);

  // Other common find predicates
  const findName = await isCommandSafe(
    "find . -name foo -type f",
    workspaceRoot,
  );
  assert.equal(findName.safe, true, findName.reason);

  const findMaxDepth = await isCommandSafe(
    "find . -maxdepth 2 -type d",
    workspaceRoot,
  );
  assert.equal(findMaxDepth.safe, true, findMaxDepth.reason);

  // awk / sed / xargs / jq are also in the Phase 1a allowlist
  const awkOk = await isCommandSafe("awk NR==1 file.txt", workspaceRoot);
  assert.equal(awkOk.safe, true, awkOk.reason);

  const xargsOk = await isCommandSafe("xargs ls", workspaceRoot);
  assert.equal(xargsOk.safe, true, xargsOk.reason);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("isCommandSafe: heuristic still catches real directory-creating CLIs after Phase 1a", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-test-workspace-"),
  );
  const workspaceRoot = path.join(tempDir, "root");
  fs.mkdirSync(workspaceRoot);

  // `rails new my-app` — `rails` is NOT in any allowlist; positional
  // arg `my-app` matches the new-directory regex. Must still prompt.
  const railsNew = await isCommandSafe("rails new my-app", workspaceRoot);
  assert.equal(railsNew.safe, false);
  assert.match(
    railsNew.reason || "",
    /looks like it might create a new directory/,
  );

  // Unknown CLI with a single bare-name arg
  const someNewTool = await isCommandSafe(
    "unknowncli newproject",
    workspaceRoot,
  );
  assert.equal(someNewTool.safe, false);
  assert.match(
    someNewTool.reason || "",
    /looks like it might create a new directory/,
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});
