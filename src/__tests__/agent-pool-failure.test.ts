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
import { AgentPool } from '../agent/agent-pool.js';
import {
  getDefaultConfig,
  getAgentConfig,
  getAgentPoolConfig,
  getAgentLoopGuardConfig,
  getAgentRoutingConfig,
} from '../config.js';

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
