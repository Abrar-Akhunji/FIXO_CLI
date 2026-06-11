/**
 * session-snapshots.ts — Persistence layer for `--resume <id>`.
 *
 * A snapshot is a single JSON file under
 * `~/.fixocli/sessions/<sha256(cwd)>/<iso-ts>_<short-uuid>.json`
 * capturing the exact state the REPL needs to rehydrate a
 * previous conversation: the message log, the todo list, the
 * selected files, the model, the user-supplied summary, the
 * agent mode, and the system-prompt override.
 *
 * The directory layout is keyed by `sha256(cwd)` so two
 * different working directories never collide. The snapshot id
 * is the file's basename (without `.json`) — short enough to
 * copy/paste, deterministic when re-derived.
 *
 * Atomicity: writes go to `<file>.tmp` first, then `renameSync`
 * over the final path, matching the pattern used by todo
 * persistence and the staging manager.
 *
 * Stability: every snapshot is *self-describing* — it carries a
 * `version` field and a `kind: 'fixo-cli-session'` discriminator
 * so a future change to the on-disk format can be migrated
 * rather than orphaned.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { ChatContentBlock } from '../shared/types.js';
import {
  loadTodoList,
  saveTodoList,
  type TodoList,
} from '../context/todo.js';
import {
  recordTelemetry,
  telemetry,
} from '../agent/telemetry.js';

export const SNAPSHOT_VERSION = 1 as const;
export const SNAPSHOT_KIND = 'fixo-cli-session' as const;

export type AgentMode = 'PLAN' | 'BUILD' | 'EXPLORE' | 'SCOUT';

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentBlock[];
  /** Tool name for `role === 'tool'` messages. */
  name?: string;
  /** Monotonic per-conversation index. */
  index: number;
}

export interface SessionSnapshot {
  version: typeof SNAPSHOT_VERSION;
  kind: typeof SNAPSHOT_KIND;
  /** Snapshot id = file basename without `.json`. */
  id: string;
  /** Absolute cwd captured at save time. */
  cwd: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** Conversation log. */
  conversation: SessionMessage[];
  /** Estimated prompt tokens (approximate, for UI display). */
  tokens: number;
  /** Active model at save time. */
  model: string;
  /** Agent mode at save time. */
  mode: AgentMode;
  /** Files the user had selected (e.g. via `--files` or the file picker). */
  selectedFiles: string[];
  /** Optional user-supplied session summary (auto-derived from the
   *  first user prompt when not set). */
  summary?: string;
  /**
   * User-chosen human-readable label for this session — what the user
   * sees in the header, in `/sessions`, and what they pass to `/resume`.
   * Distinct from {@link summary} (auto-derived) and {@link id} (file
   * basename); ids are kept stable across renames so existing resume
   * links never break.
   */
  label?: string;
  /** Optional system-prompt override (FIXO.md block stripped, but
   *  the caller's original override preserved). */
  fixedInstructions?: string;
  /** Persisted todo list at save time. */
  todo: TodoList;
}

/* ──────────────────────── path helpers ──────────────────────── */

function sessionsRoot(): string {
  return path.join(os.homedir(), '.fixocli', 'sessions');
}

function hashCwd(cwd: string): string {
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 32);
}

function dirForCwd(cwd: string): string {
  return path.join(sessionsRoot(), hashCwd(cwd));
}

function shortUuid(): string {
  return crypto.randomBytes(6).toString('base64url');
}

export function makeSnapshotId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  return `${iso}_${shortUuid()}`;
}

export function snapshotPath(cwd: string, id: string): string {
  return path.join(dirForCwd(cwd), `${id}.json`);
}

/* ──────────────────────── save ──────────────────────── */

export interface SaveInput {
  cwd: string;
  conversation: SessionMessage[];
  tokens: number;
  model: string;
  mode: AgentMode;
  selectedFiles: string[];
  summary?: string;
  /** User-chosen session label. See {@link SessionSnapshot.label}. */
  label?: string;
  /** Reuse a specific id (only used by /resume to overwrite in place). */
  id?: string;
  fixedInstructions?: string;
  /** If omitted, the todo list is reloaded from disk. */
  todo?: TodoList;
}

export interface SaveResult {
  ok: boolean;
  id: string;
  path: string;
  error?: string;
}

export function saveSnapshot(input: SaveInput, now: Date = new Date()): SaveResult {
  const id = input.id ?? makeSnapshotId(now);
  const file = snapshotPath(input.cwd, id);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, id, path: file, error: (err as Error).message };
  }
  const todo = input.todo ?? loadTodoList(input.cwd);
  const snapshot: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    kind: SNAPSHOT_KIND,
    id,
    cwd: input.cwd,
    createdAt: now.toISOString(),
    conversation: input.conversation,
    tokens: input.tokens,
    model: input.model,
    mode: input.mode,
    selectedFiles: input.selectedFiles,
    summary: input.summary,
    label: input.label,
    fixedInstructions: input.fixedInstructions,
    todo,
  };
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
    recordTelemetry(
      telemetry.sessionSnapshot({ id, op: 'save', tokens: input.tokens, items: todo.items.length }),
    );
    // Best-effort: mirror the todo list to its on-disk location so
    // a stale-snapshot resume still gets a sensible todo list
    // *if* the caller didn't supply one. This keeps
    // `loadTodoList(cwd)` consistent with what the user saw.
    if (!input.todo) saveTodoList(input.cwd, todo);
    return { ok: true, id, path: file };
  } catch (err) {
    return { ok: false, id, path: file, error: (err as Error).message };
  }
}

