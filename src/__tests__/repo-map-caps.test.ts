/**
 * repo-map-caps.test.ts — Phase 3.3 acceptance test.
 *
 * Proves the recursion-depth and per-directory file caps in
 * `buildRepoMap` can be overridden by the caller. Each case
 * constructs a workspace that intentionally exceeds the default
 * caps, then runs `buildRepoMap` first with defaults (must truncate)
 * and again with an explicit higher cap (must include the
 * previously-truncated content).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRepoMap } from '../agent/repo-map.js';

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function touch(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', 'utf-8');
}

test('buildRepoMap — maxDepth override exposes nested directories the default cap truncates', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-repo-map-depth-'));
  try {
    // /a/b/c/d/e/f/g/deep-leaf.txt — 8 levels deep.
    // Default cap is 4, so `deep-leaf.txt` MUST not appear by default.
    mkdir(path.join(cwd, 'a', 'b', 'c', 'd', 'e', 'f', 'g'));
    touch(path.join(cwd, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'deep-leaf.txt'));

    const defaultMap = await buildRepoMap(cwd);
    assert.equal(
      defaultMap.includes('deep-leaf.txt'),
      false,
      `default depth cap should hide deep-leaf.txt, got:\n${defaultMap}`,
    );

    const expandedMap = await buildRepoMap(cwd, { maxDepth: 10 });
    assert.equal(
      expandedMap.includes('deep-leaf.txt'),
      true,
      `maxDepth: 10 should expose deep-leaf.txt, got:\n${expandedMap}`,
    );
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('buildRepoMap — maxFiles override raises the per-directory file cap', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-repo-map-files-'));
  try {
    // 250 files in a single flat directory.
    // Default cap is 200, so file-249.txt MUST not appear by default.
    for (let i = 0; i < 250; i++) {
      const name = `file-${String(i).padStart(3, '0')}.txt`;
      touch(path.join(cwd, name));
    }

    const defaultMap = await buildRepoMap(cwd);
    assert.equal(
      defaultMap.includes('file-249.txt'),
      false,
      'default maxFiles cap should hide file-249.txt',
    );

    const expandedMap = await buildRepoMap(cwd, { maxFiles: 500 });
    assert.equal(
      expandedMap.includes('file-249.txt'),
      true,
      `maxFiles: 500 should expose file-249.txt`,
    );
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('buildRepoMap — legacy positional excludes argument still works (back-compat)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-repo-map-legacy-'));
  try {
    mkdir(path.join(cwd, 'public'));
    touch(path.join(cwd, 'public', 'a.txt'));
    mkdir(path.join(cwd, 'secret'));
    touch(path.join(cwd, 'secret', 'b.txt'));

    // Old call shape: second positional arg is the excludes array.
    const map = await buildRepoMap(cwd, ['secret']);
    assert.equal(map.includes('a.txt'), true);
    assert.equal(map.includes('secret'), false, 'excluded dir name must not appear');
    assert.equal(map.includes('b.txt'), false, 'file inside excluded dir must not appear');
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
