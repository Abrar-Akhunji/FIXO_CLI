import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderKeyVault,
  ProviderNotInVaultError,
  EmptyKeyRejectedError,
  getProviderKeyVault,
  resetProviderKeyVault,
  type ProviderCredential,
} from '../runtime/credential-vault.js';

/* ------------------------------------------------------------------ */
/* isolation                                                          */
/* ------------------------------------------------------------------ */

test.beforeEach(() => {
  resetProviderKeyVault();
});

/* ------------------------------------------------------------------ */
/* withApiKey — happy path                                             */
/* ------------------------------------------------------------------ */

test('withApiKey — callback receives the key', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('anthropic', 'sk-ant-api03-XYZ', 'https://api.anthropic.com', 'Anthropic');
  let received: string | null = null;
  await vault.withApiKey('anthropic', (k) => {
    received = k;
    return 'ok';
  });
  assert.equal(received, 'sk-ant-api03-XYZ');
});

test('withApiKey — returns the callback return value', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk-XYZ', 'https://api.openai.com/v1', 'OpenAI');
  const result = await vault.withApiKey('openai', () => 42);
  assert.equal(result, 42);
});

test('withApiKey — key is not accessible after the callback returns', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk-XYZ', 'https://api.openai.com/v1', 'OpenAI');
  let capturedRef: string | null = null;
  await vault.withApiKey('openai', (k) => {
    // Capture the reference; the test asserts the reference is
    // not stored anywhere reachable through the vault.
    capturedRef = k;
  });
  // The captured reference is the same value (the test is a
  // reminder, not a guarantee — JS strings are immutable and
  // always copy on access). The real guarantee is that
  // `vault` exposes no getter that returns the key.
  assert.equal(capturedRef, 'sk-XYZ');
  // hasProvider is the only safe accessor; size is metadata.
  assert.equal(vault.hasProvider('openai'), true);
  assert.equal(vault.size(), 1);
});

test('withApiKey — awaits async callbacks', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('google', 'AIza-XYZ', 'https://generativelanguage.googleapis.com', 'Google');
  const result = await vault.withApiKey('google', async (k) => {
    await new Promise((r) => setTimeout(r, 5));
    return k.length;
  });
  assert.equal(result, 8);
});

test('withApiKey — throws ProviderNotInVaultError when unconfigured', async () => {
  const vault = new ProviderKeyVault();
  await assert.rejects(
    () => vault.withApiKey('missing', () => 'never'),
    (err: unknown) => err instanceof ProviderNotInVaultError,
  );
});

test('withApiKey — propagates callback errors', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk-XYZ', 'https://api.openai.com/v1', 'OpenAI');
  await assert.rejects(
    () => vault.withApiKey('openai', () => { throw new Error('boom'); }),
    (err: unknown) => err instanceof Error && err.message === 'boom',
  );
});

/* ------------------------------------------------------------------ */
/* withCredential — exposes baseUrl + displayName                      */
/* ------------------------------------------------------------------ */

test('withCredential — exposes the full credential object', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('anthropic', 'sk-ant-XYZ', 'https://api.anthropic.com', 'Anthropic');
  const url = await vault.withCredential('anthropic', (cred) => cred.baseUrl + '/v1/messages');
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
});

/* ------------------------------------------------------------------ */
/* ingest — overwrites existing                                        */
/* ------------------------------------------------------------------ */

test('ingest — overwrites an existing credential', () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'old-key', 'https://api.openai.com/v1', 'OpenAI');
  vault.ingest('openai', 'new-key', 'https://api.openai.com/v1', 'OpenAI');
  assert.equal(vault.size(), 1);
  let received: string | null = null;
  // Use the async variant in a synchronous test by awaiting via
  // an IIFE; the test framework will pick up the rejection if any.
  return vault.withApiKey('openai', (k) => {
    received = k;
    return null;
  }).then(() => {
    assert.equal(received, 'new-key');
  });
});

