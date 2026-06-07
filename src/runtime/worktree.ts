/**
 * worktree.ts — Git worktree management + annotation parser.
 *
 * Phase 3.6 spec:
 *   - Three operations: create / merge / remove.
 *   - NOT exposed as a tool. Instead, the SingleAgent scans
 *     its final assistant message for inline annotations of
 *     the form `[worktree:create branch=x]` / `[worktree:merge]`
 *     / `[worktree:remove]` and dispatches the corresponding
 *     worktree operation.
 *   - All operations are guarded by `git isGitRepo(cwd)` and
 *     use `execFileSync('git', ...)` so we never go through a
 *     shell.
 *
 * Annotation format (single line, anywhere in assistant text):
 *   [worktree:create branch=foo]
 *   [worktree:create branch=foo base=main]
 *   [worktree:merge]
 *   [worktree:remove path=<absolute path to worktree>]
 */
import { execFileSync } from 'node:child_process';

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: unknown) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr ? err.stderr.toString() : err.message ?? '');
    throw new Error(`Git error (git ${args.join(' ')}): ${stderr.trim()}`);
  }
}

export interface CreateWorktreeInput {
  /** Branch to create (and check out in the new worktree). */
  branch: string;
  /** Base branch / ref to fork from. Default: 'HEAD'. */
  base?: string;
  /** Where to put the worktree directory. Default: `<cwd>/.fixo/worktrees/<branch>`. */
  path?: string;
}

export interface WorktreeResult {
  ok: boolean;
  /** Path to the new worktree (create) / merged branch name (merge) / removed path (remove). */
  detail: string;
  /** Captured git output. */
  output: string;
  /** Error message, if any. */
  error?: string;
}

function defaultWorktreePath(cwd: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '-');
  return `${cwd}/.fixo/worktrees/${safe}`;
}

/** Create a new worktree at `path` on `branch` forked from `base`. */
export function createWorktree(cwd: string, input: CreateWorktreeInput): WorktreeResult {
  if (!input.branch || typeof input.branch !== 'string') {
    return { ok: false, detail: '', output: '', error: 'createWorktree: branch is required' };
  }
  const worktreePath = input.path ?? defaultWorktreePath(cwd, input.branch);
  const base = input.base ?? 'HEAD';
  try {
    const out = runGit(cwd, ['worktree', 'add', '-b', input.branch, worktreePath, base]);
    return { ok: true, detail: worktreePath, output: out };
  } catch (err) {
    return { ok: false, detail: worktreePath, output: '', error: (err as Error).message };
  }
}

/** Merge the worktree's branch back into the current branch of `cwd`. */
export function mergeWorktree(cwd: string, branch: string, targetBranch?: string): WorktreeResult {
  if (!branch) {
    return { ok: false, detail: '', output: '', error: 'mergeWorktree: branch is required' };
  }
  try {
    const out = runGit(cwd, ['merge', '--no-ff', branch, '-m', `Merge worktree branch ${branch}`]);
    return { ok: true, detail: targetBranch ?? branch, output: out };
  } catch (err) {
    return { ok: false, detail: branch, output: '', error: (err as Error).message };
  }
}

/** Remove a worktree at `worktreePath` and (optionally) delete its branch. */
export function removeWorktree(
  cwd: string,
  worktreePath: string,
  opts: { deleteBranch?: boolean; branch?: string } = {},
): WorktreeResult {
  if (!worktreePath) {
    return { ok: false, detail: '', output: '', error: 'removeWorktree: worktreePath is required' };
  }
  try {
    const out = runGit(cwd, ['worktree', 'remove', worktreePath, '--force']);
    let extra = '';
    if (opts.deleteBranch && opts.branch) {
      try {
        extra = '\n' + runGit(cwd, ['branch', '-D', opts.branch]);
      } catch {
        // Branch may already be gone or merged — non-fatal.
      }
    }
    return { ok: true, detail: worktreePath, output: out + extra };
  } catch (err) {
    return { ok: false, detail: worktreePath, output: '', error: (err as Error).message };
  }
}

/* ──────────────────── Annotation parser ──────────────────── */

export type WorktreeAnnotation =
  | { op: 'create'; branch: string; base?: string; path?: string }
  | { op: 'merge'; branch: string }
  | { op: 'remove'; path: string; deleteBranch?: boolean; branch?: string };

const ANNOTATION_RE = /\[worktree:(\w+)([^\]]*)\]/g;

/**
 * Extract a single annotation from a `[worktree:op key=value ...]`
 * token. Returns null if the token is malformed.
 */
function parseOneAnnotation(op: string, body: string): WorktreeAnnotation | null {
  // Parse key=value pairs (values may be quoted; we accept
  // any non-whitespace token).
  const pairs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    pairs[m[1]] = m[2] ?? m[3] ?? '';
  }
  if (op === 'create') {
    if (!pairs.branch) return null;
    return {
      op: 'create',
      branch: pairs.branch,
      base: pairs.base,
      path: pairs.path,
    };
  }
  if (op === 'merge') {
    if (!pairs.branch) return null;
    return { op: 'merge', branch: pairs.branch };
  }
  if (op === 'remove') {
    if (!pairs.path) return null;
    return {
      op: 'remove',
      path: pairs.path,
      deleteBranch: pairs.deleteBranch === 'true' || pairs.deleteBranch === '1',
      branch: pairs.branch,
    };
  }
  return null;
}

/**
 * Extract all worktree annotations from `text`. Annotations
 * are returned in the order they appear. The text is not
 * mutated.
 */
export function parseWorktreeAnnotations(text: string): WorktreeAnnotation[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: WorktreeAnnotation[] = [];
  ANNOTATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANNOTATION_RE.exec(text)) !== null) {
    const op = m[1];
    const body = m[2] ?? '';
    const parsed = parseOneAnnotation(op, body);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Apply a list of worktree annotations. Each annotation runs
 * in order; failures are returned but do not stop the chain.
 * Returns a list of results, one per annotation.
 */
export function applyWorktreeAnnotations(
  cwd: string,
  annotations: WorktreeAnnotation[],
): WorktreeResult[] {
  return annotations.map(ann => {
    if (ann.op === 'create') {
      return createWorktree(cwd, { branch: ann.branch, base: ann.base, path: ann.path });
    }
    if (ann.op === 'merge') {
      return mergeWorktree(cwd, ann.branch);
    }
    // remove
    return removeWorktree(cwd, ann.path, {
      deleteBranch: ann.deleteBranch,
      branch: ann.branch,
    });
  });
}

/** Strip worktree annotations from a string (used to clean the assistant output). */
export function stripWorktreeAnnotations(text: string): string {
  return text.replace(ANNOTATION_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}
