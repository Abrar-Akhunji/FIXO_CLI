/**
 * markdown-stream.ts — incremental ANSI markdown renderer for
 * streaming model output.
 *
 * Design contract:
 *   - `write(chunk)` accepts arbitrary chunks (a single byte, half
 *     a word, a full paragraph). Lines are buffered until the
 *     trailing `\n` arrives; partial lines stay in the buffer.
 *   - `flush()` closes the renderer and emits any remaining buffer.
 *
 * State machine: `text` → `code-fence` → `text`, `text` → `table`
 * → `text`. Transitions trigger on a complete line; partial lines
 * never push the renderer into a new mode.
 *
 * Fenced code blocks use a hybrid presentation:
 *   - TTY path: stream a dim preview with side borders + the top
 *     border, then on close fence cursor-up + clear-to-end-of-screen
 *     and re-emit the finalised framed block with syntax highlight.
 *   - Non-TTY path (tests, pipes): suppress the preview and emit
 *     only the finalised framed block. Output is deterministic.
 *
 * Tables are buffered until a blank line / non-table line arrives,
 * then rendered with Unicode box drawing.
 */
import { C, visLen, padToVisual } from './colors.js';

/* ──────────────────────── width helpers ──────────────────────── */

const FRAME_FALLBACK = 76;

function frameWidth(): number {
  const cols = process.stdout.columns ?? FRAME_FALLBACK + 4;
  return Math.max(20, Math.min(100, cols - 4));
}

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

function safeWrite(s: string): void {
  try { process.stdout.write(s); } catch { /* stdout may be closed */ }
}

function safeWriteLine(s: string): void {
  safeWrite(s + '\n');
}

/* ──────────────────────── inline formatting ──────────────────────── */

const ITALIC_ON = '\x1b[3m';

/**
 * Apply inline markdown formatting to a single line: bold, italic,
 * inline code, links, file paths, error keywords. Returns an
 * ANSI-coloured string suitable for embedding in a wider line.
 *
 * Order matters: bold (`**`) before italic (`*`) so the longer
 * delimiter wins. Inline code uses backticks and runs after the
 * emphasis pass so backticks inside emphasis are honoured.
 */
function inlineFormat(text: string): string {
  let out = text;
  // Links: [text](url) → just the text in blue + underline.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string) => `${C.BLUE}\x1b[4m${txt}${C.RESET}`);
  // Inline code first so its body is not re-formatted by the
  // emphasis pass below.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `${C.PURPLE}${code}${C.RESET}`);
  // Bold (**...**).
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => `${C.BOLD}${C.SNOW}${c}${C.RESET}`);
  // Italic (*...* or _..._), skipping the bold escape we just emitted.
  out = out.replace(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, (_m, c: string) => `${ITALIC_ON}${C.SNOW3}${c}${C.RESET}`);
  out = out.replace(/(?<![_\\])_([^_\n]+)_(?!_)/g, (_m, c: string) => `${ITALIC_ON}${C.SNOW3}${c}${C.RESET}`);
  // Warning keywords.
  out = out.replace(/\b(error|errors|failed|warning|warn)\b/gi, (m) => `${C.LAVA}${m}${C.RESET}`);
  return out;
}

/* ──────────────────────── code highlight ──────────────────────── */

