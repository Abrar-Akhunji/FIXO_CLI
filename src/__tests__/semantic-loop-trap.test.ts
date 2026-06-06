import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  SemanticLoopDetector,
  SemanticLoopAbortedError,
  DEFAULT_SEMANTIC_LOOP_PREFS,
  SEMANTIC_LOOP_TARGET_TOOLS,
  toSafetyAlertDirective,
  type SemanticLoopPreferences,
  type SemanticLoopVerdict,
} from '../runtime/loop-trap.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => T | Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-semantic-'));
  return (async () => {
    try {
      return await fn(tmp);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  })();
}

function customPrefs(
  partial: Partial<SemanticLoopPreferences> = {},
): SemanticLoopPreferences {
  return { ...DEFAULT_SEMANTIC_LOOP_PREFS, ...partial };
}

/* ------------------------------------------------------------------ */
/* constructor validation                                              */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — rejects invalid windowSize', () => {
  assert.throws(
    () => new SemanticLoopDetector(customPrefs({ windowSize: 0 })),
    /windowSize must be >= 1/,
  );
});

test('SemanticLoopDetector — rejects triggerCount < 1', () => {
  assert.throws(
    () => new SemanticLoopDetector(customPrefs({ triggerCount: 0 })),
    /triggerCount must be >= 1/,
  );
});

test('SemanticLoopDetector — rejects hardAbortCount < triggerCount', () => {
  assert.throws(
    () =>
      new SemanticLoopDetector(
        customPrefs({ triggerCount: 5, hardAbortCount: 3 }),
      ),
    /hardAbortCount must be >= triggerCount/,
  );
});

/* ------------------------------------------------------------------ */
/* record() basics                                                    */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — first record is always ok', () => {
  const d = new SemanticLoopDetector();
  const v = d.record(0, 'read_file', { path: 'a.ts' }, '/cwd');
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') assert.equal(v.count, 1);
});

test('SemanticLoopDetector — non-file tools are ignored', () => {
  const d = new SemanticLoopDetector();
  for (let i = 0; i < 10; i++) {
    const v = d.record(i, 'run_command', { command: 'ls' }, '/cwd');
    assert.equal(v.state, 'ok');
  }
  assert.equal(d.getFrequencies().size, 0);
});

test('SemanticLoopDetector — apply_patch is ignored (no path arg)', () => {
  const d = new SemanticLoopDetector();
  const v = d.record(0, 'apply_patch', { patch: '--- a\n+++ b\n' }, '/cwd');
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') assert.equal(v.target, '');
});

test('SemanticLoopDetector — tools without a path arg are ignored', () => {
  const d = new SemanticLoopDetector();
  const v = d.record(0, 'read_file', {}, '/cwd');
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') assert.equal(v.target, '');
});

test('SemanticLoopDetector — disabled detector never trips', () => {
  const d = new SemanticLoopDetector(customPrefs({ enabled: false }));
  for (let i = 0; i < 20; i++) {
    const v = d.record(i, 'read_file', { path: 'a.ts' }, '/cwd');
    assert.equal(v.state, 'ok');
  }
});

/* ------------------------------------------------------------------ */
/* frequency math                                                     */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — three accesses to same path trigger warn', () => {
  const d = new SemanticLoopDetector(customPrefs({
    windowSize: 5,
    triggerCount: 3,
    hardAbortCount: 6,
  }));
  d.record(0, 'read_file', { path: 'a.ts' }, '/cwd');
  d.record(1, 'read_file', { path: 'a.ts' }, '/cwd');
  const v = d.record(2, 'read_file', { path: 'a.ts' }, '/cwd');
  assert.equal(v.state, 'warn');
  if (v.state === 'warn') {
    assert.equal(v.count, 3);
    assert.equal(v.windowSize, 3);
  }
});

