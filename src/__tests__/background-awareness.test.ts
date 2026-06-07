/**
 * background-awareness.test.ts — Phase 3 tests.
 *
 * Covers six cases:
 *   (a) empty registry → snapshot is empty + directive is null;
 *   (b) one running job → directive lists it under "Still running";
 *   (c) job exits between turns → first directive announces the
 *       exit; second snapshot does NOT re-announce it;
 *   (d) failed job → directive surfaces a stderr tail capped at
 *       ≤200 chars;
 *   (e) many jobs → directive is hard-capped at the documented
 *       MAX_DIRECTIVE_CHARS;
 *   (f) cwd with no registry → snapshot is empty, no crash.
 *
 * The awareness module reads through `listAllBackgroundJobs(cwd)`,
 * which delegates to the per-cwd registry kept by `tool-executor.ts`.
 * We seed the registry via `setBackgroundJobRegistry` so the tests
 * don't have to spawn real processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BackgroundJobRegistry,
  type BackgroundJob,
} from '../runtime/background-jobs.js';
import {
  setBackgroundJobRegistry,
} from '../agent/tool-executor.js';
import { BackgroundAwareness } from '../agent/background-awareness.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-awareness-'));
}

/** Mint a fake job and insert it into the registry's internal map. */
function injectJob(reg: BackgroundJobRegistry, job: BackgroundJob): void {
  // The registry exposes `list()` over its internal Map; we reach in
  // through `(reg as any).jobs` to avoid having to spawn real
  // children. This is the same pattern background-jobs.test.ts uses
  // when it needs to verify lifecycle invariants in isolation.
  const jobsMap = (reg as unknown as { jobs: Map<string, BackgroundJob> }).jobs;
  jobsMap.set(job.id, job);
}

function fakeJob(overrides: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: overrides.id ?? 'job_aaaa1111',
    cmd: overrides.cmd ?? 'sleep',
    args: overrides.args ?? ['1'],
    cwd: overrides.cwd ?? '/tmp',
    pid: overrides.pid,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? new Date(Date.now() - 5_000).toISOString(),
    exitedAt: overrides.exitedAt,
    exitCode: overrides.exitCode,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    totalStdoutBytes: overrides.totalStdoutBytes ?? 0,
    totalStderrBytes: overrides.totalStderrBytes ?? 0,
    stdoutTruncated: overrides.stdoutTruncated ?? false,
    stderrTruncated: overrides.stderrTruncated ?? false,
    failureReason: overrides.failureReason,
    lastError: overrides.lastError,
  };
}

/* ──────────────────── (a) empty ──────────────────── */

