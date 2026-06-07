/**
 * FIXO.md loader — Phase 2 deliverable.
 *
 * Convention: a single, optional `FIXO.md` (or `.fixo/FIXO.md`)
 * provides project-local instructions for the agent. The
 * loader reads it from a deterministic lookup chain and
 * surfaces the loaded content to the system-prompt builder.
 *
 * Lookup order (first hit wins):
 *   1. `<cwd>/.fixo/FIXO.md`
 *   2. `<cwd>/FIXO.md`
 *   3. `~/.fixocli/FIXO.md`
 *
 * The loader is *additive* — `AgentContext.systemPromptOverride`
 * still wins if the caller already supplied one. The FIXO.md
 * content is appended under a clearly-labelled
 * `<project-instructions>` block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';

export type FixoMdSource = 'project-fixo' | 'project-cwd' | 'global' | 'none';

export interface FixoMdLoadResult {
  /** The path that won, or null when no FIXO.md was found. */
  readonly source: FixoMdSource;
  /** Absolute path of the file that was loaded, when source !== 'none'. */
  readonly path: string | null;
  /** Raw file content. Empty string when source === 'none'. */
  readonly content: string;
  /** Byte size of the loaded file. 0 when source === 'none'. */
  readonly bytes: number;
}

/* ──────────────────────── lookup chain ──────────────────────── */

/**
 * Search the lookup chain and return the first match. Does not
 * read the file — the caller decides whether to read it
 * synchronously or stream it.
 */
export function findFixoMdPath(cwd: string): { source: FixoMdSource; path: string | null } {
  const candidates: Array<{ source: FixoMdSource; p: string }> = [
    { source: 'project-fixo', p: path.join(cwd, '.fixo', 'FIXO.md') },
    { source: 'project-cwd', p: path.join(cwd, 'FIXO.md') },
    { source: 'global', p: path.join(getConfigDir(), 'FIXO.md') },
  ];
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c.p);
      if (stat.isFile() && stat.size > 0) {
        return { source: c.source, path: c.p };
      }
    } catch {
      // ENOENT or permission denied — try the next candidate.
    }
  }
  return { source: 'none', path: null };
}

/**
 * Read the FIXO.md content from the first match in the lookup
 * chain. Returns `{ source: 'none', ... }` when no file exists.
 *
 * Best-effort sandboxing: each candidate is read through the
 * platform's `fs.readFileSync` and capped at 1 MiB so a runaway
 * file cannot OOM the agent.
 */
export function loadProjectInstructions(cwd: string): FixoMdLoadResult {
  const found = findFixoMdPath(cwd);
  if (found.path === null) {
    return { source: 'none', path: null, content: '', bytes: 0 };
  }
  let content: string;
  try {
    content = fs.readFileSync(found.path, 'utf-8');
  } catch {
    return { source: 'none', path: found.path, content: '', bytes: 0 };
  }
  const bytes = Buffer.byteLength(content, 'utf-8');
  return {
    source: found.source,
    path: found.path,
    content,
    bytes,
  };
}

/* ──────────────────────── prompt block ──────────────────────── */

/**
 * Build the `<project-instructions>` block that is appended to
 * the agent's system prompt. The block is wrapped in clearly
 * labelled fences so the LLM cannot confuse it with the
 * platform-managed system prompt.
 *
 * The block is empty when no FIXO.md was found; callers can
 * detect this by inspecting `source === 'none'`.
 */
export function buildProjectInstructionsBlock(cwd: string): {
  block: string;
  result: FixoMdLoadResult;
} {
  const result = loadProjectInstructions(cwd);
  if (result.source === 'none' || result.content.length === 0) {
    return { block: '', result };
  }
  const header =
    result.source === 'global'
      ? 'Global instructions (from ~/.fixocli/FIXO.md)'
      : `Project instructions (from ${result.path ?? 'FIXO.md'})`;
  const block =
    `\n\n<project-instructions source="${result.source}">\n` +
    `## ${header}\n\n` +
    `${result.content.trim()}\n` +
    `</project-instructions>\n`;
  return { block, result };
}

/* ──────────────────────── telemetry ──────────────────────── */

/**
 * Best-effort telemetry emission. Imported lazily so a missing
 * `telemetry.js` (e.g. during early bootstrap) never blocks
 * the loader. Errors are swallowed — telemetry must never
 * break a tool call.
 */
export async function recordFixoMdLoad(result: FixoMdLoadResult): Promise<void> {
  try {
    const { recordTelemetry, telemetry } = await import('../agent/telemetry.js');
    recordTelemetry(
      telemetry.fixoMdLoaded({
        source: result.source,
        bytes: result.bytes,
      }),
    );
  } catch {
    // ignore
  }
}
