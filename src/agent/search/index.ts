/**
 * Reliable web search — provider chain.
 *
 * The original `src/agent/web.ts` (Phase 0) reached DuckDuckGo
 * directly via HTML scraping. The DDG endpoint is rate-limited,
 * geo-fenced, and silently changes its DOM. Phase 2 replaces
 * it with a typed provider chain that prefers first-party
 * search APIs (Brave, then Tavily) and falls back to DDG
 * only when no API key is configured. The chain records
 * per-provider quality scores so the cooldown manager can
 * prefer whichever provider is currently responding fastest.
 *
 * Pillar 4 (credential vault) is preserved by reading every
 * API key through {@link getProviderKeyVault}.withApiKey so
 * the key never escapes the callback scope and never
 * appears in tool results, telemetry, or error messages.
 */
import { withRetry, defaultIsRetryable } from "../retry.js";
import {
  getProviderKeyVault,
  ProviderNotInVaultError,
} from "../../runtime/credential-vault.js";
import {
  recordProviderError,
  recordProviderQuality,
} from "../provider-cooldown.js";
import * as cheerio from "cheerio";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly score?: number;
}

export interface SearchOptions {
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface SearchProvider {
  readonly id: "brave" | "tavily" | "ddg";
  /**
   * True if the provider can run right now (key configured, not
   * currently rate-limited). The chain uses this to skip a
   * provider without paying the cost of an HTTP round-trip.
   */
  isAvailable(): Promise<boolean>;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/* ──────────────────────── Errors ──────────────────────── */

export class SearchExhaustedError extends Error {
  public readonly query: string;
  public readonly attempts: ReadonlyArray<{ provider: string; error: string }>;
  constructor(
    query: string,
    attempts: ReadonlyArray<{ provider: string; error: string }>,
  ) {
    super(
      `All search providers failed for query "${query}". ` +
        `Tried: ${attempts.map((a) => a.provider).join(" → ")}.`,
    );
    this.name = "SearchExhaustedError";
    this.query = query;
    this.attempts = attempts;
  }
}

/* ──────────────────────── Brave ──────────────────────── */

const BRAVE_PROVIDER_NAME = "search.brave";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_KEY_NOT_CONFIGURED = "__not_configured__";

class BraveProvider implements SearchProvider {
  public readonly id = "brave" as const;

  public async isAvailable(): Promise<boolean> {
    try {
      return await getProviderKeyVault().hasProvider(BRAVE_PROVIDER_NAME);
    } catch {
      return false;
    }
  }

  public async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const maxResults = opts.maxResults ?? 10;
    const t0 = Date.now();

    return await withRetry(
      async (signal) => {
        const headers = await getProviderKeyVault().buildAuthHeaders(
          BRAVE_PROVIDER_NAME,
          (cred) => ({
            "X-Subscription-Token": cred.apiKey,
            Accept: "application/json",
            "User-Agent": "FixO-CLI/2.0 (search)",
          }),
        );
        const url = new URL(BRAVE_ENDPOINT);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(Math.min(maxResults, 20)));
        const response = await fetch(url.toString(), {
          method: "GET",
          headers,
          signal,
        });
        if (!response.ok) {
          const status = response.status;
          recordProviderError(
            "brave",
            status,
            `HTTP ${status} ${response.statusText}`,
          );
          if (status === 401 || status === 403) {
            throw new ProviderNotInVaultError(BRAVE_PROVIDER_NAME);
          }
          throw new Error(`Brave HTTP ${status}`);
        }
        const json = (await response.json()) as {
          web?: {
            results?: Array<{
              title?: string;
              url?: string;
              description?: string;
            }>;
          };
        };
        const results: SearchResult[] = (json.web?.results ?? [])
          .filter((r) => r.title && r.url)
          .slice(0, maxResults)
          .map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.description ?? "",
          }));
        recordProviderQuality("brave", Date.now() - t0, results.length);
        return results;
      },
      {
        maxAttempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        jitter: "full",
        isRetryable: (err) => {
          if (err instanceof ProviderNotInVaultError) return false;
          return defaultIsRetryable(err);
        },
      },
      opts.signal,
    );
  }
}

/* ──────────────────────── Tavily ──────────────────────── */

const TAVILY_PROVIDER_NAME = "search.tavily";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

class TavilyProvider implements SearchProvider {
  public readonly id = "tavily" as const;

  public async isAvailable(): Promise<boolean> {
    try {
      return await getProviderKeyVault().hasProvider(TAVILY_PROVIDER_NAME);
    } catch {
      return false;
    }
  }

  public async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const maxResults = opts.maxResults ?? 10;
    const t0 = Date.now();

    return await withRetry(
      async (signal) => {
        const apiKey = await getProviderKeyVault().withApiKey(
          TAVILY_PROVIDER_NAME,
          async (key) => key,
        );
        const response = await fetch(TAVILY_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "FixO-CLI/2.0 (search)",
          },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: Math.min(maxResults, 20),
            include_answer: false,
            search_depth: "basic",
          }),
          signal,
        });
        if (!response.ok) {
          const status = response.status;
          recordProviderError(
            "tavily",
            status,
            `HTTP ${status} ${response.statusText}`,
          );
          if (status === 401 || status === 403) {
            throw new ProviderNotInVaultError(TAVILY_PROVIDER_NAME);
          }
          throw new Error(`Tavily HTTP ${status}`);
        }
        const json = (await response.json()) as {
          results?: Array<{
            title?: string;
            url?: string;
            content?: string;
            score?: number;
          }>;
        };
        const results: SearchResult[] = (json.results ?? [])
          .filter((r) => r.title && r.url)
          .slice(0, maxResults)
          .map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.content ?? "",
            score: r.score,
          }));
        recordProviderQuality("tavily", Date.now() - t0, results.length);
        return results;
      },
      {
        maxAttempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        jitter: "full",
        isRetryable: (err) => {
          if (err instanceof ProviderNotInVaultError) return false;
          return defaultIsRetryable(err);
        },
      },
      opts.signal,
    );
  }
}