/* ──────────────────────── load ──────────────────────── */

export interface LoadResult {
  ok: boolean;
  snapshot: SessionSnapshot | null;
  error?: string;
}

export function loadSnapshot(cwd: string, id: string): LoadResult {
  const file = snapshotPath(cwd, id);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { ok: false, snapshot: null, error: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, snapshot: null, error: 'snapshot is not an object' };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.kind !== SNAPSHOT_KIND) {
      return { ok: false, snapshot: null, error: `unexpected snapshot kind: ${String(obj.kind)}` };
    }
    if (obj.version !== SNAPSHOT_VERSION) {
      return { ok: false, snapshot: null, error: `unsupported snapshot version: ${String(obj.version)}` };
    }
    const snap = obj as unknown as SessionSnapshot;
    recordTelemetry(
      telemetry.sessionSnapshot({ id, op: 'load', tokens: snap.tokens, items: snap.todo.items.length }),
    );
    return { ok: true, snapshot: snap };
  } catch (err) {
    return { ok: false, snapshot: null, error: (err as Error).message };
  }
}

/* ──────────────────────── list ──────────────────────── */

export interface SnapshotListEntry {
  id: string;
  path: string;
  createdAt: string;
  tokens: number;
  items: number;
  summary?: string;
  label?: string;
}

export function listSnapshots(cwd: string): SnapshotListEntry[] {
  const dir = dirForCwd(cwd);
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SnapshotListEntry[] = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      const obj = parsed as Record<string, unknown>;
      if (obj.kind !== SNAPSHOT_KIND) continue;
      const conv = Array.isArray(obj.conversation) ? obj.conversation : [];
      const todo = (obj.todo && typeof obj.todo === 'object') ? obj.todo as { items?: unknown[] } : {};
      const items = Array.isArray(todo.items) ? todo.items.length : 0;
      out.push({
        id: name.slice(0, -'.json'.length),
        path: file,
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
        tokens: typeof obj.tokens === 'number' ? obj.tokens : 0,
        items,
        summary: typeof obj.summary === 'string' ? obj.summary : undefined,
        label: typeof obj.label === 'string' ? obj.label : undefined,
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/* ──────────────────────── rename ──────────────────────── */

/**
 * Maximum label length. Long enough for "clinic-website-accessibility-audit"
 * but short enough to fit in a session header pill on a 100-col terminal.
 */
export const MAX_LABEL_LENGTH = 64;

/**
 * Returns true if the label is safe to store, render, and search.
 *
 * Rules:
 *   - 1..MAX_LABEL_LENGTH characters
 *   - letters, digits, dash, underscore, dot, and spaces only
 *   - no path separators (`/`, `\`) so a label can never affect
 *     where the snapshot file lives on disk
 *   - no shell metacharacters (backtick, `$`, `;`, `|`, `&`, `<`, `>`)
 *     so a future render path that interpolates the label cannot be
 *     hijacked
 *
 * The validator is conservative on purpose — labels are user-facing,
 * not creative writing. The file id stays as the durable identifier.
 */
export function isValidSessionLabel(label: string): boolean {
  if (typeof label !== 'string') return false;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) return false;
  // Allow Unicode letters/digits + space + dash + underscore + dot.
  return /^[\p{L}\p{N}._\- ]+$/u.test(trimmed);
}

export interface RenameResult {
  ok: boolean;
  id: string;
  label?: string;
  error?: string;
}

/**
 * Atomically rewrite the `label` field of an existing snapshot.
 * The on-disk file basename (the snapshot id) is **never** renamed —
 * existing `/resume <id>` invocations keep working after a relabel.
 *
 * Pass `label: undefined` to clear an existing label.
 */
export function renameSnapshot(
  cwd: string,
  id: string,
  label: string | undefined,
): RenameResult {
  if (label !== undefined && !isValidSessionLabel(label)) {
    return {
      ok: false,
      id,
      error:
        `invalid label: must be 1..${MAX_LABEL_LENGTH} chars, letters/digits/space/dash/underscore/dot only`,
    };
  }
  const loaded = loadSnapshot(cwd, id);
  if (!loaded.ok || !loaded.snapshot) {
    return { ok: false, id, error: loaded.error ?? 'snapshot not found' };
  }
  const updated: SessionSnapshot = {
    ...loaded.snapshot,
    label: label?.trim() || undefined,
  };
  const file = snapshotPath(cwd, id);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore tmp cleanup failure */
    }
    return { ok: false, id, error: (err as Error).message };
  }
  return { ok: true, id, label: updated.label };
}
