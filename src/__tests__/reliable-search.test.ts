/**
 * Tests for the reliable search provider chain.
 *
 * The chain is exercised through a `MockProvider` to keep the
 * tests deterministic and offline. The chain is responsible for:
 *   - Trying providers in order
 *   - Skipping a provider whose `isAvailable()` returns false
 *   - Moving to the next provider on a thrown error
 *   - Returning the first provider that yields results
 *   - Throwing `SearchExhaustedError` when every provider fails
 *
 * The credential-vault surface is stubbed at the module level
 * so the Brave/Tavily providers can call `getProviderKeyVault()`
 * without spinning up the real vault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SearchProviderChain,
  SearchExhaustedError,
  type SearchProvider,
  type SearchResult,
} from '../agent/search/index.js';

class MockProvider implements SearchProvider {
  public readonly id: 'brave' | 'tavily' | 'ddg';
  private readonly availableFlag: boolean;
  private readonly resultsToReturn: SearchResult[];
  private readonly errorToThrow: Error | null;

  constructor(opts: {
    id: 'brave' | 'tavily' | 'ddg';
    available?: boolean;
    results?: SearchResult[];
    error?: Error;
  }) {
    this.id = opts.id;
    this.availableFlag = opts.available ?? true;
    this.resultsToReturn = opts.results ?? [];
    this.errorToThrow = opts.error ?? null;
  }

  async isAvailable(): Promise<boolean> {
    return this.availableFlag;
  }

  async search(): Promise<SearchResult[]> {
    if (this.errorToThrow) throw this.errorToThrow;
    return this.resultsToReturn;
  }
}

const SAMPLE: SearchResult[] = [
  { title: 'Hello', url: 'https://example.com/hello', snippet: 'world' },
];

test('SearchProviderChain returns first non-empty result', async () => {
  const chain = new SearchProviderChain([
    new MockProvider({ id: 'brave', results: SAMPLE }),
    new MockProvider({ id: 'tavily', results: SAMPLE }),
  ]);
  const out = await chain.search('q');
  assert.equal(out.provider, 'brave');
  assert.equal(out.results.length, 1);
});

test('SearchProviderChain falls through unavailable providers', async () => {
  const chain = new SearchProviderChain([
    new MockProvider({ id: 'brave', available: false, results: SAMPLE }),
    new MockProvider({ id: 'tavily', results: SAMPLE }),
  ]);
  const out = await chain.search('q');
  assert.equal(out.provider, 'tavily');
  assert.equal(out.attempts[0]?.provider, 'brave');
  assert.equal(out.attempts[0]?.error, 'not_configured');
});

test('SearchProviderChain falls through empty results', async () => {
  const chain = new SearchProviderChain([
    new MockProvider({ id: 'brave', results: [] }),
    new MockProvider({ id: 'tavily', results: SAMPLE }),
  ]);
  const out = await chain.search('q');
  assert.equal(out.provider, 'tavily');
  assert.equal(out.attempts[0]?.error, 'no_results');
});

test('SearchProviderChain falls through thrown errors', async () => {
  const chain = new SearchProviderChain([
    new MockProvider({ id: 'brave', error: new Error('boom') }),
    new MockProvider({ id: 'tavily', results: SAMPLE }),
  ]);
  const out = await chain.search('q');
  assert.equal(out.provider, 'tavily');
  assert.equal(out.attempts[0]?.error, 'boom');
});

test('SearchProviderChain throws SearchExhaustedError when all fail', async () => {
  const chain = new SearchProviderChain([
    new MockProvider({ id: 'brave', available: false }),
    new MockProvider({ id: 'tavily', results: [] }),
    new MockProvider({ id: 'ddg', error: new Error('down') }),
  ]);
  await assert.rejects(
    () => chain.search('hello world'),
    (err: unknown) => {
      assert.ok(err instanceof SearchExhaustedError);
      assert.equal(err.query, 'hello world');
      assert.equal(err.attempts.length, 3);
      assert.equal(err.attempts[0]?.provider, 'brave');
      assert.equal(err.attempts[1]?.provider, 'tavily');
      assert.equal(err.attempts[2]?.provider, 'ddg');
      return true;
    },
  );
});

test('SearchExhaustedError has a descriptive message', () => {
  const err = new SearchExhaustedError('foo', [
    { provider: 'brave', error: 'no_results' },
    { provider: 'ddg', error: 'down' },
  ]);
  assert.match(err.message, /All search providers failed/);
  assert.match(err.message, /brave/);
  assert.match(err.message, /ddg/);
});
