/**
 * Restricted Credential Sandbox — Pillar 4 of the Phase 2 safety
 * refactor. The problem: API keys for OpenAI, Anthropic, Google,
 * AWS, OpenRouter, etc. are long-lived secrets with catastrophic
 * blast radius if leaked into a tool result, an LLM prompt, or a
 * log line. The legacy `ProvidersManager.getDirectConfig(name)`
 * returns the raw key in an object — every caller that touches
 * that object now has the key on its stack, in error messages,
 * in telemetry, and in crash dumps.
 *
 * The fix: a {@link ProviderKeyVault} that owns the credentials
 * in a private, read-only `Map` and exposes them **only** inside
 * a scoped executor block. Outside the block, the vault reveals
 * nothing but metadata (provider names, presence, count). There
 * is no `getApiKey`, no `peek`, no `toJSON`. The only way to
 * read a key is to hand a callback to the vault, and the key
 * is never visible to the caller after the callback returns.
 *
 * The vault is in-memory and process-local; persistence is
 * delegated to `ProvidersManager`, which calls `vault.ingest()`
 * after a disk read. Test code can call `ingest()` directly with
 * fixture credentials.
 *
 * The class is intentionally small (no `any`, no async-only
 * fast paths) so the security boundary is auditable in one read.
 */

/* ──────────────────────── Public types ──────────────────────── */

/** A scoped credential, exposed only inside a vault callback. */
export interface ProviderCredential {
  /** The provider name as it appears in `PROVIDER_REGISTRY`. */
  readonly providerName: string;
  /** The raw API key. Never log, never stringify, never serialise. */
  readonly apiKey: string;
  /** Provider base URL. */
  readonly baseUrl: string;
  /** Display name (e.g. "OpenAI"). */
  readonly displayName: string;
}

/** Callback that receives a key. */
export type KeyCallback<T> = (key: string) => Promise<T> | T;
/** Callback that receives a full credential. */
export type CredentialCallback<T> = (
  cred: ProviderCredential,
) => Promise<T> | T;

/** Options for the vault. */
export interface ProviderKeyVaultOptions {
  /**
   * When true (default), `ingest()` rejects empty / whitespace-only
   * keys. Disable for tests that exercise the empty-key error path
   * via direct construction.
   */
  rejectEmptyKeys?: boolean;
}

/* ──────────────────────── Errors ──────────────────────── */

/** Thrown when a requested provider is not in the vault. */
export class ProviderNotInVaultError extends Error {
  public readonly providerName: string;
  constructor(providerName: string) {
    super(`ProviderKeyVault: no credential for "${providerName}"`);
    this.name = "ProviderNotInVaultError";
    this.providerName = providerName;
  }
}

/** Thrown when ingest() is called with an empty / blank key. */
export class EmptyKeyRejectedError extends Error {
  constructor(providerName: string) {
    super(
      `ProviderKeyVault: refused to ingest empty key for "${providerName}"`,
    );
    this.name = "EmptyKeyRejectedError";
  }
}

/* ──────────────────────── ProviderKeyVault ──────────────────────── */

export class ProviderKeyVault {
  /**
   * Backing store. Marked `readonly` so a misbehaving consumer
   * cannot reassign the map, but the map itself is private so
   * the `ProviderCredential` objects are unreachable from
   * outside the class.
   */
  readonly #store: Map<string, ProviderCredential> = new Map();
  readonly #rejectEmpty: boolean;

  constructor(options: ProviderKeyVaultOptions = {}) {
    this.#rejectEmpty = options.rejectEmptyKeys ?? true;
  }

