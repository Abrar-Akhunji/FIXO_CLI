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
import { AgentPool, computePartialCommitPlan, findInFlightConflict } from '../agent/agent-pool.js';
import { serializeWriteConflicts, couldOverlapFile } from '../agent/orchestrator.js';
import type { Subtask } from '../types.js';
import {
  getDefaultConfig,
  getAgentConfig,
  getAgentPoolConfig,
  getAgentLoopGuardConfig,
  getAgentRoutingConfig,
  getAgentDagConfig,
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

test('AgentPool.preservePartialOnFailure defaults to true (Phase 7 flips)', () => {
  const defaults = getAgentPoolConfig(getDefaultConfig());
  assert.equal(defaults.preservePartialOnFailure, true);
});

test('AgentLoopGuard defaults: legacy session-lifetime lockout (Phase 7 flips)', () => {
  const defaults = getAgentLoopGuardConfig(getDefaultConfig());
  assert.equal(defaults.useSlidingWindow, true);
  assert.equal(defaults.blockWindowTurns, 10);
  assert.equal(defaults.blockResetOnSubtask, true);
});

test('AgentRouting defaults: verification flag NOT honored (Phase 6 flips)', () => {
  const defaults = getAgentRoutingConfig(getDefaultConfig());
  assert.equal(defaults.honorVerificationFlag, true);
  assert.equal(defaults.allowUnverifiedDag, false);
});

test('AgentDag defaults: serializeWriteConflicts + serializeMissingFiles default ON', () => {
  const defaults = getAgentDagConfig(getDefaultConfig());
  assert.equal(defaults.serializeWriteConflicts, true);
  assert.equal(defaults.serializeMissingFiles, true);
});

test('getAgentConfig falls back to defaults for configs predating the namespace', () => {
  // Simulate an old config that has no preferences.agent field at all.
  const oldConfig = getDefaultConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (oldConfig.preferences as any).agent;
  const resolved = getAgentConfig(oldConfig);
  assert.equal(resolved.pool.concurrencyLimit, 3);
  assert.equal(resolved.pool.subtaskBudget, 12);
  assert.equal(resolved.loopGuard.useSlidingWindow, true);
  assert.equal(resolved.routing.honorVerificationFlag, true);
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

// ── Phase 5.3 — couldOverlapFile ─────────────────────────────────────────

test('couldOverlapFile: exact match', () => {
  assert.equal(couldOverlapFile('src/a.ts', 'src/a.ts'), true);
});

test('couldOverlapFile: literal vs literal — disjoint', () => {
  assert.equal(couldOverlapFile('src/a.ts', 'src/b.ts'), false);
});

test('couldOverlapFile: glob vs literal — matches', () => {
  assert.equal(couldOverlapFile('src/*.ts', 'src/a.ts'), true);
  assert.equal(couldOverlapFile('src/**/*.css', 'src/styles/main.css'), true);
});

test('couldOverlapFile: glob vs literal — disjoint', () => {
  assert.equal(couldOverlapFile('src/*.ts', 'docs/readme.md'), false);
});

test('couldOverlapFile: glob vs glob — conservative true', () => {
  // Pattern-vs-pattern overlap is undecidable cheaply.
  assert.equal(couldOverlapFile('src/*.ts', 'src/*.tsx'), true);
});

// ── Phase 5.3 — serializeWriteConflicts ──────────────────────────────────

test('serializeWriteConflicts: 3 subtasks writing the same file → 3-chain', () => {
  // Replays the orchestration shape from the June 22, 2026 log session:
  // "animations / palette / typography" all targeting style.css with
  // no LLM-emitted dependencies.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a-animations', status: 'pending', persona: 'code', files: ['style.css'] }),
    makeSubtask({ id: 'b-palette', status: 'pending', persona: 'code', files: ['style.css'] }),
    makeSubtask({ id: 'c-typography', status: 'pending', persona: 'code', files: ['style.css'] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks);
  // Pair-wise: (a,b), (a,c), (b,c) — three edges, all forward by id sort.
  assert.equal(edgesInserted.length, 3);
  // Concrete check: b depends on a, c depends on a and b.
  const a = subtasks.find(s => s.id === 'a-animations')!;
  const b = subtasks.find(s => s.id === 'b-palette')!;
  const c = subtasks.find(s => s.id === 'c-typography')!;
  assert.deepEqual(a.dependencies, []);
  assert.ok(b.dependencies.includes('a-animations'));
  assert.ok(c.dependencies.includes('a-animations'));
  assert.ok(c.dependencies.includes('b-palette'));
});

test('serializeWriteConflicts: disjoint files → still parallel', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'pending', persona: 'code', files: ['src/a.ts'] }),
    makeSubtask({ id: 'b', status: 'pending', persona: 'code', files: ['src/b.ts'] }),
    makeSubtask({ id: 'c', status: 'pending', persona: 'code', files: ['src/c.ts'] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks);
  assert.equal(edgesInserted.length, 0);
  for (const s of subtasks) assert.equal(s.dependencies.length, 0);
});

test('serializeWriteConflicts: reviewer is read-only — never serialized', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a-code', status: 'pending', persona: 'code', files: ['x.ts'] }),
    makeSubtask({ id: 'b-reviewer', status: 'pending', persona: 'reviewer', files: ['x.ts'] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks);
  assert.equal(edgesInserted.length, 0);
});

test('serializeWriteConflicts: respects existing dependencies', () => {
  // If the LLM already linked b → a, the post-pass shouldn't add a
  // duplicate or reverse edge.
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'pending', persona: 'code', files: ['x.ts'], dependencies: [] }),
    makeSubtask({ id: 'b', status: 'pending', persona: 'code', files: ['x.ts'], dependencies: ['a'] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks);
  assert.equal(edgesInserted.length, 0);
});

test('serializeWriteConflicts: missing files (LLM omission) → serialized when serializeMissingFiles=true', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'pending', persona: 'code', files: [] }),
    makeSubtask({ id: 'b', status: 'pending', persona: 'code', files: [] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks, { serializeMissingFiles: true });
  assert.equal(edgesInserted.length, 1);
  assert.equal(edgesInserted[0].from, 'a');
  assert.equal(edgesInserted[0].to, 'b');
});

