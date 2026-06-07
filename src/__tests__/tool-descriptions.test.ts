/**
 * tool-descriptions.test.ts — Phase 1 (Edit-Semantics Steering) regression guard.
 *
 * The reactive tool surface tells weaker models (Groq / GLM / Gemini-Flash)
 * how to behave. If a future refactor silently strips the steering
 * language from `write_file` or `str_replace`, the model will drift back
 * to rewriting whole files. These tests lock the steering substrings in
 * place so any future loss is a build failure, not a quiet regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getActiveTools } from '../agent/tool-executor.js';

function findTool(name: string) {
  const tools = getActiveTools('BUILD');
  const def = tools.find((t) => t.function.name === name);
  assert.ok(def, `expected tool '${name}' to be active in BUILD mode`);
  return def!;
}

test('write_file description steers existing-file edits to str_replace', () => {
  const def = findTool('write_file');
  const desc = def.function.description ?? '';
  // The steering must explicitly point the model at str_replace.
  assert.match(
    desc,
    /str_replace/,
    'write_file description must mention str_replace as the preferred edit path',
  );
  assert.match(
    desc,
    /apply_patch/,
    'write_file description must mention apply_patch for multi-region edits',
  );
  // The "new files or full rewrites" framing is the green-light scope.
  assert.match(
    desc,
    /new files? or full rewrites?/i,
    'write_file description must reserve its use for new files or full rewrites',
  );
});

test('str_replace description positions itself as the default edit tool', () => {
  const def = findTool('str_replace');
  const desc = def.function.description ?? '';
  assert.match(
    desc,
    /default for any in-place edit/i,
    'str_replace description must claim the default-edit slot for the model',
  );
  // Uniqueness contract is part of the steering — non-unique matches
  // must be communicated up-front so the model writes narrow snippets.
  assert.match(
    desc,
    /unique/i,
    'str_replace description must surface the uniqueness contract',
  );
});

test('tool descriptions remain below the per-tool budget cap (800 chars)', () => {
  // Per the Phase 1 plan: keep individual descriptions terse so we
  // do not blow the model's tool-schema budget. 800 is a soft cap
  // we picked during planning; if a future change exceeds it, the
  // author should split the description or move detail to the
  // system prompt's Editing Discipline block.
  for (const name of ['write_file', 'str_replace']) {
    const def = findTool(name);
    const desc = def.function.description ?? '';
    assert.ok(
      desc.length <= 800,
      `${name} description is ${desc.length} chars; cap is 800. ` +
        `Move detail to the Editing Discipline block in single-agent.ts instead.`,
    );
  }
});
