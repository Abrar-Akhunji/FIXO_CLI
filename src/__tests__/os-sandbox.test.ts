/**
 * os-sandbox.test.ts — Phase 1.2 acceptance test.
 *
 * These tests prove the central safety contract: when
 * `safety.sandboxMode === 'os-sandbox'`, a command that the regex
 * command-parser layer would have *allowed* still cannot write
 * outside the workspace + tmpdir. The block is enforced by the
 * kernel, not by JavaScript regex.
 *
 * Platform-conditional:
 *   - macOS  → asserts `sandbox-exec` denies a write to $HOME.
 *   - Linux  → asserts `bwrap`'s allow-list prevents the same write
 *              (skipped if `bwrap` is not installed; this is the
 *              honest behaviour the runtime ships and the test
 *              must reflect it).
 *   - Other  → skipped (mirrors the runtime's structured-error
 *              behaviour on unsupported platforms).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runSandboxed, probeSandbox, SandboxUnavailableError } from '../runtime/os-sandbox.js';

function platformSupported(): boolean {
  const p = process.platform;
  if (p === 'darwin') {
    return spawnSync('which', ['sandbox-exec'], { encoding: 'utf-8' }).status === 0;
  }
  if (p === 'linux') {
    return spawnSync('which', ['bwrap'], { encoding: 'utf-8' }).status === 0;
  }
  return false;
}

function mkWorkspace(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-sandbox-ws-'));
  return {
    root,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* safe: best-effort */ }
    },
  };
}

test('probeSandbox — returns a result shape regardless of platform', () => {
  const probe = probeSandbox();
  assert.ok(typeof probe.ok === 'boolean', 'probe must report ok status');
  if (!probe.ok) {
    assert.ok(typeof probe.reason === 'string' && probe.reason.length > 0, 'failure must carry a reason');
  }
});

test('runSandboxed — throws SandboxUnavailableError on unsupported platforms', { skip: platformSupported() ? 'platform is supported; this case is not applicable' : false }, () => {
  assert.throws(
    () =>
      runSandboxed('echo hi', {
        cwd: os.tmpdir(),
        allowedWritePaths: [os.tmpdir()],
        allowNetwork: false,
      }),
    SandboxUnavailableError,
  );
});

test('runSandboxed — allows writes inside the workspace root', { skip: !platformSupported() ? 'OS sandbox binary not installed on this host' : false }, () => {
  const ws = mkWorkspace();
  try {
    const target = path.join(ws.root, 'allowed.txt');
    const result = runSandboxed(`echo hello > ${JSON.stringify(target)}`, {
      cwd: ws.root,
      allowedWritePaths: [ws.root],
      allowNetwork: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `expected sandbox-internal write to succeed, got status=${result.status}, stderr=${result.stderr}`);
    assert.ok(fs.existsSync(target), 'allowed write target must exist after the run');
    assert.equal(fs.readFileSync(target, 'utf-8').trim(), 'hello');
  } finally {
    ws.cleanup();
  }
});

test('runSandboxed — blocks writes outside the workspace (defeats command-parser bypass)', { skip: !platformSupported() ? 'OS sandbox binary not installed on this host' : false }, () => {
  const ws = mkWorkspace();
  const escapeFile = path.join(os.homedir(), `.fixo-os-sandbox-escape-test-${process.pid}-${Date.now()}.txt`);
  try { fs.unlinkSync(escapeFile); } catch { /* safe: best-effort pre-cleanup */ }
  try {
    const cmd = `echo escaped > ${JSON.stringify(escapeFile)}`;
    const result = runSandboxed(cmd, {
      cwd: ws.root,
      allowedWritePaths: [ws.root],
      allowNetwork: true,
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, `sandbox should have blocked the escape write, got status=${result.status}`);
    assert.equal(
      fs.existsSync(escapeFile),
      false,
      'escape file must not exist on disk after a blocked write',
    );
  } finally {
    ws.cleanup();
    try { fs.unlinkSync(escapeFile); } catch { /* safe: best-effort cleanup */ }
  }
});