const LANG_KEYWORDS: Record<string, ReadonlySet<string>> = {
  typescript: new Set(['const', 'let', 'var', 'function', 'class', 'import', 'export', 'from', 'return', 'if', 'else', 'for', 'while', 'async', 'await', 'interface', 'type', 'enum', 'extends', 'implements', 'new', 'throw', 'try', 'catch', 'finally', 'public', 'private', 'protected', 'readonly', 'static', 'this', 'super', 'void', 'true', 'false', 'null', 'undefined']),
  javascript: new Set(['const', 'let', 'var', 'function', 'class', 'import', 'export', 'from', 'return', 'if', 'else', 'for', 'while', 'async', 'await', 'new', 'throw', 'try', 'catch', 'finally', 'this', 'super', 'true', 'false', 'null', 'undefined']),
  python: new Set(['def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while', 'async', 'await', 'try', 'except', 'finally', 'with', 'as', 'in', 'is', 'not', 'and', 'or', 'pass', 'raise', 'lambda', 'yield', 'True', 'False', 'None', 'self']),
  rust: new Set(['fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'use', 'pub', 'mod', 'return', 'if', 'else', 'for', 'while', 'loop', 'match', 'self', 'Self', 'true', 'false']),
  go: new Set(['func', 'var', 'const', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'defer', 'go', 'chan', 'struct', 'interface', 'type', 'true', 'false', 'nil']),
  bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'function', 'return', 'export', 'local', 'echo']),
  sh: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'function', 'return', 'export', 'local', 'echo']),
  json: new Set(['true', 'false', 'null']),
};

function langKey(raw: string): string {
  const k = raw.toLowerCase().trim();
  if (k === 'ts' || k === 'tsx') return 'typescript';
  if (k === 'js' || k === 'jsx' || k === 'mjs') return 'javascript';
  if (k === 'py') return 'python';
  if (k === 'rs') return 'rust';
  if (k === 'shell' || k === 'zsh') return 'bash';
  return k;
}

/**
 * Tokenise a single line of code and emit ANSI-coloured output.
 * Token rules (in scan order, first match wins):
 *   - Line comment (`//` for C-family, `#` for python/bash) → SNOW4.
 *   - String literal (`"`, `'`, `` ` ``)                    → GREEN.
 *   - Numeric literal                                       → YELLOW.
 *   - Identifier / keyword                                  → PURPLE if keyword, SNOW2 otherwise.
 *   - Punctuation / whitespace                              → SNOW3.
 *
 * Languages without an entry in {@link LANG_KEYWORDS} get a plain
 * SNOW2 rendering (no highlighting).
 */
function highlightCodeLine(line: string, lang: string): string {
  const key = langKey(lang);
  const keywords = LANG_KEYWORDS[key];
  if (!keywords) return `${C.SNOW2}${line}${C.RESET}`;
  const usesHashComment = key === 'python' || key === 'bash' || key === 'sh';
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    // Comment-to-end-of-line.
    if (c === '/' && line[i + 1] === '/') {
      out.push(`${C.SNOW4}${line.slice(i)}${C.RESET}`);
      break;
    }
    if (c === '#' && usesHashComment) {
      out.push(`${C.SNOW4}${line.slice(i)}${C.RESET}`);
      break;
    }
    // String literal.
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === '\\' && j + 1 < line.length) j++;
        j++;
      }
      j = Math.min(j + 1, line.length);
      out.push(`${C.GREEN}${line.slice(i, j)}${C.RESET}`);
      i = j;
      continue;
    }
    // Number.
    if (/\d/.test(c) && (i === 0 || !/[A-Za-z_]/.test(line[i - 1]!))) {
      let j = i;
      while (j < line.length && /[\d.]/.test(line[j]!)) j++;
      out.push(`${C.YELLOW}${line.slice(i, j)}${C.RESET}`);
      i = j;
      continue;
    }
    // Identifier.
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      if (keywords.has(word)) out.push(`${C.PURPLE}${word}${C.RESET}`);
      else out.push(`${C.SNOW2}${word}${C.RESET}`);
      i = j;
      continue;
    }
    // Everything else (punctuation, whitespace).
    out.push(`${C.SNOW3}${c}${C.RESET}`);
    i++;
  }
  return out.join('');
}

/* ──────────────────────── word wrap ──────────────────────── */

