/**
 * Live Pre-Save LSP Compilation Check — Pillar 3 of the Phase 2
 * safety refactor. The problem: an LLM can produce syntactically
 * valid TypeScript that is semantically broken (undefined
 * references, wrong import paths, type errors). A workspace
 * corrupted by a "looks-fine" write is worse than a workspace
 * that crashes loudly.
 *
 * The fix: after the new content is staged, query the local
 * language server for diagnostics. If the user-configured mode
 * is `block` and any errors are present, refuse the commit and
 * roll the staging back so the user keeps the original file. If
 * the mode is `warn`, log the diagnostics but commit anyway. If
 * the mode is `off`, the gate is a no-op.
 *
 * The gate is constructed lazily on first use and cached in a
 * module-level singleton. The diagnostics call is bounded by a
 * 500ms hard timeout so the staging path never blocks the agent
 * loop indefinitely waiting for a slow or hung language server.
 *
 * The gate is fully decoupled from `LspManager` via a
 * `LspDiagnosticsProvider` function — production code supplies
 * one that wraps `LspManager.getDiagnostics`; tests supply a
 * mock that returns canned data.
 */

import type { StagedWrite } from '../runtime/staging.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Pre-save gate severity. Mirrors `LspPreSaveMode` in `config.ts`. */
export type LspPreSaveMode = 'off' | 'warn' | 'block' | 'sandbox-mock';

/** Severity, normalised from the LSP `DiagnosticSeverity` int. */
export type LspDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** A single diagnostic, normalised. */
export interface LspDiagnostic {
  readonly severity: LspDiagnosticSeverity;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly source: string;
  readonly code: string | number | null;
}

/** Result of a single pre-save check. */
export type LspPreSaveResult =
  | { readonly state: 'ok' }
  | { readonly state: 'no-language-server' }
  | {
      readonly state: 'diagnostics';
      readonly diagnostics: ReadonlyArray<LspDiagnostic>;
      /** Convenience: the count of `error`-severity items. */
      readonly errorCount: number;
    };

/** Function that returns diagnostics for a file (or empty). */
export type LspDiagnosticsProvider = (filePath: string) => Promise<LspDiagnostic[]>;

/** Options for {@link LspPreSaveGate}. */
export interface LspPreSaveGateOptions {
  /** The mode. Defaults to `'off'`. */
  mode?: LspPreSaveMode;
  /** The diagnostics provider (defaults to a noop). */
  provider?: LspDiagnosticsProvider;
  /**
   * Predicate that reports whether a real language server is
   * installed for the given file path. Used by `sandbox-mock`
   * mode to distinguish "LSP returned 0 diagnostics" (real pass)
   * from "no LSP installed, unvalidated write" (must be
   * blocked in sandbox-mock mode). Defaults to `true` — i.e.
   * the gate assumes an LSP is available unless the caller
   * overrides this.
   */
  hasLanguageServer?: (filePath: string) => boolean;
  /** Maximum time (ms) to wait for diagnostics. Defaults to 500. */
  timeoutMs?: number;
  /**
   * Optional callback invoked with the gate's decision before the
   * caller (the staging manager) acts on it. Useful for telemetry
   * and for warning-mode logging. Errors thrown here are caught
   * and swallowed — they never block the write.
   */
  onResult?: (result: LspPreSaveResult, entry: StagedWrite) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map the LSP `DiagnosticSeverity` int to our normalised severity. */
export function normaliseSeverity(int: unknown): LspDiagnosticSeverity {
  switch (int) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'info';
  }
}

/** Normalise a raw LSP `Diagnostic` payload into our typed shape. */
export function normaliseDiagnostic(raw: unknown): LspDiagnostic {
  if (!raw || typeof raw !== 'object') {
    return {
      severity: 'info',
      message: String(raw),
      line: 0,
      column: 0,
      source: '',
      code: null,
    };
  }
  const r = raw as {
    severity?: unknown;
    message?: unknown;
    range?: { start?: { line?: number; character?: number } };
    source?: unknown;
    code?: unknown;
  };
  const start = r.range?.start;
  return {
    severity: normaliseSeverity(r.severity),
    message: typeof r.message === 'string' ? r.message : String(r.message ?? ''),
    line: typeof start?.line === 'number' ? start.line : 0,
    column: typeof start?.character === 'number' ? start.character : 0,
    source: typeof r.source === 'string' ? r.source : '',
    code:
      typeof r.code === 'string' || typeof r.code === 'number' ? r.code : null,
  };
}

const noopProvider: LspDiagnosticsProvider = async () => [];

// ---------------------------------------------------------------------------
// LspPreSaveGate
// ---------------------------------------------------------------------------

export class LspPreSaveGate {
  public readonly mode: LspPreSaveMode;
  public readonly provider: LspDiagnosticsProvider;
  public readonly timeoutMs: number;
  public readonly onResult: ((r: LspPreSaveResult, e: StagedWrite) => void) | undefined;
  public readonly hasLanguageServer: (filePath: string) => boolean;

  constructor(options: LspPreSaveGateOptions = {}) {
    this.mode = options.mode ?? 'off';
    this.provider = options.provider ?? noopProvider;
    this.timeoutMs = options.timeoutMs ?? 500;
    this.onResult = options.onResult;
    this.hasLanguageServer = options.hasLanguageServer ?? (() => true);
  }

