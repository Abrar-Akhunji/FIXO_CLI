/**
 * model-routing.test.ts — Phase 2.4 acceptance test.
 *
 * Proves the local fast/heavy-tier model substitution works without
 * the FreeLLMAPI proxy needing to do anything: when a caller tags
 * its request with `required_capabilities: ['fast']` AND the user
 * has configured `preferences.modelRouting.fast`, the request body
 * that actually leaves the process carries the configured fast
 * model — NOT the caller's original model.
 *
 * Backwards-compatibility: when no routing is configured the
 * caller's model passes through unchanged. This is the regression
 * guard for users who haven't opted into routing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentClient } from '../agent/agent-client.js';
import { ProvidersManager } from '../agent/providers-manager.js';

type FetchFn = typeof globalThis.fetch;

function mkHome(): { home: string; restore: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-model-routing-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = tmp;
  ProvidersManager.resetVault();
  return {
    home: tmp,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      globalThis.fetch = originalFetch;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      ProvidersManager.resetVault();
    },
  };
}

function captureFetch(captured: { body?: string; url?: string }): FetchFn {
  return (async (input: unknown, init?: RequestInit) => {
    captured.url = typeof input === 'string' ? input : String(input);
    captured.body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: 'unused',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as FetchFn;
}

test("modelRouting.fast — required_capabilities: ['fast'] substitutes the fast-tier model on the wire", async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-routing-test-1');
    const captured: { body?: string; url?: string } = {};
    globalThis.fetch = captureFetch(captured);

    const client = new AgentClient('', undefined, false, 'direct', { fast: 'gpt-4o-mini' });
    await client.chat(
      [{ role: 'user', content: 'classify this' }],
      'gpt-4o',
      { required_capabilities: ['fast'] },
    );

    const sent = JSON.parse(captured.body ?? '{}') as { model?: string };
    assert.equal(sent.model, 'gpt-4o-mini', 'fast tier must substitute the request-body model');
  } finally {
    ctx.restore();
  }
});

test("modelRouting.heavy — required_capabilities: ['heavy'] substitutes the heavy-tier model on the wire", async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-routing-test-2');
    const captured: { body?: string; url?: string } = {};
    globalThis.fetch = captureFetch(captured);

    const client = new AgentClient('', undefined, false, 'direct', { heavy: 'o3' });
    await client.chat(
      [{ role: 'user', content: 'tough refactor' }],
      'gpt-4o',
      { required_capabilities: ['heavy'] },
    );

    const sent = JSON.parse(captured.body ?? '{}') as { model?: string };
    assert.equal(sent.model, 'o3', 'heavy tier must substitute the request-body model');
  } finally {
    ctx.restore();
  }
});

test('modelRouting — no capability tag means the caller model passes through unchanged', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-routing-test-3');
    const captured: { body?: string; url?: string } = {};
    globalThis.fetch = captureFetch(captured);

    const client = new AgentClient('', undefined, false, 'direct', { fast: 'gpt-4o-mini' });
    await client.chat([{ role: 'user', content: 'plain task' }], 'gpt-4o', {});

    const sent = JSON.parse(captured.body ?? '{}') as { model?: string };
    assert.equal(sent.model, 'gpt-4o', 'no capability tag must NOT substitute the model');
  } finally {
    ctx.restore();
  }
});

test('modelRouting — when fast tier is not configured, fast-tagged calls fall through to the caller model', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-routing-test-4');
    const captured: { body?: string; url?: string } = {};
    globalThis.fetch = captureFetch(captured);

    const client = new AgentClient('', undefined, false, 'direct', { heavy: 'o3' });
    await client.chat(
      [{ role: 'user', content: 'classify' }],
      'gpt-4o',
      { required_capabilities: ['fast'] },
    );

    const sent = JSON.parse(captured.body ?? '{}') as { model?: string };
    assert.equal(sent.model, 'gpt-4o', 'unset fast tier must fall through to caller model');
  } finally {
    ctx.restore();
  }
});

test('modelRouting — back-compat: undefined modelRouting (older config) routes unchanged', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-routing-test-5');
    const captured: { body?: string; url?: string } = {};
    globalThis.fetch = captureFetch(captured);

    const client = new AgentClient('', undefined, false, 'direct');
    await client.chat(
      [{ role: 'user', content: 'whatever' }],
      'gpt-4o',
      { required_capabilities: ['fast'] },
    );

    const sent = JSON.parse(captured.body ?? '{}') as { model?: string };
    assert.equal(sent.model, 'gpt-4o', 'absent modelRouting must NOT modify the model');
  } finally {
    ctx.restore();
  }
});
