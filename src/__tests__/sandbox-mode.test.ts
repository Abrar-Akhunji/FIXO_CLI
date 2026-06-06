/**
 * Pillar 5 / Protection 3 — LSP Strict Fallback.
 *
 * The `sandbox-mock` mode of `LspPreSaveGate` is the second
 * layer of defence for the failure mode that caused this
 * branch: an LLM autonomously corrupted tool-executor.ts.
 *
 * With `sandbox-mock`, when no language server is available
 * the gate refuses to commit the write. The operator must
 * either install a real LSP (typescript-language-server,
 * pyright, etc.) or set the mode to `off` to disable
 * validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LspPreSaveGate,
  LspPreSaveBlockedError,
  type LspDiagnosticsProvider,
} from '../lsp/lsp-pre-save.js';
import type { StagedWrite } from '../runtime/staging.js';

function makeEntry(): StagedWrite {
  return {
    id: 'test',
    targetPath: '/workspace/src/example.ts',
    pendingPath: '/workspace/.fixo/staging/test/example.ts',
    metaPath: '/workspace/.fixo/staging/test/example.ts.meta.json',
    createdAt: Date.now(),
    mode: 0o644,
  };
}

const emptyProvider: LspDiagnosticsProvider = async () => [];

test('sandbox-mock mode blocks when no language server is available', async () => {
  const gate = new LspPreSaveGate({
    mode: 'sandbox-mock',
    provider: emptyProvider,
    hasLanguageServer: () => false,
  });
  const entry = makeEntry();
  const result = await gate.check(entry);
  assert.equal(result.state, 'no-language-server');
  assert.throws(
    () => gate.enforce(result, entry),
    (err: unknown) => err instanceof LspPreSaveBlockedError,
  );
});

test('sandbox-mock mode allows the write when a real LSP returns no diagnostics', async () => {
  const gate = new LspPreSaveGate({
    mode: 'sandbox-mock',
    provider: emptyProvider,
    hasLanguageServer: () => true,
  });
  const entry = makeEntry();
  const result = await gate.check(entry);
  assert.equal(result.state, 'ok');
  assert.doesNotThrow(() => gate.enforce(result, entry));
});

test('sandbox-mock mode allows warnings (does not block on warnings)', async () => {
  const warnProvider: LspDiagnosticsProvider = async () => [
    {
      severity: 'warning',
      message: 'unused variable',
      line: 1,
      column: 1,
      source: 'ts',
      code: 'no-unused-vars',
    },
  ];
  const gate = new LspPreSaveGate({
    mode: 'sandbox-mock',
    provider: warnProvider,
    hasLanguageServer: () => true,
  });
  const entry = makeEntry();
  const result = await gate.check(entry);
  assert.equal(result.state, 'diagnostics');
  assert.equal(result.errorCount, 0);
  assert.doesNotThrow(() => gate.enforce(result, entry));
});

test('sandbox-mock blocked error message tells the user how to install an LSP or opt out', async () => {
  const gate = new LspPreSaveGate({
    mode: 'sandbox-mock',
    provider: emptyProvider,
    hasLanguageServer: () => false,
  });
  const entry = makeEntry();
  const result = await gate.check(entry);
  try {
    gate.enforce(result, entry);
    assert.fail('expected throw');
  } catch (err: unknown) {
    assert.ok(err instanceof LspPreSaveBlockedError);
    const diagnostics = (err as LspPreSaveBlockedError).diagnostics;
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /sandbox-mock/);
    assert.match(
      diagnostics[0].message,
      /typescript-language-server|pyright|preferences\.safety\.lspPreSave/,
    );
  }
});
