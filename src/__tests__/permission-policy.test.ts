/**
 * Tests for the pattern-based permission engine (§3.5).
 *
 * We exercise:
 *   - globToRegExp: glob → RegExp
 *   - parseRulePattern: `Tool(glob)` parsing
 *   - buildArgString: tool-arg projection
 *   - matchPermission: first-match-wins lookup
 *   - checkPermission: rule → default-ask → fallback-policy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildArgString,
  checkPermission,
  getPermissionsPath,
  globToRegExp,
  loadPermissionsFile,
  matchPermission,
  NEW_TOOL_DEFAULT_ASK,
  parseRulePattern,
  savePermissionsFile,
  type PermissionRule,
  type PermissionsFile,
} from '../agent/permissions.js';

function mkTmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perms-test-'));
}

test('globToRegExp: `*` matches any non-slash chars', () => {
  const re = globToRegExp('*.ts');
  assert.equal(re.test('a.ts'), true);
  assert.equal(re.test('foo/bar.ts'), false, '* does not cross /');
  assert.equal(re.test('a.js'), false);
});

test('globToRegExp: `**` matches across slashes', () => {
  const re = globToRegExp('src/**/*.ts');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/sub/b.ts'), true);
  assert.equal(re.test('lib/a.ts'), false);
});

test('globToRegExp: `?` matches a single non-slash char', () => {
  const re = globToRegExp('a?c');
  assert.equal(re.test('abc'), true);
  assert.equal(re.test('a/c'), false);
  assert.equal(re.test('ac'), false);
});

test('globToRegExp: special regex chars are escaped', () => {
  const re = globToRegExp('a.b+c');
  assert.equal(re.test('a.b+c'), true);
  assert.equal(re.test('a-b-c'), false, '. should not match -');
  assert.equal(re.test('axbxc'), false, '+ should not match x');
});

test('parseRulePattern: Tool(arg-glob)', () => {
  assert.deepEqual(parseRulePattern('Bash(npm test:*)'), { tool: 'Bash', argPattern: 'npm test:*' });
  assert.deepEqual(parseRulePattern('Edit(src/**/*.ts)'), { tool: 'Edit', argPattern: 'src/**/*.ts' });
});

test('parseRulePattern: tool-only pattern', () => {
  assert.deepEqual(parseRulePattern('Bash'), { tool: 'Bash', argPattern: null });
});

test('parseRulePattern: malformed input returns safe fallback', () => {
  // A pattern with no tool name shouldn't crash.
  const r = parseRulePattern('(foo)');
  assert.equal(typeof r.tool, 'string');
});

test('buildArgString: prefers `path` for path-shaped tools', () => {
  assert.equal(buildArgString('write_file', { path: 'a.ts', content: 'x' }), 'a.ts');
  assert.equal(buildArgString('write_file', { filePath: 'b.ts' }), 'b.ts');
  assert.equal(buildArgString('run_command', { cmd: 'npm test' }), 'npm test');
  assert.equal(buildArgString('run_command', { command: 'echo hi' }), 'echo hi');
});

test('buildArgString: falls back to joined arg values', () => {
  assert.equal(buildArgString('random_tool', { a: 1, b: 'two', c: true }), '1 two true');
});

test('matchPermission: first-match-wins', () => {
  const rules: PermissionRule[] = [
    { pattern: 'Bash(*)', decision: 'ask' },
    { pattern: 'Bash(npm test:*)', decision: 'allow' },
  ];
  const m = matchPermission('Bash', { cmd: 'npm test --watch' }, rules);
  assert.equal(m?.decision, 'ask', 'first rule wins, even though second would allow');
});

test('matchPermission: tool-name must match exactly', () => {
  const rules: PermissionRule[] = [{ pattern: 'Bash(*)', decision: 'allow' }];
  assert.equal(matchPermission('Edit', { path: 'a.ts' }, rules), null);
});

test('matchPermission: tool-only pattern matches any args', () => {
  const rules: PermissionRule[] = [{ pattern: 'Read', decision: 'allow' }];
  assert.ok(matchPermission('Read', { path: 'whatever.ts' }, rules));
});

test('matchPermission: malformed glob is skipped, not crash', () => {
  // Unclosed bracket → invalid regex. We expect the matcher
  // to skip the rule and try the next one.
  const rules: PermissionRule[] = [
    { pattern: 'Bash([)', decision: 'allow' },
    { pattern: 'Bash(*)', decision: 'deny' },
  ];
  const m = matchPermission('Bash', { cmd: 'x' }, rules);
  assert.equal(m?.decision, 'deny');
});

