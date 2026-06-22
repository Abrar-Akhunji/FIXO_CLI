import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { PolicyProfile } from './runtime/policy.js';

export const DEFAULT_API_URL = 'https://freellm-liart.vercel.app/v1';

/**
 * How the CLI authenticates against an LLM backend.
 *
 *  - `direct` — Requests go straight to a provider (OpenAI, Anthropic,
 *               Groq, etc.) using a key the user pasted at setup. Zero
 *               traffic to the FreeLLMAPI proxy. This is the default
 *               for fresh installs starting with v1.1.
 *  - `proxy`  — Requests transit the FreeLLMAPI proxy at
 *               {@link DEFAULT_API_URL} (or a custom URL). Opt-in
 *               convenience for users who want load-balanced failover
 *               across free-tier providers without managing keys.
 */
export type ProviderMode = 'direct' | 'proxy';

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

/**
 * Sandbox mode for `run_command` execution.
 *
 *  - `guard`        — Today's behaviour. The in-process command-parser
 *                     regex layer + WorkspaceGuard path-boundary checks
 *                     are the only line of defence. Fast, no platform
 *                     dependencies, no behaviour change.
 *  - `os-sandbox`   — Opt-in. Wraps every shell command in an
 *                     OS-enforced sandbox (`sandbox-exec` on macOS,
 *                     `bwrap` on Linux). Blocks writes outside the
 *                     workspace + tmpdir even when the regex guard is
 *                     bypassed by a creative command. Requires the
 *                     platform binary to be present; surfaces a
 *                     structured error otherwise rather than silently
 *                     downgrading to `guard`.
 *
 * Always combined with the regex/guard layer — defence in depth.
 */
export type SandboxMode = 'guard' | 'os-sandbox';

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
  /** OS-level sandbox for `run_command`. Defaults to `'guard'`. */
  sandboxMode?: SandboxMode;
  /**
   * Phase 2 — automatic post-edit verification. When `true` (default)
   * AND the run is in BUILD mode AND at least one file-mutating tool
   * was called, the agent runs the project's detected test/typecheck
   * command at the end of the tool loop and — if it fails — pushes a
   * repair-request message back to the model up to
   * {@link autoVerifyMaxRepairs} times before returning.
   *
   * Set to `false` to restore the pre-Phase-2 "trust the model"
   * behaviour. Cheap-to-detect projects (no test/typecheck command in
   * {@link import('./project-memory.js').detectProjectFacts}) silently
   * skip the verifier — there's nothing to run.
   */
  autoVerify?: boolean;
  /**
   * Maximum number of automatic repair turns the verifier may use in
   * one run. The default of 1 was chosen so a long-horizon task gets
   * exactly one self-correction shot — enough to catch obvious type
   * errors without spinning forever on hard failures.
   */
  autoVerifyMaxRepairs?: number;
}

/* ──────────────────────── Agent Subsystem Configuration ──────────────────────── */

/**
 * Phase 5 — Agent Pool tuning surface.
 *
 * Controls the concurrency and per-subtask budget of the orchestrator's
 * parallel worker pool. All defaults match the constants that were
 * hardcoded in `agent-pool.ts` before this namespace existed, so adding
 * the namespace alone is a zero-behavior-change refactor.
 */
export interface AgentPoolConfig {
  /** Maximum concurrent worker subtasks. Default 3. */
  concurrencyLimit: number;
  /** Tool-call budget per subtask. Default 12 (raised to 40 in Phase 4a). */
  subtaskBudget: number;
  /**
   * When true, successful peer subtasks are committed even if siblings
   * fail (Phase 2). Default false; flipped in Phase 7 after the regression
   * harness validates the partial-commit path.
   */
  preservePartialOnFailure: boolean;
}

/**
 * Phase 5 — loop-mitigation policy.
 *
 * The legacy `LoopMitigationTracker` (loop-mitigation.ts) blocks reads
 * on a target permanently once the warn threshold trips. Phase 1b adds a
 * sliding-window alternative; this config selects between them.
 */
