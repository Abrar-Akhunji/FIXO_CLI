import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { PolicyProfile } from './runtime/policy.js';

export const DEFAULT_API_URL = 'https://api.freellmapi.com/v1';

/** Stream-resume policy. */
export type StreamResumePolicy = 'auto' | 'never';

/**
 * Context-budget policy.
 *  - `auto`     — proactive enforcement is enabled and, if the enforcer
 *                 asks for compaction, the agent summarises the oldest
 *                 turns via an LLM call. (default)
 *  - `truncate` — proactive enforcement runs but the agent will NOT
 *                 trigger LLM-based compaction. If even the enforcer
 *                 cannot fit the budget, the request is sent anyway
 *                 (and may 413).
 *  - `never`    — kill-switch. No enforcement, no compaction. Useful
 *                 when a user wants exact 1:1 historical behaviour.
 */
export type ContextBudgetPolicy = 'auto' | 'truncate' | 'never';

/** Resilience preferences for the new withRetry + chatStreamWithResume paths. */
export interface ResilienceConfig {
  /** When 'auto', mid-stream cuts are resumed transparently (default). */
  streamResume: StreamResumePolicy;
  /** Max additional resume attempts after a mid-stream cut. */
  maxResumeAttempts: number;
  /** When true, the new withRetry engine is used for non-streaming calls. */
  useWithRetry: boolean;
  /**
   * Context-budget policy. When 'auto' or 'truncate', the
   * {@link ContextBudgetEnforcer} runs before every LLM call and
   * trims the conversation to fit the model's input window. When
   * 'auto', the agent may also call `compact()` to summarise the
   * oldest turns.
   */
  contextBudget: ContextBudgetPolicy;
  /**
   * Fraction of the model context window to use as the hard cap when
   * enforcing the budget. 0.8 leaves 20% headroom for the response.
   */
  contextBudgetRatio: number;
}

/**
 * Global configuration for the FixO CLI.
 * Persisted at `~/.fixocli/config.json`.
 */
export interface FreeLLMConfig {
  freellmapi_api_key?: string;
  apiUrl?: string;
  defaultModel: string;
  preferences: {
    autoCommit: boolean;
    streaming: boolean;
    theme: 'dark' | 'light';
    maxRetries: number;
    policy: PolicyProfile;
    telemetry: boolean;
    resilience: ResilienceConfig;
  };
  _firstRunComplete: boolean;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the FixO CLI config directory (`~/.fixocli/`). */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.fixocli');
}

/** Returns the full path to the config file (`~/.fixocli/config.json`). */
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/** Returns the full path to the prompt history log (`~/.fixocli/history.jsonl`). */
export function getHistoryPath(): string {
  return path.join(getConfigDir(), 'history.jsonl');
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

/** Returns a complete default configuration object. */
export function getDefaultConfig(): FreeLLMConfig {
  return {
    defaultModel: 'auto',
    preferences: {
      autoCommit: false,
      streaming: true,
      theme: 'dark',
      maxRetries: 3,
      policy: 'shell-confirm',
      telemetry: true,
      resilience: {
        streamResume: 'auto',
        maxResumeAttempts: 3,
        useWithRetry: true,
        contextBudget: 'auto',
        contextBudgetRatio: 0.8,
      },
    },
    _firstRunComplete: false,
  };
}

/**
 * Reads `~/.fixocli/config.json` and returns the parsed config.
 * If the file doesn't exist or is unreadable, a default config is returned
 * instead — the caller can then decide whether to run the setup wizard.
 */
export function loadConfig(): FreeLLMConfig {
  const configPath = getConfigPath();

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FreeLLMConfig>;
    const defaults = getDefaultConfig();

    // Merge top-level keys while keeping nested `preferences` safe.
    // `resilience` is deep-merged so old configs that predate a new
    // resilience field still pick up the new default.
    const parsedPreferences = parsed.preferences ?? {};
    const parsedResilience =
      (parsedPreferences as { resilience?: Partial<ResilienceConfig> }).resilience ?? {};
    return {
      ...defaults,
      ...parsed,
      preferences: {
        ...defaults.preferences,
        ...parsedPreferences,
        resilience: {
          ...defaults.preferences.resilience,
          ...parsedResilience,
        },
      },
    };
  } catch {
    // File missing, corrupt, or otherwise unreadable — use defaults.
    return getDefaultConfig();
  }
}

/**
 * Persists the given config to `~/.fixocli/config.json`.
 * Creates the config directory if it doesn't already exist.
 */
export function saveConfig(config: FreeLLMConfig): void {
  const dir = getConfigDir();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });

  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Ignore OS limitations
  }
}
