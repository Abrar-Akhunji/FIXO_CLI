import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseShellCommand, isCommandSafe } from '../agent/command-parser.js';

test('parseShellCommand parses basic and compound commands', async () => {
  const cmds = await parseShellCommand('rm -rf ./dist && cat .env');
  assert.equal(cmds.length, 2);

  assert.equal(cmds[0].binary, 'rm');
  assert.deepEqual(cmds[0].arguments, ['-rf', './dist']);

  assert.equal(cmds[1].binary, 'cat');
  assert.deepEqual(cmds[1].arguments, ['.env']);
});

test('isCommandSafe flags dangerous operations outside workspace', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-test-workspace-'));
  const workspaceRoot = path.join(tempDir, 'root');
  fs.mkdirSync(workspaceRoot);

  // Safe commands inside workspace
  const safeRes = await isCommandSafe('rm -rf ./dist', workspaceRoot);
  assert.equal(safeRes.safe, true);

  // Dangerous modifier outside workspace
  const unsafeRes1 = await isCommandSafe('rm -rf ../outside-file.txt', workspaceRoot);
  assert.equal(unsafeRes1.safe, false);
  assert.match(unsafeRes1.reason || '', /attempts to write or delete files outside the workspace root/);

  // Sensitive credentials access (read)
  const unsafeRes2 = await isCommandSafe('cat .env', workspaceRoot);
  assert.equal(unsafeRes2.safe, false);
  assert.match(unsafeRes2.reason || '', /attempts to read a sensitive credentials file: \.env/);

  // Sensitive credentials access (write)
  const unsafeRes3 = await isCommandSafe('touch .env', workspaceRoot);
  assert.equal(unsafeRes3.safe, false);
  assert.match(unsafeRes3.reason || '', /attempts to modify a sensitive credentials file: \.env/);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('isCommandSafe permits trusted global binaries invoked by absolute path', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-test-workspace-'));
  const workspaceRoot = path.join(tempDir, 'root');
  fs.mkdirSync(workspaceRoot);

  // Absolute path to git — the binary lives outside the workspace, but
  // git is on the allowlist and the file target stays inside.
  const okGit = await isCommandSafe('/usr/bin/git status', workspaceRoot);
  assert.equal(okGit.safe, true, okGit.reason);

  // Same for node.
  const okNode = await isCommandSafe('/opt/homebrew/bin/node --version', workspaceRoot);
  assert.equal(okNode.safe, true, okNode.reason);

  // A non-allowlisted external binary is still rejected.
  const blocked = await isCommandSafe('/usr/bin/curl https://example.com', workspaceRoot);
  assert.equal(blocked.safe, false);
  assert.match(blocked.reason || '', /external binary/);

  // Allowlist does not weaken file containment: `rm` on the allowlist,
  // but the target escapes the workspace.
  const stillBlocked = await isCommandSafe('/bin/rm ../outside.txt', workspaceRoot);
  assert.equal(stillBlocked.safe, false);
  assert.match(stillBlocked.reason || '', /outside the workspace root/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
