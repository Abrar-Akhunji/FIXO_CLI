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
  type SaveInput,
  type SessionMessage,
} from '../runtime/session-snapshots.js';
import { emptyTodoList, addItem } from '../context/todo.js';

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
