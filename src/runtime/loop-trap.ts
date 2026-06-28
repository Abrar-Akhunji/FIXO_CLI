/**
 * Loop-Trap Defenses — sha256-based repetition detection + semantic
 * target-frequency detection.
 *
 * The module owns two independent detectors that run side-by-side:
 *
 *   1. {@link LoopTrapDetector} — the original Pillar 1 detector.
 *      Operates on a three-layer composite fingerprint (tool-args,
 *      tool-result, workspace). A model that re-issues the *same*
 *      tool call with *the same* arguments on the *same* workspace
 *      triggers it.
 *
 *   2. {@link SemanticLoopDetector} — Pillar 2 of the post-mortem
 *      refit. Operates on the *resolved target path* of every file-
 *      touching tool call. Two tool calls with completely different
 *      arguments but the same target still trip this detector. The
 *      algorithm is the one specified in the architectural refit:
 *
 *          F(p) = Σ 𝟙(P(Tᵢ) = p)   over sliding window W of last N turns
 *
 *      Defaults: windowSize = 5, triggerCount = 3 (warn), hardAbortCount
 *      = 6 (throw). All three are tunable.
 *
 * Both detectors throw a typed error class (LoopTrapAbortedError /
 * SemanticLoopAbortedError) when they hard-abort. Both expose a
 * static {@link toSafetyAlertDirective} helper that produces the
 * non-negotiable system-prompt directive the caller should inject.
 *
 * The module is pure and dependency-free apart from node:crypto,
 * node:fs, and node:path. The semantic detector is fully
 * synchronous.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Public types — composite (Pillar 1) detector
// ---------------------------------------------------------------------------

/** A single turn's three-layer fingerprint. */
export interface LoopSnapshot {
  /** 0-based index of the turn that produced this snapshot. */
  readonly turnIndex: number;
  /** sha256 of canonicalised tool-call arguments. */
  readonly toolCallFingerprint: string;
  /** sha256 of the tail of the tool result. */
  readonly toolResultFingerprint: string;
  /** sha256 of the (path, content-hash) walk over the workspace. */
  readonly workspaceFingerprint: string;
  /** ISO timestamp the snapshot was recorded. */
  readonly ts: string;
}

/** Which layers contributed to a `trap-detected` verdict. */
export type LoopTrapLayer = "tool-args" | "tool-result" | "workspace";

/** The detector's verdict for a turn. */
export type LoopTrapVerdict =
  | { readonly state: "ok" }
  | {
      readonly state: "trap-detected";
      /** Composite fingerprint of the repeated turns. */
      readonly fingerprint: string;
      /** Layers that contributed to the detection. */
      readonly layers: ReadonlyArray<LoopTrapLayer>;
      /** Index of the turn that triggered the verdict. */
      readonly turnIndex: number;
      /** Number of consecutive equivalent turns. */
      readonly consecutiveCount: number;
    }
  | {
      readonly state: "hard-abort";
      /** Composite fingerprint of the repeated turns. */
      readonly fingerprint: string;
      /** Number of consecutive equivalent turns. */
      readonly consecutiveCount: number;
    };

/** Tunable thresholds. Mirrored under `preferences.safety.loopTrap`. */
export interface LoopTrapPreferences {
  /** Number of consecutive equivalent turns that triggers a directive. */
  readonly triggerCount: number;
  /** Number of consecutive equivalent turns that triggers a hard abort. */
  readonly hardAbortCount: number;
  /** Maximum number of tool-result bytes to include in the fingerprint. */
  readonly toolResultTailBytes: number;
  /** Hard cap on in-memory history to bound memory growth. */
  readonly maxHistory: number;
}

/** Default preferences — safe and well-tested. */
export const DEFAULT_LOOP_TRAP_PREFS: LoopTrapPreferences = {
  triggerCount: 3,
  hardAbortCount: 6,
  toolResultTailBytes: 1024,
  maxHistory: 64,
};

/** Thrown when the loop trap fires its hard-abort threshold. */
export class LoopTrapAbortedError extends Error {
  public readonly compositeFingerprint: string;
  public readonly consecutiveCount: number;

  constructor(compositeFingerprint: string, consecutiveCount: number) {
    super(
      `Loop-trap hard-abort after ${consecutiveCount} consecutive equivalent turns ` +
        `(composite sha256: ${compositeFingerprint.slice(0, 16)}…).`,
    );
    this.name = "LoopTrapAbortedError";
    this.compositeFingerprint = compositeFingerprint;
    this.consecutiveCount = consecutiveCount;
  }
}

// ---------------------------------------------------------------------------
// Public types — semantic (Pillar 2) detector
// ---------------------------------------------------------------------------

