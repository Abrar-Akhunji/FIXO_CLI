/**
 * todo.ts — Persistent, project-local todo list for the agent.
 *
 * A todo list is the agent's "external working memory": a tiny,
 * ordered set of `{ id, content, status, createdAt, updatedAt }`
 * records the agent reads and writes as it works. Persisted as
 * JSON to `<cwd>/.fixo/todo_list.json` so the user can inspect
 * the agent's state at any time, and so a crashed session can
 * pick up where it left off.
 *
 * Atomicity: writes go to `<file>.tmp` first, then `fs.renameSync`
 * over the final path. This is the same pattern used elsewhere
 * in the runtime (see `AtomicStagingManager`).
 *
 * Concurrency: the runtime is single-process, so we do not need
 * a file lock — the runtime only has one REPL at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  /** Optional blocker description — surfaced in the per-turn summary. */
  blockedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TodoList {
  version: 1;
  items: TodoItem[];
  /** Epoch ms of the most recent mutation. */
  updatedAt: number;
}

const TODO_FILENAME = "todo_list.json";
const TODO_SUBDIR = ".fixo";

function todoPath(cwd: string): string {
  return path.join(cwd, TODO_SUBDIR, TODO_FILENAME);
}

/* ──────────────────────── factory ──────────────────────── */

export function emptyTodoList(): TodoList {
  return { version: 1, items: [], updatedAt: Date.now() };
}

function normaliseItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const id =
      typeof obj.id === "string" && obj.id.length > 0 ? obj.id : randomUUID();
    if (seen.has(id)) continue;
    seen.add(id);
    const content = typeof obj.content === "string" ? obj.content : "";
    if (content.length === 0) continue;
    const status: TodoStatus =
      obj.status === "in_progress" ||
      obj.status === "done" ||
      obj.status === "cancelled"
        ? obj.status
        : "pending";
    const blockedBy =
      typeof obj.blockedBy === "string" ? obj.blockedBy : undefined;
    const createdAt =
      typeof obj.createdAt === "number" ? obj.createdAt : Date.now();
    const updatedAt =
      typeof obj.updatedAt === "number" ? obj.updatedAt : createdAt;
    out.push({ id, content, status, blockedBy, createdAt, updatedAt });
  }
  return out;
}

/* ──────────────────────── read ──────────────────────── */

/**
 * Read the todo list from disk. Returns an empty list when the
 * file does not exist, is empty, or fails to parse — the
 * loader never throws on a missing file because todo state is
 * optional project metadata.
 */
export function loadTodoList(cwd: string): TodoList {
  const p = todoPath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return emptyTodoList();
  }
  if (raw.trim().length === 0) return emptyTodoList();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyTodoList();
    const obj = parsed as Record<string, unknown>;
    const items = normaliseItems(obj.items);
    const updatedAt =
      typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now();
    return { version: 1, items, updatedAt };
  } catch {
    return emptyTodoList();
  }
}

/* ──────────────────────── write ──────────────────────── */

export interface SaveResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * Persist the list atomically: write to `<path>.tmp`, rename
 * over the final path. Creates the `.fixo` directory if it
 * does not exist.
 */
export function saveTodoList(cwd: string, list: TodoList): SaveResult {
  const p = todoPath(cwd);
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, path: p, error: (err as Error).message };
  }
  const stamped: TodoList = { ...list, version: 1, updatedAt: Date.now() };
  const tmp = `${p}.tmp`;
  const payload = JSON.stringify(stamped, null, 2);
  try {
    fs.writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, path: p, error: (err as Error).message };
  }
}

/* ──────────────────────── mutations ──────────────────────── */

export interface AddItemInput {
  content: string;
  blockedBy?: string;
}

export function addItem(
  list: TodoList,
  input: AddItemInput,
  now: number = Date.now(),
): TodoList {
  const trimmed = input.content.trim();
  if (trimmed.length === 0) return list;
  const item: TodoItem = {
    id: randomUUID(),
    content: trimmed,
    status: "pending",
    blockedBy: input.blockedBy?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  return { ...list, items: [...list.items, item], updatedAt: now };
}

export interface SetStatusInput {
  id: string;
  status: TodoStatus;
}

export function setItemStatus(
  list: TodoList,
  input: SetStatusInput,
  now: number = Date.now(),
): TodoList {
  const items = list.items.map((it) =>
    it.id === input.id ? { ...it, status: input.status, updatedAt: now } : it,
  );
  return { ...list, items, updatedAt: now };
}

export interface RemoveItemInput {
  id: string;
}

export function removeItem(
  list: TodoList,
  input: RemoveItemInput,
  now: number = Date.now(),
): TodoList {
  return {
    ...list,
    items: list.items.filter((it) => it.id !== input.id),
    updatedAt: now,
  };
}

export function clearDoneItems(
  list: TodoList,
  now: number = Date.now(),
): TodoList {
  return {
    ...list,
    items: list.items.filter(
      (it) => it.status !== "done" && it.status !== "cancelled",
    ),
    updatedAt: now,
  };
}

/* ──────────────────────── summary ──────────────────────── */

/**
 * One-line summary injected as a system message after every
 * turn. Format is deliberately stable so the LLM can diff
 * consecutive summaries cheaply.
 *
 * Empty list → empty string (no message appended).
 */
export function summariseTodoList(list: TodoList): string {
  if (list.items.length === 0) return "";
  const open = list.items.filter(
    (it) => it.status === "pending" || it.status === "in_progress",
  );
  const done = list.items.filter((it) => it.status === "done");
  const blocked = open.filter((it) => it.blockedBy && it.blockedBy.length > 0);
  const inProgress = open.find((it) => it.status === "in_progress");
  const head = `Todo: ${open.length} open / ${done.length} done / ${list.items.length} total`;
  const current = inProgress ? ` — current: "${inProgress.content}"` : "";
  const blockSuffix = blocked.length > 0 ? ` — ${blocked.length} blocked` : "";
  return head + current + blockSuffix;
}

/**
 * Multi-line rendering for `/todo` slash command. Markdown-like,
 * deterministic ordering (open items first, by createdAt asc;
 * done/cancelled at the end).
 */
export function renderTodoList(list: TodoList): string {
  if (list.items.length === 0) return "(todo list is empty)";
  const open = list.items.filter(
    (it) => it.status === "pending" || it.status === "in_progress",
  );
  const done = list.items.filter(
    (it) => it.status === "done" || it.status === "cancelled",
  );
  const orderFn = (a: TodoItem, b: TodoItem) => a.createdAt - b.createdAt;
  open.sort(orderFn);
  done.sort(orderFn);

  const renderItem = (it: TodoItem): string => {
    const tag =
      it.status === "in_progress"
        ? "[~]"
        : it.status === "done"
          ? "[x]"
          : it.status === "cancelled"
            ? "[-]"
            : "[ ]";
    const block = it.blockedBy ? ` (blocked: ${it.blockedBy})` : "";
    return `${tag} ${it.content}${block}`;
  };
  const lines: string[] = [];
  if (open.length > 0) {
    lines.push("Open:");
    for (const it of open) lines.push("  " + renderItem(it));
  }
  if (done.length > 0) {
    lines.push("Completed:");
    for (const it of done) lines.push("  " + renderItem(it));
  }
  return lines.join("\n");
}
