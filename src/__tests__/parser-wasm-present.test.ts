import assert from 'node:assert/strict';
import test from 'node:test';
import { TreeSitterAdapter, ParserFactory } from '../agent/parser-adapter.js';

test('TreeSitterAdapter initialises against vendored WASM', async () => {
  ParserFactory.reset();
  const adapter = new TreeSitterAdapter();
  const result = await adapter.init();
  assert.equal(result.ok, true, `init failed: ${result.reason ?? ''}`);
  assert.equal(adapter.supported, true);

  // Confirms the bash grammar was loaded and shell parsing works
  // through tree-sitter rather than the regex fallback.
  const parsed = adapter.parseShellCommand('echo hi && rm -rf ./tmp');
  assert.ok(parsed.length >= 2);
  assert.equal(parsed[0].binary, 'echo');
  assert.equal(parsed[1].binary, 'rm');

  adapter.dispose();
});

test('ParserFactory.getParser returns the tree-sitter adapter when WASM is present', async () => {
  ParserFactory.reset();
  const adapter = await ParserFactory.getParser('tree-sitter');
  assert.equal(adapter.name, 'tree-sitter');
  assert.equal(adapter.supported, true);
  ParserFactory.reset();
});