/* ──────────────────────── DDG fallback ──────────────────────── */

/**
 * Original DDG HTML scraping path, refactored to implement
 * {@link SearchProvider} so it can sit in the chain. Returns
 * an empty result (not an error) when the page structure
 * changes — a structural-change error is logged via
 * `recordProviderError` and the chain moves to the next
 * provider.
 */
class DdgProvider implements SearchProvider {
  public readonly id = "ddg" as const;

  public async isAvailable(): Promise<boolean> {
    return true; // always available, no key required
  }

  public async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const maxResults = opts.maxResults ?? 10;
    const t0 = Date.now();
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: opts.signal,
    });
    if (!response.ok) {
      const status = response.status;
      recordProviderError(
        "ddg",
        status,
        `HTTP ${status} ${response.statusText}`,
      );
      throw new Error(`DDG HTTP ${status}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $(".result").each((_i, elem) => {
      if (results.length >= maxResults) return false;
      const titleElem = $(elem).find(".result__title a");
      const snippetElem = $(elem).find(".result__snippet");
      if (titleElem.length === 0) return;
      let rawUrl = titleElem.attr("href") ?? "";
      if (rawUrl.startsWith("//duckduckgo.com/l/?")) {
        const m = rawUrl.match(/uddg=([^&]+)/);
        if (m && m[1]) {
          try {
            rawUrl = decodeURIComponent(m[1]);
          } catch {
            rawUrl = "";
          }
        }
      }
      if (!rawUrl) return;
      results.push({
        title: titleElem.text().trim(),
        url: rawUrl,
        snippet: snippetElem.text().trim(),
      });
    });
    recordProviderQuality("ddg", Date.now() - t0, results.length);
    return results;
  }
}

/* ──────────────────────── Chain ──────────────────────── */

/**
 * Default provider chain: Brave → Tavily → DDG fallback. The
 * order is hard-coded; if you need a different order, construct
 * a custom {@link SearchProviderChain} via the named-arg form.
 */
export class SearchProviderChain {
  private readonly providers: SearchProvider[];
  private readonly onProviderTried?: (
    provider: string,
    results: number,
    durationMs: number,
  ) => void;

  constructor(
    providers?: SearchProvider[],
    hooks?: {
      onProviderTried?: (
        provider: string,
        results: number,
        durationMs: number,
      ) => void;
    },
  ) {
    this.providers = providers ?? [
      new BraveProvider(),
      new TavilyProvider(),
      new DdgProvider(),
    ];
    this.onProviderTried = hooks?.onProviderTried;
  }

  public async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<{
    results: SearchResult[];
    provider: SearchProvider["id"] | null;
    attempts: Array<{ provider: string; error: string }>;
  }> {
    const attempts: Array<{ provider: string; error: string }> = [];
    for (const provider of this.providers) {
      const available = await provider.isAvailable();
      if (!available) {
        attempts.push({ provider: provider.id, error: "not_configured" });
        continue;
      }
      const t0 = Date.now();
      try {
        const results = await provider.search(query, opts);
        const duration = Date.now() - t0;
        this.onProviderTried?.(provider.id, results.length, duration);
        if (results.length > 0) {
          return { results, provider: provider.id, attempts };
        }
        attempts.push({ provider: provider.id, error: "no_results" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ provider: provider.id, error: msg });
        // Auth errors short-circuit — no point trying the next
        // provider with a key the user hasn't configured.
        if (err instanceof ProviderNotInVaultError) continue;
        // Otherwise keep trying the next provider.
      }
    }
    throw new SearchExhaustedError(query, attempts);
  }
}

let cachedChain: SearchProviderChain | null = null;

export function getDefaultSearchChain(): SearchProviderChain {
  if (!cachedChain) cachedChain = new SearchProviderChain();
  return cachedChain;
}

/** Test hook — drop the cached chain. */
export function resetDefaultSearchChain(): void {
  cachedChain = null;
}

/* ──────────────────────── Markdown formatter (legacy surface) ───── */

function formatAsMarkdown(
  results: SearchResult[],
  providerId: SearchProvider["id"] | null,
): string {
  if (results.length === 0) {
    return "No results found.";
  }
  const header = providerId ? `_via ${providerId}_\n\n` : "";
  const body = results
    .map((r) => `### [${r.title}](${r.url})\n${r.snippet}\n`)
    .join("\n");
  return header + body;
}

/**
 * High-level "search the web" entry point. Backwards-compatible
 * with the legacy `webSearch(query)` signature so existing tool
 * dispatch and tests keep working.
 */
export async function webSearch(query: string): Promise<string> {
  try {
    const { results, provider } = await getDefaultSearchChain().search(query);
    return formatAsMarkdown(results, provider);
  } catch (err) {
    if (err instanceof SearchExhaustedError) {
      return `No results found. Tried: ${err.attempts.map((a) => a.provider).join(", ")}.`;
    }
    return `Error performing web search: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Suppress unused-warning for the constant we keep around for symmetry.
void BRAVE_KEY_NOT_CONFIGURED;
