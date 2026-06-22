/**
 * Phase 5 regression fence — agent pool defaults and failure semantics.
 *
 * These tests lock in the BEHAVIOR OBSERVED IN THE JUNE 22, 2026 LOG
 * SESSION before any Phase 1–4 fixes are applied. Later phases will
 * extend this file with the post-fix expectations; the original
 * assertions are kept (sometimes adjusted to new default values) so
 * we always know what changed and why.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentPool, computePartialCommitPlan } from '../agent/agent-pool.js';
import type { Subtask } from '../types.js';
import {
  getDefaultConfig,
  getAgentConfig,
  getAgentPoolConfig,
  getAgentLoopGuardConfig,
  getAgentRoutingConfig,
} from '../config.js';

// Test helper — build a Subtask quickly. Defaults match a minimal
// valid Subtask so tests stay focused on the fields under inspection.
function makeSubtask(overrides: Partial<Subtask> & Pick<Subtask, 'id' | 'status'>): Subtask {
  return {
    id: overrides.id,
    title: overrides.title ?? `task-${overrides.id}`,
    description: overrides.description ?? '',
    persona: overrides.persona ?? 'code',
    dependencies: overrides.dependencies ?? [],
    files: overrides.files ?? [],
    status: overrides.status,
    result: overrides.result,
    touchedFiles: overrides.touchedFiles,
  };
}

test('AgentPool default concurrencyLimit is 3 (current behavior)', () => {
  const pool = new AgentPool();
  // Field is private, so we probe through the only public surface that
  // exposes it: a no-op constructor matches the documented default.
  // If a future phase widens the default, this test must be updated AND
  // its prior expectation captured in a CHANGELOG entry.
  const defaults = getAgentPoolConfig(getDefaultConfig());
  assert.equal(defaults.concurrencyLimit, 3);
  assert.ok(pool); // pool constructs successfully with defaults
});

test('AgentPool default subtaskBudget is 12 (Phase 4a will raise to 40)', () => {
  const defaults = getAgentPoolConfig(getDefaultConfig());
  assert.equal(defaults.subtaskBudget, 12);
});

test('AgentPool.preservePartialOnFailure defaults to false (Phase 7 flips)', () => {
  const defaults = getAgentPoolConfig(getDefaultConfig());
  assert.equal(defaults.preservePartialOnFailure, false);
});

test('AgentLoopGuard defaults: legacy session-lifetime lockout (Phase 7 flips)', () => {
  const defaults = getAgentLoopGuardConfig(getDefaultConfig());
  assert.equal(defaults.useSlidingWindow, false);
  assert.equal(defaults.blockWindowTurns, 10);
  assert.equal(defaults.blockResetOnSubtask, true);
});

test('AgentRouting defaults: verification flag NOT honored (Phase 6 flips)', () => {
  const defaults = getAgentRoutingConfig(getDefaultConfig());
  assert.equal(defaults.honorVerificationFlag, false);
  assert.equal(defaults.allowUnverifiedDag, false);
});

test('getAgentConfig falls back to defaults for configs predating the namespace', () => {
  // Simulate an old config that has no preferences.agent field at all.
  const oldConfig = getDefaultConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (oldConfig.preferences as any).agent;
  const resolved = getAgentConfig(oldConfig);
  assert.equal(resolved.pool.concurrencyLimit, 3);
  assert.equal(resolved.pool.subtaskBudget, 12);
  assert.equal(resolved.loopGuard.useSlidingWindow, false);
  assert.equal(resolved.routing.honorVerificationFlag, false);
});

test('AgentPool can be constructed with custom budget+concurrency (config-driven)', () => {
  // Phase 4a will route the configured defaults into the constructor;
  // proving the constructor accepts overrides locks in that contract.
  const pool = new AgentPool(5, 40);
  assert.ok(pool);
});

// ── Phase 5.2 — computePartialCommitPlan ─────────────────────────────────

test('computePartialCommitPlan: flag off → never takes partial path', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'completed', touchedFiles: ['/ws/a.css'] }),
    makeSubtask({ id: 'b', status: 'failed', touchedFiles: ['/ws/b.css'] }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: false });
  assert.equal(plan.partialCommitPath, false);
  // Pure aggregation still works — useful for telemetry even when path is off.
  assert.deepEqual(plan.successFiles.sort(), ['/ws/a.css']);
  assert.deepEqual(plan.failureOnlyFiles.sort(), ['/ws/b.css']);
});

test('computePartialCommitPlan: flag on + no success → not partial', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'failed', touchedFiles: ['/ws/a.css'] }),
    makeSubtask({ id: 'b', status: 'failed', touchedFiles: ['/ws/b.css'] }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: true });
  assert.equal(plan.partialCommitPath, false);
  assert.equal(plan.successFiles.length, 0);
  assert.deepEqual(plan.failureOnlyFiles.sort(), ['/ws/a.css', '/ws/b.css']);
});

test('computePartialCommitPlan: flag on + mixed → partial', () => {
  // Reproduces the orchestration log shape: 3 subtasks, 1 succeeds, 2 fail.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'animations', status: 'completed', touchedFiles: ['/ws/style.css', '/ws/script.js'] }),
    makeSubtask({ id: 'palette', status: 'failed', touchedFiles: ['/ws/palette.txt'] }),
    makeSubtask({ id: 'typography', status: 'failed' }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: true });
  assert.equal(plan.partialCommitPath, true);
  assert.deepEqual(plan.successFiles.sort(), ['/ws/script.js', '/ws/style.css']);
  assert.deepEqual(plan.failureOnlyFiles.sort(), ['/ws/palette.txt']);
  assert.equal(plan.completedCount, 1);
  assert.equal(plan.failedCount, 2);
});

test('computePartialCommitPlan: file touched by both → attributed to success', () => {
  // Conflict policy: a file written by both a completed and a failed
  // subtask is preserved (it's the final on-disk state if writes were
  // sequential; the safer default). Phase 3 will prevent this from
  // arising in the first place with write-set conflict detection.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'completed', touchedFiles: ['/ws/shared.css'] }),
    makeSubtask({ id: 'b', status: 'failed', touchedFiles: ['/ws/shared.css', '/ws/onlyB.css'] }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: true });
  assert.deepEqual(plan.successFiles.sort(), ['/ws/shared.css']);
  // shared.css does NOT appear in failureOnlyFiles
  assert.deepEqual(plan.failureOnlyFiles.sort(), ['/ws/onlyB.css']);
});

test('computePartialCommitPlan: subtasks with no touchedFiles are ignored cleanly', () => {
  // Earlier in development a subtask may finish without writing
  // anything (a reviewer/doc-only subtask, or one that hit the budget
  // wall before getting to a write). The aggregator must not crash.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'reviewer', status: 'completed' }),
    makeSubtask({ id: 'doc', status: 'completed', touchedFiles: [] }),
    makeSubtask({ id: 'code', status: 'failed', touchedFiles: ['/ws/x.ts'] }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: true });
  // No success files → no partial path (preserves "all rolled back" UX
  // for runs where every successful subtask was non-mutating).
  assert.equal(plan.partialCommitPath, false);
  assert.deepEqual(plan.failureOnlyFiles.sort(), ['/ws/x.ts']);
});

test('computePartialCommitPlan: all succeeded → trivially partial-eligible but caller will not enter that branch', () => {
  // Task-router only takes the partial-commit branch when `!success`
  // (at least one subtask failed). This test confirms the helper still
  // computes a sane partition for the all-success case, so a future
  // caller doesn't get garbage if it inspects the plan unconditionally.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'completed', touchedFiles: ['/ws/a.css'] }),
    makeSubtask({ id: 'b', status: 'completed', touchedFiles: ['/ws/b.css'] }),
  ];
  const plan = computePartialCommitPlan(subtasks, { preservePartialOnFailure: true });
  assert.equal(plan.partialCommitPath, true);
  assert.equal(plan.failureOnlyFiles.length, 0);
  assert.equal(plan.completedCount, 2);
  assert.equal(plan.failedCount, 0);
});