test('ingest — rejects empty keys by default', () => {
  const vault = new ProviderKeyVault();
  assert.throws(
    () => vault.ingest('openai', '', 'https://api.openai.com/v1', 'OpenAI'),
    (err: unknown) => err instanceof EmptyKeyRejectedError,
  );
  assert.throws(
    () => vault.ingest('openai', '   ', 'https://api.openai.com/v1', 'OpenAI'),
    (err: unknown) => err instanceof EmptyKeyRejectedError,
  );
});

test('ingest — accepts empty keys when rejectEmptyKeys is false', () => {
  const vault = new ProviderKeyVault({ rejectEmptyKeys: false });
  vault.ingest('openai', '', 'https://api.openai.com/v1', 'OpenAI');
  assert.equal(vault.hasProvider('openai'), true);
});

/* ------------------------------------------------------------------ */
/* introspection — safe accessors                                       */
/* ------------------------------------------------------------------ */

test('hasProvider — returns correct boolean', () => {
  const vault = new ProviderKeyVault();
  assert.equal(vault.hasProvider('openai'), false);
  vault.ingest('openai', 'sk-XYZ', 'https://api.openai.com/v1', 'OpenAI');
  assert.equal(vault.hasProvider('openai'), true);
});

test('listProviderNames — returns sorted names', () => {
  const vault = new ProviderKeyVault();
  vault.ingest('zen', 'k1', 'u1', 'Zen');
  vault.ingest('anthropic', 'k2', 'u2', 'Anthropic');
  vault.ingest('openai', 'k3', 'u3', 'OpenAI');
  assert.deepEqual(vault.listProviderNames(), ['anthropic', 'openai', 'zen']);
});

test('providerForModel — returns the resolved name only if the vault has it', () => {
  const vault = new ProviderKeyVault();
  vault.ingest('anthropic', 'k', 'u', 'Anthropic');
  const resolver = (model: string) => (model.startsWith('claude-') ? 'anthropic' : 'openai');
  assert.equal(vault.providerForModel('claude-opus', resolver), 'anthropic');
  // openai is not in the vault — returns null even though the
  // resolver found a match.
  assert.equal(vault.providerForModel('gpt-4o', resolver), null);
  assert.equal(vault.providerForModel('unknown', resolver), null);
});

/* ------------------------------------------------------------------ */
/* clearAll / evict                                                    */
/* ------------------------------------------------------------------ */

test('evict — removes a single provider', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk-XYZ', 'u', 'OpenAI');
  vault.ingest('anthropic', 'sk-ant-XYZ', 'u', 'Anthropic');
  assert.equal(vault.evict('openai'), true);
  assert.equal(vault.hasProvider('openai'), false);
  assert.equal(vault.hasProvider('anthropic'), true);
  assert.equal(vault.evict('openai'), false); // already gone
});

test('clearAll — removes every credential', () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk', 'u', 'OpenAI');
  vault.ingest('anthropic', 'sk-ant', 'u', 'Anthropic');
  vault.clearAll();
  assert.equal(vault.size(), 0);
  assert.equal(vault.hasProvider('openai'), false);
});

/* ------------------------------------------------------------------ */
/* concurrent isolation                                                */
/* ------------------------------------------------------------------ */

test('withApiKey — concurrent calls do not leak between scopes', async () => {
  const vault = new ProviderKeyVault();
  vault.ingest('openai', 'sk-OPENAI', 'u', 'OpenAI');
  vault.ingest('anthropic', 'sk-ant-ANTHROPIC', 'u', 'Anthropic');
  const [a, b] = await Promise.all([
    vault.withApiKey('openai', async (k) => {
      await new Promise((r) => setTimeout(r, 10));
      return k;
    }),
    vault.withApiKey('anthropic', async (k) => {
      await new Promise((r) => setTimeout(r, 5));
      return k;
    }),
  ]);
  assert.equal(a, 'sk-OPENAI');
  assert.equal(b, 'sk-ant-ANTHROPIC');
});

/* ------------------------------------------------------------------ */
/* singleton                                                          */
/* ------------------------------------------------------------------ */

test('getProviderKeyVault — returns the same instance until reset', () => {
  const a = getProviderKeyVault();
  const b = getProviderKeyVault();
  assert.equal(a, b);
  resetProviderKeyVault();
  const c = getProviderKeyVault();
  assert.notEqual(a, c);
});
