/**
 * Pure composer decisions. The REPL applies them to readline.
 * A single-line paste is text. A slash prefix can be completed.
 */

export function classifyBracketedPaste(
  raw: string,
): { kind: "line"; text: string } | { kind: "block"; text: string; lines: number } {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= 1) return { kind: "line", text: lines[0] ?? "" };
  return {
    kind: "block",
    text: text.endsWith("\n") ? text.slice(0, -1) : text,
    lines: lines.length,
  };
}

/** The line is only `/something` with no space yet. */
export function isSlashPrefix(line: string): boolean {
  return /^\/\S*$/.test(line);
}

/** Prefixes win; a small edit distance covers common command typos. */
export function rankSlashCommands(
  input: string,
  commands: readonly string[],
): string[] {
  const query = input.toLowerCase();
  if (!query.startsWith("/")) return [];
  const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(
          next[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous = next;
    }
    return previous[b.length];
  };
  return commands
    .map((command, index) => {
      const candidate = command.toLowerCase();
      const prefix = candidate.startsWith(query);
      const edits = distance(query, candidate.slice(0, query.length));
      return { command, index, score: prefix ? 0 : edits + 2 };
    })
    .filter(({ score }) => score <= Math.max(3, Math.floor(query.length / 3) + 2))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ command }) => command);
}

/**
 * When a suggestion is open on a slash prefix, Enter and Tab
 * insert the highlighted command instead of submitting the fragment.
 */
export function acceptHighlighted(
  line: string,
  highlighted: string | null | undefined,
): string | null {
  if (!highlighted || !isSlashPrefix(line)) return null;
  return highlighted.endsWith(" ") ? highlighted : `${highlighted} `;
}

/** Keep readline state and its painted line in sync after completion/paste. */
export function replaceComposerLine(
  editor: { line: string; cursor: number; _refreshLine(): void },
  value: string,
  cursor = value.length,
): void {
  editor.line = value;
  editor.cursor = Math.max(0, Math.min(cursor, value.length));
  editor._refreshLine();
}

/** Replace only the active slash command or @mention, preserving nearby text. */
export function completeActiveToken(
  line: string,
  cursor: number,
  tokenStart: number,
  value: string,
): { line: string; cursor: number } | null {
  if (tokenStart < 0 || tokenStart > cursor || !value) return null;
  const remainingToken = /^\S*/.exec(line.slice(cursor))?.[0] ?? "";
  const suffix = line.slice(cursor + remainingToken.length);
  const next = line.slice(0, tokenStart) + value +
    (value.endsWith(" ") && suffix.startsWith(" ") ? suffix.slice(1) : suffix);
  return { line: next, cursor: tokenStart + value.length };
}

/** First `/model` screen: connected providers, then add. No mixed list. */
export function providerChoiceValues(providerNames: readonly string[]): string[] {
  return [...providerNames, "__add__"];
}

export function nextHighlight(
  current: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}
