/**
 * config-tool-budget.test.ts — Coverage for the configurable
 * tool-call budget added to `preferences.safety.toolCalls`.
 *
 * The tests run against `loadConfig()` with an isolated `HOME` so
 * the on-disk config in the developer's actual home directory is
 * not consulted. This pattern is reused elsewhere in the suite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultConfig, loadConfig } from '../config.js';

test('getDefaultConfig: toolCalls budget defaults to soft=50, hard=100, autoExtend=true', () => {
  const cfg = getDefaultConfig();
  assert.deepEqual(cfg.preferences.safety.toolCalls, {
    softLimit: 50,
    hardLimit: 100,
    autoExtend: true,
  });
});

test('loadConfig: missing toolCalls in config.json falls back to defaults', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-cfg-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    // Write a config that pre-dates the toolCalls field.
    const cfgDir = path.join(tempHome, '.fixocli');
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        defaultModel: 'auto',
        preferences: {
          safety: {
            atomicStaging: true,
          },
        },
      }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    const loaded = loadConfig();
    assert.equal(loaded.preferences.safety.toolCalls.softLimit, 50);
    assert.equal(loaded.preferences.safety.toolCalls.hardLimit, 100);
    assert.equal(loaded.preferences.safety.toolCalls.autoExtend, true);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('loadConfig: partial toolCalls overrides merge with defaults', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-cfg-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const cfgDir = path.join(tempHome, '.fixocli');
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        preferences: {
          safety: {
            toolCalls: { softLimit: 25 },
          },
        },
      }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    const loaded = loadConfig();
    assert.equal(loaded.preferences.safety.toolCalls.softLimit, 25);
    assert.equal(loaded.preferences.safety.toolCalls.hardLimit, 100);
    assert.equal(loaded.preferences.safety.toolCalls.autoExtend, true);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