/** Tool names whose `path` argument should be tracked by the semantic
 *  detector. Anything not in this set contributes 0 to F(p). */
export const SEMANTIC_LOOP_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "replace_range",
  "insert_after",
  "rename_file",
  "delete_file",
]);

/** Tunable thresholds for the semantic detector. */
export interface SemanticLoopPreferences {
  /** Master kill-switch. */
  readonly enabled: boolean;
  /** Width of the sliding window W. */
  readonly windowSize: number;
  /** F(p) >= triggerCount → warn directive. */
  readonly triggerCount: number;
  /** F(p) >= hardAbortCount → throw. */
  readonly hardAbortCount: number;
}

/** Default preferences — matches the architectural spec. */
export const DEFAULT_SEMANTIC_LOOP_PREFS: SemanticLoopPreferences = {
  enabled: true,
  windowSize: 5,
  triggerCount: 3,
  hardAbortCount: 6,
};

/** A single resolved file access within the sliding window. */
export interface FileAccessRecord {
  readonly turnIndex: number;
  readonly tool: string;
  /** Resolved absolute path. */
  readonly target: string;
}

/** The semantic detector's verdict for a turn. */
export type SemanticLoopVerdict =
  | { readonly state: "ok"; target: string; count: number }
  | {
      readonly state: "warn";
      target: string;
      count: number;
      windowSize: number;
    }
  | {
      readonly state: "hard-abort";
      target: string;
      count: number;
      windowSize: number;
    };

/** Thrown when the semantic detector hard-aborts. */
export class SemanticLoopAbortedError extends Error {
  public readonly target: string;
  public readonly count: number;
  public readonly windowSize: number;

  constructor(target: string, count: number, windowSize: number) {
    super(
      `Semantic loop-trap hard-abort: target '${target}' was accessed ` +
        `${count} times within the last ${windowSize} turns. ` +
        `The agent is forbidden from accessing this file again.`,
    );
    this.name = "SemanticLoopAbortedError";
    this.target = target;
    this.count = count;
    this.windowSize = windowSize;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256 = (input: string): string =>
  crypto.createHash("sha256").update(input, "utf-8").digest("hex");

const DEFAULT_WORKSPACE_EXCLUDES: ReadonlyArray<string> = [
  ".fixo",
  ".git",
  "node_modules",
  "dist",
  ".next",
  "out",
  "build",
  "coverage",
  ".cache",
  ".turbo",
];

/**
 * Canonicalise a tool-call argument object for stable hashing. Sorts
 * keys, drops `undefined` values, and JSON-stringifies. Order of
 * keys in the input does not affect the fingerprint.
 */
export function canonicaliseArgs(args: Record<string, unknown>): string {
  const sortedKeys = Object.keys(args).sort();
  const filtered: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const value = args[key];
    if (value === undefined) continue;
    filtered[key] = value;
  }
  return JSON.stringify(filtered);
}

// ---------------------------------------------------------------------------
// LoopTrapDetector (Pillar 1 — composite fingerprint)
// ---------------------------------------------------------------------------

export class LoopTrapDetector {
  private readonly history: LoopSnapshot[] = [];
  private readonly prefs: LoopTrapPreferences;

  constructor(prefs: LoopTrapPreferences = DEFAULT_LOOP_TRAP_PREFS) {
    if (prefs.triggerCount < 1) {
      throw new Error("LoopTrapPreferences.triggerCount must be >= 1");
    }
    if (prefs.hardAbortCount < prefs.triggerCount) {
      throw new Error(
        "LoopTrapPreferences.hardAbortCount must be >= triggerCount",
      );
    }
    if (prefs.toolResultTailBytes < 64) {
      throw new Error("LoopTrapPreferences.toolResultTailBytes must be >= 64");
    }
    if (prefs.maxHistory < prefs.hardAbortCount) {
      throw new Error(
        "LoopTrapPreferences.maxHistory must be >= hardAbortCount",
      );
    }
    this.prefs = prefs;
  }

  public fingerprintToolCall(args: Record<string, unknown>): string {
    return sha256(canonicaliseArgs(args));
  }

  public fingerprintToolResult(result: string): string {
    const tail =
      result.length > this.prefs.toolResultTailBytes
        ? result.slice(result.length - this.prefs.toolResultTailBytes)
        : result;
    return sha256(tail);
  }

