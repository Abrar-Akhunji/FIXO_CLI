/**
 * markdown-stream.test.ts — coverage for the incremental markdown
 * renderer wired into the streaming + non-streaming response paths.
 *
 * The renderer writes to `process.stdout`. Tests capture that
 * output via a monkey-patched `process.stdout.write` and assert
 * on the resulting string. `process.stdout.isTTY` is forced to
 * `undefined` so the renderer takes its non-TTY code path (no
 * preview, no cursor-up escape sequences) — keeping the output
 * deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { C } from '../ui/colors.js';
import { MarkdownStreamRenderer, renderMarkdown, __internal } from '../ui/markdown-stream.js';

/* ──────────────────────── stdout capture ──────────────────────── */

let captured = '';
const originalWrite = process.stdout.write.bind(process.stdout);
const originalIsTTY = process.stdout.isTTY;

function captureStdout(): void {
  captured = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured += s;
    return true;
  };
  // Force non-TTY so the preview/cursor-up logic is suppressed.
  Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
}

test.beforeEach(() => { captureStdout(); });
test.afterEach(() => {
  (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
});

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/* ──────────────────────── inline ──────────────────────── */

test('inlineFormat: backticks → PURPLE, bold → BOLD+SNOW, italic → italic+SNOW3', () => {
  const out = __internal.inlineFormat('use `npm test` and **stop** when _done_');
  assert.ok(out.includes(`${C.PURPLE}npm test${C.RESET}`));
  assert.ok(out.includes(`${C.BOLD}${C.SNOW}stop${C.RESET}`));
  assert.ok(out.includes('\x1b[3m')); // italic on
  assert.ok(out.includes(`${C.SNOW3}done${C.RESET}`));
});

test('inlineFormat: warning keywords → LAVA', () => {
  const out = __internal.inlineFormat('the test failed with an error');
  assert.ok(out.includes(`${C.LAVA}failed${C.RESET}`));
  assert.ok(out.includes(`${C.LAVA}error${C.RESET}`));
});

test('inlineFormat: [text](url) → blue + underline', () => {
  const out = __internal.inlineFormat('See [docs](https://example.com) for more');
  assert.ok(out.includes(`${C.BLUE}\x1b[4mdocs${C.RESET}`));
});

/* ──────────────────────── headings ──────────────────────── */

test('renderMarkdown: # heading is bold + LAVA + underlined', () => {
  renderMarkdown('# Hello world\n');
  assert.ok(captured.includes(C.BOLD));
  assert.ok(captured.includes(C.LAVA));
  assert.ok(captured.includes('\x1b[4m'));
  assert.ok(strip(captured).includes('Hello world'));
});

test('renderMarkdown: ### heading is bold but not underlined', () => {
  renderMarkdown('### subheading\n');
  assert.ok(captured.includes(C.BOLD));
  assert.ok(!captured.includes('\x1b[4m'), 'h3 has no underline');
  assert.ok(strip(captured).includes('subheading'));
});

/* ──────────────────────── lists ──────────────────────── */

test('renderMarkdown: bullet list uses LAVA • glyph', () => {
  renderMarkdown('- first item\n- second item\n');
  assert.ok(captured.includes(`${C.LAVA}•${C.RESET}`));
  assert.ok(strip(captured).includes('first item'));
  assert.ok(strip(captured).includes('second item'));
});

test('renderMarkdown: numbered list keeps the index, glyph in LAVA', () => {
  renderMarkdown('1. alpha\n2. beta\n');
  assert.ok(captured.includes(`${C.LAVA}1.${C.RESET}`));
  assert.ok(captured.includes(`${C.LAVA}2.${C.RESET}`));
});

/* ──────────────────────── horizontal rule + blockquote ──────────────────────── */

test('renderMarkdown: --- renders as a SNOW4 horizontal rule', () => {
  renderMarkdown('above\n---\nbelow\n');
  assert.ok(/─{10,}/.test(strip(captured)));
  assert.ok(captured.includes(C.SNOW4));
});

test('renderMarkdown: > blockquote uses LAVA │ + dim text', () => {
  renderMarkdown('> quoted line\n');
  assert.ok(captured.includes(`${C.LAVA}│${C.RESET}`));
  assert.ok(strip(captured).includes('quoted line'));
});

/* ──────────────────────── code fence ──────────────────────── */

test('renderMarkdown: fenced code emits a framed box with lang label', () => {
  renderMarkdown('```typescript\nconst x = 1;\nconst y = "hi";\n```\n');
  const stripped = strip(captured);
  assert.ok(stripped.includes('typescript'));
  assert.ok(/┌.*typescript.*┐/.test(stripped) || stripped.includes('┌'));
  assert.ok(stripped.includes('└'));
  // Side bars present on each code line.
  const sideMatches = stripped.match(/│/g) ?? [];
  assert.ok(sideMatches.length >= 4, `expected at least 4 │ (2 lines × 2 sides) got ${sideMatches.length}`);
});

test('renderMarkdown: TS keywords inside fence get PURPLE highlight', () => {
  renderMarkdown('```ts\nconst x = 1;\n```\n');
  assert.ok(captured.includes(`${C.PURPLE}const${C.RESET}`));
});

test('renderMarkdown: strings inside fence get GREEN highlight', () => {
  renderMarkdown('```ts\nconst x = "hi";\n```\n');
  assert.ok(captured.includes(`${C.GREEN}"hi"${C.RESET}`));
});

test('renderMarkdown: python keywords highlighted, # comments in SNOW4', () => {
  renderMarkdown('```python\ndef f():\n    # comment\n    return 1\n```\n');
  assert.ok(captured.includes(`${C.PURPLE}def${C.RESET}`));
  assert.ok(captured.includes(`${C.PURPLE}return${C.RESET}`));
  assert.ok(captured.includes(`${C.SNOW4}# comment${C.RESET}`));
});

test('renderMarkdown: unknown language falls back to plain SNOW2', () => {
  renderMarkdown('```xyz\nfoo bar\n```\n');
  assert.ok(captured.includes(`${C.SNOW2}foo bar${C.RESET}`));
});

test('MarkdownStreamRenderer: EOF inside fence closes the block implicitly', () => {
  const r = new MarkdownStreamRenderer();
  r.write('```ts\nconst x = 1;\n');
  r.flush();
  // The bottom border must still be emitted.
  assert.ok(strip(captured).includes('└'));
});

/* ──────────────────────── streaming chunk boundaries ──────────────────────── */

test('MarkdownStreamRenderer: chunk split mid-fence does not desync state', () => {
  const r = new MarkdownStreamRenderer();
  // Split the opening fence across two writes.
  r.write('``');
  r.write('`ts\nconst x = 1;\n');
  r.write('```\n');
  r.flush();
  const stripped = strip(captured);
  assert.ok(stripped.includes('┌'));
  assert.ok(stripped.includes('└'));
  assert.ok(captured.includes(`${C.PURPLE}const${C.RESET}`));
});

test('MarkdownStreamRenderer: chunk split inside a word renders correctly', () => {
  const r = new MarkdownStreamRenderer();
  r.write('hel');
  r.write('lo wo');
  r.write('rld\n');
  r.flush();
  assert.ok(strip(captured).includes('hello world'));
});

test('MarkdownStreamRenderer: trailing partial line is emitted on flush', () => {
  const r = new MarkdownStreamRenderer();
  r.write('paragraph without newline');
  r.flush();
  assert.ok(strip(captured).includes('paragraph without newline'));
});

/* ──────────────────────── tables ──────────────────────── */

test('renderMarkdown: 3-col table renders with box-drawing borders', () => {
  renderMarkdown('| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n');
  const stripped = strip(captured);
  assert.ok(stripped.includes('┌'));
  assert.ok(stripped.includes('┬'));
  assert.ok(stripped.includes('┐'));
  assert.ok(stripped.includes('├'));
  assert.ok(stripped.includes('┼'));
  assert.ok(stripped.includes('┤'));
  assert.ok(stripped.includes('└'));
  assert.ok(stripped.includes('┴'));
  assert.ok(stripped.includes('┘'));
  // All cells present.
  for (const c of ['A', 'B', 'C', '1', '2', '3', '4', '5', '6']) {
    assert.ok(stripped.includes(c), `expected cell ${c}`);
  }
});

test('renderMarkdown: table header is BOLD + SNOW', () => {
  renderMarkdown('| H1 | H2 |\n| - | - |\n| a | b |\n\n');
  assert.ok(captured.includes(`${C.BOLD}${C.SNOW}H1${C.RESET}`));
  assert.ok(captured.includes(`${C.BOLD}${C.SNOW}H2${C.RESET}`));
});

test('renderMarkdown: table flushes when a non-table line follows', () => {
  renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\nplain paragraph after\n');
  const stripped = strip(captured);
  assert.ok(stripped.includes('└'), 'table closed');
  assert.ok(stripped.includes('plain paragraph after'));
});

/* ──────────────────────── pure text ──────────────────────── */

test('renderMarkdown: a single paragraph passes through with margin indent', () => {
  renderMarkdown('just some plain text\n');
  // Lines are prefixed with the two-space margin.
  assert.ok(captured.split('\n').some((l) => l.startsWith('  ') && strip(l).includes('plain text')));
});

test('renderMarkdown: blank line preserved between paragraphs', () => {
  renderMarkdown('first paragraph\n\nsecond paragraph\n');
  const lines = captured.split('\n');
  // There must be at least one empty line between the two paragraphs.
  const idxFirst = lines.findIndex((l) => strip(l).includes('first paragraph'));
  const idxSecond = lines.findIndex((l) => strip(l).includes('second paragraph'));
  assert.ok(idxFirst >= 0 && idxSecond > idxFirst);
  assert.ok(lines.slice(idxFirst + 1, idxSecond).some((l) => l === ''));
});

/* ──────────────────────── lang normaliser ──────────────────────── */

/* ──────────────────────── responsive table ──────────────────────── */

test('renderMarkdown: cells with <br> break onto multiple visual lines', () => {
  // Force a narrow but workable width.
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  renderMarkdown('| Feature | Value |\n| - | - |\n| Tech | TypeScript<br>Node.js |\n\n');
  const stripped = strip(captured);
  assert.ok(stripped.includes('TypeScript'));
  assert.ok(stripped.includes('Node.js'));
  // The literal `<br>` must NOT appear in the rendered output.
  assert.ok(!stripped.includes('<br>'), 'literal <br> escaped through');
});

test('renderMarkdown: wide table proportionally shrinks to fit terminal width', () => {
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  const longA = 'word '.repeat(40).trim();
  const longB = 'thing '.repeat(40).trim();
  renderMarkdown(`| Col A | Col B |\n| - | - |\n| ${longA} | ${longB} |\n\n`);
  const lines = captured.split('\n').map(strip);
  // Every rendered line must fit within the configured columns.
  for (const line of lines) {
    assert.ok(line.length <= 82, `line exceeded terminal width: ${line.length} > 82\n${line}`);
  }
  // And both long values must still appear somewhere.
  const all = lines.join(' ');
  assert.ok(all.includes('word'));
  assert.ok(all.includes('thing'));
});

test('renderMarkdown: multi-row table inserts row separators between rows', () => {
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\n');
  const stripped = strip(captured);
  // Three body rows + header → at least 3 `├` separators (header
  // divider + 2 inter-row dividers) and 1 `└` bottom border.
  const leftJoins = (stripped.match(/├/g) ?? []).length;
  assert.ok(leftJoins >= 3, `expected ≥3 ├ joins, got ${leftJoins}`);
});

test('renderMarkdown: paragraph longer than viewport hard-wraps without overflow', () => {
  Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
  const long = 'a'.repeat(200);
  renderMarkdown(`${long}\n`);
  const lines = captured.split('\n').map(strip);
  for (const line of lines) {
    assert.ok(line.length <= 62, `paragraph line exceeded width: ${line.length}\n${line}`);
  }
});

/* ──────────────────────── heading spacing ──────────────────────── */

test('renderMarkdown: h1 emits a blank line after for breathing room', () => {
  renderMarkdown('# Title\nbody text\n');
  const lines = captured.split('\n');
  const titleIdx = lines.findIndex((l) => strip(l).includes('Title'));
  assert.ok(titleIdx >= 0);
  assert.equal(lines[titleIdx + 1], '', 'expected blank line after h1');
});

test('renderMarkdown: h3 does NOT emit a blank line after', () => {
  renderMarkdown('### Title\nbody text\n');
  const lines = captured.split('\n');
  const titleIdx = lines.findIndex((l) => strip(l).includes('Title'));
  assert.ok(titleIdx >= 0);
  assert.notEqual(lines[titleIdx + 1], '', 'h3 should not insert blank line');
});

test('langKey: aliases map to canonical names', () => {
  assert.equal(__internal.langKey('ts'), 'typescript');
  assert.equal(__internal.langKey('TSX'), 'typescript');
  assert.equal(__internal.langKey('js'), 'javascript');
  assert.equal(__internal.langKey('py'), 'python');
  assert.equal(__internal.langKey('rs'), 'rust');
  assert.equal(__internal.langKey('shell'), 'bash');
});
