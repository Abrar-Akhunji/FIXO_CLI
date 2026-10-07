import fs from "node:fs";
import path from "node:path";
import {
  loadTodoList,
  saveTodoList,
  addItem,
  setItemStatus,
  removeItem,
  clearDoneItems,
  renderTodoList,
  summariseTodoList,
  type TodoStatus,
} from "../../context/todo.js";
import { recordTelemetry, telemetry } from "../telemetry.js";
import type { ToolExecutionOptions } from "./types.js";

export interface TodoWriteArgs {
  /** Mutation kind. */
  op: "add" | "set_status" | "remove" | "clear_done";
  /** Required for `add`. */
  content?: string;
  /** Required for `set_status` and `remove`. */
  id?: string;
  /** Required for `set_status`. */
  status?: TodoStatus;
  /** Optional blocker description (add only). */
  blockedBy?: string;
}

export class TodoWriteError extends Error {
  public readonly code:
    "plan_mode_rejected" | "invalid_args" | "not_found" | "io_failure";
  public readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TodoWriteError["code"],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TodoWriteError";
    this.code = code;
    this.details = details;
  }
}

export function executeTodoRead(cwd: string): string {
  const list = loadTodoList(cwd);
  return renderTodoList(list);
}

const VALID_TODO_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "done",
  "cancelled",
]);

export async function executeTodoWrite(
  args: TodoWriteArgs,
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (options.mode === "PLAN") {
    return `Error: todo_write: rejected in PLAN mode (no on-disk mutations).`;
  }
  const op = args.op;
  if (
    op !== "add" &&
    op !== "set_status" &&
    op !== "remove" &&
    op !== "clear_done"
  ) {
    throw new TodoWriteError(
      `todo_write: unknown op "${String(op)}"`,
      "invalid_args",
      { op: String(op) },
    );
  }
  let list = loadTodoList(cwd);
  switch (op) {
    case "add": {
      if (
        typeof args.content !== "string" ||
        args.content.trim().length === 0
      ) {
        throw new TodoWriteError(
          'todo_write: "content" is required for op=add',
          "invalid_args",
        );
      }
      list = addItem(list, {
        content: args.content,
        blockedBy: args.blockedBy,
      });
      break;
    }
    case "set_status": {
      if (typeof args.id !== "string" || args.id.length === 0) {
        throw new TodoWriteError(
          'todo_write: "id" is required for op=set_status',
          "invalid_args",
        );
      }
      if (!args.status || !VALID_TODO_STATUSES.has(args.status)) {
        throw new TodoWriteError(
          `todo_write: "status" must be one of pending|in_progress|done|cancelled (got "${String(args.status)}")`,
          "invalid_args",
        );
      }
      const exists = list.items.some((it) => it.id === args.id);
      if (!exists) {
        const content =
          typeof args.content === "string" && args.content.trim().length > 0
            ? args.content
            : `Task ${args.id}`;
        list = addItem(list, { content, blockedBy: args.blockedBy });
        const newId = list.items[list.items.length - 1].id;
        list = setItemStatus(list, { id: newId, status: args.status });
        const save = saveTodoList(cwd, list);
        if (!save.ok) {
          throw new TodoWriteError(
            `todo_write: failed to persist: ${save.error ?? "unknown"}`,
            "io_failure",
            { path: save.path },
          );
        }
        return `Successfully appended new item with auto-assigned ID: ${newId}`;
      }
      list = setItemStatus(list, { id: args.id, status: args.status });
      break;
    }
    case "remove": {
      if (typeof args.id !== "string" || args.id.length === 0) {
        throw new TodoWriteError(
          'todo_write: "id" is required for op=remove',
          "invalid_args",
        );
      }
      const exists = list.items.some((it) => it.id === args.id);
      if (!exists) {
        throw new TodoWriteError(
          `todo_write: item id "${args.id}" not found`,
          "not_found",
        );
      }
      list = removeItem(list, { id: args.id });
      break;
    }
    case "clear_done": {
      list = clearDoneItems(list);
      break;
    }
  }
  const save = saveTodoList(cwd, list);
  if (!save.ok) {
    throw new TodoWriteError(
      `todo_write: failed to persist: ${save.error ?? "unknown"}`,
      "io_failure",
      {
        path: save.path,
      },
    );
  }
  const summary = summariseTodoList(list);
  recordTelemetry(
    telemetry.todoMutation({
      op,
      items: list.items.length,
      id: typeof args.id === "string" ? args.id : undefined,
    }),
  );
  return `${renderTodoList(list)}\n\n(summary: ${summary})`;
}

export async function executeEnterPlanMode(
  args: { reason?: string },
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  options.mode = "PLAN";
  if (options.context) {
    options.context.mode = "PLAN";
  }
  if (options.onModeChange) {
    options.onModeChange("PLAN");
  }
  const fixoDir = path.join(cwd, ".fixo");
  try {
    if (!fs.existsSync(fixoDir)) {
      fs.mkdirSync(fixoDir, { recursive: true });
    }
    const planMdPath = path.join(fixoDir, "plan.md");
    if (!fs.existsSync(planMdPath)) {
      const initialTemplate = `# Plan\n\n## Objective\n${args?.reason ? args.reason : "Plan formulation"}\n\n## Steps\n1. Analyze requirements\n2. Explore codebase\n3. Formulate implementation steps\n`;
      fs.writeFileSync(planMdPath, initialTemplate, "utf-8");
    }
  } catch {
    // Best effort initialization of .fixo/plan.md
  }
  return "Switched to PLAN mode. File mutations and mutating commands are now blocked. You may only read files, search code, and write to .fixo/plan.md or plan.md. When planning is complete, call exit_plan_mode to proceed with execution.";
}

export async function executeExitPlanMode(
  args: { planSummary?: string },
  _cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  options.mode = "BUILD";
  if (options.context) {
    options.context.mode = "BUILD";
  }
  if (options.onModeChange) {
    options.onModeChange("BUILD");
  }
  const planSummary = args?.planSummary ? ` Plan summary: ${args.planSummary}` : "";
  return `Exited PLAN mode. Switched to BUILD mode. File mutations and commands are now enabled.${planSummary}`;
}