  public async fingerprintWorkspace(
    cwd: string,
    extraExclude: ReadonlyArray<string> = [],
  ): Promise<string> {
    const exclude = new Set<string>([
      ...DEFAULT_WORKSPACE_EXCLUDES,
      ...extraExclude,
    ]);
    const root = path.resolve(cwd);
    const entries: Array<[string, string]> = [];
    const MAX_FILES = 100_000;

    const walk = (dir: string): boolean => {
      if (entries.length >= MAX_FILES) return false;
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return true;
      }
      for (const name of names) {
        if (exclude.has(name)) continue;
        if (entries.length >= MAX_FILES) return false;
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!walk(full)) return false;
        } else if (stat.isFile()) {
          const rel = path.relative(root, full);
          let content: Buffer;
          try {
            content = fs.readFileSync(full);
          } catch {
            continue;
          }
          entries.push([rel, sha256(content.toString("binary"))]);
        }
      }
      return true;
    };

    try {
      walk(root);
    } catch {
      // Unreadable root — return an empty fingerprint so we still
      // hash the other two layers deterministically.
    }

    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const materialised = entries.map(([p, h]) => `${p}\t${h}`).join("\n");
    return sha256(materialised);
  }

  public getHistory(): ReadonlyArray<LoopSnapshot> {
    return this.history.slice();
  }

  public reset(): void {
    this.history.length = 0;
  }

  public record(snapshot: LoopSnapshot): LoopTrapVerdict {
    this.history.push(snapshot);
    if (this.history.length > this.prefs.maxHistory) {
      this.history.splice(0, this.history.length - this.prefs.maxHistory);
    }

    const composite = this.compositeFingerprint(snapshot);

    let consecutive = 1;
    const layers: LoopTrapLayer[] = [];
    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2]!;
      if (prev.toolCallFingerprint === snapshot.toolCallFingerprint) {
        layers.push("tool-args");
      }
      if (prev.toolResultFingerprint === snapshot.toolResultFingerprint) {
        layers.push("tool-result");
      }
      if (prev.workspaceFingerprint === snapshot.workspaceFingerprint) {
        layers.push("workspace");
      }
      for (let i = this.history.length - 2; i >= 0; i--) {
        const h = this.history[i]!;
        if (
          h.toolCallFingerprint === snapshot.toolCallFingerprint &&
          h.toolResultFingerprint === snapshot.toolResultFingerprint &&
          h.workspaceFingerprint === snapshot.workspaceFingerprint
        ) {
          consecutive += 1;
        } else {
          break;
        }
      }
    }

    let identicalResultAndWorkspaceCount = 1;
    if (this.history.length >= 2) {
      for (let i = this.history.length - 2; i >= 0; i--) {
        const h = this.history[i]!;
        if (
          h.toolResultFingerprint === snapshot.toolResultFingerprint &&
          h.workspaceFingerprint === snapshot.workspaceFingerprint
        ) {
          identicalResultAndWorkspaceCount += 1;
        } else {
          break;
        }
      }
    }

    const effectiveConsecutive = Math.max(
      consecutive,
      identicalResultAndWorkspaceCount,
    );

    if (effectiveConsecutive >= this.prefs.hardAbortCount) {
      return {
        state: "hard-abort",
        fingerprint: composite,
        consecutiveCount: effectiveConsecutive,
      };
    }
    if (effectiveConsecutive >= this.prefs.triggerCount) {
      return {
        state: "trap-detected",
        fingerprint: composite,
        layers:
          identicalResultAndWorkspaceCount > consecutive
            ? ["tool-result", "workspace"]
            : layers,
        turnIndex: snapshot.turnIndex,
        consecutiveCount: effectiveConsecutive,
      };
    }
    return { state: "ok" };
  }

  private compositeFingerprint(snapshot: LoopSnapshot): string {
    return sha256(
      snapshot.toolCallFingerprint +
        snapshot.toolResultFingerprint +
        snapshot.workspaceFingerprint,
    );
  }
}

// ---------------------------------------------------------------------------
// SemanticLoopDetector (Pillar 2 — sliding-window target frequency)
// ---------------------------------------------------------------------------

/**
 * Tracks the frequency of every file target across a sliding window
 * of the last N turns. Two tool calls with completely different
 * arguments but the same resolved target still collide here, which
 * is exactly what the composite (Pillar 1) detector misses.
 *
 * The detector is independent of the agent loop and safe to call
 * from synchronous code.
 */
export class SemanticLoopDetector {
  private readonly window: FileAccessRecord[] = [];
  private readonly freq = new Map<string, number>();
  private readonly prefs: SemanticLoopPreferences;

  constructor(prefs: SemanticLoopPreferences = DEFAULT_SEMANTIC_LOOP_PREFS) {
    if (prefs.windowSize < 1) {
      throw new Error("SemanticLoopPreferences.windowSize must be >= 1");
    }
    if (prefs.triggerCount < 1) {
      throw new Error("SemanticLoopPreferences.triggerCount must be >= 1");
    }
    if (prefs.hardAbortCount < prefs.triggerCount) {
      throw new Error(
        "SemanticLoopPreferences.hardAbortCount must be >= triggerCount",
      );
    }
    this.prefs = prefs;
  }

