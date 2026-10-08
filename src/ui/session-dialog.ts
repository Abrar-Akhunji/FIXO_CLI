/** Input and view state for an in-session prompt. No terminal or readline ownership. */
import { wrapStyledText } from "./terminal-text.js";
export const DIALOG_CANCEL = Symbol("dialog-cancel");
export interface DialogOption<T> { value: T; label: string; hint?: string }
export interface DialogSpec<T> {
  message: string;
  options?: DialogOption<T>[];
  initialValue?: T;
  placeholder?: string;
  password?: boolean;
  validate?: (value: string) => string | Error | undefined;
}
export interface DialogRow { text: string; tone: "title" | "muted" | "selected" | "normal" | "error" }

export class SessionDialog<T> {
  private value = "";
  private cursor = 0;
  private selected = 0;
  private pending = "";
  private paste: string | null = null;
  private error = "";
  private done = false;
  private detailOffset = 0;

  constructor(readonly spec: DialogSpec<T>, private settle: (value: T | symbol) => void) {
    if (spec.options) {
      this.selected = Math.max(0, spec.options.findIndex((item) => item.value === spec.initialValue));
    } else {
      this.value = typeof spec.initialValue === "string" ? spec.initialValue : "";
      this.cursor = this.value.length;
    }
  }

  private matches(): DialogOption<T>[] {
    const terms = this.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (this.spec.options ?? []).filter((option) => terms.every((term) =>
      `${option.label} ${option.hint ?? ""} ${String(option.value)}`.toLowerCase().includes(term)));
  }

  cancel(): void { this.finish(DIALOG_CANCEL); }

  private finish(value: T | symbol): void {
    if (this.done) return;
    this.done = true;
    // Never retain credentials in the closed view or in a terminal transcript.
    this.value = this.pending = "";
    this.paste = null;
    this.settle(value);
  }