test('checkPermission: rule hit short-circuits', () => {
  const cwd = mkTmpCwd();
  try {
    savePermissionsFile(cwd, {
      version: 1,
      rules: [{ pattern: 'Bash(npm test*)', decision: 'allow', reason: 'safe test' }],
    });
    const r = checkPermission('Bash', { cmd: 'npm test' }, cwd, 'shell-confirm');
    assert.equal(r.decision, 'allow');
    assert.equal(r.matchedRule, 'Bash(npm test*)');
    assert.equal(r.source, 'rule');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: deny rule wins over default-ask for new tools', () => {
  const cwd = mkTmpCwd();
  try {
    savePermissionsFile(cwd, {
      version: 1,
      rules: [{ pattern: 'str_replace(*)', decision: 'deny', reason: 'too risky' }],
    });
    const r = checkPermission('str_replace', { path: 'a.ts' }, cwd, 'shell-confirm');
    assert.equal(r.decision, 'deny');
    assert.equal(r.source, 'rule');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: new tool with no rule → default-ask', () => {
  const cwd = mkTmpCwd();
  try {
    // No permissions file at all.
    const r = checkPermission('str_replace', { path: 'a.ts' }, cwd, 'shell-confirm');
    assert.equal(r.decision, 'ask');
    assert.equal(r.source, 'default-ask');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: new-tool default-ask list is locked', () => {
  // Sanity: the set is what the PRD mandates.
  const expected = [
    'str_replace',
    'glob_files',
    'todo_write',
    'run_command_async',
    'poll_command_status',
    'kill_command',
  ];
  for (const t of expected) {
    assert.ok(NEW_TOOL_DEFAULT_ASK.has(t), `${t} should default-ask`);
  }
});

test('checkPermission: legacy tool with no rule → fallback-policy', () => {
  const cwd = mkTmpCwd();
  try {
    // `read_file` is not a new tool, so the default-ask
    // branch is skipped and decidePolicy runs.
    const r = checkPermission('read_file', { path: 'a.ts' }, cwd, 'shell-confirm');
    assert.equal(r.source, 'fallback-policy');
    assert.equal(r.decision, 'allow', 'read actions are allowed by decidePolicy');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: dangerous-deny profile → deny via fallback', () => {
  const cwd = mkTmpCwd();
  try {
    const r = checkPermission('read_file', { path: 'a.ts' }, cwd, 'dangerous-deny');
    assert.equal(r.decision, 'deny');
    assert.equal(r.source, 'fallback-policy');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: high-risk command → ask via fallback', () => {
  const cwd = mkTmpCwd();
  try {
    const r = checkPermission('run_command', { cmd: 'rm -rf /tmp/x' }, cwd, 'shell-confirm');
    // rm -rf is a high-risk command; shell-confirm needs
    // confirmation, so decision is `ask`.
    assert.equal(r.decision, 'ask');
    assert.equal(r.source, 'fallback-policy');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('savePermissionsFile + loadPermissionsFile roundtrip', () => {
  const cwd = mkTmpCwd();
  try {
    const file: PermissionsFile = {
      version: 1,
      rules: [
        { pattern: 'Bash(*)', decision: 'ask' },
        { pattern: 'Edit(src/**)', decision: 'allow' },
      ],
    };
    const r = savePermissionsFile(cwd, file);
    assert.equal(r.ok, true);
    const loaded = loadPermissionsFile(cwd);
    assert.equal(loaded?.rules.length, 2);
    assert.equal(loaded?.rules[1].pattern, 'Edit(src/**)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadPermissionsFile returns null on malformed JSON', () => {
  const cwd = mkTmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.fixo'), { recursive: true });
    fs.writeFileSync(getPermissionsPath(cwd), '{not-json');
    assert.equal(loadPermissionsFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadPermissionsFile returns null on wrong version', () => {
  const cwd = mkTmpCwd();
  try {
    savePermissionsFile(cwd, { version: 2, rules: [] } as unknown as PermissionsFile);
    assert.equal(loadPermissionsFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadPermissionsFile returns null when no file', () => {
  const cwd = mkTmpCwd();
  try {
    assert.equal(loadPermissionsFile(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  Phase 4: tool-executor → checkPermission wiring assertions.
 *  These tests prove the migrated callsites in tool-executor.ts
 *  consult `checkPermission` (and therefore .fixo/permissions.json
 *  rules) before falling back to legacy `decidePolicy`.
 * ─────────────────────────────────────────────────────────────*/

test('checkPermission: explicit deny rule fires before legacy policy', () => {
  const cwd = mkTmpCwd();
  try {
    savePermissionsFile(cwd, {
      version: 1,
      rules: [{ pattern: 'run_command(rm -rf**)', decision: 'deny', reason: 'unsafe' }],
    });
    const result = checkPermission('run_command', { command: 'rm -rf /' }, cwd, 'shell-confirm');
    assert.equal(result.decision, 'deny');
    assert.equal(result.source, 'rule');
    assert.equal(result.matchedRule, 'run_command(rm -rf**)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: no rules → legacy decidePolicy is consulted (fallback-policy source)', () => {
  const cwd = mkTmpCwd();
  try {
    // No permissions.json. read_file is not in NEW_TOOL_DEFAULT_ASK,
    // so we must hit the fallback-policy tier.
    const result = checkPermission('read_file', { path: 'foo.ts' }, cwd, 'shell-confirm');
    assert.equal(result.source, 'fallback-policy');
    // read_file under shell-confirm is read action → allow
    assert.equal(result.decision, 'allow');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkPermission: new Phase 1-3 tools default to ask when no rule matches', () => {
  const cwd = mkTmpCwd();
  try {
    // str_replace is in NEW_TOOL_DEFAULT_ASK — no rule → ask.
    const r1 = checkPermission('str_replace', { path: 'src/x.ts' }, cwd, 'shell-confirm');
    assert.equal(r1.decision, 'ask');
    assert.equal(r1.source, 'default-ask');
    // todo_write is in NEW_TOOL_DEFAULT_ASK
    const r2 = checkPermission('todo_write', { items: [] }, cwd, 'shell-confirm');
    assert.equal(r2.decision, 'ask');
    assert.equal(r2.source, 'default-ask');
    // run_command_async is in NEW_TOOL_DEFAULT_ASK
    const r3 = checkPermission('run_command_async', { command: 'npm test' }, cwd, 'shell-confirm');
    assert.equal(r3.decision, 'ask');
    assert.equal(r3.source, 'default-ask');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