function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text.length === 0) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const out: string[] = [];
  let line = '';
  const pushWord = (w: string): void => {
    // Hard-break words that don't fit on a line by themselves.
    while (w.length > width) {
      if (line.length > 0) { out.push(line); line = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (line.length === 0) {
      line = w;
    } else if (line.length + 1 + w.length <= width) {
      line += ' ' + w;
    } else {
      out.push(line);
      line = w;
    }
  };
  for (const w of words) pushWord(w);
  if (line.length > 0) out.push(line);
  return out;
}

/* ──────────────────────── renderer ──────────────────────── */

type State = 'text' | 'code-fence' | 'table';

export class MarkdownStreamRenderer {
  private buf = '';
  private state: State = 'text';
  private codeLang = '';
  private codeLines: string[] = [];
  private previewLineCount = 0;
  private tableRows: string[] = [];
  private firstWrite = true;

  /**
   * Feed a chunk of streamed text. Lines are emitted as they
   * complete; the trailing fragment (text after the last `\n`)
   * stays in the buffer until the next write or flush.
   */
  write(chunk: string): void {
    if (this.firstWrite) {
      // Match the leading newline the legacy console.log path used,
      // so the rendered block lifts off the prompt cleanly.
      safeWrite('\n');
      this.firstWrite = false;
    }
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  /**
   * Close the renderer. Emits any buffered partial line, closes
   * any open code fence (treating EOF as an implicit close), and
   * flushes any open table.
   */
  flush(): void {
    if (this.buf.length > 0) {
      const tail = this.buf;
      this.buf = '';
      this.handleLine(tail);
    }
    if (this.state === 'code-fence') this.closeCodeFence();
    if (this.state === 'table') this.flushTable();
  }

  /* ────────── line dispatch ────────── */

  private handleLine(line: string): void {
    if (this.state === 'code-fence') {
      if (/^\s*```\s*$/.test(line)) { this.closeCodeFence(); return; }
      this.codeLines.push(line);
      this.streamCodePreviewLine(line);
      return;
    }
    if (this.state === 'table') {
      if (this.looksLikeTableRow(line)) { this.tableRows.push(line); return; }
      this.flushTable();
      // Fall through to text handling for this line.
    }
    const fence = line.match(/^\s*```\s*(\S+)?\s*$/);
    if (fence) { this.openCodeFence(fence[1] ?? ''); return; }
    if (this.looksLikeTableRow(line)) {
      this.state = 'table';
      this.tableRows.push(line);
      return;
    }
    this.renderTextLine(line);
  }

  /* ────────── text-mode renderers ────────── */

  private renderTextLine(line: string): void {
    if (line.trim() === '') { safeWriteLine(''); return; }
    // Heading.
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const color = level === 1 ? C.LAVA : level === 2 ? C.LAVA : C.SNOW;
      const underline = level <= 2 ? '\x1b[4m' : '';
      safeWriteLine(`  ${C.BOLD}${color}${underline}${text}${C.RESET}`);
      // h1/h2 get a blank line for breathing room.
      if (level <= 2) safeWriteLine('');
      return;
    }
    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      const w = frameWidth();
      safeWriteLine(`  ${C.SNOW4}${'─'.repeat(w)}${C.RESET}`);
      return;
    }
    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const rest = line.replace(/^\s*>\s?/, '');
      safeWriteLine(`  ${C.LAVA}│${C.RESET} ${C.SNOW3}${inlineFormat(rest)}${C.RESET}`);
      return;
    }
    // Bulleted list.
    const b = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (b) {
      const sp = b[1]!;
      const rest = b[3]!;
      safeWriteLine(`  ${sp}${C.LAVA}•${C.RESET} ${inlineFormat(rest)}`);
      return;
    }
    // Numbered list.
    const n = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (n) {
      const sp = n[1]!;
      const num = n[2]!;
      const rest = n[3]!;
      safeWriteLine(`  ${sp}${C.LAVA}${num}.${C.RESET} ${inlineFormat(rest)}`);
      return;
    }
    // Plain paragraph — wrap.
    const w = frameWidth();
    for (const wrapped of wrapToWidth(line, w - 2)) {
      safeWriteLine(`  ${inlineFormat(wrapped)}`);
    }
  }

  /* ────────── code fence ────────── */

  private openCodeFence(lang: string): void {
    this.state = 'code-fence';
    this.codeLang = lang;
    this.codeLines = [];
    this.previewLineCount = 0;
    if (!isTTY()) return;
    // Stream a top border immediately so the user sees the box
    // appearing. The lang tag (or "stream") sits in the top edge.
    safeWriteLine(this.codeTopBorder(lang || 'stream'));
    this.previewLineCount++;
  }

  private streamCodePreviewLine(line: string): void {
    if (!isTTY()) return;
    const w = frameWidth();
    const inner = w - 2;
    const truncated = line.length > inner ? line.slice(0, inner) : line;
    const pad = Math.max(0, inner - truncated.length);
    safeWriteLine(`  ${C.LAVA}│${C.RESET} ${C.SNOW4}${truncated}${C.RESET}${' '.repeat(pad)} ${C.LAVA}│${C.RESET}`);
    this.previewLineCount++;
  }

  private closeCodeFence(): void {
    if (isTTY() && this.previewLineCount > 0) {
      // Erase the dim preview + its top border, then re-render
      // with syntax highlighting.
      safeWrite(`\x1b[${this.previewLineCount}A\r\x1b[J`);
    }
    safeWriteLine(this.codeTopBorder(this.codeLang || 'code'));
    const w = frameWidth();
    const inner = w - 2;
    for (const raw of this.codeLines) {
      const truncated = raw.length > inner ? raw.slice(0, inner) : raw;
      const highlighted = highlightCodeLine(truncated, this.codeLang);
      const pad = Math.max(0, inner - visLen(highlighted));
      safeWriteLine(`  ${C.LAVA}│${C.RESET} ${highlighted}${' '.repeat(pad)} ${C.LAVA}│${C.RESET}`);
    }
    safeWriteLine(`  ${C.LAVA}└${'─'.repeat(frameWidth())}┘${C.RESET}`);
    this.state = 'text';
    this.codeLang = '';
    this.codeLines = [];
    this.previewLineCount = 0;
  }

  private codeTopBorder(label: string): string {
    const w = frameWidth();
    const tag = ` ${label} `;
    const fillLen = Math.max(0, w - tag.length - 1);
    return `  ${C.LAVA}┌${C.RESET}${C.LAVA}${tag}${C.RESET}${C.LAVA}${'─'.repeat(fillLen)}┐${C.RESET}`;
  }

  /* ────────── tables ────────── */

  private looksLikeTableRow(line: string): boolean {
    const t = line.trim();
    return t.startsWith('|') && t.endsWith('|') && t.length >= 3;
  }

  private flushTable(): void {
    const rawRows = this.tableRows.map((row) => {
      const t = row.trim().slice(1, -1);
      return t.split('|').map((cell) => cell.trim());
    });
    this.tableRows = [];
    this.state = 'text';
    if (rawRows.length === 0) return;
    const isDivider = (cells: string[]): boolean =>
      cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
    const header = rawRows[0]!;
    let bodyStart = 1;
    if (rawRows.length > 1 && isDivider(rawRows[1]!)) bodyStart = 2;
    const body = rawRows.slice(bodyStart);
    const cols = header.length;
    if (cols === 0) return;

    // Split each cell on <br>, <br/>, <br />, and real newlines so
    // models emitting `<br>` for "wrap inside cell" produce real
    // visual line breaks. Pre-segment per cell.
    const segmentCell = (raw: string): string[] =>
      raw
        .split(/<br\s*\/?>|\\n|\n/i)
        .map((s) => s.trim())
        .filter((_s, i, arr) => arr.length === 1 || _s.length > 0 || i < arr.length - 1);

    const segHeader = header.map(segmentCell);
    const segBody = body.map((row) => row.map(segmentCell));

    // Natural width per column = longest single segment in any
    // cell, after inline formatting (so escape codes don't count).
    const natural = new Array<number>(cols).fill(0);
    for (const segRow of [segHeader, ...segBody]) {
      for (let i = 0; i < cols; i++) {
        for (const seg of segRow[i] ?? []) {
          const len = visLen(inlineFormat(seg));
          if (len > natural[i]!) natural[i] = len;
        }
      }
    }

    // Available inner width: terminal width minus the 2-char margin
    // minus the (cols+1) vertical separators minus (cols*2) cell
    // padding (one space each side).
    const margin = 2;
    const cellPad = 2; // ' x ' adds 2
    const sepCount = cols + 1;
    const available = Math.max(cols * 3, frameWidth() - sepCount - cols * cellPad);

    // Shrink the widest columns iteratively until the sum fits.
    const widths = natural.slice();
    // Clamp tiny minimum so each column can hold ~one short word.
    const MIN = 4;
    while (widths.reduce((a, b) => a + b, 0) > available) {
      let maxIdx = 0;
      for (let i = 1; i < cols; i++) if (widths[i]! > widths[maxIdx]!) maxIdx = i;
      if (widths[maxIdx]! <= MIN) break;
      widths[maxIdx] = widths[maxIdx]! - 1;
    }
    // Final safety: if even MIN-per-col overflows, accept overflow
    // gracefully rather than infinite-loop above (loop exits via `break`).
    void margin;

    const border = (l: string, m: string, r: string): string => {
      const segs = widths.map((wd) => '─'.repeat(wd + 2));
      return `  ${C.SNOW4}${l}${segs.join(m)}${r}${C.RESET}`;
    };

    // Render one logical table row, possibly across multiple
    // visual lines if any cell needs wrapping. The result is an
    // array of visual lines.
    const renderLogicalRow = (segCells: string[][], bold = false): string[] => {
      // Wrap each cell to its column width, joining segments with
      // forced line breaks first.
      const wrappedCells: string[][] = [];
      let height = 1;
      for (let i = 0; i < cols; i++) {
        const segments = segCells[i] ?? [''];
        const lines: string[] = [];
        for (const seg of segments) {
          for (const wrapped of wrapToWidth(seg, widths[i]!)) {
            lines.push(wrapped);
          }
        }
        if (lines.length === 0) lines.push('');
        wrappedCells.push(lines);
        if (lines.length > height) height = lines.length;
      }
      const visualLines: string[] = [];
      for (let row = 0; row < height; row++) {
        const parts: string[] = [];
        for (let i = 0; i < cols; i++) {
          const raw = wrappedCells[i]![row] ?? '';
          const formatted = bold
            ? `${C.BOLD}${C.SNOW}${raw}${C.RESET}`
            : inlineFormat(raw);
          const pad = Math.max(0, widths[i]! - visLen(formatted));
          parts.push(` ${formatted}${' '.repeat(pad)} `);
        }
        visualLines.push(
          `  ${C.SNOW4}│${C.RESET}${parts.join(`${C.SNOW4}│${C.RESET}`)}${C.SNOW4}│${C.RESET}`,
        );
      }
      return visualLines;
    };

    safeWriteLine(border('┌', '┬', '┐'));
    for (const line of renderLogicalRow(segHeader, true)) safeWriteLine(line);
    safeWriteLine(border('├', '┼', '┤'));
    for (let r = 0; r < segBody.length; r++) {
      for (const line of renderLogicalRow(segBody[r]!)) safeWriteLine(line);
      // Light row separator for multi-line bodies so rows stay
      // visually distinct. Skip after the last body row — the
      // closing border handles that.
      if (segBody.length > 1 && r < segBody.length - 1) {
        safeWriteLine(border('├', '┼', '┤'));
      }
    }
    safeWriteLine(border('└', '┴', '┘'));
  }
}

/* ──────────────────────── one-shot helper ──────────────────────── */

/**
 * Render a complete markdown string (non-streaming path). Used by
 * the post-tool response print site in single-agent.ts.
 */
export function renderMarkdown(text: string): void {
  const r = new MarkdownStreamRenderer();
  r.write(text);
  if (!text.endsWith('\n')) r.write('\n');
  r.flush();
}

/* ──────────────────────── exports for tests ──────────────────────── */

export const __internal = { inlineFormat, highlightCodeLine, langKey, padToVisual };