  /** Read-only view of the current sliding window. */
  public getWindow(): ReadonlyArray<FileAccessRecord> {
    return this.window.slice();
  }

  /** Frequency map (target → count in window). */
  public getFrequencies(): ReadonlyMap<string, number> {
    return new Map(this.freq);
  }

  /** Active preferences. Useful for callers that want to read the
   *  `enabled` flag without re-passing the config object. */
  public get preference(): SemanticLoopPreferences {
    return this.prefs;
  }

  /** Wipe state — call after a successful compaction. */
  public reset(): void {
    this.window.length = 0;
    this.freq.clear();
  }

  /**
   * Record a tool call against a target. Returns the verdict:
   *
   *   - 'ok'         — frequency is below triggerCount.
   *   - 'warn'       — frequency >= triggerCount. The caller should
   *                    inject the [Safety-Alert] directive.
   *   - 'hard-abort' — frequency >= hardAbortCount. The caller
   *                    should throw {@link SemanticLoopAbortedError}.
   *
   * Non-file tools (anything not in
   * {@link SEMANTIC_LOOP_TARGET_TOOLS}) and tools without a `path`
   * argument do not contribute to F(p).
   */
  public record(
    turnIndex: number,
    tool: string,
    args: Record<string, unknown>,
    cwd: string,
  ): SemanticLoopVerdict {
    if (!this.prefs.enabled) {
      return { state: "ok", target: "", count: 0 };
    }
    if (!SEMANTIC_LOOP_TARGET_TOOLS.has(tool)) {
      return { state: "ok", target: "", count: 0 };
    }
    const rawTarget = pickTargetArg(tool, args);
    if (!rawTarget) {
      return { state: "ok", target: "", count: 0 };
    }

    const resolved = safeResolve(cwd, rawTarget);
    if (!resolved) {
      return { state: "ok", target: "", count: 0 };
    }

    // Slide the window: evict the oldest record if full.
    if (this.window.length >= this.prefs.windowSize) {
      const dropped = this.window.shift();
      if (dropped) {
        const cur = this.freq.get(dropped.target) ?? 1;
        if (cur <= 1) this.freq.delete(dropped.target);
        else this.freq.set(dropped.target, cur - 1);
      }
    }

    const rec: FileAccessRecord = { turnIndex, tool, target: resolved };
    this.window.push(rec);
    const f = (this.freq.get(resolved) ?? 0) + 1;
    this.freq.set(resolved, f);

    if (f >= this.prefs.hardAbortCount) {
      return {
        state: "hard-abort",
        target: resolved,
        count: f,
        windowSize: this.window.length,
      };
    }
    if (f >= this.prefs.triggerCount) {
      return {
        state: "warn",
        target: resolved,
        count: f,
        windowSize: this.window.length,
      };
    }
    return { state: "ok", target: resolved, count: f };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pick the right argument to fingerprint for each tool. */
function pickTargetArg(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  switch (tool) {
    case "read_file":
    case "write_file":
    case "replace_range":
    case "insert_after":
    case "delete_file":
      return typeof args.path === "string" ? args.path : null;
    case "rename_file":
      return typeof args.to === "string"
        ? args.to
        : typeof args.from === "string"
          ? args.from
          : null;
    case "apply_patch": {
      // apply_patch takes a unified diff — we can't resolve individual
      // targets synchronously, so return null and let the caller
      // fall back to the composite detector.
      return null;
    }
    default:
      return null;
  }
}

function safeResolve(cwd: string, target: string): string | null {
  try {
    return path.resolve(cwd, target);
  } catch {
    return null;
  }
}

/**
 * Build the non-negotiable [Safety-Alert] directive the caller
 * should inject into the next system prompt when the semantic
 * detector warns. The wording matches the architectural spec.
 */
export function toSafetyAlertDirective(
  verdict: SemanticLoopVerdict,
): string | null {
  if (verdict.state !== "warn" && verdict.state !== "hard-abort") return null;
  return (
    `[Safety-Alert] You have queried or modified the target path '${verdict.target}' ` +
    `more than 3 times in your recent sequence. Your current approach is looping. ` +
    `You are forbidden from calling read_file or replace_file on this path in your next turn. ` +
    `You must either analyze alternative file dependencies, consult different workspace ` +
    `symbols, or request direct user guidance.`
  );
}

/** Build the [Loop-Trap] directive used by the composite detector. */
export function toLoopTrapDirective(verdict: LoopTrapVerdict): string | null {
  if (verdict.state !== "trap-detected") return null;
  return (
    `[Loop-Trap] Detected ${verdict.consecutiveCount} consecutive equivalent turns. ` +
    `Reconsider your strategy before issuing the next tool call.`
  );
}
