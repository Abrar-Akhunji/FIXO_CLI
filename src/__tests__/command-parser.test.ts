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