  /**
   * Add or replace a credential. Existing entries for the same
   * provider are silently overwritten; the old `ProviderCredential`
   * is dropped, and the previous key becomes unreachable.
   */
  public ingest(
    providerName: string,
    apiKey: string,
    baseUrl: string,
    displayName?: string,
  ): void {
    if (!providerName) {
      throw new Error("ProviderKeyVault.ingest: providerName is required");
    }
    if (this.#rejectEmpty && (!apiKey || !apiKey.trim())) {
      throw new EmptyKeyRejectedError(providerName);
    }
    this.#store.set(providerName, {
      providerName,
      apiKey,
      baseUrl,
      displayName: displayName ?? providerName,
    });
  }

  /**
   * True if the vault has a credential for the given provider.
   * Safe to call from anywhere — does not leak the key.
   */
  public hasProvider(providerName: string): boolean {
    return this.#store.has(providerName);
  }

  /** Number of providers currently in the vault. */
  public size(): number {
    return this.#store.size;
  }

  /** Sorted list of configured provider names. */
  public listProviderNames(): string[] {
    return Array.from(this.#store.keys()).sort();
  }

  /**
   * Resolve the provider name for a given model id by walking a
   * caller-supplied resolver. The vault itself does not know the
   * provider registry; callers pass a pure function so the vault
   * stays a pure credential container.
   *
   * Returns the resolved provider name or null if `resolveModel`
   * returned null.
   */
  public providerForModel(
    model: string,
    resolveModel: (model: string) => string | null,
  ): string | null {
    const name = resolveModel(model);
    if (!name) return null;
    return this.#store.has(name) ? name : null;
  }

  /**
   * The ONLY way to read an API key. Pass a callback; the vault
   * invokes it with the key as the sole argument. The key is
   * never returned, never serialised, never assigned to a wider
   * scope. If the provider is not configured, the callback is
   * never called and {@link ProviderNotInVaultError} is thrown.
   */
  public async withApiKey<T>(
    providerName: string,
    fn: KeyCallback<T>,
  ): Promise<T> {
    const cred = this.#store.get(providerName);
    if (!cred) throw new ProviderNotInVaultError(providerName);
    return await fn(cred.apiKey);
  }

  /**
   * Synchronous variant of {@link withApiKey}. Throws if the
   * callback returns a promise (use `withApiKey` for async).
   */
  public withApiKeySync<T>(providerName: string, fn: KeyCallback<T>): T {
    const cred = this.#store.get(providerName);
    if (!cred) throw new ProviderNotInVaultError(providerName);
    const result = fn(cred.apiKey);
    if (result instanceof Promise) {
      throw new Error(
        "ProviderKeyVault.withApiKeySync: callback returned a Promise; use withApiKey() instead",
      );
    }
    return result;
  }

  /**
   * Like {@link withApiKey} but exposes the entire
   * {@link ProviderCredential} (apiKey, baseUrl, displayName).
   * Use this for the common "build a request to a provider" case
   * where the URL is part of the credential surface.
   */
  public async withCredential<T>(
    providerName: string,
    fn: CredentialCallback<T>,
  ): Promise<T> {
    const cred = this.#store.get(providerName);
    if (!cred) throw new ProviderNotInVaultError(providerName);
    return await fn(cred);
  }

  /** Remove a single provider's credential. */
  public evict(providerName: string): boolean {
    return this.#store.delete(providerName);
  }

  /** Remove every credential. Used by `/fixo vault:reset`. */
  public clearAll(): void {
    this.#store.clear();
  }

  /**
   * Internal: build a `Headers`-shaped object for the provider
   * using a callback. The callback receives the credential and
   * returns a `Record<string, string>`. The callback is the only
   * place where the key is materialised, and the returned object
   * is owned by the caller (which can pass it to `fetch`).
   */
  public async buildAuthHeaders(
    providerName: string,
    builder: (cred: ProviderCredential) => Record<string, string>,
  ): Promise<Record<string, string>> {
    const cred = this.#store.get(providerName);
    if (!cred) throw new ProviderNotInVaultError(providerName);
    return builder(cred);
  }
}

/* ──────────────────────── Process-wide singleton ─────────────────── */

/**
 * Process-wide vault singleton. Lazily created on first call to
 * {@link getProviderKeyVault}. Tests that need an isolated vault
 * should construct their own {@link ProviderKeyVault} directly
 * and use it without going through this singleton.
 */
let cachedVault: ProviderKeyVault | null = null;

export function getProviderKeyVault(): ProviderKeyVault {
  if (!cachedVault) cachedVault = new ProviderKeyVault();
  return cachedVault;
}

/** Test hook — drop the cached singleton. */
export function resetProviderKeyVault(): void {
  cachedVault = null;
}
