/** Cell-aware text layout. Retain SGR styling, never terminal navigation from output. */
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const sgr = /^\x1b\[[0-9;]*m$/;
export function safeTerminalText(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => sgr.test(sequence) ? sequence : "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
}
export function cellWidth(value: string): number {
  let width = 0;
  for (const { segment } of segments.segment(value.replace(/\x1b\[[0-9;]*m/g, ""))) {
    const code = segment.codePointAt(0)!;
    if (code < 32 || /^(?:\p{Mark}|\u200d|\ufe0f)+$/u.test(segment)) continue;
    width += /\p{Extended_Pictographic}/u.test(segment) ||
      (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
        code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
        code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
        code >= 0x20000)) ? 2 : 1;
  }
  return width;
}
export function wrapStyledText(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const rows: string[] = [];
  let row = "", used = 0, style = "";
  for (const token of safeTerminalText(value).split(/(\x1b\[[0-9;]*m)/g)) {
    if (sgr.test(token)) {
      style = token === "\x1b[0m" || token === "\x1b[m" ? "" : style + token;
      row += token;
      continue;
    }
    for (const { segment } of segments.segment(token)) {
      const size = cellWidth(segment);
      if (used + size > width && used > 0) {
        rows.push(row + (style ? "\x1b[0m" : ""));
        row = style; used = 0;
      }
      // A wide glyph cannot fit in a one-cell terminal.
      row += size > width ? "?" : segment;
      used += Math.min(size, width);
    }
  }
  rows.push(row + (style ? "\x1b[0m" : ""));
  return rows;
}
export function clipStyledText(value: string, columns: number): string {
  const clean = safeTerminalText(value).replace(/[\r\n\t]/g, " ");
  const width = Math.max(1, columns);
  return cellWidth(clean) <= width ? clean : wrapStyledText(clean, Math.max(1, width - 1))[0] + (width > 1 ? "…" : "");
}

/** Wrap an editable draft without moving the input outside its three-row box. */
export function layoutComposer(value: string, cursor: number, columns: number, height = 3): {
  lines: string[]; cursorRow: number; cursorColumn: number;
} {
  const width = Math.max(1, columns);
  const lines = [""];
  let used = 0, cursorRow = 0, cursorColumn = 0;
  for (const { segment, index } of segments.segment(value)) {
    const size = Math.min(width, cellWidth(segment));
    if (used + size > width || used === width) { lines.push(""); used = 0; }
    if (index <= cursor) { cursorRow = lines.length - 1; cursorColumn = used; }
    lines[lines.length - 1] += segment;
    used += size;
    if (index + segment.length <= cursor) { cursorRow = lines.length - 1; cursorColumn = used; }
  }
  if (cursorColumn === width) {
    cursorRow++;
    cursorColumn = 0;
    if (cursorRow === lines.length) lines.push("");
  }
  const start = Math.max(0, Math.min(cursorRow - height + 1, lines.length - height));
  return { lines: lines.slice(start, start + height), cursorRow: cursorRow - start, cursorColumn };
}
