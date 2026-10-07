/**
 * replacer.ts — Multi-strategy cascading file replacement engine.
 *
 * Clean-room TypeScript implementation inspired by industry standard
 * AI coding tool architectures (Grok Build / OpenCode).
 *
 * Implements a 9-level cascading fallback chain to resolve edits reliably
 * when LLMs introduce minor whitespace, indentation, escaping, or anchor variations:
 *   1. SimpleReplacer (exact substring match)
 *   2. LineTrimmedReplacer (per-line whitespace trimmed)
 *   3. BlockAnchorReplacer (first & last line anchors + Levenshtein distance on inner lines)
 *   4. WhitespaceNormalizedReplacer (collapses spaces, tabs, internal runs)
 *   5. IndentationFlexibleReplacer (adapts for indent shifts)
 *   6. EscapeNormalizedReplacer (normalizes \r\n, \t, escaped quotes, unicode quotes)
 *   7. TrimmedBoundaryReplacer (trims leading/trailing empty lines in oldString)
 *   8. ContextAwareReplacer (heuristics with surrounding lines)
 *   9. MultiOccurrenceReplacer (yields all exact matches for multi-occurrence handling)
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export interface ReplacerResult {
  success: boolean;
  newContent?: string;
  strategy?: string;
  occurrences?: number;
  matchedSpan?: string;
  error?: string;
}

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

/**
 * Levenshtein distance algorithm for calculating string similarity.
 */
export function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Guard against matches that are disproportionately larger than oldString,
 * preventing accidental overwrite of huge unintended sections of code.
 */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (oldLines === 1) return false;
  return searchLines >= Math.max(oldLines + 3, oldLines * 2);
}

/**
 * Strategy 1: Simple exact match
 */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/**
 * Strategy 2: Line-trimmed match (ignores line-level leading/trailing whitespace)
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim();
      const searchTrimmed = searchLines[j].trim();

      if (originalTrimmed !== searchTrimmed) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1;
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

/**
 * Strategy 3: Block anchor match with Levenshtein fuzzy distance on middle lines
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.length < 3) return;

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
          break;
        }
      }
    }
  }

  if (candidates.length === 0) return;

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += (1 - distance / maxLen) / linesToCheck;

        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
      }
    } else {
      similarity = 1.0;
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0;
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }
      let matchEndIndex = matchStartIndex;
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length;
        if (k < endLine) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += 1 - distance / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1.0;
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch;
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) matchEndIndex += 1;
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

/**
 * Strategy 4: Whitespace-normalized match (spaces, tabs collapsed)
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    } else {
      const normalizedLine = normalizeWhitespace(line);
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/);
        if (words.length > 0) {
          const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
          try {
            const regex = new RegExp(pattern);
            const match = line.match(regex);
            if (match) yield match[0];
          } catch {
            // invalid regex, skip
          }
        }
      }
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

/**
 * Strategy 5: Indentation-flexible match
 */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

/**
 * Strategy 6: Escape-normalized match
 */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_match, capturedChar) => {
        switch (capturedChar) {
          case "n": return "\n";
          case "t": return "\t";
          case "r": return "\r";
          case "'": return "'";
          case '"': return '"';
          case "`": return "`";
          case "\\": return "\\";
          case "\n": return "\n";
          case "$": return "$";
          default: return capturedChar;
        }
      });
  };

  const unescapedFind = unescapeString(find);

  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    const unescapedBlock = unescapeString(block);

    if (unescapedBlock === unescapedFind) {
      yield block;
    }
  }
};

/**
 * Strategy 7: Trimmed boundary match (trims leading/trailing empty lines in oldString)
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) return;

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

/**
 * Strategy 8: Context-aware anchor match (50% interior line similarity)
 */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;

  if (findLines[findLines.length - 1] === "") {
    findLines.pop();
  }

  const contentLines = content.split("\n");
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1);
        const block = blockLines.join("\n");

        if (blockLines.length === findLines.length) {
          let matchingLines = 0;
          let totalNonEmptyLines = 0;

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim();
            const searchLine = findLines[k].trim();

            if (blockLine.length > 0 || searchLine.length > 0) {
              totalNonEmptyLines++;
              if (blockLine === searchLine) matchingLines++;
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block;
            break;
          }
        }
        break;
      }
    }
  }
};

/**
 * Strategy 9: Multi-occurrence replacer
 */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + Math.max(1, find.length);
  }
};

export const REPLACER_STRATEGIES: { name: string; fn: Replacer }[] = [
  { name: "Simple", fn: SimpleReplacer },
  { name: "LineTrimmed", fn: LineTrimmedReplacer },
  { name: "BlockAnchor", fn: BlockAnchorReplacer },
  { name: "WhitespaceNormalized", fn: WhitespaceNormalizedReplacer },
  { name: "IndentationFlexible", fn: IndentationFlexibleReplacer },
  { name: "EscapeNormalized", fn: EscapeNormalizedReplacer },
  { name: "TrimmedBoundary", fn: TrimmedBoundaryReplacer },
  { name: "ContextAware", fn: ContextAwareReplacer },
  { name: "MultiOccurrence", fn: MultiOccurrenceReplacer },
];

/**
 * High-level replace function executing the 9-stage cascading replacer chain.
 */
export function cascadingReplace(
  content: string,
  oldString: string,
  newString: string,
  options: { replaceAll?: boolean; expectUnique?: boolean } = {},
): ReplacerResult {
  if (oldString === newString) {
    return {
      success: false,
      error: "No changes to apply: oldString and newString are identical.",
    };
  }

  if (oldString === "") {
    return {
      success: false,
      error: 'oldString cannot be empty when editing an existing file. Provide exact text to replace or use write_file.',
    };
  }

  const replaceAll = options.replaceAll === true;
  const expectUnique = !replaceAll && options.expectUnique !== false;

  for (const { name, fn } of REPLACER_STRATEGIES) {
    const candidates: string[] = [];
    for (const match of fn(content, oldString)) {
      if (content.includes(match)) {
        candidates.push(match);
      }
    }

    if (candidates.length === 0) continue;

    // Filter unique candidates
    const uniqueCandidates = Array.from(new Set(candidates));

    for (const candidate of uniqueCandidates) {
      if (isDisproportionateMatch(candidate, oldString)) {
        return {
          success: false,
          error: `Refusing replacement: matched span (${candidate.split("\n").length} lines) is disproportionately larger than oldString (${oldString.split("\n").length} lines). Provide more exact context.`,
        };
      }

      // Check occurrences of this specific candidate in content
      let occurrences = 0;
      let pos = 0;
      while (true) {
        const found = content.indexOf(candidate, pos);
        if (found === -1) break;
        occurrences++;
        pos = found + Math.max(1, candidate.length);
      }

      if (occurrences > 1 && expectUnique) {
        return {
          success: false,
          occurrences,
          strategy: name,
          matchedSpan: candidate,
          error: `oldString appears ${occurrences} times (${name} matches). Provide more surrounding context or set replaceAll=true.`,
        };
      }

      if (occurrences >= 1) {
        let updated: string;
        if (replaceAll) {
          updated = content.split(candidate).join(newString);
        } else {
          const firstIdx = content.indexOf(candidate);
          updated =
            content.substring(0, firstIdx) +
            newString +
            content.substring(firstIdx + candidate.length);
        }

        return {
          success: true,
          newContent: updated,
          strategy: name,
          occurrences,
          matchedSpan: candidate,
        };
      }
    }
  }

  return {
    success: false,
    error: `Could not find oldString in file across all 9 replacer strategies. Verify exact characters or surrounding lines.`,
  };
}
