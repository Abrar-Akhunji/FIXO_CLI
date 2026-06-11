import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { PolicyProfile } from './runtime/policy.js';

export const DEFAULT_API_URL = 'https://freellm-liart.vercel.app/v1';

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

/* ──────────────────────── Safety Configuration ──────────────────────── */

/**
 * Loop-trap configuration. Lives under `preferences.safety.loopTrap`
 * (not `preferences.resilience`) so the safety and resilience
 * concerns remain orthogonal.
 *
 * The defaults match the design decision: warn at 3 consecutive
 * equivalent turns (acts as an intentional psychological disruptor
 * to the LLM via system-prompt injection), hard-abort at 6.
 */
export interface LoopTrapPolicy {
  /** Number of consecutive equivalent turns that triggers a directive. */
  triggerCount: number;
  /** Number of consecutive equivalent turns that triggers a hard abort. */
  hardAbortCount: number;
  /** Maximum number of tool-result bytes to include in the fingerprint. */
  toolResultTailBytes: number;
  /** Hard cap on in-memory history to bound memory growth. */
  maxHistory: number;
  /** Master kill-switch; when false, the detector is never invoked. */
  enabled: boolean;
}

/** Semantic loop-trap configuration. Tracks file-target frequency
 *  inside a sliding window so that an LLM which varies its search
 *  arguments but keeps hammering the same file still trips. */
export interface SemanticLoopTrapPolicy {
  enabled: boolean;
  windowSize: number;
  triggerCount: number;
  hardAbortCount: number;
}

/**
 * Tool-call budget policy. The agent loop runs at most `softLimit`
 * tool calls per task. When `autoExtend` is enabled, the agent may
 * extend up to `hardLimit` as long as the semantic loop detector
 * has not warned — i.e. as long as the agent is still making
 * forward progress rather than thrashing on the same file. The
 * hard limit is the absolute ceiling.
 */
export interface ToolCallBudgetPolicy {
  /** Initial cap. Defaults to 50. */
  softLimit: number;
  /** Absolute ceiling reachable via auto-extension. Defaults to 100. */
  hardLimit: number;
  /** When true, the soft limit silently extends if no loop is detected. */
  autoExtend: boolean;
  /**
   * Multiplier applied to `hardLimit` when the loop has invoked only
   * read-only tools so far (no `write_file`, `apply_patch`, `sed -i`,
   * `run_command`, etc.). Investigation-shaped tasks — audits, reviews,
   * "find vulnerabilities" — often need to read 80+ files before
   * answering. Defaults to 3, giving a ceiling of `hardLimit * 3` (300
   * with the default 100 hard limit). Snaps back to `hardLimit` the
   * instant the agent runs a mutating tool. Set to 1 to disable.
   */
  investigationMultiplier: number;
}

/** Pre-save gate severity. */
export type LspPreSaveMode = 'off' | 'warn' | 'block' | 'sandbox-mock';

/** Safety preferences — Pillar 1, 2, 3 surface. Pillar 4 lives in the
 *  credential vault module, not in the user-facing config. */