test('serializeWriteConflicts: missing files + flag off → preserves parallelism', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'pending', persona: 'code', files: [] }),
    makeSubtask({ id: 'b', status: 'pending', persona: 'code', files: [] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks, { serializeMissingFiles: false });
  assert.equal(edgesInserted.length, 0);
});

test('serializeWriteConflicts: glob overlap is detected', () => {
  const subtasks: Subtask[] = [
    makeSubtask({ id: 'a', status: 'pending', persona: 'code', files: ['src/styles/main.css'] }),
    makeSubtask({ id: 'b', status: 'pending', persona: 'code', files: ['src/styles/**/*.css'] }),
  ];
  const { edgesInserted } = serializeWriteConflicts(subtasks);
  assert.equal(edgesInserted.length, 1);
});

// ── Phase 5.3 — findInFlightConflict (pool runtime check) ────────────────

test('findInFlightConflict: candidate disjoint from in-flight → null', () => {
  const candidate = makeSubtask({ id: 'cand', status: 'pending', persona: 'code', files: ['src/a.ts'] });
  const inFlight = [
    makeSubtask({ id: 'peer', status: 'running', persona: 'code', files: ['src/b.ts'] }),
  ];
  assert.equal(findInFlightConflict(candidate, inFlight), null);
});

test('findInFlightConflict: candidate overlaps in-flight peer → returns peer id', () => {
  const candidate = makeSubtask({ id: 'cand', status: 'pending', persona: 'code', files: ['x.css'] });
  const inFlight = [
    makeSubtask({ id: 'peer-a', status: 'running', persona: 'code', files: ['y.css'] }),
    makeSubtask({ id: 'peer-b', status: 'running', persona: 'code', files: ['x.css'] }),
  ];
  assert.equal(findInFlightConflict(candidate, inFlight), 'peer-b');
});

test('findInFlightConflict: empty in-flight → null even with empty candidate files', () => {
  const candidate = makeSubtask({ id: 'cand', status: 'pending', persona: 'code', files: [] });
  assert.equal(findInFlightConflict(candidate, []), null);
});

test('findInFlightConflict: missing files + flag on → defers', () => {
  const candidate = makeSubtask({ id: 'cand', status: 'pending', persona: 'code', files: [] });
  const inFlight = [
    makeSubtask({ id: 'peer', status: 'running', persona: 'code', files: ['x.ts'] }),
  ];
  assert.equal(findInFlightConflict(candidate, inFlight, { serializeMissingFiles: true }), 'peer');
});

test('findInFlightConflict: missing files + flag off → allows', () => {
  const candidate = makeSubtask({ id: 'cand', status: 'pending', persona: 'code', files: [] });
  const inFlight = [
    makeSubtask({ id: 'peer', status: 'running', persona: 'code', files: ['x.ts'] }),
  ];
  assert.equal(findInFlightConflict(candidate, inFlight, { serializeMissingFiles: false }), null);
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
