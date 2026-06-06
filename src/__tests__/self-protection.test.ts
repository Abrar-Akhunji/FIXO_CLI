/**
 * Pillar 5 / Protection 1 — Platform-Path Lock.
 *
 * Verifies that the WorkspaceGuard refuses to resolve any
 * target that lands on a platform runtime file. The list of
 * locked paths is `src/**`, `package.json`, `package-lock.json`,
 * `tsconfig*.json`, `dist/**`, `node_modules/**`.
 *
 * The protection is the direct response to the LLM
 * autonomously corrupting `src/agent/tool-executor.ts` on
 * this branch: a `try { ... } catch` block was pasted into
 * the middle of an unrelated function and the build broke
 * with `ERROR: Unexpected "catch"`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  WorkspaceGuard,
  PlatformPathLockedError,
} from '../workspace-guard.js';

function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixo-platform-lock-'));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents, 'utf-8');
  }
  return dir;
}

test('isPlatformPath recognises src/, package.json, tsconfig*.json, dist/, node_modules/', () => {
  assert.equal(WorkspaceGuard.isPlatformPath('src/agent/tool-executor.ts'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('src/index.ts'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('package.json'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('package-lock.json'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('tsconfig.json'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('tsconfig.build.json'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('dist/index.js'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('node_modules/tsx/package.json'), true);
});

test('isPlatformPath is case-insensitive (Finder/Explorer rename silently)', () => {
  assert.equal(WorkspaceGuard.isPlatformPath('SRC/agent/tool-executor.ts'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('Package.json'), true);
  assert.equal(WorkspaceGuard.isPlatformPath('TSCOnfig.json'), true);
});

test('isPlatformPath allows regular project files', () => {
  assert.equal(WorkspaceGuard.isPlatformPath('README.md'), false);
  assert.equal(WorkspaceGuard.isPlatformPath('docs/spec.md'), false);
  assert.equal(WorkspaceGuard.isPlatformPath('tests/sample.test.ts'), false);
  assert.equal(WorkspaceGuard.isPlatformPath('app/routes.ts'), false);
});

test('assertNotPlatformPath throws PlatformPathLockedError on locked targets', () => {
  const cwd = makeWorkspace();
  try {
    const guard = new WorkspaceGuard(cwd);
    assert.throws(
      () => guard.assertNotPlatformPath('src/agent/tool-executor.ts'),
      (err: unknown) => {
        assert.ok(err instanceof PlatformPathLockedError);
        assert.match((err as Error).message, /Fixo CLI core architecture/);
        return true;
      },
    );
  } finally {
    // mkdtempSync directories are auto-cleaned by the OS
  }
});

test('assertNotPlatformPath does not throw on regular project files', () => {
  const cwd = makeWorkspace();
  const guard = new WorkspaceGuard(cwd);
  assert.doesNotThrow(() => guard.assertNotPlatformPath('README.md'));
  assert.doesNotThrow(() => guard.assertNotPlatformPath('app/routes.ts'));
});

test('PlatformPathLockedError carries a useful message with the offending path', () => {
  const cwd = makeWorkspace();
  const guard = new WorkspaceGuard(cwd);
  try {
    guard.assertNotPlatformPath('package.json');
    assert.fail('should have thrown');
  } catch (err: unknown) {
    assert.ok(err instanceof PlatformPathLockedError);
    const msg = (err as Error).message;
    assert.match(msg, /package\.json/);
    assert.match(msg, /Fixo CLI core architecture/);
  }
});

test('Absolute paths that resolve under src/ are also locked', () => {
  const cwd = makeWorkspace();
  const guard = new WorkspaceGuard(cwd);
  const absolute = join(cwd, 'src', 'planner.ts');
  try {
    guard.assertNotPlatformPath(absolute);
    assert.fail('should have thrown');
  } catch (err: unknown) {
    assert.ok(err instanceof PlatformPathLockedError);
  }
});

test('Paths that merely *contain* the substring "src" are not falsely locked', () => {
  // `resource/hello.txt` should not match the `src/**` pattern.
  assert.equal(WorkspaceGuard.isPlatformPath('resource/hello.txt'), false);
  assert.equal(WorkspaceGuard.isPlatformPath('user-src/file.ts'), false);
  assert.equal(WorkspaceGuard.isPlatformPath('subsrc/file.ts'), false);
});