test('SemanticLoopDetector — six accesses to same path hard-abort', () => {
  const d = new SemanticLoopDetector(customPrefs({
    windowSize: 5,
    triggerCount: 3,
    hardAbortCount: 6,
  }));
  // First 3 reach warn threshold.
  for (let i = 0; i < 3; i++) {
    d.record(i, 'read_file', { path: 'a.ts' }, '/cwd');
  }
  // Reads 4 and 5 push the window forward but stay below hard-abort
  // because of the sliding window: the earliest 1 has been evicted,
  // so the frequency is still 5.
  d.record(3, 'read_file', { path: 'a.ts' }, '/cwd');
  const v5 = d.record(4, 'read_file', { path: 'a.ts' }, '/cwd');
  assert.equal(v5.state, 'warn');
  if (v5.state === 'warn') assert.equal(v5.count, 5);

  // Read 6: window evicts the first access, but adds a new one.
  // F(p) is still 5 (4 kept + 1 new = 5). Need 6 consecutive in
  // window to trip hard-abort, which means we need a wider window.
  // Switch to a wider detector to verify the threshold itself.
  const wide = new SemanticLoopDetector(customPrefs({
    windowSize: 8,
    triggerCount: 3,
    hardAbortCount: 6,
  }));
  for (let i = 0; i < 5; i++) {
    wide.record(i, 'read_file', { path: 'a.ts' }, '/cwd');
  }
  const v6 = wide.record(5, 'read_file', { path: 'a.ts' }, '/cwd');
  assert.equal(v6.state, 'hard-abort');
  if (v6.state === 'hard-abort') {
    assert.equal(v6.count, 6);
  }
});

/* ------------------------------------------------------------------ */
/* path normalisation                                                 */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — relative, dot-prefixed, and absolute paths collide', async () => {
  await withTempCwd(async (cwd) => {
    const d = new SemanticLoopDetector(customPrefs({
      windowSize: 5,
      triggerCount: 3,
      hardAbortCount: 6,
    }));
    d.record(0, 'read_file', { path: 'src/foo.ts' }, cwd);
    d.record(1, 'read_file', { path: './src/foo.ts' }, cwd);
    const abs = path.resolve(cwd, 'src/foo.ts');
    const v = d.record(2, 'read_file', { path: abs }, cwd);
    assert.equal(v.state, 'warn');
    if (v.state === 'warn') assert.equal(v.target, abs);
  });
});

/* ------------------------------------------------------------------ */
/* window eviction                                                    */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — window eviction drops the count', () => {
  const d = new SemanticLoopDetector(customPrefs({
    windowSize: 3,
    triggerCount: 3,
    hardAbortCount: 6,
  }));
  d.record(0, 'read_file', { path: 'a.ts' }, '/cwd');
  d.record(1, 'read_file', { path: 'a.ts' }, '/cwd');
  const v2 = d.record(2, 'read_file', { path: 'a.ts' }, '/cwd'); // warn
  assert.equal(v2.state, 'warn');
  d.record(3, 'read_file', { path: 'b.ts' }, '/cwd'); // evicts a.ts #0
  const v3 = d.record(4, 'read_file', { path: 'a.ts' }, '/cwd'); // evicts a.ts #1
  // window is now [a.ts#2, b.ts, a.ts#4] — a.ts count = 2
  assert.equal(v3.state, 'ok');
  if (v3.state === 'ok') assert.equal(v3.count, 2);
});

/* ------------------------------------------------------------------ */
/* rename_file uses 'to' as the target                                */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — rename_file tracks the destination', () => {
  const d = new SemanticLoopDetector(customPrefs({
    windowSize: 5,
    triggerCount: 3,
    hardAbortCount: 6,
  }));
  d.record(0, 'rename_file', { from: 'a.ts', to: 'b.ts' }, '/cwd');
  d.record(1, 'rename_file', { from: 'c.ts', to: 'b.ts' }, '/cwd');
  const v = d.record(2, 'rename_file', { from: 'd.ts', to: 'b.ts' }, '/cwd');
  assert.equal(v.state, 'warn');
  if (v.state === 'warn') {
    assert.equal(v.target, path.resolve('/cwd', 'b.ts'));
  }
});

