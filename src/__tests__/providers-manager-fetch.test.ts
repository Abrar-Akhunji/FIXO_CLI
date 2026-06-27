/**
 * providers-manager-fetch.test.ts — coverage for the live model
 * discovery + on-disk cache layer added to `ProvidersManager`.
 *
 * Each test pins `$HOME` to a fresh `mkdtempSync` directory so the
 * `~/.fixocli/{providers.json,models-cache.json}` files for one
 * case can't leak into the next. The credential vault singleton is
 * reset between cases for the same reason.
 *
 * `globalThis.fetch` is monkey-patched per case so we can assert on
 * the request shape (URL, headers) without touching the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProvidersManager } from '../agent/providers-manager.js';

type FetchFn = typeof globalThis.fetch;

function mkHome(): { home: string; restore: () => void; originalFetch: FetchFn } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixo-models-cache-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = tmp;
  ProvidersManager.resetVault();
  return {
    home: tmp,
    originalFetch,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      globalThis.fetch = originalFetch;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      ProvidersManager.resetVault();
    },
  };
}

function modelsCachePath(home: string): string {
  return path.join(home, '.fixocli', 'models-cache.json');
}

function mockFetchOk(body: unknown, capture?: { url?: string; headers?: Record<string, string> }): FetchFn {
  return (async (input: any, init?: any) => {
    if (capture) {
      capture.url = typeof input === 'string' ? input : String(input);
      const h = (init?.headers ?? {}) as Record<string, string>;
      capture.headers = { ...h };
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as FetchFn;
}

function mockFetchThrows(): FetchFn {
  return (async () => { throw new Error('network unreachable'); }) as FetchFn;
}

/* ──────────────────── live fetch persists cache ──────────────────── */

test('fetchRemoteModels — live success persists cache and returns live source', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('openai', 'sk-test-key-1234567890');
    const capture: { url?: string; headers?: Record<string, string> } = {};
    globalThis.fetch = mockFetchOk(
      { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'o3' }] },
      capture,
    );

    const result = await ProvidersManager.fetchRemoteModels('openai');
    assert.equal(result.source, 'live');
    assert.deepEqual(result.models, ['gpt-4o', 'gpt-4o-mini', 'o3']);

    // The request must hit the OpenAI base URL and carry the Bearer token.
    assert.ok(capture.url?.endsWith('/models'), `unexpected url: ${capture.url}`);
    assert.equal(capture.headers?.['Authorization'], 'Bearer sk-test-key-1234567890');

    // Cache file exists, is mode 0600, and round-trips the live payload.
    const cachePath = modelsCachePath(ctx.home);
    assert.ok(fs.existsSync(cachePath), 'cache file written');
    const mode = fs.statSync(cachePath).mode & 0o777;
    assert.equal(mode, 0o600, 'cache file is mode 0600');
    const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    assert.equal(onDisk.openai.source, 'live');
    assert.deepEqual(onDisk.openai.models, ['gpt-4o', 'gpt-4o-mini', 'o3']);
  } finally {
    ctx.restore();
  }
});

/* ──────────────────── failure → registry fallback, then cache ──────────────────── */

test('fetchRemoteModels — network failure falls back to registry, then cache on re-run', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('groq', 'gsk-test-key-1234567890');
    globalThis.fetch = mockFetchThrows();

    const first = await ProvidersManager.fetchRemoteModels('groq');
    assert.equal(first.source, 'registry-fallback');
    assert.ok(first.models.length > 0, 'registry models surfaced');

    // Now seed a *fresh* live cache and ensure the second call uses it.
    const cachePath = modelsCachePath(ctx.home);
    const fresh = {
      groq: {
        models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
        fetchedAt: new Date().toISOString(),
        source: 'live' as const,
      },
    };
    fs.writeFileSync(cachePath, JSON.stringify(fresh, null, 2), { encoding: 'utf-8', mode: 0o600 });

    // Network still failing — fetchRemoteModels must serve from cache.
    const second = await ProvidersManager.fetchRemoteModels('groq');
    assert.equal(second.source, 'cache');
    assert.deepEqual(second.models, ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']);
  } finally {
    ctx.restore();
  }
});

/* ──────────────────── cache TTL ──────────────────── */