test('snapshot is empty + directive is null when no registry exists', () => {
  const cwd = mkTmp();
  try {
    const awareness = new BackgroundAwareness(cwd);
    const snap = awareness.snapshot();
    assert.equal(snap.running.length, 0);
    assert.equal(snap.newlyFinished.length, 0);
    assert.equal(snap.totalJobs, 0);
    assert.equal(awareness.formatDirective(snap), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (b) one running ──────────────────── */

test('a single running job appears under "Still running"', () => {
  const cwd = mkTmp();
  const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
  try {
    setBackgroundJobRegistry(cwd, reg);
    injectJob(
      reg,
      fakeJob({
        id: 'job_run01',
        cmd: 'npm',
        args: ['run', 'build'],
        status: 'running',
        totalStdoutBytes: 2048,
      }),
    );
    const awareness = new BackgroundAwareness(cwd);
    const snap = awareness.snapshot();
    assert.equal(snap.running.length, 1);
    assert.equal(snap.newlyFinished.length, 0);
    const directive = awareness.formatDirective(snap);
    assert.ok(directive);
    assert.match(directive!, /\[Background Jobs\]/);
    assert.match(directive!, /Still running/);
    assert.match(directive!, /job_run01/);
    assert.match(directive!, /npm/);
    assert.match(directive!, /stdout=2048B/);
    assert.doesNotMatch(directive!, /Newly finished/);
  } finally {
    setBackgroundJobRegistry(cwd, null);
    reg.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (c) announce once ──────────────────── */

test('a newly-finished job is announced exactly once', () => {
  const cwd = mkTmp();
  const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
  try {
    setBackgroundJobRegistry(cwd, reg);
    injectJob(
      reg,
      fakeJob({
        id: 'job_exit01',
        cmd: 'echo',
        args: ['ok'],
        status: 'exited',
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      }),
    );
    const awareness = new BackgroundAwareness(cwd);

    // First call: newly-finished should include the job.
    const first = awareness.snapshot();
    assert.equal(first.newlyFinished.length, 1);
    const d1 = awareness.formatDirective(first);
    assert.ok(d1);
    assert.match(d1!, /Newly finished/);
    assert.match(d1!, /job_exit01/);
    assert.match(d1!, /exit 0/);
    awareness.markAnnounced(first);

    // Second call: status hasn't changed since we last surfaced it,
    // so newlyFinished is empty and we emit no directive at all.
    const second = awareness.snapshot();
    assert.equal(second.newlyFinished.length, 0);
    assert.equal(second.running.length, 0);
    assert.equal(awareness.formatDirective(second), null);
  } finally {
    setBackgroundJobRegistry(cwd, null);
    reg.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (d) stderr tail ──────────────────── */

test('failed jobs include a truncated stderr tail (≤200 chars)', () => {
  const cwd = mkTmp();
  const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
  try {
    setBackgroundJobRegistry(cwd, reg);
    const longStderr =
      'preamble that should be sliced away ' + 'X'.repeat(400) + ' END_MARKER';
    injectJob(
      reg,
      fakeJob({
        id: 'job_fail01',
        cmd: 'fail-cmd',
        status: 'failed',
        exitCode: 1,
        exitedAt: new Date().toISOString(),
        stderr: longStderr,
        totalStderrBytes: longStderr.length,
      }),
    );
    const awareness = new BackgroundAwareness(cwd);
    const snap = awareness.snapshot();
    const directive = awareness.formatDirective(snap);
    assert.ok(directive);
    assert.match(directive!, /Newly finished/);
    assert.match(directive!, /failed/);
    assert.match(directive!, /END_MARKER/);
    // The truncation ellipsis means the "preamble" prefix must be gone.
    assert.doesNotMatch(directive!, /preamble/);
    // And the literal stderr line in the directive should not exceed
    // the documented tail size by more than the "    stderr: " prefix
    // + the leading "…" marker.
    const stderrLine = directive!
      .split('\n')
      .find((l) => l.trim().startsWith('stderr:'));
    assert.ok(stderrLine);
    assert.ok(stderrLine!.length < 260, `stderr line was ${stderrLine!.length} chars`);
  } finally {
    setBackgroundJobRegistry(cwd, null);
    reg.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (e) hard cap ──────────────────── */

test('the directive is hard-capped at the documented size', () => {
  const cwd = mkTmp();
  const reg = new BackgroundJobRegistry(cwd, { disableReaper: true });
  try {
    setBackgroundJobRegistry(cwd, reg);
    // 30 running jobs with verbose command names. Each renders to
    // roughly 80 chars; together they're well past 1500.
    for (let i = 0; i < 30; i++) {
      injectJob(
        reg,
        fakeJob({
          id: `job_bulk${i.toString().padStart(2, '0')}`,
          cmd: `command-with-a-fairly-long-name-${i}`,
          args: ['--flag', '--another-flag', 'value'],
          status: 'running',
          totalStdoutBytes: 1024 * (i + 1),
          startedAt: new Date(Date.now() - 10_000 * (i + 1)).toISOString(),
        }),
      );
    }
    const awareness = new BackgroundAwareness(cwd);
    const directive = awareness.formatDirective(awareness.snapshot());
    assert.ok(directive);
    assert.ok(
      directive!.length <= 1500,
      `directive was ${directive!.length} chars (cap 1500)`,
    );
    // The truncation marker proves the cap actually fired.
    assert.match(directive!, /\[truncated\]/);
  } finally {
    setBackgroundJobRegistry(cwd, null);
    reg.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ──────────────────── (f) no registry ──────────────────── */

test('snapshot returns empty for a cwd with no registry (no crash)', () => {
  const isolatedCwd = mkTmp();
  try {
    // Deliberately do NOT register a BackgroundJobRegistry for this cwd.
    const awareness = new BackgroundAwareness(isolatedCwd);
    const snap = awareness.snapshot();
    assert.equal(snap.running.length, 0);
    assert.equal(snap.newlyFinished.length, 0);
    assert.equal(snap.totalJobs, 0);
    assert.equal(awareness.formatDirective(snap), null);
  } finally {
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
});
