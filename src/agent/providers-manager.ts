/**
 * FixO CLI Provider Connector Manager.
 * Manages user-supplied API keys for direct provider access,
 * stored securely at ~/.fixocli/providers.json (mode 0600).
 *
 * When a direct key exists for a provider, FixO bypasses the
 * FreeLLMAPI SaaS proxy and calls the provider's API natively.
 *
 * Pillar 4: the legacy `getDirectConfig(name)` method is now
 * a thin wrapper around the {@link ProviderKeyVault} singleton.
 * New code should use `withDirectCredential(name, fn)` instead,
 * which exposes the credential exclusively inside a scoped
 * callback so the raw key never escapes into a wider stack
 * frame, an error message, or a log line.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  getProviderKeyVault,
  resetProviderKeyVault,
  type ProviderCredential,
} from "../runtime/credential-vault.js";

/* ──────────────────────── Provider Registry ──────────────────────── */

/**
 * Known-good models that reliably follow the multi-agent DAG orchestration contract.
 * Used by the router when `modelRouting === 'auto'` to prevent task deadlocks.
 */
export const MODEL_DAG_VERIFIED = new Set([
  "claude-3-5-sonnet-20241022",
  "gemini-2.5-pro",
  "gpt-4o",
  "o3-mini",
]);

export interface ProviderDefinition {
  /** Short ID used as the key in providers.json */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Base URL for the provider's API (OpenAI-compatible unless noted) */
  baseUrl: string;
  /** Whether this provider uses the standard OpenAI /chat/completions format */
  openAICompat: boolean;
  /** Example model IDs for the picker */
  models: string[];
  /** Whether an API key is required (some providers allow anonymous use) */
  requiresKey: boolean;
  /** Docs / sign-up URL for the provider */
  docsUrl: string;
}

export const PROVIDER_REGISTRY: ProviderDefinition[] = [
  {
    name: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    openAICompat: true,
    models: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "gpt-4.1"],
    requiresKey: true,
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    name: "anthropic",
    displayName: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    openAICompat: false,
    models: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    requiresKey: true,
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    name: "google",
    displayName: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    openAICompat: true,
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    requiresKey: true,
    docsUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    name: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    openAICompat: true,
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
    ],
    requiresKey: true,
    docsUrl: "https://console.groq.com/keys",
  },
  {
    name: "mistral",
    displayName: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    openAICompat: true,
    models: [
      "mistral-large-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
    requiresKey: true,
    docsUrl: "https://console.mistral.ai/api-keys/",
  },
  {
    name: "cohere",
    displayName: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    openAICompat: true,
    models: ["command-r-plus", "command-r", "command-a-03-2025"],
    requiresKey: true,
    docsUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    name: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    openAICompat: true,
    models: [
      "anthropic/claude-opus-4-7",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "meta-llama/llama-4-maverick",
    ],
    requiresKey: true,
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    name: "nvidia",
    displayName: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    openAICompat: true,
    models: [
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "meta/llama-3.1-405b-instruct",
    ],
    requiresKey: true,
    docsUrl: "https://build.nvidia.com/explore/discover",
  },
  {
    name: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    openAICompat: true,
    models: ["llama3.3-70b", "llama-4-scout-17b-16e-instruct", "qwen-3-32b"],
    requiresKey: true,
    docsUrl: "https://cloud.cerebras.ai/",
  },
  {
    name: "sambanova",
    displayName: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    openAICompat: true,
    models: [
      "Meta-Llama-3.3-70B-Instruct",
      "DeepSeek-R1-671B",
      "Llama-4-Maverick-17B-128E-Instruct",
    ],
    requiresKey: true,
    docsUrl: "https://cloud.sambanova.ai/",
  },
  {
    name: "github",
    displayName: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    openAICompat: true,
    models: ["openai/gpt-4o", "microsoft/phi-4", "meta/llama-3.3-70b-instruct"],
    requiresKey: true,
    docsUrl: "https://github.com/settings/tokens",
  },
  {
    name: "xai",
    displayName: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    openAICompat: true,
    models: ["grok-3", "grok-3-mini", "grok-2-1212"],
    requiresKey: true,
    docsUrl: "https://console.x.ai/",
  },
  {
    name: "zen",
    displayName: "Zen (OpenCode)",
    baseUrl: "https://opencode.ai/zen/v1",
    openAICompat: true,
    models: [
      "kimi-k2.6",
      "mimo-v2.5-free",
      "minimax-m2.7",
      "minimax-m3-free",
      "nemotron-3-super-free",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "stepfun/step-3.5-flash-free",
      "z-ai/glm-4.7-flash-free",
      "deepseek/deepseek-chat",
    ],
    requiresKey: true,
    docsUrl: "https://opencode.ai/zen",
  },
];