export interface AgentLoopGuardConfig {
  /**
   * When true, block accounting uses a sliding window of tool calls
   * instead of session-lifetime lockout. Default false in phase 1b;
   * flipped to true in Phase 7 after soak.
   */
  useSlidingWindow: boolean;
  /** Sliding-window size in tool calls. Default 10. Ignored when sliding is off. */
  blockWindowTurns: number;
  /**
   * When true, the loop-mitigation tracker is reset between orchestrator
   * subtasks so one stuck subtask cannot poison the rest of the run.
   * Default true.
   */
  blockResetOnSubtask: boolean;
}

/**
 * Phase 5 — routing-honor policy.
 *
 * The router currently surfaces a "model unverified for autonomous DAG
 * execution" warning but routes to the Orchestrator anyway. Phase 6
 * makes the warning actionable.
 */
export interface AgentRoutingConfig {
  /**
   * When true, Complex-classified tasks on models NOT in the
   * verified-DAG list are routed to SingleAgent. Default false in
   * Phase 0; flipped to true in Phase 6.
   */
  honorVerificationFlag: boolean;
  /**
   * Override that permits unverified-model DAG execution even when
   * `honorVerificationFlag` is true. For power users who explicitly
   * accept the risk. Default false.
   */
  allowUnverifiedDag: boolean;
}

export interface AgentConfig {
  pool: AgentPoolConfig;
  loopGuard: AgentLoopGuardConfig;
  routing: AgentRoutingConfig;
}

/**
 * Phase 3.3 — repo-map scan caps.
 *
 * Controls how aggressively `buildRepoMap` walks the workspace.
 * Both fields are optional; defaults track the pre-Phase-3.3
 * constants (depth 4, 200 files) so existing users see no
 * behaviour change. Increase these on large repos where the
 * default cap truncates important directories.
 */
export interface RepoMapConfig {
  /** Maximum recursion depth. Default 4. */
  maxDepth?: number;
  /** Maximum files per directory. Default 200. */
  maxFiles?: number;
}

/**
 * Phase 2.4 — local fast/heavy-tier model substitution.
 *
 * When a code path tags its request with `required_capabilities`,
 * the client looks up the corresponding tier in this table and
 * substitutes the locally-configured model BEFORE issuing the
 * request. Works in both direct and proxy modes — direct sends the
 * substituted model to the provider; proxy still sees the
 * substitution as well as the legacy metadata headers.
 *
 * Per-tier semantics:
 *   - `fast`    — used for planner classification, complexity
 *                  routing, summary turns. Optimise for latency
 *                  + cost; quality is less important.
 *   - `heavy`   — used for the orchestrator's plan() and any
 *                  call that asks for `'heavy'`. Optimise for
 *                  quality.
 *   - `default` — fallback when a request asks for a capability
 *                  the user hasn't configured; equivalent to
 *                  not substituting at all.
 *
 * All three fields are optional. When a tier is unset, the
 * client falls through to the model the caller passed.
 */
