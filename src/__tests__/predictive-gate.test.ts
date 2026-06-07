/**
 * predictive-gate.test.ts — Phase 4 predictive context-budget gate.
 *
 * Exercises the predictive read gate from `agent/predictive-gate.ts`
 * directly, and via `executeTool('read_file', ...)` to confirm the
 * wire-up in tool-executor is correct.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  estimateReadCost,
  shouldDeferRead,
  formatPredictiveGateDirective,
  DEFAULT_PREDICTIVE_BUDGET_PCT,
} from '../agent/predictive-gate.js';
import { executeTool } from '../agent/tool-executor.js';
import { resolveModelContextLimit } from '../agent/conversation.js';
import { TaskSession } from '../runtime/task-session.js';

/** Standard safety knobs used by the soak suite. Keeps each test
 *  call site small while still exercising the real gate logic. */
const SOAK_SAFETY = {
  atomicStaging: false,
  stagingTtlMs: 0,
  lspPreSave: 'off' as const,
  loopTrap: {
    triggerCount: 3,
    hardAbortCount: 6,
    toolResultTailBytes: 200,
    maxHistory: 50,
    enabled: true,
  },
  semanticLoopTrap: { enabled: true, windowSize: 5, triggerCount: 3, hardAbortCount: 6 },
  largeFileGateBytes: 15 * 1024,
  largeFileGateLines: 350,
  predictiveBudgetPct: 0.85,
};

