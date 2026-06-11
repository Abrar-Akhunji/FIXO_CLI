import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration } from '../agent/duration.js';
import { ProviderInCooldownError } from '../agent/provider-cooldown.js';

test('formatDuration: sub-second values render in ms', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(999), '999ms');
});

test('formatDuration: 1s–59s renders in seconds', () => {
  assert.equal(formatDuration(1_000), '1s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(59_499), '59s');
});

test('formatDuration: minutes:seconds, dropping seconds when zero', () => {
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(134_000), '2m 14s');
  assert.equal(formatDuration(120_000), '2m');
});

test('formatDuration: hours:minutes, dropping seconds', () => {
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(3_750_000), '1h 2m');
  assert.equal(formatDuration(7_320_000), '2h 2m');
});

test('formatDuration: non-finite or negative returns "0ms"', () => {
  assert.equal(formatDuration(Number.NaN), '0ms');
  assert.equal(formatDuration(-1), '0ms');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0ms');
});

test('ProviderInCooldownError uses formatDuration, not raw ms', () => {
  const until = Date.now() + 134_000;
  const err = new ProviderInCooldownError('zen', 134_000, until);
  assert.match(err.message, /Provider 'zen' is in cooldown for 2m 14s/);
  // Raw ms must NOT appear in the message.
  assert.ok(!err.message.includes('134000ms'));
});
