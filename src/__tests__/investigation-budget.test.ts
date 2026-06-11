import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadOnlyTool, MUTATING_TOOL_NAMES } from '../agent/single-agent.js';
import { getDefaultConfig } from '../config.js';

test('MUTATING_TOOL_NAMES contains every state-changing tool', () => {
  for (const name of [
    'write_file',
    'run_command',
    'apply_patch',
    'str_replace',
    'replace_range',
    'insert_after',
    'rename_file',
    'delete_file',
    'create_branch',
    'commit_changes',
    'push_branch',
    'create_pull_request',
  ]) {
    assert.ok(
      MUTATING_TOOL_NAMES.has(name),
      `MUTATING_TOOL_NAMES should include '${name}'`,
    );
  }
});

test('isReadOnlyTool classifies pure-read tools correctly', () => {
  for (const name of [
    'read_file',
    'search_code',
    'list_dir',
    'extract_symbols',
    'extract_imports',
  ]) {
    assert.equal(isReadOnlyTool(name), true, `'${name}' should be read-only`);
  }
});

test('isReadOnlyTool flags mutation tools', () => {
  for (const name of ['write_file', 'run_command', 'str_replace', 'apply_patch']) {
    assert.equal(isReadOnlyTool(name), false, `'${name}' should be mutating`);
  }
});

test('default toolCalls budget exposes investigationMultiplier', () => {
  const cfg = getDefaultConfig();
  assert.ok(cfg.preferences.safety.toolCalls.investigationMultiplier >= 1);
  assert.equal(cfg.preferences.safety.toolCalls.investigationMultiplier, 3);
});

test('investigation ceiling = hardLimit * investigationMultiplier (computed shape)', () => {
  // The single-agent loop computes the ceiling as
  //   Math.max(hardLimit, Math.floor(hardLimit * multiplier))
  // We replicate the formula so a future tweak (e.g. switching to
  // softLimit * multiplier) requires updating the test deliberately.
  const cfg = getDefaultConfig();
  const { hardLimit, investigationMultiplier } = cfg.preferences.safety.toolCalls;
  const ceiling = Math.max(hardLimit, Math.floor(hardLimit * investigationMultiplier));
  assert.equal(ceiling, 300);
});
