import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  extractWriteTargets,
  isCommandSafe,
} from '../agent/command-parser.js';

function makeWorkspace(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-bypass-'));
  // Mimic the platform layout that triggers PlatformPathLockedError.
  fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'src', 'components', 'BookingCTA.jsx'), '');
  return tmp;
}

test('extractWriteTargets — `cat > file` redirect', () => {
  const ts = extractWriteTargets("cat > src/components/BookingCTA.jsx << 'EOF'\nhi\nEOF");
  assert.ok(ts.some((t) => t.kind === 'redirect' && t.path === 'src/components/BookingCTA.jsx'));
});

test('extractWriteTargets — `>>` append redirect', () => {
  const ts = extractWriteTargets('echo line >> src/log.txt');
  assert.ok(ts.some((t) => t.kind === 'redirect' && t.path === 'src/log.txt'));
});

test('extractWriteTargets — `tee` writes', () => {
  const ts = extractWriteTargets('echo hi | tee -a src/log.txt other.txt');
  const paths = ts.filter((t) => t.kind === 'tee').map((t) => t.path).sort();
  assert.deepEqual(paths, ['other.txt', 'src/log.txt']);
});

test('extractWriteTargets — `sed -i` in-place', () => {
  const ts = extractWriteTargets("sed -i 's/foo/bar/' src/index.ts");
  assert.ok(ts.some((t) => t.kind === 'sed-in-place' && t.path === 'src/index.ts'));
});

test('extractWriteTargets — `mv` destination', () => {
  const ts = extractWriteTargets('mv old.ts src/new.ts');
  assert.ok(ts.some((t) => t.kind === 'mv-cp-dest' && t.path === 'src/new.ts'));
});

test('extractWriteTargets — `python3 -c "open(X, \'w\')"`', () => {
  const cmd = `python3 -c "open('src/components/BookingCTA.jsx','w').write('hi')"`;
  const ts = extractWriteTargets(cmd);
  assert.ok(
    ts.some(
      (t) =>
        t.kind === 'interpreter-script' &&
        t.via === 'python3' &&
        t.path === 'src/components/BookingCTA.jsx',
    ),
  );
});

test('extractWriteTargets — `python3 << PYEOF` heredoc smuggling write', () => {
  const cmd = [
    "python3 << 'PYEOF'",
    "open('src/components/BookingCTA.jsx', 'w').write('content')",
    'PYEOF',
  ].join('\n');
  const ts = extractWriteTargets(cmd);
  assert.ok(
    ts.some(
      (t) => t.kind === 'interpreter-script' && t.path === 'src/components/BookingCTA.jsx',
    ),
  );
});

test('extractWriteTargets — `node -e "fs.writeFileSync(X, ...)"`', () => {
  const cmd = `node -e "require('fs').writeFileSync('src/index.ts', 'x')"`;
  const ts = extractWriteTargets(cmd);
  assert.ok(
    ts.some(
      (t) => t.kind === 'interpreter-script' && t.via === 'node' && t.path === 'src/index.ts',
    ),
  );
});

test('extractWriteTargets — does not flag fd duplications like `2>&1`', () => {
  const ts = extractWriteTargets('npm test 2>&1 | tee out.log');
  for (const t of ts) {
    assert.notEqual(t.path, '&1');
  }
});

test('extractWriteTargets — ignores /dev/null', () => {
  const ts = extractWriteTargets('rm -rf node_modules > /dev/null 2>&1');
  for (const t of ts) {
    assert.ok(!t.path.startsWith('/dev/'));
  }
});

test('isCommandSafe blocks `cat > src/components/X.jsx` (platform path lock)', async () => {
  const ws = makeWorkspace();
  const result = await isCommandSafe(
    "cat > src/components/BookingCTA.jsx << 'EOF'\nhi\nEOF",
    ws,
  );
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /Fixo CLI core architecture/);
});

test('isCommandSafe blocks `python3 -c open(X, "w")` against platform path', async () => {
  const ws = makeWorkspace();
  const result = await isCommandSafe(
    `python3 -c "open('src/components/BookingCTA.jsx','w').write('x')"`,
    ws,
  );
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /Fixo CLI core architecture/);
});

test('isCommandSafe blocks `sed -i` against platform src file', async () => {
  const ws = makeWorkspace();
  // Ensure target file exists so the path resolves cleanly.
  fs.writeFileSync(path.join(ws, 'src', 'index.ts'), '');
  const result = await isCommandSafe("sed -i '' 's/foo/bar/' src/index.ts", ws);
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /sed -i in-place edit/);
});

test('isCommandSafe blocks `tee` against package.json', async () => {
  const ws = makeWorkspace();
  const result = await isCommandSafe('echo {} | tee package.json', ws);
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /Fixo CLI core architecture/);
});

test('isCommandSafe blocks `mv` whose destination is a platform file', async () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, 'tmp.json'), '{}');
  const result = await isCommandSafe('mv tmp.json package.json', ws);
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /Fixo CLI core architecture/);
});

test('isCommandSafe blocks heredoc-smuggled write into platform path', async () => {
  const ws = makeWorkspace();
  const cmd = [
    "python3 << 'PYEOF'",
    "open('src/components/BookingCTA.jsx', 'w').write('x')",
    'PYEOF',
  ].join('\n');
  const result = await isCommandSafe(cmd, ws);
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /Fixo CLI core architecture/);
});

test('isCommandSafe blocks redirect that escapes the workspace', async () => {
  const ws = makeWorkspace();
  const result = await isCommandSafe('echo hi > /etc/passwd', ws);
  assert.equal(result.safe, false);
  assert.match(result.reason ?? '', /outside the workspace/);
});

test('isCommandSafe still allows benign in-workspace redirect to non-platform path', async () => {
  const ws = makeWorkspace();
  fs.mkdirSync(path.join(ws, 'logs'), { recursive: true });
  const result = await isCommandSafe('echo hi > logs/today.log', ws);
  assert.equal(result.safe, true);
});

test('isCommandSafe still allows ordinary read commands', async () => {
  const ws = makeWorkspace();
  const result = await isCommandSafe('grep -r foo src/', ws);
  assert.equal(result.safe, true);
});