  private insert(text: string): void {
    const clean = text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 65536 - this.value.length);
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
    this.selected = 0;
    this.error = "";
  }

  /** Own the entire byte sequence; never forward pasted secrets to the composer. */
  input(chunk: string): void {
    if (this.done) return;
    this.pending += chunk;
    while (this.pending && !this.done) {
      if (this.paste !== null) {
        const end = this.pending.indexOf("\x1b[201~");
        if (end < 0) {
          // Keep a possible fragmented closing delimiter for the next event.
          const take = Math.max(0, this.pending.length - 5);
          this.paste = (this.paste + this.pending.slice(0, take)).slice(0, 65536);
          this.pending = this.pending.slice(take);
          return;
        }
        this.insert((this.paste + this.pending.slice(0, end)).trim());
        this.paste = null;
        this.pending = this.pending.slice(end + 6);
        continue;
      }
      if (this.pending.startsWith("\x1b[200~")) {
        this.paste = "";
        this.pending = this.pending.slice(6);
        continue;
      }
      let key = this.pending[0];
      if (key === "\x1b" && this.pending.length > 1) {
        const sequence = /^\x1b(?:\[[0-9;<]*[A-Za-z~]|O[A-Za-z])/.exec(this.pending)?.[0];
        if (!sequence && /^\x1b\[[0-9;<]*$/.test(this.pending)) return;
        if (sequence) key = sequence;
      }
      this.pending = this.pending.slice(key.length);
      if (key === "\x1b[1;5A" || key === "\x1b[1;5B") {
        this.detailOffset = Math.max(0, this.detailOffset + (key.endsWith("A") ? -1 : 1));
        continue;
      }
      if (key === "\x1b" || key === "\x03") { this.cancel(); return; }
      if (key === "\r" || key === "\n") {
        if (this.spec.options) {
          const option = this.matches()[this.selected];
          if (option) this.finish(option.value);
        } else {
          const validation = this.spec.validate?.(this.value);
          if (validation) this.error = String(validation);
          else this.finish(this.value as T);
        }
        continue;
      }
      const count = this.matches().length;
      if (this.spec.options && ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\t"].includes(key)) {
        const delta = key === "\x1b[A" ? -1 : key === "\x1b[5~" ? -8 : key === "\x1b[6~" ? 8 : 1;
        this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
      } else if (/^\x1b\[<6[45];/.test(key)) {
        this.selected = Math.max(0, Math.min(count - 1, this.selected + (key.startsWith("\x1b[<64;") ? -3 : 3)));
      } else if (key === "\x7f" || key === "\b") {
        const before = Array.from(this.value.slice(0, this.cursor));
        const removed = before.pop()?.length ?? 0;
        this.value = before.join("") + this.value.slice(this.cursor);
        this.cursor -= removed;
        this.selected = 0;
      } else if (key === "\x15") {
        this.value = this.value.slice(this.cursor); this.cursor = 0; this.selected = 0;
      } else if (key === "\x1b[D") {
        this.cursor -= Array.from(this.value.slice(0, this.cursor)).pop()?.length ?? 0;
      } else if (key === "\x1b[C") {
        this.cursor += Array.from(this.value.slice(this.cursor))[0]?.length ?? 0;
      } else if (key === "\x01" || key === "\x1b[H") this.cursor = 0;
      else if (key === "\x05" || key === "\x1b[F") this.cursor = this.value.length;
      else if (key === "\x1b[3~") {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + (Array.from(this.value.slice(this.cursor))[0]?.length ?? 0));
      } else if (!key.startsWith("\x1b") && key >= " ") this.insert(key);
    }
  }

  view(height: number, width: number): DialogRow[] {
    const display = this.spec.password ? "•".repeat(Math.min(this.value.length, 32)) : this.value;
    const caret = this.spec.password ? Math.min(this.cursor, 32) : this.cursor;
    const field = display ? `${display.slice(0, caret)}▏${display.slice(caret)}`
      : `▏${this.spec.placeholder || (this.spec.options ? "Type to filter…" : "Type or paste…")}`;
    const details = wrapStyledText(this.spec.message, Math.max(1, width));
    const detailCapacity = Math.max(1, Math.min(4, height - 8));
    const offset = Math.min(this.detailOffset, Math.max(0, details.length - detailCapacity));
    const title: DialogRow[] = details.slice(offset, offset + detailCapacity).map((text) => ({ text, tone: "title" }));
    if (details.length > detailCapacity) title.push({ text: `Ctrl+↑↓ scroll details (${offset + 1}/${details.length})`, tone: "muted" });
    const rows: DialogRow[] = [
      ...title,
      { text: "", tone: "normal" },
      { text: `${this.spec.options ? "Search" : this.spec.password ? "API key" : "Value"}  › ${field.slice(-Math.max(8, width - 14))}`, tone: display ? "normal" : "muted" },
      { text: "", tone: "normal" },
    ];
    if (this.spec.options) {
      const options = this.matches();
      const capacity = Math.max(1, height - rows.length - 2);
      const start = Math.max(0, Math.min(this.selected - Math.floor(capacity / 2), options.length - capacity));
      for (let index = start; index < Math.min(options.length, start + capacity); index++) {
        const option = options[index];
        rows.push({ text: `${index === this.selected ? "›" : " "} ${option.label}${option.hint ? `  ${option.hint}` : ""}`, tone: index === this.selected ? "selected" : "normal" });
      }
      if (!options.length) rows.push({ text: "No matches. Backspace to change the search.", tone: "muted" });
      rows.push({ text: "", tone: "normal" }, { text: `${options.length ? this.selected + 1 : 0} / ${options.length}  •  ↑↓ select  Enter choose  Esc back`, tone: "muted" });
    } else {
      rows.push({ text: this.error || (this.spec.password ? "Hidden input • paste supported • never added to chat" : "←→ edit  Ctrl+U clear"), tone: this.error ? "error" : "muted" });
      rows.push({ text: "Enter confirm   Esc cancel", tone: "muted" });
    }
    // Small terminals still expose the selected option and a way to cancel.
    if (height < 8) {
      const choice = this.spec.options ? this.matches()[this.selected] : undefined;
      return [
        { text: this.spec.message, tone: "title" },
        { text: `› ${field}`, tone: "normal" },
        { text: choice ? `› ${choice.label}` : this.error || (this.spec.options ? "No matches" : "Enter confirm"), tone: "selected" },
        { text: "↑↓ select  Enter choose  Esc back", tone: "muted" },
      ].slice(0, Math.max(1, height)) as DialogRow[];
    }
    return rows.slice(0, Math.max(1, height));
  }
}