export interface ModelRoutingConfig {
  fast?: string;
  default?: string;
  heavy?: string;
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
  /**
   * Authentication mode. New installs default to `'direct'`. Existing
   * configs that predate this field are inferred at load time:
   * presence of `freellmapi_api_key` means `'proxy'`, absence means
   * `'direct'`. Never undefined after {@link loadConfig} returns.
   */
  provider_mode: ProviderMode;
  /**
   * When `provider_mode === 'direct'`, identifies the provider the
   * user selected at setup time and the default model to use for new
   * sessions. The actual API key lives in the providers store
   * (`~/.fixocli/providers.json`) and the in-memory credential vault,
   * never here.
   */
  directProvider?: {
    name: string;
    defaultModel: string;
  };
  freellmapi_api_key?: string;
  apiUrl?: string;
  defaultModel: string;
  /** Persisted across launches so the next boot auto-reconnects. */
  lastSession?: {
    provider: string;      // e.g. "google"
    model: string;         // e.g. "gemini-2.5-pro"
    updatedAt: string;     // ISO timestamp
  };
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
    /**
     * Phase 2.4 — per-capability model substitution. Optional. See
     * {@link ModelRoutingConfig}.
     */
    modelRouting?: ModelRoutingConfig;
    /**
     * Phase 3.3 — repo-map walk caps. Optional. See
     * {@link RepoMapConfig}.
     */
    repoMap?: RepoMapConfig;
    /**
     * Phase 5 — Agent subsystem tunables (pool, loop guard, routing).
     * Optional. Missing fields fall through to the defaults in
     * {@link getDefaultConfig}. See {@link AgentConfig}.
     */
    agent?: AgentConfig;
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
    provider_mode: 'direct',
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
        sandboxMode: 'guard',
        autoVerify: true,
        autoVerifyMaxRepairs: 1,
      },
      agent: {
        pool: {
          concurrencyLimit: 3,
          subtaskBudget: 12,
          preservePartialOnFailure: false,
        },
        loopGuard: {
          useSlidingWindow: false,
          blockWindowTurns: 10,
          blockResetOnSubtask: true,
        },
        routing: {
          honorVerificationFlag: false,
          allowUnverifiedDag: false,
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
    const parsedAgent =
      (parsedPreferences as { agent?: Partial<AgentConfig> }).agent ?? {};
    const parsedAgentPool =
      (parsedAgent as { pool?: Partial<AgentPoolConfig> }).pool ?? {};
    const parsedAgentLoopGuard =
      (parsedAgent as { loopGuard?: Partial<AgentLoopGuardConfig> }).loopGuard ?? {};
    const parsedAgentRouting =
      (parsedAgent as { routing?: Partial<AgentRoutingConfig> }).routing ?? {};
    // Back-compat: existing configs predating v1.1 don't have
    // `provider_mode`. If they have a FreeLLMAPI key they were
    // implicitly proxy users; otherwise they're either fresh or
    // explicitly direct. Never silently flip an existing user.
    const inferredMode: ProviderMode =
      parsed.provider_mode ?? (parsed.freellmapi_api_key ? 'proxy' : 'direct');

    return {
      ...defaults,
      ...parsed,
      provider_mode: inferredMode,
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
        agent: {
          pool: {
            ...defaults.preferences.agent!.pool,
            ...parsedAgentPool,
          },
          loopGuard: {
            ...defaults.preferences.agent!.loopGuard,
            ...parsedAgentLoopGuard,
          },
          routing: {
            ...defaults.preferences.agent!.routing,
            ...parsedAgentRouting,
          },
        },
      },
    };
  } catch {
    // File missing, corrupt, or otherwise unreadable — use defaults.
    return getDefaultConfig();
  }
}

// ---------------------------------------------------------------------------
// Agent subsystem helpers (Phase 5 — see AgentConfig)
// ---------------------------------------------------------------------------

/**
 * Returns the resolved {@link AgentConfig} from the loaded config.
 * Guaranteed non-null — falls back to defaults for old configs that
 * predate this namespace.
 */
export function getAgentConfig(config?: FreeLLMConfig): AgentConfig {
  const cfg = config ?? loadConfig();
  if (cfg.preferences.agent) return cfg.preferences.agent;
  return getDefaultConfig().preferences.agent!;
}

export function getAgentPoolConfig(config?: FreeLLMConfig): AgentPoolConfig {
  return getAgentConfig(config).pool;
}

export function getAgentLoopGuardConfig(config?: FreeLLMConfig): AgentLoopGuardConfig {
  return getAgentConfig(config).loopGuard;
}

export function getAgentRoutingConfig(config?: FreeLLMConfig): AgentRoutingConfig {
  return getAgentConfig(config).routing;
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
