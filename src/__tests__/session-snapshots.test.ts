/**
 * Tests for the session-snapshots persistence layer.
 *
 * The snapshot writer and reader must round-trip:
 *   - the conversation (messages)
 *   - the token count
 *   - the model
 *   - the mode
 *   - the selected files
 *   - the todo list
 *
 * The reader must reject snapshots whose `kind` discriminator
 * or `version` field does not match — the loader is the gatekeeper
 * for future format migrations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listSnapshots,
  loadSnapshot,
  makeSnapshotId,
  saveSnapshot,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  isValidSessionLabel,
  renameSnapshot,
  type SaveInput,
  type SessionMessage,
} from '../runtime/session-snapshots.js';
import { emptyTodoList, addItem } from '../context/todo.js';
import { ConversationManager, SessionManager } from '../agent/conversation.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildSampleInput(cwd: string): SaveInput {
  const conversation: SessionMessage[] = [
    { role: 'system', content: 'sys', index: 0 },
    { role: 'user', content: 'hi', index: 1 },
    { role: 'assistant', content: 'hello', index: 2 },
  ];
  const todo = addItem(emptyTodoList(), { content: 'ship it' });
  return {
    cwd,
    conversation,
    tokens: 42,
    model: 'gemini-2.5-pro',
    mode: 'BUILD',
    selectedFiles: ['a.ts', 'b.ts'],
    summary: 'demo',
    fixedInstructions: 'be terse',
    todo,
  };
}

test('saveSnapshot returns an id and writes a file under the cwd hash', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const result = saveSnapshot(buildSampleInput(cwd));
    assert.equal(result.ok, true);
    assert.ok(result.id.length > 0);
    assert.match(result.path, /sessions[\\\/][a-f0-9]{32}[\\\/]/);
    assert.ok(fs.existsSync(result.path));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('saveSnapshot + loadSnapshot round-trips every field', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const input = buildSampleInput(cwd);
    const result = saveSnapshot(input);
    assert.equal(result.ok, true);
    const loaded = loadSnapshot(cwd, result.id);
    assert.equal(loaded.ok, true);
    const snap = loaded.snapshot;
    assert.ok(snap);
    assert.equal(snap.version, SNAPSHOT_VERSION);
    assert.equal(snap.kind, SNAPSHOT_KIND);
    assert.equal(snap.id, result.id);
    assert.equal(snap.cwd, cwd);
    assert.equal(snap.tokens, 42);
    assert.equal(snap.model, 'gemini-2.5-pro');
    assert.equal(snap.mode, 'BUILD');
    assert.deepEqual(snap.selectedFiles, ['a.ts', 'b.ts']);
    assert.equal(snap.summary, 'demo');
    assert.equal(snap.fixedInstructions, 'be terse');
    assert.equal(snap.conversation.length, 3);
    assert.equal(snap.conversation[1]?.content, 'hi');
    assert.equal(snap.todo.items.length, 1);
    assert.equal(snap.todo.items[0]?.content, 'ship it');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadSnapshot returns error for unknown id', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const r = loadSnapshot(cwd, 'does-not-exist');
    assert.equal(r.ok, false);
    assert.equal(r.snapshot, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadSnapshot rejects a wrong kind discriminator', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const result = saveSnapshot(buildSampleInput(cwd));
    const file = result.path;
    const raw = fs.readFileSync(file, 'utf-8');
    const tampered = raw.replace(SNAPSHOT_KIND, 'something-else');
    fs.writeFileSync(file, tampered, 'utf-8');
    const r = loadSnapshot(cwd, result.id);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /kind/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadSnapshot rejects a wrong version', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const result = saveSnapshot(buildSampleInput(cwd));
    const file = result.path;
    const raw = fs.readFileSync(file, 'utf-8');
    // `JSON.stringify(..., null, 2)` emits `"version": 1` (with a space).
    const tampered = raw.replace(`"version": ${SNAPSHOT_VERSION}`, '"version": 999');
    fs.writeFileSync(file, tampered, 'utf-8');
    const r = loadSnapshot(cwd, result.id);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /version/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('listSnapshots returns newest-first and skips foreign files', async () => {
  const cwd = mkTmp('snap-test-');
  try {
    const a = saveSnapshot(buildSampleInput(cwd));
    // Force a small gap so the iso timestamp is distinct.
    await new Promise((r) => setTimeout(r, 5));
    const b = saveSnapshot(buildSampleInput(cwd));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // Drop a foreign file in the same directory — must be skipped.
    const dir = path.dirname(a.path);
    fs.writeFileSync(path.join(dir, 'not-a-snapshot.json'), '{}');
    const list = listSnapshots(cwd);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, b.id);
    assert.equal(list[1]?.id, a.id);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('listSnapshots returns [] when no snapshots exist', () => {
  const cwd = mkTmp('snap-test-');
  try {
    assert.deepEqual(listSnapshots(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('makeSnapshotId is unique across rapid calls', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    ids.add(makeSnapshotId());
  }
  assert.equal(ids.size, 50);
});

test('saveSnapshot is atomic — no leftover .tmp file', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const result = saveSnapshot(buildSampleInput(cwd));
    const dir = path.dirname(result.path);
    const stray = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.equal(stray.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('isValidSessionLabel validates label names', () => {
  assert.equal(isValidSessionLabel('my-session.1'), true);
  assert.equal(isValidSessionLabel('accessibility_audit'), true);
  assert.equal(isValidSessionLabel('  valid label with spaces  '), true);
  
  // Invalid cases
  assert.equal(isValidSessionLabel(''), false); // empty
  assert.equal(isValidSessionLabel('a'.repeat(65)), false); // too long
  assert.equal(isValidSessionLabel('session/1'), false); // path separator
  assert.equal(isValidSessionLabel('session\\1'), false); // backslash
  assert.equal(isValidSessionLabel('session; echo bad'), false); // semicolon
  assert.equal(isValidSessionLabel('session$foo'), false); // dollar
  assert.equal(isValidSessionLabel('session`pwd`'), false); // backtick
  assert.equal(isValidSessionLabel(null as any), false); // wrong type
});

test('renameSnapshot atomically updates session label on disk', () => {
  const cwd = mkTmp('snap-test-');
  try {
    const input = buildSampleInput(cwd);
    const result = saveSnapshot(input);
    assert.equal(result.ok, true);

    // Initial load should have no label
    const initial = loadSnapshot(cwd, result.id);
    assert.equal(initial.ok, true);
    assert.equal(initial.snapshot?.label, undefined);

    // Rename
    const renameRes = renameSnapshot(cwd, result.id, 'new-label');
    assert.equal(renameRes.ok, true);
    assert.equal(renameRes.label, 'new-label');

    // Reload and check
    const reloaded = loadSnapshot(cwd, result.id);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.snapshot?.label, 'new-label');

    // Rename with invalid label should fail
    const failRename = renameSnapshot(cwd, result.id, 'bad;label');
    assert.equal(failRename.ok, false);
    assert.match(failRename.error || '', /invalid label/);

    // Reload again and check label remains unchanged
    const reloaded2 = loadSnapshot(cwd, result.id);
    assert.equal(reloaded2.ok, true);
    assert.equal(reloaded2.snapshot?.label, 'new-label');

    // Clear label
    const clearRes = renameSnapshot(cwd, result.id, undefined);
    assert.equal(clearRes.ok, true);
    assert.equal(clearRes.label, undefined);

    const reloaded3 = loadSnapshot(cwd, result.id);
    assert.equal(reloaded3.ok, true);
    assert.equal(reloaded3.snapshot?.label, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('SessionManager.renameSession atomically updates global session label', () => {
  // Mock the sessions directory to avoid writing to ~/.fixocli/sessions
  const tmpDir = mkTmp('sessions-test-');
  const originalGetSessionsDir = SessionManager.getSessionsDir;
  SessionManager.getSessionsDir = () => tmpDir;

  try {
    const conv = new ConversationManager();
    conv.addTurn('hi', 'hello');

    const sessionId = SessionManager.saveSession(
      conv,
      'gemini-2.5-flash',
      ['a.ts'],
      { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    );

    // Initial check
    const list = SessionManager.listSessions();
    const found = list.find((s) => s.sessionId === sessionId);
    assert.ok(found);
    assert.equal(found.label, undefined);

    // Rename
    const ok = SessionManager.renameSession(sessionId, 'my-global-label');
    assert.equal(ok, true);

    // Reload and verify
    const list2 = SessionManager.listSessions();
    const found2 = list2.find((s) => s.sessionId === sessionId);
    assert.ok(found2);
    assert.equal(found2.label, 'my-global-label');

    // Rename non-existent session
    const ok2 = SessionManager.renameSession('non-existent-uuid', 'label');
    assert.equal(ok2, false);
  } finally {
    SessionManager.getSessionsDir = originalGetSessionsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
