import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LoopMitigationTracker,
  REPEAT_WARN_BLOCK_THRESHOLD,
  isReadTool,
  buildLoopBlockedReadResult,
} from '../runtime/loop-mitigation.js';

test('REPEAT_WARN_BLOCK_THRESHOLD is at least 2', () => {
  assert.ok(REPEAT_WARN_BLOCK_THRESHOLD >= 2);
});

test('LoopMitigationTracker: first warn does not block', () => {
  const t = new LoopMitigationTracker();
  const nowBlocking = t.recordWarn('src/foo.ts');
  assert.equal(nowBlocking, false);
  assert.equal(t.isBlocked('src/foo.ts'), false);
  assert.equal(t.warnsFor('src/foo.ts'), 1);
});

test('LoopMitigationTracker: second warn flips to blocked', () => {
  const t = new LoopMitigationTracker();
  t.recordWarn('src/foo.ts');
  const nowBlocking = t.recordWarn('src/foo.ts');
  assert.equal(nowBlocking, true);
  assert.equal(t.isBlocked('src/foo.ts'), true);
});

test('LoopMitigationTracker: third warn keeps blocked but returns false (already announced)', () => {
  const t = new LoopMitigationTracker();
  t.recordWarn('src/foo.ts');
  t.recordWarn('src/foo.ts');
  const nowBlocking = t.recordWarn('src/foo.ts');
  assert.equal(nowBlocking, false);
  assert.equal(t.isBlocked('src/foo.ts'), true);
  assert.equal(t.warnsFor('src/foo.ts'), 3);
});

test('LoopMitigationTracker: per-target isolation', () => {
  const t = new LoopMitigationTracker();
  t.recordWarn('src/a.ts');
  t.recordWarn('src/a.ts');
  assert.equal(t.isBlocked('src/a.ts'), true);
  assert.equal(t.isBlocked('src/b.ts'), false);
});

test('LoopMitigationTracker: reset clears state', () => {
  const t = new LoopMitigationTracker();
  t.recordWarn('src/foo.ts');
  t.recordWarn('src/foo.ts');
  t.reset();
  assert.equal(t.isBlocked('src/foo.ts'), false);
  assert.equal(t.warnsFor('src/foo.ts'), 0);
});

test('isReadTool classifies read-shaped tools', () => {
  for (const name of ['read_file', 'extract_symbols', 'extract_imports']) {
    assert.equal(isReadTool(name), true, `'${name}' should be a read`);
  }
});

test('isReadTool rejects non-read tools', () => {
  for (const name of ['write_file', 'run_command', 'search_code', 'list_dir']) {
    assert.equal(isReadTool(name), false, `'${name}' should not be a read`);
  }
});

test('buildLoopBlockedReadResult produces a clear tool-error string', () => {
  const msg = buildLoopBlockedReadResult('src/foo.ts', 4);
  assert.match(msg, /Error: read_file refused/);
  assert.match(msg, /src\/foo\.ts/);
  assert.match(msg, /4 consecutive warnings/);
  assert.match(msg, /search_code|extract_imports|clarifying question/);
});
