/**
 * predictive-gate.ts — token-aware predictive read gate.
 *
 * Phase 4 spec:
 *   - The existing 15 KiB / 350-line byte gate in `executeReadFile`
 *     is a cheap pre-filter. It does not know about the *current*
 *     conversation pressure, so a series of small reads can still
 *     blow the window.
 *   - This module adds a second tier: before we read a file, we
 *     estimate its token cost via `gpt-tokenizer` and compare the
 *     projected total (conversation + file) against the model's
 *     effective input limit. If the projected total exceeds the
 *     configured pct (default 85%), we defer and return a
 *     directive telling the model to use the surgical alternative.
 *
 * Layering:
 *   read_file dispatch
 *     ├── existing byte gate  (cheapest)
 *     └── predictive gate     (this module — fires only when byte gate passes)
 *
 * Fail-open: any error in encoding or model resolution allows the
 * read to proceed. The gate is an optimisation, never a correctness
 * boundary, so availability beats precision.
 */

import fs from 'node:fs';
import { countTokens } from './tokenizer.js';
import { resolveModelContextLimit } from './conversation.js';

/** ~4 bytes per token is the industry-standard rough estimate for English text. */
const FALLBACK_BYTES_PER_TOKEN = 4;

/** Cap the sample we tokenise to keep cold reads predictable. */
const SAMPLE_BYTES = 16 * 1024;

/** Default fraction of the model window we will let the next read fill. */
export const DEFAULT_PREDICTIVE_BUDGET_PCT = 0.85;

export interface ReadEstimate {
  /** File size in bytes (0 if the file is missing). */
  readonly bytes: number;
  /** Estimated token cost of reading the full file. */
  readonly projectedTokens: number;
  /** True if the file could be tokenised exactly (small enough to fit in sample). */
  readonly exact: boolean;
}

export interface DeferDecision {
  /** True if the caller should NOT read the file. */
  readonly defer: boolean;
  /** Human-readable explanation. */
  readonly reason: string;
  /** Projected total tokens (conversation + read). */
  readonly projectedTotal: number;
  /** Effective hard cap used for the decision. */
  readonly hardCap: number;
}

/**
 * Estimate the token cost of reading a file. The function never
 * throws — on any error it returns `{ bytes: 0, projectedTokens: 0,
 * exact: false }` and the caller treats that as "no signal, fall
 * through."
 */
export function estimateReadCost(
  absolutePath: string,
  model: string | undefined | null,
): ReadEstimate {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return { bytes: 0, projectedTokens: 0, exact: false };
    const bytes = stat.size;
    if (bytes === 0) return { bytes: 0, projectedTokens: 0, exact: true };

    if (bytes <= SAMPLE_BYTES) {
      // Small enough to tokenise exactly.
      const text = fs.readFileSync(absolutePath, 'utf-8');
      try {
        const projectedTokens = countTokens(text, model);
        return { bytes, projectedTokens, exact: true };
      } catch {
        return { bytes, projectedTokens: Math.ceil(bytes / FALLBACK_BYTES_PER_TOKEN), exact: false };
      }
    }

    // Larger file: tokenise the first SAMPLE_BYTES and extrapolate.
    const fd = fs.openSync(absolutePath, 'r');
    try {
      const buf = Buffer.alloc(SAMPLE_BYTES);
      const read = fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
      const sample = buf.subarray(0, read).toString('utf-8');
      const sampleTokens = countTokens(sample, model);
      const tokensPerByte = sampleTokens / Math.max(read, 1);
      const projectedTokens = Math.ceil(tokensPerByte * bytes);
      return { bytes, projectedTokens, exact: false };
    } catch {
      return { bytes, projectedTokens: Math.ceil(bytes / FALLBACK_BYTES_PER_TOKEN), exact: false };
    } finally {
      // safe: closeSync after a failed openSync just means there was
      // no fd to close, or the kernel already reaped it. Either way
      // resource recovery is best-effort.
      try { fs.closeSync(fd); } catch { /* safe: see above */ }
    }
  } catch {
    return { bytes: 0, projectedTokens: 0, exact: false };
  }
}

/**
 * Decide whether the projected read would push the conversation
 * over the model's effective budget.
 *
 * `conversationTokens` is the count *before* this read. `model` is
 * used to look up the per-model context limit (see
 * `resolveModelContextLimit`). `budgetPct` lets callers tune the
 * threshold; passing `1.0` effectively disables the gate.
 */
export function shouldDeferRead(
  estimate: ReadEstimate,
  conversationTokens: number,
  model: string | undefined | null,
  budgetPct: number = DEFAULT_PREDICTIVE_BUDGET_PCT,
): DeferDecision {
  const modelLimit = resolveModelContextLimit(model);
  // budgetPct is sanitised: clamp to (0, 1].
  const pct = !Number.isFinite(budgetPct) || budgetPct <= 0
    ? DEFAULT_PREDICTIVE_BUDGET_PCT
    : Math.min(budgetPct, 1);
  const hardCap = Math.floor(modelLimit * pct);
  const projectedTotal = Math.max(0, conversationTokens) + Math.max(0, estimate.projectedTokens);
  if (projectedTotal <= hardCap) {
    return { defer: false, reason: 'within budget', projectedTotal, hardCap };
  }
  const overshoot = projectedTotal - hardCap;
  return {
    defer: true,
    reason: `predicted ${projectedTotal.toLocaleString()} tokens would exceed budget ${hardCap.toLocaleString()} by ${overshoot.toLocaleString()}`,
    projectedTotal,
    hardCap,
  };
}

/**
 * Format the synthetic directive returned to the model when the
 * gate fires. The shape matches the existing
 * `[Context-Budget Guard]` directive used by the byte gate so the
 * model's existing routing behaviour applies unchanged.
 */
export function formatPredictiveGateDirective(
  relativePath: string,
  estimate: ReadEstimate,
  decision: DeferDecision,
): string {
  return [
    `[Context-Budget Guard] read_file ${relativePath} deferred.`,
    `  bytes=${estimate.bytes.toLocaleString()} projected_tokens=${estimate.projectedTokens.toLocaleString()}${estimate.exact ? '' : ' (estimated)'}`,
    `  ${decision.reason}.`,
    `  → Use extract_symbols or extract_imports to scan the file's surface, then`,
    `    read_file with explicit lines, or use str_replace to edit without`,
    `    pulling the full file into context.`,
  ].join('\n');
}
