/** One prompt API: native session dialogs in the TUI, Clack for inline/setup. */
import * as clack from "@clack/prompts";
import { getActiveSessionScreen } from "./session-screen.js";
import { DIALOG_CANCEL, type DialogOption } from "./session-dialog.js";
export { spinner, intro, outro, note, log } from "@clack/prompts";
export function isCancel(value: unknown): value is symbol {
  return value === DIALOG_CANCEL || clack.isCancel(value);
}

export function select<T>(options: {
  message: string; options: DialogOption<T>[]; initialValue?: T; maxItems?: number;
}): Promise<T | symbol> {
  const screen = getActiveSessionScreen();
  return screen ? screen.ask(options) : clack.select(options as Parameters<typeof clack.select<T>>[0]);
}

export function text(options: {
  message: string; placeholder?: string; initialValue?: string; defaultValue?: string;
  validate?: (value: string) => string | Error | undefined;
}): Promise<string | symbol> {
  const screen = getActiveSessionScreen();
  return screen ? screen.ask({ ...options, initialValue: options.initialValue ?? options.defaultValue }) : clack.text(options);
}

export function password(options: {
  message: string; placeholder?: string; mask?: string; validate?: (value: string) => string | Error | undefined;
}): Promise<string | symbol> {
  const screen = getActiveSessionScreen();
  return screen ? screen.ask<string>({ ...options, password: true }) : clack.password(options);
}

export function confirm(options: {
  message: string; initialValue?: boolean; active?: string; inactive?: string;
}): Promise<boolean | symbol> {
  const screen = getActiveSessionScreen();
  return screen ? screen.ask({
    message: options.message,
    initialValue: options.initialValue ?? false,
    options: [ { value: true, label: options.active ?? "Yes" }, { value: false, label: options.inactive ?? "No" } ],
  }) : clack.confirm(options);
}