export interface SafetyConfig {
  /** Run file writes through the atomic shadow-staging pipeline. */
  atomicStaging: boolean;
  /** Staged writes older than this (ms) are eligible for auto-GC. */
  stagingTtlMs: number;
  /** How to react to LSP diagnostics on a staged write. */
  lspPreSave: LspPreSaveMode;
  /** Loop-trap thresholds. */
  loopTrap: LoopTrapPolicy;
  /** Semantic loop-trap thresholds (Pillar 2 of the refit). */
  semanticLoopTrap: SemanticLoopTrapPolicy;
  /** Maximum bytes a file may be before read_file is gated by the
   *  structural pre-scan rule. Defaults to 15 KiB. */
  largeFileGateBytes: number;
  /** Maximum line count before read_file is gated. Defaults to 350. */
  largeFileGateLines: number;
  /**
   * Predictive context-budget gate (Phase 4). When set to a value in
   * (0, 1], `read_file` projects the token cost of the read against
   * the model's input window and defers if projected total exceeds
   * this fraction. Default 0.85. Set to 1.0 to disable.
   */
  predictiveBudgetPct?: number;
  /** Tool-call budget — see {@link ToolCallBudgetPolicy}. */
  toolCalls: ToolCallBudgetPolicy;
}

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
    /**
     * Local NDJSON sink. Defaults to true. When false, no events are
     * written to `~/.fixocli/telemetry.jsonl` — useful for users who
     * want to keep their disk private but still want to send events
     * to the remote sink.
     */
    telemetryLocal: boolean;
    /**
     * Remote HTTP sink (legacy). Defaults to false. When true, the
     * legacy `logTelemetry` HTTP poster is re-enabled alongside the
     * local sink. The free FixO API server collects anonymous usage
     * stats so we can prioritise provider fixes.
     */
    telemetryRemote: boolean;
    resilience: ResilienceConfig;
    /**
     * Safety preferences — orthogonal to `resilience`.
     *
     * - `resilience` keeps the system alive through network noise.
     * - `safety`     keeps the system from corrupting the user's
     *                 workspace or leaking secrets.
     *
     * Pillar 1 (loop-trap), Pillar 2 (atomic staging), and Pillar 3
     * (LSP pre-save) are wired up here. Pillar 4 (credential vault)
     * is a programmatic-only surface and is not user-configurable.
     */
    safety: SafetyConfig;
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
      telemetryLocal: true,
      telemetryRemote: false,
      resilience: {
        streamResume: 'auto',
        maxResumeAttempts: 3,
        useWithRetry: true,
        contextBudget: 'auto',
        contextBudgetRatio: 0.8,
      },
      safety: {
        atomicStaging: true,
        stagingTtlMs: 24 * 60 * 60 * 1000,
        lspPreSave: 'warn',
        loopTrap: {
          triggerCount: 3,
          hardAbortCount: 6,
          toolResultTailBytes: 1024,
          maxHistory: 64,
          enabled: true,
        },
        semanticLoopTrap: {
          enabled: true,
          windowSize: 5,
          triggerCount: 3,
          hardAbortCount: 6,
        },
        largeFileGateBytes: 15 * 1024,
        largeFileGateLines: 350,
        toolCalls: {
          softLimit: 50,
          hardLimit: 100,
          autoExtend: true,
          investigationMultiplier: 3,
        },
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
    // `resilience` and `safety` are deep-merged so old configs that
    // predate a new field still pick up the new default.
    const parsedPreferences = parsed.preferences ?? {};
    const parsedResilience =
      (parsedPreferences as { resilience?: Partial<ResilienceConfig> }).resilience ?? {};
    const parsedSafety =
      (parsedPreferences as { safety?: Partial<SafetyConfig> }).safety ?? {};
    const parsedLoopTrap =
      (parsedSafety as { loopTrap?: Partial<LoopTrapPolicy> }).loopTrap ?? {};
    const parsedSemanticLoopTrap =
      (parsedSafety as { semanticLoopTrap?: Partial<SemanticLoopTrapPolicy> })
        .semanticLoopTrap ?? {};
    const parsedToolCalls =
      (parsedSafety as { toolCalls?: Partial<ToolCallBudgetPolicy> }).toolCalls ?? {};
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
        safety: {
          ...defaults.preferences.safety,
          ...parsedSafety,
          loopTrap: {
            ...defaults.preferences.safety.loopTrap,
            ...parsedLoopTrap,
          },
          semanticLoopTrap: {
            ...defaults.preferences.safety.semanticLoopTrap,
            ...parsedSemanticLoopTrap,
          },
          toolCalls: {
            ...defaults.preferences.safety.toolCalls,
            ...parsedToolCalls,
          },
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