  /**
   * Run the gate against a staged write. Returns one of:
   *
   *   - `ok`                — the file passes the gate.
   *   - `no-language-server`— the provider returned no diagnostics and
   *                           we have no LSP installed; treat as a
   *                           pass-through so users without a language
   *                           server aren't blocked.
   *   - `diagnostics`       — there are diagnostics; the caller
   *                           decides what to do based on the gate's
   *                           mode and on the `errorCount`.
   */
  public async check(entry: StagedWrite): Promise<LspPreSaveResult> {
    if (this.mode === 'off') {
      return { state: 'ok' };
    }

    let raw: LspDiagnostic[];
    try {
      raw = await this.withTimeout(this.provider(entry.targetPath), this.timeoutMs);
    } catch {
      // Provider threw or timed out — treat as a pass-through so a
      // hung language server does not block the agent loop.
      return { state: 'no-language-server' };
    }

    if (raw.length === 0) {
      // Provider returned zero diagnostics. Distinguish
      // between "LSP installed, file is clean" (→ `ok`) and
      // "no LSP installed, write is unvalidated" (→
      // `no-language-server`). The latter is what the
      // sandbox-mock mode rejects.
      if (!this.hasLanguageServer(entry.targetPath)) {
        const result: LspPreSaveResult = { state: 'no-language-server' };
        this.notify(result, entry);
        return result;
      }
      const result: LspPreSaveResult = { state: 'ok' };
      this.notify(result, entry);
      return result;
    }

    const errorCount = raw.filter((d) => d.severity === 'error').length;
    const result: LspPreSaveResult = {
      state: 'diagnostics',
      diagnostics: raw,
      errorCount,
    };
    this.notify(result, entry);
    return result;
  }

  /**
   * Throw an {@link LspPreSaveBlockedError} if the result should
   * be a hard block. The caller (the staging pipeline) uses this
   * as the pre-commit hook. In `warn` mode this always returns
   * without throwing. In `block` mode it throws when there is at
   * least one `error`-severity diagnostic. In `sandbox-mock` mode
   * (Pillar 5 / Protection 3) it throws when the result was
   * `no-language-server` — the gate refuses to allow unvalidated
   * writes when no LSP is available, forcing the operator to
   * install a real language server or downgrade to `off`.
   */
  public enforce(result: LspPreSaveResult, entry: StagedWrite): void {
    if (this.mode === 'off') return;
    if (this.mode === 'warn') return;
    if (this.mode === 'sandbox-mock') {
      // Pillar 5 / Protection 3 — refuse to commit a write
      // when the gate has no language server backing it. The
      // operator must explicitly opt out by setting the mode
      // to `off` (or by installing a real LSP).
      if (result.state === 'no-language-server') {
        throw new LspPreSaveBlockedError(entry.targetPath, [
          {
            severity: 'error',
            message:
              'sandbox-mock: no language server is available to validate this write. ' +
              'Install typescript-language-server / pyright etc., or set ' +
              'preferences.safety.lspPreSave to "off" to disable pre-save validation.',
            line: 0,
            column: 0,
            source: 'fixo-safety',
            code: 'SANDBOX_MOCK_NO_LSP',
          },
        ]);
      }
      return;
    }
    // `block` mode — fail on any error-severity diagnostic.
    if (result.state !== 'diagnostics') return;
    if (result.errorCount === 0) return;
    throw new LspPreSaveBlockedError(entry.targetPath, result.diagnostics);
  }

  private notify(result: LspPreSaveResult, entry: StagedWrite): void {
    if (!this.onResult) return;
    try {
      this.onResult(result, entry);
    } catch {
      // Swallow observer errors — they are best-effort.
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LSP gate timeout')), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link LspPreSaveGate.enforce} when the gate's mode is
 * `block` and the file has at least one `error`-severity
 * diagnostic. Caught by {@link AtomicStagingManager.commit} and
 * surfaced as a {@link PreCommitHookRejectedError}.
 */
export class LspPreSaveBlockedError extends Error {
  public readonly targetPath: string;
  public readonly diagnostics: ReadonlyArray<LspDiagnostic>;
  constructor(targetPath: string, diagnostics: ReadonlyArray<LspDiagnostic>) {
    const summary = diagnostics
      .filter((d) => d.severity === 'error')
      .slice(0, 3)
      .map((d) => `${d.line + 1}:${d.column + 1} ${d.message}`)
      .join('; ');
    super(
      `LSP pre-save blocked: ${diagnostics.filter((d) => d.severity === 'error').length} ` +
        `error(s) in ${targetPath}${summary ? ` — ${summary}` : ''}`,
    );
    this.name = 'LspPreSaveBlockedError';
    this.targetPath = targetPath;
    this.diagnostics = diagnostics;
  }
}

// ---------------------------------------------------------------------------
// Adapter — wire LspManager into the gate
// ---------------------------------------------------------------------------

/**
 * Build a {@link LspDiagnosticsProvider} from an
 * {@link LspManager}-shaped object. Decouples the gate from the
 * concrete `LspManager` class so tests can inject a mock.
 */
export function makeLspProvider(
  lspManager: {
    getClientAndSync(filePath: string): Promise<unknown>;
  },
): LspDiagnosticsProvider {
  return async (filePath: string) => {
    const client = (await lspManager.getClientAndSync(filePath)) as
      | { getDiagnostics(filePath: string): unknown[] }
      | null;
    if (!client) return [];
    // Give the LSP a short tick to publish (matches LspManager's
    // existing behaviour for the very first open).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = client.getDiagnostics(filePath);
    return Array.isArray(raw) ? raw.map((d) => normaliseDiagnostic(d)) : [];
  };
}
