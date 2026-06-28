/**
 * Tests for the todo list persistence and the
 * `executeTodoRead` / `executeTodoWrite` tool wrappers.
 *
 * The tools are tested by:
 *   - calling the pure mutators (addItem, setItemStatus, …)
 *     directly to confirm their semantics
 *   - calling executeTodoWrite with each op and verifying the
 *     persisted file
 *   - confirming PLAN mode rejects the write
 *   - confirming the unknown-id path returns a structured error
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  addItem,
  emptyTodoList,
  loadTodoList,
  removeItem,
  renderTodoList,
  saveTodoList,
  setItemStatus,
  summariseTodoList,
  clearDoneItems,
  type TodoList,
} from "../context/todo.js";
import {
  executeTodoRead,
  executeTodoWrite,
  TodoWriteError,
} from "../agent/tool-executor.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listPath(cwd: string): string {
  return path.join(cwd, ".fixo", "todo_list.json");
}

test("addItem appends an item with a fresh id and pending status", () => {
  const t0 = 1_700_000_000_000;
  const list = emptyTodoList();
  const next = addItem(list, { content: "one" }, t0);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]?.content, "one");
  assert.equal(next.items[0]?.status, "pending");
  assert.ok((next.items[0]?.id ?? "").length > 0);
});

test("addItem trims whitespace and rejects empty content", () => {
  const list = emptyTodoList();
  const next = addItem(list, { content: "   " });
  assert.equal(next.items.length, 0);
});

test("setItemStatus updates an existing item", () => {
  const list = addItem(emptyTodoList(), { content: "x" });
  const id = list.items[0]?.id ?? "";
  const next = setItemStatus(list, { id, status: "in_progress" });
  assert.equal(next.items[0]?.status, "in_progress");
});

test("removeItem removes an item by id", () => {
  let list = addItem(emptyTodoList(), { content: "a" });
  list = addItem(list, { content: "b" });
  const a = list.items[0]?.id ?? "";
  const next = removeItem(list, { id: a });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]?.content, "b");
});

test("clearDoneItems removes only done/cancelled", () => {
  let list = addItem(emptyTodoList(), { content: "a" });
  list = addItem(list, { content: "b" });
  const a = list.items[0]?.id ?? "";
  list = setItemStatus(list, { id: a, status: "done" });
  const next = clearDoneItems(list);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]?.content, "b");
});

test("saveTodoList persists to <cwd>/.fixo/todo_list.json atomically", () => {
  const cwd = mkTmp("todo-test-");
  try {
    const list = addItem(emptyTodoList(), { content: "one" });
    const result = saveTodoList(cwd, list);
    assert.equal(result.ok, true);
    const stat = fs.statSync(listPath(cwd));
    assert.ok(stat.isFile());
    const reloaded = loadTodoList(cwd);
    assert.equal(reloaded.items.length, 1);
    assert.equal(reloaded.items[0]?.content, "one");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadTodoList returns empty when no file exists", () => {
  const cwd = mkTmp("todo-test-");
  try {
    const list = loadTodoList(cwd);
    assert.equal(list.items.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadTodoList tolerates corrupt JSON", () => {
  const cwd = mkTmp("todo-test-");
  try {
    const p = listPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not-json", "utf-8");
    const list = loadTodoList(cwd);
    assert.equal(list.items.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderTodoList is empty for an empty list", () => {
  assert.equal(renderTodoList(emptyTodoList()), "(todo list is empty)");
});

test("summariseTodoList is empty for an empty list", () => {
  assert.equal(summariseTodoList(emptyTodoList()), "");
});

test("summariseTodoList reports open/done/total counts", () => {
  let list = addItem(emptyTodoList(), { content: "a" });
  list = addItem(list, { content: "b" });
  const a = list.items[0]?.id ?? "";
  list = setItemStatus(list, { id: a, status: "done" });
  const s = summariseTodoList(list);
  assert.match(s, /1 open/);
  assert.match(s, /1 done/);
  assert.match(s, /2 total/);
});

test("executeTodoRead returns the rendered list", () => {
  const cwd = mkTmp("todo-test-");
  try {
    const out = executeTodoRead(cwd);
    assert.match(out, /empty/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite add persists and returns the rendered list", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    const out = await executeTodoWrite({ op: "add", content: "ship it" }, cwd);
    assert.match(out, /ship it/);
    const reloaded = loadTodoList(cwd);
    assert.equal(reloaded.items.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite set_status updates an item by id", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    const list = addItem(emptyTodoList(), { content: "x" });
    saveTodoList(cwd, list);
    const id = list.items[0]?.id ?? "";
    await executeTodoWrite({ op: "set_status", id, status: "done" }, cwd);
    const reloaded = loadTodoList(cwd);
    assert.equal(reloaded.items[0]?.status, "done");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite remove drops an item by id", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    const list = addItem(addItem(emptyTodoList(), { content: "a" }), {
      content: "b",
    });
    saveTodoList(cwd, list);
    const a = list.items[0]?.id ?? "";
    await executeTodoWrite({ op: "remove", id: a }, cwd);
    const reloaded = loadTodoList(cwd);
    assert.equal(reloaded.items.length, 1);
    assert.equal(reloaded.items[0]?.content, "b");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite clear_done removes only completed items", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    let list: TodoList = emptyTodoList();
    list = addItem(list, { content: "a" });
    list = addItem(list, { content: "b" });
    const a = list.items[0]?.id ?? "";
    list = setItemStatus(list, { id: a, status: "done" });
    saveTodoList(cwd, list);
    await executeTodoWrite({ op: "clear_done" }, cwd);
    const reloaded = loadTodoList(cwd);
    assert.equal(reloaded.items.length, 1);
    assert.equal(reloaded.items[0]?.content, "b");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite rejects in PLAN mode", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    const out = await executeTodoWrite({ op: "add", content: "x" }, cwd, {
      mode: "PLAN",
    });
    assert.match(out, /PLAN mode/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite throws TodoWriteError on unknown id", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    await assert.rejects(
      () => executeTodoWrite({ op: "remove", id: "nope" }, cwd),
      (err: unknown) => err instanceof TodoWriteError,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite throws on invalid op", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    await assert.rejects(
      () => executeTodoWrite({ op: "invalid" as never }, cwd),
      (err: unknown) => err instanceof TodoWriteError,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTodoWrite throws on missing content for add", async () => {
  const cwd = mkTmp("todo-test-");
  try {
    await assert.rejects(
      () => executeTodoWrite({ op: "add" }, cwd),
      (err: unknown) => err instanceof TodoWriteError,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