/* ------------------------------------------------------------------ */
/* reset()                                                            */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — reset() wipes the window and frequencies', () => {
  const d = new SemanticLoopDetector();
  d.record(0, 'read_file', { path: 'a.ts' }, '/cwd');
  d.record(1, 'read_file', { path: 'a.ts' }, '/cwd');
  d.reset();
  assert.equal(d.getWindow().length, 0);
  assert.equal(d.getFrequencies().size, 0);
});

/* ------------------------------------------------------------------ */
/* toSafetyAlertDirective                                             */
/* ------------------------------------------------------------------ */

test('toSafetyAlertDirective — ok verdict returns null', () => {
  const v: SemanticLoopVerdict = { state: 'ok', target: 'a.ts', count: 1 };
  assert.equal(toSafetyAlertDirective(v), null);
});

test('toSafetyAlertDirective — warn verdict contains the target', () => {
  const v: SemanticLoopVerdict = {
    state: 'warn',
    target: 'a.ts',
    count: 3,
    windowSize: 3,
  };
  const directive = toSafetyAlertDirective(v);
  assert.ok(directive);
  assert.match(directive!, /a\.ts/);
  assert.match(directive!, /Safety-Alert/);
  assert.match(directive!, /read_file or replace_file/);
});

test('toSafetyAlertDirective — hard-abort verdict also produces a directive', () => {
  const v: SemanticLoopVerdict = {
    state: 'hard-abort',
    target: 'a.ts',
    count: 6,
    windowSize: 6,
  };
  const directive = toSafetyAlertDirective(v);
  assert.ok(directive);
  assert.match(directive!, /a\.ts/);
});

/* ------------------------------------------------------------------ */
/* SemanticLoopAbortedError shape                                     */
/* ------------------------------------------------------------------ */

test('SemanticLoopAbortedError — carries target, count, and windowSize', () => {
  const err = new SemanticLoopAbortedError('a.ts', 6, 5);
  assert.equal(err.name, 'SemanticLoopAbortedError');
  assert.equal(err.target, 'a.ts');
  assert.equal(err.count, 6);
  assert.equal(err.windowSize, 5);
  assert.match(err.message, /Semantic loop-trap hard-abort/);
});

/* ------------------------------------------------------------------ */
/* tool set sanity                                                    */
/* ------------------------------------------------------------------ */

test('SEMANTIC_LOOP_TARGET_TOOLS — contains the seven file-mutating tools', () => {
  const expected = [
    'read_file',
    'write_file',
    'apply_patch',
    'replace_range',
    'insert_after',
    'rename_file',
    'delete_file',
  ];
  for (const name of expected) {
    assert.ok(SEMANTIC_LOOP_TARGET_TOOLS.has(name), `expected ${name}`);
  }
  // run_command and web_search are not file-targets
  assert.equal(SEMANTIC_LOOP_TARGET_TOOLS.has('run_command'), false);
  assert.equal(SEMANTIC_LOOP_TARGET_TOOLS.has('web_search'), false);
});

/* ------------------------------------------------------------------ */
/* defaults match the architectural spec                              */
/* ------------------------------------------------------------------ */

test('SemanticLoopDetector — default prefs match the spec (5/3/6)', () => {
  assert.equal(DEFAULT_SEMANTIC_LOOP_PREFS.windowSize, 5);
  assert.equal(DEFAULT_SEMANTIC_LOOP_PREFS.triggerCount, 3);
  assert.equal(DEFAULT_SEMANTIC_LOOP_PREFS.hardAbortCount, 6);
  assert.equal(DEFAULT_SEMANTIC_LOOP_PREFS.enabled, true);
});