test('fetchRemoteModels — stale cache (>24h old) is treated as missing', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('anthropic', 'sk-ant-test-1234567890');
    globalThis.fetch = mockFetchThrows();

    // Seed a cache entry that is 25h old → past the 24h TTL.
    const cachePath = modelsCachePath(ctx.home);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const stale = {
      anthropic: {
        models: ['claude-opus-3'],
        fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        source: 'live' as const,
      },
    };
    fs.writeFileSync(cachePath, JSON.stringify(stale, null, 2), { encoding: 'utf-8', mode: 0o600 });

    // Stale + network down → should report registry fallback, not cache.
    const result = await ProvidersManager.fetchRemoteModels('anthropic');
    assert.equal(result.source, 'registry-fallback');
    assert.notDeepEqual(result.models, ['claude-opus-3']);

    // And `getCachedModels` should return null for the stale entry.
    assert.equal(ProvidersManager.getCachedModels('anthropic')?.source, 'registry-fallback',
      'after registry fallback, cache entry should be re-tagged registry-fallback');
  } finally {
    ctx.restore();
  }
});

/* ──────────────────── provider-specific headers ──────────────────── */

test('fetchRemoteModels — zen provider sends HTTP-Referer + X-Title headers', async () => {
  const ctx = mkHome();
  try {
    ProvidersManager.add('zen', 'zen-test-key-1234567890');
    const capture: { url?: string; headers?: Record<string, string> } = {};
    globalThis.fetch = mockFetchOk({ data: [{ id: 'kimi-k2.6' }] }, capture);

    const result = await ProvidersManager.fetchRemoteModels('zen');
    assert.equal(result.source, 'live');
    assert.equal(capture.headers?.['HTTP-Referer'], 'https://opencode.ai/');
    assert.equal(capture.headers?.['X-Title'], 'opencode');
    assert.equal(capture.headers?.['Authorization'], 'Bearer zen-test-key-1234567890');
  } finally {
    ctx.restore();
  }
});

/* ──────────────────── no key configured ──────────────────── */

test('fetchRemoteModels — unconfigured provider falls back without attempting fetch', async () => {
  const ctx = mkHome();
  try {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as FetchFn;

    const result = await ProvidersManager.fetchRemoteModels('mistral');
    assert.equal(fetchCalled, false, 'fetch must not be called when no key is configured');
    assert.equal(result.source, 'registry-fallback');
    assert.ok(result.models.length > 0);
  } finally {
    ctx.restore();
  }
});

/* ──────────────────── verifyKeyAndFetchModels tests ──────────────────── */

test('verifyKeyAndFetchModels — success fetches models and caches them', async () => {
  const ctx = mkHome();
  try {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    globalThis.fetch = mockFetchOk(
      { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
      capture,
    );

    const models = await ProvidersManager.verifyKeyAndFetchModels('openai', 'sk-test-key-555');
    assert.deepEqual(models, ['gpt-4o', 'gpt-4o-mini']);
    assert.equal(capture.headers?.['Authorization'], 'Bearer sk-test-key-555');

    // Cache should be updated
    const cached = ProvidersManager.getCachedModels('openai');
    assert.ok(cached);
    assert.equal(cached.source, 'live');
    assert.deepEqual(cached.models, ['gpt-4o', 'gpt-4o-mini']);
  } finally {
    ctx.restore();
  }
});

test('verifyKeyAndFetchModels — HTTP error throws descriptive error', async () => {
  const ctx = mkHome();
  try {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API Key' } }),
      } as unknown as Response;
    }) as FetchFn;

    await assert.rejects(
      async () => {
        await ProvidersManager.verifyKeyAndFetchModels('openai', 'invalid-key');
      },
      (err: any) => {
        assert.ok(err.message.includes('API returned status 401 Unauthorized: Invalid API Key'), `unexpected error message: ${err.message}`);
        return true;
      }
    );
  } finally {
    ctx.restore();
  }
});

test('verifyKeyAndFetchModels — network error throws descriptive error', async () => {
  const ctx = mkHome();
  try {
    globalThis.fetch = mockFetchThrows();

    await assert.rejects(
      async () => {
        await ProvidersManager.verifyKeyAndFetchModels('openai', 'some-key');
      },
      (err: any) => {
        assert.ok(err.message.includes('Network error or timeout connecting to OpenAI'), `unexpected error message: ${err.message}`);
        return true;
      }
    );
  } finally {
    ctx.restore();
  }
});