/* ──────────────────────── Storage Schema ──────────────────────── */

interface ProviderEntry {
  apiKey: string;
  addedAt: string;
  note?: string;
}

type ProvidersStore = Record<string, ProviderEntry>;

/* ──────────────────────── ProvidersManager ──────────────────────── */

function getProvidersFilePath(): string {
  return path.join(os.homedir(), ".fixocli", "providers.json");
}

function getMachineKey(): Buffer {
  const p = path.join(os.homedir(), ".fixocli", ".machine_key");
  if (fs.existsSync(p)) {
    return Buffer.from(fs.readFileSync(p, "utf-8").trim(), "hex");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

function encryptKey(key: string): string {
  if (key.startsWith("ENC:")) return key;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMachineKey(), iv);
  let encrypted = cipher.update(key, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `ENC:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decryptKey(val: string): string {
  if (!val.startsWith("ENC:")) return val;
  const parts = val.split(":");
  if (parts.length !== 4) {
    console.warn(
      "[FixO] providers.json: malformed ENC entry — removing this key. Run /providers remove and re-add it.",
    );
    throw new Error("Malformed encrypted key entry in providers.json");
  }
  const iv = Buffer.from(parts[1], "hex");
  const authTag = Buffer.from(parts[2], "hex");
  const encrypted = parts[3];
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getMachineKey(),
      iv,
    );
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    console.warn(
      "[FixO] Failed to decrypt a stored API key. Your ~/.fixocli/providers.json may be corrupted\n" +
        "       or the machine key has changed. Run: /providers remove <name>, then re-add the key.",
    );
    throw new Error(
      "AES-256-GCM decryption failed — corrupted providers.json or rotated machine key",
    );
  }
}

function loadStore(): ProvidersStore {
  const filePath = getProvidersFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    const store = JSON.parse(raw) as ProvidersStore;
    for (const k of Object.keys(store)) {
      if (store[k].apiKey) {
        store[k].apiKey = decryptKey(store[k].apiKey);
      }
    }
    return store;
  } catch {
    return {};
  }
}

function saveStore(store: ProvidersStore): void {
  const dir = path.join(os.homedir(), ".fixocli");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = getProvidersFilePath();
  const toSave = JSON.parse(JSON.stringify(store)); // deep copy
  for (const k of Object.keys(toSave)) {
    if (toSave[k].apiKey) {
      toSave[k].apiKey = encryptKey(toSave[k].apiKey);
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* safe: see above */
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••" + key.slice(-4);
}

/* ──────────────────────── Models Cache ──────────────────────── */

/**
 * On-disk cache of the live model list returned by each provider's
 * `/models` endpoint. The cache is per-provider and bounded by
 * `MODELS_CACHE_TTL_MS`. Live fetches refresh the entry; stale or
 * missing entries fall back to the registry `models[]` array with
 * a `registry-fallback` source tag so the UI can show an
 * `[unverified]` hint.
 */
export interface ProviderModelsCacheEntry {
  models: string[];
  fetchedAt: string; // ISO timestamp
  source: "live" | "registry-fallback";
}

type ProviderModelsCacheStore = Record<string, ProviderModelsCacheEntry>;

const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getModelsCachePath(): string {
  return path.join(os.homedir(), ".fixocli", "models-cache.json");
}

function loadModelsCache(): ProviderModelsCacheStore {
  const filePath = getModelsCachePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ProviderModelsCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveModelsCache(store: ProviderModelsCacheStore): void {
  const dir = path.join(os.homedir(), ".fixocli");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = getModelsCachePath();
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  // safe: same belt-and-braces chmod as saveStore — see comment there.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* safe: see saveStore */
  }
}

/**
 * Build the same provider-specific headers that the existing
 * `/providers test` flow uses. Kept here so the live-fetch path
 * and the legacy test path can share one source of truth.
 */
function buildModelsRequestHeaders(
  name: string,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (name === "zen" || name === "openrouter") {
    headers["HTTP-Referer"] = "https://opencode.ai/";
    headers["X-Title"] = "opencode";
  } else if (name === "nvidia") {
    headers["HTTP-Referer"] = "https://opencode.ai/";
    headers["X-Title"] = "opencode";
    headers["X-BILLING-INVOKE-ORIGIN"] = "OpenCode";
  } else if (name === "cerebras") {
    headers["X-Cerebras-3rd-Party-Integration"] = "opencode";
  }
  return headers;
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: unknown }>;
}

function parseModelsResponse(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as OpenAIModelsResponse).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((m) =>
      m && typeof m === "object" && typeof m.id === "string" ? m.id : null,
    )
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return ids.length > 0 ? ids : null;
}

function getModelHintsPath(): string {
  return path.join(os.homedir(), ".fixocli", "model-hints.json");
}

function loadModelProviderHints(): Map<string, string> {
  try {
    const raw = fs.readFileSync(getModelHintsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function persistModelProviderHints(hints: Map<string, string>): void {
  const dir = path.join(os.homedir(), ".fixocli");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    getModelHintsPath(),
    JSON.stringify(Object.fromEntries(hints), null, 2) + "\n",
    { encoding: "utf-8", mode: 0o600 },
  );
}

/**
 * Maps model IDs to their explicitly-selected provider name.
 * Populated when the user picks a model from a provider's list
 * via the /model interactive picker. Consulted by
 * AgentClient.resolveDirectConfig() before heuristic matching,
 * which makes live-fetched models route to their correct provider.
 */
let modelProviderHints = loadModelProviderHints();

export const ProvidersManager = {
  /** Set an explicit model-to-provider association. */
  setModelProviderHint(model: string, provider: string): void {
    modelProviderHints.set(model.toLowerCase().trim(), provider);
    persistModelProviderHints(modelProviderHints);
  },

  /** Get the explicit provider hint for a model, if one exists. */
  getModelProviderHint(model: string): string | undefined {
    return modelProviderHints.get(model.toLowerCase().trim());
  },

  /** Clear all model-provider hints (e.g. when context resets). */
  clearModelProviderHints(): void {
    modelProviderHints = new Map<string, string>();
    persistModelProviderHints(modelProviderHints);
  },

  /** List all connected providers with masked keys. */
  list(): Array<{
    name: string;
    displayName: string;
    maskedKey: string;
    addedAt: string;
  }> {
    const store = loadStore();
    return Object.entries(store).map(([name, entry]) => {
      const def = PROVIDER_REGISTRY.find((p) => p.name === name);
      return {
        name,
        displayName: def?.displayName ?? name,
        maskedKey: maskKey(entry.apiKey),
        addedAt: entry.addedAt,
      };
    });
  },

  /** Add or update a provider API key. */
  add(name: string, apiKey: string, note?: string): void {
    const store = loadStore();
    store[name] = {
      apiKey: apiKey.trim(),
      addedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    saveStore(store);
    // Keep the vault in sync so callers using withDirectCredential
    // see the new key without having to wait for the next
    // hydration.
    const def = PROVIDER_REGISTRY.find((p) => p.name === name);
    if (def) {
      getProviderKeyVault().ingest(
        name,
        apiKey.trim(),
        def.baseUrl,
        def.displayName,
      );
    }
  },

  /** Remove a provider key. Returns true if removed, false if not found. */
  remove(name: string): boolean {
    const store = loadStore();
    if (!store[name]) return false;
    delete store[name];
    saveStore(store);
    getProviderKeyVault().evict(name);
    return true;
  },

  /** Get the raw API key for a provider, or null if not configured. */
  getKey(name: string): string | null {
    const store = loadStore();
    return store[name]?.apiKey ?? null;
  },

  /** Get the base URL and key for a provider — for direct bypass. */
  getDirectConfig(
    name: string,
  ): { apiKey: string; baseUrl: string; displayName: string } | null {
    // Lazily hydrate the vault on first access.
    this.hydrateVault();
    const store = loadStore();
    const entry = store[name];
    if (!entry) return null;
    const def = PROVIDER_REGISTRY.find((p) => p.name === name);
    if (!def) return null;
    // Re-ingest in case the on-disk key was added since the last
    // hydration. Idempotent: ingest() overwrites by name.
    getProviderKeyVault().ingest(
      name,
      entry.apiKey,
      def.baseUrl,
      def.displayName,
    );
    return {
      apiKey: entry.apiKey,
      baseUrl: def.baseUrl,
      displayName: def.displayName,
    };
  },

  /**
   * Run `fn` with a direct provider's full credential
   * ({@link ProviderCredential}) handed in via a scoped
   * callback. The credential is sourced from the in-memory
   * {@link ProviderKeyVault} and is only reachable inside `fn`.
   *
   * Use this in preference to `getDirectConfig(name)` whenever
   * possible — it keeps the raw API key out of return values,
   * error stacks, and exception payloads.
   */
  async withDirectCredential<T>(
    name: string,
    fn: (
      cred: ProviderCredential & { openAICompat: boolean },
    ) => Promise<T> | T,
  ): Promise<T | null> {
    if (!this.has(name)) return null;
    // Make sure the vault is hydrated.
    this.hydrateVault();
    const def = this.getDefinition(name);
    const vault = getProviderKeyVault();
    return await vault.withCredential(name, (cred) =>
      fn({ ...cred, openAICompat: def ? def.openAICompat : true }),
    );
  },

  /**
   * Populate the {@link ProviderKeyVault} from the on-disk
   * providers store. Idempotent: re-running it is safe and
   * only refreshes entries for providers that have keys on
   * disk. Called automatically on first direct-config access.
   */
  hydrateVault(): void {
    const store = loadStore();
    const vault = getProviderKeyVault();
    let needsMigration = false;

    // We read directly from file without decrypting to check if any are unencrypted
    try {
      const raw = fs.readFileSync(getProvidersFilePath(), "utf-8");
      const rawStore = JSON.parse(raw) as ProvidersStore;
      for (const entry of Object.values(rawStore)) {
        if (entry.apiKey && !entry.apiKey.startsWith("ENC:")) {
          needsMigration = true;
          break;
        }
      }
    } catch {
      // ignore
    }

    for (const [name, entry] of Object.entries(store)) {
      const def = PROVIDER_REGISTRY.find((p) => p.name === name);
      vault.ingest(
        name,
        entry.apiKey,
        def ? def.baseUrl : "",
        def ? def.displayName : name,
      );
    }

    if (needsMigration) {
      saveStore(store);
    }
  },

  /**
   * Drop the cached vault singleton. Used by the
   * `/fixo providers:reset` slash command and by tests.
   */
  resetVault(): void {
    resetProviderKeyVault();
  },

  /** Check if a provider key is configured. */
  has(name: string): boolean {
    const store = loadStore();
    return !!store[name];
  },

  /** Get provider definition by name. */
  getDefinition(name: string): ProviderDefinition | undefined {
    return PROVIDER_REGISTRY.find((p) => p.name === name);
  },

  /** Get all registered provider definitions. */
  getAllDefinitions(): ProviderDefinition[] {
    return PROVIDER_REGISTRY;
  },

  /**
   * Read the cached model list for `name`. Returns `null` when no
   * entry exists or when the entry is stale (older than
   * {@link MODELS_CACHE_TTL_MS}). Synchronous + read-only so the
   * `/model` picker can call it inline without awaiting.
   */
  getCachedModels(name: string): ProviderModelsCacheEntry | null {
    const store = loadModelsCache();
    const entry = store[name];
    if (!entry) return null;
    const fetchedAtMs = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(fetchedAtMs)) return null;
    if (Date.now() - fetchedAtMs > MODELS_CACHE_TTL_MS) return null;
    return entry;
  },

  /**
   * Fetch the live model list from the provider's `/models`
   * endpoint and persist it to the on-disk cache. Routes through
   * the credential vault so the raw API key never escapes into a
   * wider stack frame.
   *
   * Resolution order:
   *   1. live fetch (success → cache + return `source: 'live'`).
   *   2. fresh cache hit (within TTL) → `source: 'cache'`.
   *   3. registry `models[]` fallback → `source: 'registry-fallback'`.
   *
   * Never throws — failure modes degrade through the layers above.
   */
  async fetchRemoteModels(name: string): Promise<{
    models: string[];
    source: "live" | "cache" | "registry-fallback";
    fetchedAt: string;
  }> {
    const def = this.getDefinition(name);
    if (!def) {
      const fallback = this.getCachedModels(name);
      if (fallback) {
        return {
          models: fallback.models,
          source: "cache",
          fetchedAt: fallback.fetchedAt,
        };
      }
      return {
        models: [],
        source: "registry-fallback",
        fetchedAt: new Date().toISOString(),
      };
    }

    const registryFallback = (): {
      models: string[];
      source: "registry-fallback";
      fetchedAt: string;
    } => {
      const now = new Date().toISOString();
      // Persist a synthetic entry tagged registry-fallback so the
      // /model picker can render the `[unverified]` hint without
      // having to know whether a live fetch was ever attempted.
      const store = loadModelsCache();
      store[name] = {
        models: def.models.slice(),
        fetchedAt: now,
        source: "registry-fallback",
      };
      // safe: cache persistence is a perf optimisation only — losing
      // it means the next /model call re-runs the fallback, never
      // user-visible breakage. ENOSPC / read-only $HOME are the only
      // realistic causes.
      try {
        saveModelsCache(store);
      } catch {
        /* safe: see above */
      }
      return {
        models: def.models.slice(),
        source: "registry-fallback",
        fetchedAt: now,
      };
    };

    // No key on disk → cannot live-fetch; fall through to cache → registry.
    if (!this.has(name)) {
      const cached = this.getCachedModels(name);
      if (cached) {
        return {
          models: cached.models,
          source: "cache",
          fetchedAt: cached.fetchedAt,
        };
      }
      return registryFallback();
    }

    const liveResult = await this.withDirectCredential(name, async (cred) => {
      try {
        const headers = buildModelsRequestHeaders(name, cred.apiKey);
        const resp = await fetch(`${cred.baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const payload = await resp.json().catch(() => null);
        const ids = parseModelsResponse(payload);
        if (!ids) return null;
        const now = new Date().toISOString();
        const store = loadModelsCache();
        store[name] = { models: ids, fetchedAt: now, source: "live" };
        saveModelsCache(store);
        return { models: ids, source: "live" as const, fetchedAt: now };
      } catch {
        return null;
      }
    });

    if (liveResult) return liveResult;

    const cached = this.getCachedModels(name);
    if (cached) {
      return {
        models: cached.models,
        source: "cache",
        fetchedAt: cached.fetchedAt,
      };
    }
    return registryFallback();
  },

  /**
   * Verify an API key and fetch the live models.
   * Unlike fetchRemoteModels, this does not require the key to be saved in the manager.
   * It makes a live API call and throws if the call fails or returns non-OK status.
   */
  async verifyKeyAndFetchModels(
    name: string,
    apiKey: string,
  ): Promise<string[]> {
    const def = this.getDefinition(name);
    if (!def) {
      throw new Error(`Unknown provider: ${name}`);
    }
    const headers = buildModelsRequestHeaders(name, apiKey.trim());
    let resp;
    try {
      resp = await fetch(`${def.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      throw new Error(
        `Network error or timeout connecting to ${def.displayName}: ${err?.message ?? err}`,
      );
    }

    if (!resp.ok) {
      let detail = "";
      try {
        const body = await resp.json();
        if (body && typeof body === "object") {
          const errObj = (body as any).error;
          detail =
            errObj?.message || (body as any).message || JSON.stringify(body);
        }
      } catch {
        try {
          detail = await resp.text();
        } catch {
          // ignore
        }
      }
      const errMsg = detail ? `: ${detail.slice(0, 150)}` : "";
      throw new Error(
        `API returned status ${resp.status} ${resp.statusText}${errMsg}`,
      );
    }

    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      throw new Error("Failed to parse API response as JSON");
    }

    const ids = parseModelsResponse(payload);
    if (!ids || ids.length === 0) {
      throw new Error(
        "No models returned from API or failed to parse response",
      );
    }

    // Cache the successfully retrieved models
    const now = new Date().toISOString();
    const store = loadModelsCache();
    store[name] = { models: ids, fetchedAt: now, source: "live" };
    try {
      saveModelsCache(store);
    } catch {
      // ignore cache write error
    }

    return ids;
  },
};
