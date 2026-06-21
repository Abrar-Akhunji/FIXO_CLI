/**
 * lsp-context-assembly.test.ts — Phase 3.2 acceptance test.
 *
 * Proves the contract: gatherReferencesForTargets() returns a
 * well-formed markdown block when references are available, and a
 * clean empty string in every "LSP unavailable / no targets"
 * scenario. The empty-string cases are the important
 * not-break-the-world contract — single-agent.ts splices the result
 * unconditionally into the system prompt.
 *
 * Avoids depending on a real language server being on $PATH (CI
 * runners + dev machines vary). The LspManager dependency is
 * injected via the getLspManager callback so the tests stub it
 * with a fake findReferences().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gatherReferencesForTargets } from '../agent/context-builder.js';
import type { LspManager } from '../lsp/lsp-manager.js';

function mkWorkspace(files: Record<string, string>): { cwd: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-lsp-ctx-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return {
    cwd,
    cleanup: () => {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function fakeLsp(refs: Array<{ uri: string; line: number }>): LspManager {
  return {
    async findReferences() {
      return refs.map((r) => ({
        uri: r.uri,
        range: { start: { line: r.line, character: 0 } },
      }));
    },
  } as unknown as LspManager;
}

test('gatherReferencesForTargets — no targets means clean empty string', async () => {
  const out = await gatherReferencesForTargets('/tmp', [], () => fakeLsp([]));
  assert.equal(out, '', 'empty targets must return empty string');
});

test('gatherReferencesForTargets — no LSP manager available means clean empty string (not an error)', async () => {
  const ws = mkWorkspace({ 'lib.ts': 'export function foo() {}\n' });
  try {
    const out = await gatherReferencesForTargets(
      ws.cwd,
      [{ file: path.join(ws.cwd, 'lib.ts') }],
      () => null, // LSP simply isn't present
    );
    assert.equal(out, '');
  } finally {
    ws.cleanup();
  }
});

test('gatherReferencesForTargets — target file that does not exist is skipped, no crash', async () => {
  const out = await gatherReferencesForTargets(
    '/tmp',
    [{ file: '/tmp/this-file-does-not-exist-xyz.ts' }],
    () => fakeLsp([]),
  );
  assert.equal(out, '');
});

test('gatherReferencesForTargets — references in OTHER files are formatted into a markdown block', async () => {
  const ws = mkWorkspace({
    'src/lib.ts': 'export function foo() {}\n',
    'src/a.ts':   'foo();\n',
    'src/b.ts':   'foo();\nfoo();\n',
  });
  try {
    const out = await gatherReferencesForTargets(
      ws.cwd,
      [{ file: path.join(ws.cwd, 'src', 'lib.ts'), symbols: ['foo'] }],
      () => fakeLsp([
        { uri: 'file://' + path.join(ws.cwd, 'src', 'a.ts'), line: 0 },
        { uri: 'file://' + path.join(ws.cwd, 'src', 'b.ts'), line: 0 },
        { uri: 'file://' + path.join(ws.cwd, 'src', 'b.ts'), line: 1 },
      ]),
    );
    assert.match(out, /Cross-file references/);
    assert.match(out, /\bfoo\b/);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /src\/b\.ts/);
  } finally {
    ws.cleanup();
  }
});

test('gatherReferencesForTargets — references in the origin file itself are filtered out', async () => {
  const ws = mkWorkspace({
    'lib.ts': 'export function foo() {}\nfoo();\n', // self-ref
  });
  try {
    const out = await gatherReferencesForTargets(
      ws.cwd,
      [{ file: path.join(ws.cwd, 'lib.ts'), symbols: ['foo'] }],
      () => fakeLsp([
        { uri: 'file://' + path.join(ws.cwd, 'lib.ts'), line: 1 }, // self
      ]),
    );
    // Only self-references → empty result (caller already sees own file)
    assert.equal(out, '');
  } finally {
    ws.cleanup();
  }
});

test('gatherReferencesForTargets — LSP findReferences that hangs is bounded by timeout', async () => {
  const ws = mkWorkspace({ 'lib.ts': 'export function foo() {}\n' });
  const slowLsp = {
    async findReferences() {
      // Forever — must be cut off by the internal timeout.
      return await new Promise(() => { /* never resolves */ });
    },
  } as unknown as LspManager;
  try {
    const before = Date.now();
    const out = await gatherReferencesForTargets(
      ws.cwd,
      [{ file: path.join(ws.cwd, 'lib.ts'), symbols: ['foo'] }],
      () => slowLsp,
    );
    const elapsed = Date.now() - before;
    assert.equal(out, '', 'timed-out LSP call must produce no references');
    assert.ok(elapsed < 5000, `must time out well under 5s, got ${elapsed}ms`);
  } finally {
    ws.cleanup();
  }
});