/** Read the events.jsonl from a TaskSession's run directory. */
function readEvents(session: TaskSession): Array<Record<string, unknown>> {
  const file = path.join(session.runDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-predictive-'));
}

function writeFile(root: string, name: string, content: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

test('estimateReadCost: small file is tokenised exactly', () => {
  const cwd = mkWorkspace();
  const abs = writeFile(cwd, 'small.ts', 'export const x = 1;\n');
  const est = estimateReadCost(abs, 'gpt-4');
  assert.equal(est.exact, true);
  assert.ok(est.bytes > 0);
  assert.ok(est.projectedTokens > 0);
});

test('estimateReadCost: huge file uses sample extrapolation', () => {
  const cwd = mkWorkspace();
  const big = '// ' + 'x'.repeat(64 * 1024) + '\n'; // ~64 KiB, over sample
  const abs = writeFile(cwd, 'big.ts', big);
  const est = estimateReadCost(abs, 'gpt-4');
  assert.equal(est.exact, false);
  assert.ok(est.bytes >= 64 * 1024);
  assert.ok(est.projectedTokens > 1000);
});

test('estimateReadCost: missing file returns zeros', () => {
  const est = estimateReadCost('/nonexistent/path/that/does/not/exist.ts', 'gpt-4');
  assert.equal(est.bytes, 0);
  assert.equal(est.projectedTokens, 0);
});

test('shouldDeferRead: small file with empty conversation does not defer', () => {
  const estimate = { bytes: 100, projectedTokens: 25, exact: true };
  const decision = shouldDeferRead(estimate, 0, 'gpt-4');
  assert.equal(decision.defer, false);
});

test('shouldDeferRead: huge file with empty conversation defers', () => {
  const limit = resolveModelContextLimit('gpt-4');
  const estimate = { bytes: 999_999, projectedTokens: limit + 1000, exact: false };
  const decision = shouldDeferRead(estimate, 0, 'gpt-4');
  assert.equal(decision.defer, true);
  assert.match(decision.reason, /exceed budget/);
});

test('shouldDeferRead: small file but near-full conversation defers (uses both signals)', () => {
  const limit = resolveModelContextLimit('gpt-4');
  const conversationTokens = Math.floor(limit * 0.83); // 83% used
  const estimate = { bytes: 5000, projectedTokens: Math.floor(limit * 0.05), exact: true }; // 5% more
  const decision = shouldDeferRead(estimate, conversationTokens, 'gpt-4');
  // 83% + 5% = 88% > default 85% threshold
  assert.equal(decision.defer, true);
});

test('shouldDeferRead: budgetPct of 1.0 effectively disables the gate', () => {
  const limit = resolveModelContextLimit('gpt-4');
  const estimate = { bytes: 999_999, projectedTokens: limit + 1000, exact: false };
  // Even with the projection pushing 1000 over the limit, pct=1.0
  // means hardCap == limit, so we defer. To prove the disabling
  // intent we need an estimate that fits exactly at the limit:
  const fittingEstimate = { bytes: 100, projectedTokens: limit, exact: true };
  const decision = shouldDeferRead(fittingEstimate, 0, 'gpt-4', 1.0);
  assert.equal(decision.defer, false);
  // And under default pct=0.85 the same fitting estimate WOULD defer.
  const decisionDefault = shouldDeferRead(fittingEstimate, 0, 'gpt-4', DEFAULT_PREDICTIVE_BUDGET_PCT);
  assert.equal(decisionDefault.defer, true);
});

test('shouldDeferRead: invalid budgetPct (NaN, 0, negative) falls back to default', () => {
  const limit = resolveModelContextLimit('gpt-4');
  const fitting = { bytes: 100, projectedTokens: Math.floor(limit * 0.5), exact: true };
  // 50% of limit < 85% default — should not defer with default
  assert.equal(shouldDeferRead(fitting, 0, 'gpt-4', Number.NaN).defer, false);
  assert.equal(shouldDeferRead(fitting, 0, 'gpt-4', 0).defer, false);
  assert.equal(shouldDeferRead(fitting, 0, 'gpt-4', -1).defer, false);
});

test('formatPredictiveGateDirective: contains the Context-Budget Guard marker and routes to alternatives', () => {
  const estimate = { bytes: 200_000, projectedTokens: 50_000, exact: false };
  const decision = { defer: true, reason: 'predicted X', projectedTotal: 100_000, hardCap: 80_000 };
  const directive = formatPredictiveGateDirective('src/huge.ts', estimate, decision);
  assert.match(directive, /\[Context-Budget Guard\]/);
  assert.match(directive, /extract_symbols/);
  assert.match(directive, /extract_imports/);
  assert.match(directive, /str_replace/);
  assert.match(directive, /src\/huge\.ts/);
});

test('executeTool read_file: predictive gate fires when conversation is near-full', async () => {
  const cwd = mkWorkspace();
  // 8 KiB file — under the byte gate (15 KiB) so the byte gate
  // would not fire on its own.
  writeFile(cwd, 'medium.ts', 'export const z = 1;\n'.repeat(400));
  const limit = resolveModelContextLimit('gpt-4');
  const nearFullTokens = Math.floor(limit * 0.84);
  const ev = await executeTool('read_file', { path: 'medium.ts' }, cwd, false, {
    model: 'gpt-4',
    getConversationTokens: () => nearFullTokens,
    safety: {
      atomicStaging: false,
      stagingTtlMs: 0,
      lspPreSave: 'off',
      loopTrap: { triggerCount: 3, hardAbortCount: 6, toolResultTailBytes: 200, maxHistory: 50, enabled: true },
      semanticLoopTrap: { enabled: true, windowSize: 5, triggerCount: 3, hardAbortCount: 6 },
      largeFileGateBytes: 15 * 1024,
      largeFileGateLines: 350,
      predictiveBudgetPct: 0.85,
    },
  });
  assert.match(ev.result, /\[Context-Budget Guard\]/);
  assert.match(ev.result, /deferred/);
});

test('executeTool read_file: predictive gate skipped when no model is configured', async () => {
  const cwd = mkWorkspace();
  writeFile(cwd, 'small.ts', 'export const z = 1;\n');
  const ev = await executeTool('read_file', { path: 'small.ts' }, cwd, false, {
    // No model — gate should not fire
    getConversationTokens: () => 999_999_999,
  });
  // Should read normally
  assert.match(ev.result, /export const z = 1;/);
});

test('executeTool read_file: predictive gate skipped when predictiveBudgetPct >= 1', async () => {
  const cwd = mkWorkspace();
  writeFile(cwd, 'small.ts', 'export const z = 1;\n');
  const ev = await executeTool('read_file', { path: 'small.ts' }, cwd, false, {
    model: 'gpt-4',
    getConversationTokens: () => 999_999_999,
    safety: {
      atomicStaging: false,
      stagingTtlMs: 0,
      lspPreSave: 'off',
      loopTrap: { triggerCount: 3, hardAbortCount: 6, toolResultTailBytes: 200, maxHistory: 50, enabled: true },
      semanticLoopTrap: { enabled: true, windowSize: 5, triggerCount: 3, hardAbortCount: 6 },
      largeFileGateBytes: 15 * 1024,
      largeFileGateLines: 350,
      predictiveBudgetPct: 1.0,
    },
  });
  assert.match(ev.result, /export const z = 1;/);
});

/* ──────────────────── Phase 5 soak ──────────────────── */

test('soak: deferred read records `predictive_gate_fired` telemetry with the expected payload', async () => {
  const cwd = mkWorkspace();
  writeFile(cwd, 'medium.ts', 'export const z = 1;\n'.repeat(400));
  const session = new TaskSession({ cwd, task: 'soak', model: 'gpt-4' });
  try {
    const limit = resolveModelContextLimit('gpt-4');
    const nearFull = Math.floor(limit * 0.84);
    const ev = await executeTool('read_file', { path: 'medium.ts' }, cwd, false, {
      model: 'gpt-4',
      getConversationTokens: () => nearFull,
      session,
      safety: SOAK_SAFETY,
    });
    assert.match(ev.result, /\[Context-Budget Guard\]/);
    const fired = readEvents(session).find(
      (e) => e.type === 'predictive_gate_fired',
    );
    assert.ok(fired, 'expected a predictive_gate_fired event');
    assert.equal(fired!.path, 'medium.ts');
    assert.equal(typeof fired!.projectedTokens, 'number');
    assert.equal(typeof fired!.projectedTotal, 'number');
    assert.equal(typeof fired!.hardCap, 'number');
    assert.ok(
      (fired!.projectedTotal as number) > (fired!.hardCap as number),
      'projectedTotal must exceed hardCap when the gate fires',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('soak: deferred read sets event.affectedPath to the resolved absolute path', async () => {
  const cwd = mkWorkspace();
  const absPath = writeFile(cwd, 'big.ts', 'export const z = 1;\n'.repeat(400));
  const limit = resolveModelContextLimit('gpt-4');
  try {
    const ev = await executeTool('read_file', { path: 'big.ts' }, cwd, false, {
      model: 'gpt-4',
      getConversationTokens: () => Math.floor(limit * 0.84),
      safety: SOAK_SAFETY,
    });
    assert.match(ev.result, /deferred/);
    // The resolved absolute path is used so the rest of the agent
    // loop can still track modifications / locks even on a deferral.
    // Compare via realpath because macOS resolves /var → /private/var.
    assert.equal(ev.affectedPath, fs.realpathSync(absPath));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('soak: a zero-byte file never triggers the predictive gate', async () => {
  const cwd = mkWorkspace();
  writeFile(cwd, 'empty.ts', '');
  try {
    // Mid-range convo pressure (50%): well under the 85% hardCap on
    // its own, so the gate's verdict depends entirely on the file's
    // projected token cost. A zero-byte file contributes nothing.
    const ev = await executeTool('read_file', { path: 'empty.ts' }, cwd, false, {
      model: 'gpt-4',
      getConversationTokens: () =>
        Math.floor(resolveModelContextLimit('gpt-4') * 0.5),
      safety: SOAK_SAFETY,
    });
    // The predictive gate emits a directive that uniquely includes
    // `projected_tokens=`. The legacy byte gate uses the same
    // `[Context-Budget Guard]` header but never that field name.
    assert.doesNotMatch(ev.result, /projected_tokens=/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('soak: sequential reads flip from allow→defer at a deterministic threshold', async () => {
  const cwd = mkWorkspace();
  // 200 lines × ~20 chars ≈ 4 KiB / 200 lines. Stays under the byte
  // gate's 15 KiB AND 350-line thresholds so any deferral we see
  // must originate in the predictive gate, not the byte gate.
  writeFile(cwd, 'soak.ts', 'export const z = 1;\n'.repeat(200));
  const limit = resolveModelContextLimit('gpt-4');
  try {
    // Walk the conversation token count from 30% to 95% of the
    // model's window in 5–10-percentage-point steps. We expect ALL
    // reads at low pressure to succeed and ALL reads at high
    // pressure to be deferred. The flip must be monotonic — once a
    // defer is observed, every higher-pressure step must also defer.
    const steps = [0.30, 0.50, 0.70, 0.80, 0.85, 0.90, 0.95];
    let firstDeferIdx = -1;
    for (let i = 0; i < steps.length; i++) {
      const convoTokens = Math.floor(limit * steps[i]!);
      const ev = await executeTool('read_file', { path: 'soak.ts' }, cwd, false, {
        model: 'gpt-4',
        getConversationTokens: () => convoTokens,
        safety: SOAK_SAFETY,
      });
      // Match only the predictive-gate directive, which includes
      // `projected_tokens=`. The legacy byte gate cannot fire here
      // (file is below both thresholds).
      const deferred = /projected_tokens=/.test(ev.result);
      if (deferred && firstDeferIdx === -1) firstDeferIdx = i;
      if (firstDeferIdx >= 0 && i > firstDeferIdx) {
        // Monotonic invariant: once we tipped, every later step
        // (more pressure) must also defer.
        assert.ok(deferred, `step ${i} (pct=${steps[i]}) regressed to allow after a defer`);
      }
    }
    // Sanity: the gate MUST tip somewhere in the sweep. If it never
    // does, the integration is broken (the unit tests assert the
    // helper itself works correctly).
    assert.ok(firstDeferIdx >= 0, 'predictive gate never tipped across the 30–95% sweep');
    assert.ok(steps[firstDeferIdx]! >= 0.80, `expected tip at ≥80% pressure, got ${steps[firstDeferIdx]}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
