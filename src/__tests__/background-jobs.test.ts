/**
 * Tests for the background-jobs registry.
 *
 * Exercises the full lifecycle: spawn, poll, kill, ring-buffer
 * cap, snapshot persistence, command-parser rejection, and
 * workspace-boundary enforcement. The test fixtures use plain
 * filenames (not `src/...`) so `WorkspaceGuard.assertNotPlatformPath`
 * is never triggered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackgroundJobRegistry } from '../runtime/background-jobs.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('register spawns a short command and reports success on exit', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({ cmd: 'node', args: ['-e', 'process.stdout.write("ok")'], cwd });
    assert.equal(out.ok, true);
    assert.ok(out.jobId);
    assert.ok(typeof out.pid === 'number');
    // Wait for exit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const snap = reg.poll({ jobId: out.jobId! });
    assert.ok(snap);
    assert.equal(snap?.status, 'exited');
    assert.equal(snap?.exitCode, 0);
    assert.match(snap?.stdout ?? '', /ok/);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('register rejects an empty cmd', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({ cmd: '', args: [], cwd });
    assert.equal(out.ok, false);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('register rejects a workspace-escape command', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    // Use a sensitive file inside the workspace (the parser
    // refuses to read `.env` regardless of where it lives).
    const envFile = path.join(cwd, '.env');
    fs.writeFileSync(envFile, 'SECRET=x');
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'cat',
      args: ['.env'],
      cwd,
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /sensitive|outside|unsafe|rejected/);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('register rejects a cwd that escapes the workspace', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: '/etc',
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /workspace|outside|escape|resolves/i);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('poll honours tailLines', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', `for(let i=0;i<5;i++) process.stdout.write('line-'+i+'\\n')`],
      cwd,
    });
    await new Promise((r) => setTimeout(r, 500));
    const snap = reg.poll({ jobId: out.jobId!, tailLines: 2 });
    const lines = (snap?.stdout ?? '').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /line-3/);
    assert.match(lines[1] ?? '', /line-4/);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('stream buffer caps at 64 KiB and reports truncation', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', `process.stdout.write('a'.repeat(80_000))`],
      cwd,
    });
    await new Promise((r) => setTimeout(r, 600));
    const snap = reg.poll({ jobId: out.jobId! });
    assert.ok((snap?.totalStdoutBytes ?? 0) >= 80_000);
    assert.equal(snap?.stdoutTruncated, true);
    // The truncated text must fit in 64 KiB.
    assert.ok(Buffer.byteLength(snap?.stdout ?? '', 'utf-8') <= 64 * 1024 + 64);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('kill terminates a running job', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
    });
    // Give the child a moment to actually start.
    await new Promise((r) => setTimeout(r, 200));
    const killed = reg.kill(out.jobId!);
    assert.equal(killed.ok, true);
    await new Promise((r) => setTimeout(r, 300));
    const snap = reg.poll({ jobId: out.jobId! });
    assert.ok(snap?.status === 'killed' || snap?.status === 'failed' || snap?.status === 'exited');
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('kill returns error for an unknown jobId', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = reg.kill('job_does_not_exist');
    assert.equal(out.ok, false);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('list returns jobs newest-first', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const a = await reg.register({ cmd: 'node', args: ['-e', 'process.exit(0)'], cwd });
    await new Promise((r) => setTimeout(r, 5));
    const b = await reg.register({ cmd: 'node', args: ['-e', 'process.exit(0)'], cwd });
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, b.jobId);
    assert.equal(list[1]?.id, a.jobId);
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('snapshot file is fsynced to <cwd>/.fixo/jobs/<jobId>.json', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', 'process.stdout.write("snap-test")'],
      cwd,
    });
    // Wait long enough for the 5s flusher — but flush immediately
    // by reaching into the public surface: we have to wait, or we
    // can call shutdown() which does not flush on its own. Trigger
    // a poll to make sure state is up to date, then check the
    // filesystem via listdir.
    await new Promise((r) => setTimeout(r, 200));
    // Trigger a wait long enough for the flusher to fire — but
    // for test speed, just verify the file appears at exit.
    await new Promise((r) => setTimeout(r, 6_000));
    const dir = path.join(cwd, '.fixo', 'jobs');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(files.some((f) => f.startsWith(out.jobId!)));
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('shutdown kills running children and clears timers', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
    });
    await new Promise((r) => setTimeout(r, 300));
    reg.shutdown();
    // SIGTERM may take a moment to land. Wait for the exit
    // callback to update the status.
    await new Promise((r) => setTimeout(r, 500));
    const snap = reg.poll({ jobId: out.jobId! });
    assert.ok(snap);
    assert.notEqual(snap?.status, 'running');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('failed spawn (binary does not exist) is reported as failed', async () => {
  const cwd = mkTmp('bg-test-');
  try {
    const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
    const out = await reg.register({
      cmd: 'definitely-not-a-real-binary-xyzzy',
      args: [],
      cwd,
    });
    // Spawn may either reject synchronously (caught above) or
    // accept and emit an `error` event. Either way, the registry
    // reports a non-ok result or a failed status within a moment.
    if (out.ok) {
      await new Promise((r) => setTimeout(r, 800));
      const snap = reg.poll({ jobId: out.jobId! });
      assert.notEqual(snap?.status, 'running');
    } else {
      assert.equal(out.ok, false);
    }
    reg.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
