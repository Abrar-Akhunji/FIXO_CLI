import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeStrReplace, type StrReplaceArgs } from '../agent/tool-executor.js';
import { AtomicStagingManager } from '../runtime/staging.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-surgical-'));
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

function writeFixture(cwd: string, relPath: string, content: string): string {
  const abs = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

/* ------------------------------------------------------------------ */
/* Case 1: happy-path unique replacement                              */
/* ------------------------------------------------------------------ */

test('str_replace — unique string is replaced and old content is gone', async () => {
  await withTempCwd(async (cwd) => {
    const target = writeFixture(cwd, 'example.ts', 'const greeting = "hello";\n');
    const args: StrReplaceArgs = {
      path: 'example.ts',
      oldString: 'const greeting = "hello";',
      newString: 'const greeting = "howdy";',
    };
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    assert.equal(result.startsWith('Error:'), false, result);
    const parsed = JSON.parse(result) as { ok: boolean; path: string; occurrences: number; bytes: number };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.path, 'example.ts');
    assert.equal(parsed.occurrences, 1);
    assert.ok(parsed.bytes > 0);
    const onDisk = fs.readFileSync(target, 'utf-8');
    assert.equal(onDisk, 'const greeting = "howdy";\n');
    // Old string is gone.
    assert.equal(onDisk.includes('hello'), false);
  });
});

/* ------------------------------------------------------------------ */
/* Case 2: ambiguity rejection                                         */
/* ------------------------------------------------------------------ */

test('str_replace — multiple matches with expectUnique=true aborts cleanly', async () => {
  await withTempCwd(async (cwd) => {
    writeFixture(cwd, 'dup.ts', 'x = 1\nx = 2\nx = 3\n');
    const args: StrReplaceArgs = {
      path: 'dup.ts',
      oldString: 'x = ',
      newString: 'y = ',
      // expectUnique default is true
    };
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    assert.match(result, /appears 3 times/);
    // The file must be untouched.
    assert.equal(fs.readFileSync(path.join(cwd, 'dup.ts'), 'utf-8'), 'x = 1\nx = 2\nx = 3\n');
  });
});

test('str_replace — replaceAll=true substitutes every occurrence', async () => {
  await withTempCwd(async (cwd) => {
    const target = writeFixture(cwd, 'dup.ts', 'x = 1\nx = 2\nx = 3\n');
    const args: StrReplaceArgs = {
      path: 'dup.ts',
      oldString: 'x = ',
      newString: 'y = ',
      replaceAll: true,
    };
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    assert.equal(result.startsWith('Error:'), false, result);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'y = 1\ny = 2\ny = 3\n');
  });
});

/* ------------------------------------------------------------------ */
/* Case 3: PLAN mode rejection                                         */
/* ------------------------------------------------------------------ */

test('str_replace — PLAN mode is rejected with a structured error', async () => {
  await withTempCwd(async (cwd) => {
    const target = writeFixture(cwd, 'plan.ts', 'original\n');
    const args: StrReplaceArgs = {
      path: 'plan.ts',
      oldString: 'original',
      newString: 'changed',
    };
    const result = await executeStrReplace(args, cwd, { mode: 'PLAN' });
    assert.match(result, /PLAN mode/);
    // File must be untouched.
    assert.equal(fs.readFileSync(target, 'utf-8'), 'original\n');
  });
});

/* ------------------------------------------------------------------ */
/* Case 4: workspace escape is blocked                                 */
/* ------------------------------------------------------------------ */

test('str_replace — relative escape (../../etc/passwd) is rejected', async () => {
  await withTempCwd(async (cwd) => {
    const args: StrReplaceArgs = {
      path: '../../etc/passwd',
      oldString: 'root:x:',
      newString: 'pwned',
    };
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    assert.match(result, /escapes workspace/);
  });
});

test('str_replace — platform-locked path is rejected', async () => {
  await withTempCwd(async (cwd) => {
    const args: StrReplaceArgs = {
      path: 'package.json',
      oldString: '"name":',
      newString: '"name":',
    };
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    assert.match(result, /strictly prohibited/);
  });
});

/* ------------------------------------------------------------------ */
/* Case 5: transactional safety — .pending.bak rollback                */
/* ------------------------------------------------------------------ */

test('str_replace — atomic swap preserves original on fs.renameSync failure', async () => {
  await withTempCwd(async (cwd) => {
    const target = writeFixture(cwd, 'atomic.txt', 'before\n');
    const staging = new AtomicStagingManager(cwd, 'r-atomic');

    // Force the rename to fail by intercepting fs.renameSync on the
    // .pending → target path. The staging manager's rollback path
    // must restore from `.pending.bak`.
    const realRename = fs.renameSync;
    let renameAttempts = 0;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = (
      src: fs.PathLike,
      dest: fs.PathLike,
    ) => {
      const srcStr = String(src);
      if (srcStr.endsWith('.pending') && String(dest).endsWith('atomic.txt')) {
        renameAttempts += 1;
        throw new Error('simulated disk failure');
      }
      return realRename(src, dest);
    };

    try {
      await assert.rejects(
        () => staging.applySurgicalReplace('atomic.txt', 'after', {
          runId: 'r-atomic',
          reason: 'str_replace',
          actorId: 'test',
        }),
        /simulated disk failure/,
      );
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    }

    // Original content preserved.
    assert.equal(fs.readFileSync(target, 'utf-8'), 'before\n');
    // Backup file is consumed (cleaned up) after a successful rollback path
    // or remains in place for human recovery; we only assert the original
    // is intact.
    assert.equal(renameAttempts, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Case 6: large file + multi-byte UTF-8 boundary                      */
/* ------------------------------------------------------------------ */

test('str_replace — handles a 10MB file and multi-byte UTF-8 boundaries', async () => {
  await withTempCwd(async (cwd) => {
    // Compose a 10 MiB file with a known UTF-8 multi-byte anchor.
    // Each Chinese character is 3 bytes in UTF-8; we use a 2 MiB block
    // of Chinese characters and repeat it 5 times so the file is
    // ~10 MiB.
    const block = '你好世界'.repeat(2_000_000 / 6); // ~2 MiB
    const target = path.join(cwd, 'big.txt');
    fs.writeFileSync(target, block + '\n' + block + '\n' + block + '\n' + block + '\n' + block + '\n', 'utf-8');

    // Anchor on a multi-byte substring that is unique to the file
    // (not a prefix of the replacement).
    const oldString = '你好世界';
    const newString = '你好世界你好世界你好世界'; // different, longer
    const args: StrReplaceArgs = {
      path: 'big.txt',
      oldString,
      newString,
      replaceAll: true,
    };

    const t0 = Date.now();
    const result = await executeStrReplace(args, cwd, { mode: 'BUILD' });
    const elapsed = Date.now() - t0;
    assert.equal(result.startsWith('Error:'), false, result);

    // The new string is now the longer form.
    const after = fs.readFileSync(target, 'utf-8');
    const occurrences = countOccurrences(after, newString);
    assert.ok(occurrences >= 5, `expected >=5 occurrences of the new string, got ${occurrences}`);

    // Soft performance budget — 5s is a generous ceiling for an
    // in-memory split/join of a 10 MiB string.
    assert.ok(elapsed < 5000, `replaceAll on 10 MiB took ${elapsed}ms`);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}
