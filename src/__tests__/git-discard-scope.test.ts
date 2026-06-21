/**
 * git-discard-scope.test.ts — regression coverage for the Jun 21
 * incident where the orchestrator's failure path called
 * `discardUncommittedChanges()` (since removed), which ran
 * `git checkout -- .` + `git clean -fd` and wiped every uncommitted
 * change in the user's workspace — even files the agent never
 * touched.
 *
 * These tests prove the replacement `discardChangesIn(files)` is
 * SCOPED — it only rolls back the named files, leaves any other
 * uncommitted user work alone, and is a no-op when the list is
 * empty. They also prove the dangerous `forceDiscardAllUncommittedChanges`
 * escape hatch refuses to run without the explicit `iAmCertain`
 * flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { GitManager } from '../git/git-manager.js';

function mkRepo(): { cwd: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-git-scope-'));
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  run(['init', '-q']);
  // Local user.* config so commits work without inheriting the dev's git config.
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  return {
    cwd,
    cleanup: () => {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function write(cwd: string, rel: string, content: string): string {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

function commit(cwd: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('discardChangesIn — reverts ONLY named tracked files; leaves other dirty files alone', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'agent-touched.txt', 'committed agent content\n');
    write(ctx.cwd, 'user-work.txt', 'committed user content\n');
    commit(ctx.cwd, 'initial');

    // Both files dirty — only one was touched by the agent.
    write(ctx.cwd, 'agent-touched.txt', 'AGENT EDIT — would be lost\n');
    write(ctx.cwd, 'user-work.txt', 'USER WIP — must be preserved\n');

    const gm = new GitManager(ctx.cwd);
    gm.discardChangesIn(['agent-touched.txt']);

    assert.equal(
      fs.readFileSync(path.join(ctx.cwd, 'agent-touched.txt'), 'utf-8'),
      'committed agent content\n',
      'agent-touched file must be reverted to HEAD',
    );
    assert.equal(
      fs.readFileSync(path.join(ctx.cwd, 'user-work.txt'), 'utf-8'),
      'USER WIP — must be preserved\n',
      'user-work file must be untouched — this is the incident regression',
    );
  } finally {
    ctx.cleanup();
  }
});

test('discardChangesIn — removes ONLY named untracked files; leaves other new files alone', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'placeholder.txt', 'seed\n');
    commit(ctx.cwd, 'seed');

    // Both new files untracked — only one is the agent's creation.
    write(ctx.cwd, 'agent-new.ts', 'export const x = 1;\n');
    write(ctx.cwd, 'user-new.md', '# WIP notes\n');

    const gm = new GitManager(ctx.cwd);
    gm.discardChangesIn(['agent-new.ts']);

    assert.equal(
      fs.existsSync(path.join(ctx.cwd, 'agent-new.ts')),
      false,
      'agent-new must be removed by scoped rollback',
    );
    assert.equal(
      fs.existsSync(path.join(ctx.cwd, 'user-new.md')),
      true,
      'user-new must NOT be removed — this is the incident regression',
    );
  } finally {
    ctx.cleanup();
  }
});

test('discardChangesIn — absolute paths are normalised to workspace-relative', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'foo.txt', 'committed\n');
    commit(ctx.cwd, 'seed');
    write(ctx.cwd, 'foo.txt', 'dirty\n');

    const gm = new GitManager(ctx.cwd);
    gm.discardChangesIn([path.join(ctx.cwd, 'foo.txt')]);

    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'foo.txt'), 'utf-8'), 'committed\n');
  } finally {
    ctx.cleanup();
  }
});

test('discardChangesIn — empty list is a true no-op (no files touched, no errors thrown)', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'foo.txt', 'committed\n');
    commit(ctx.cwd, 'seed');
    write(ctx.cwd, 'foo.txt', 'dirty\n');
    write(ctx.cwd, 'bar-untracked.txt', 'untracked\n');

    const gm = new GitManager(ctx.cwd);
    gm.discardChangesIn([]);

    // Both files exactly as left.
    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'foo.txt'), 'utf-8'), 'dirty\n');
    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'bar-untracked.txt'), 'utf-8'), 'untracked\n');
  } finally {
    ctx.cleanup();
  }
});

test('discardChangesIn — silently skips files that were never dirty', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'clean.txt', 'committed\n');
    commit(ctx.cwd, 'seed');

    const gm = new GitManager(ctx.cwd);
    // Pass a file that doesn't exist + a file that's clean. Must not throw.
    gm.discardChangesIn(['clean.txt', 'never-existed.txt']);

    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'clean.txt'), 'utf-8'), 'committed\n');
  } finally {
    ctx.cleanup();
  }
});

test('forceDiscardAllUncommittedChanges — refuses without the iAmCertain flag', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'foo.txt', 'committed\n');
    commit(ctx.cwd, 'seed');
    write(ctx.cwd, 'foo.txt', 'dirty\n');
    write(ctx.cwd, 'new.txt', 'untracked\n');

    const gm = new GitManager(ctx.cwd);
    // Cast through unknown — the typed signature requires iAmCertain.
    // We want to verify the *runtime* guard, so we send an empty object.
    (gm as unknown as { forceDiscardAllUncommittedChanges: (opts: object) => void })
      .forceDiscardAllUncommittedChanges({});

    // Workspace must be unchanged when iAmCertain is missing.
    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'foo.txt'), 'utf-8'), 'dirty\n');
    assert.equal(fs.existsSync(path.join(ctx.cwd, 'new.txt')), true);
  } finally {
    ctx.cleanup();
  }
});

test('forceDiscardAllUncommittedChanges — runs the full nuke when iAmCertain is explicitly true', () => {
  const ctx = mkRepo();
  try {
    write(ctx.cwd, 'foo.txt', 'committed\n');
    commit(ctx.cwd, 'seed');
    write(ctx.cwd, 'foo.txt', 'dirty\n');
    write(ctx.cwd, 'new.txt', 'untracked\n');

    const gm = new GitManager(ctx.cwd);
    gm.forceDiscardAllUncommittedChanges({ iAmCertain: true });

    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'foo.txt'), 'utf-8'), 'committed\n');
    assert.equal(fs.existsSync(path.join(ctx.cwd, 'new.txt')), false);
  } finally {
    ctx.cleanup();
  }
});

test('GitManager no longer exposes the historically-dangerous discardUncommittedChanges method', () => {
  // Surface-level guard: a future regression that reintroduces the
  // name will fail this assertion at CI time.
  const gm = new GitManager(os.tmpdir());
  assert.equal(
    (gm as unknown as Record<string, unknown>).discardUncommittedChanges,
    undefined,
    'discardUncommittedChanges() must not exist — removed Jun 21 after the orchestrator rollback incident',
  );
});
