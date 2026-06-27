function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findFuzzyMatches(haystack: string, needle: string): { start: number, end: number, match: string }[] {
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  
  const matches: { start: number, end: number, match: string }[] = [];
  let match;
  while ((match = regex.exec(haystack)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      match: match[0],
    });
  }
  return matches;
}

export function adaptNewStringForFuzzy(oldString: string, newString: string): string {
  const oldLeading = oldString.match(/^\s*/)?.[0] || '';
  const oldTrailing = oldString.match(/\s*$/)?.[0] || '';
  
  let adapted = newString;
  if (oldLeading && adapted.startsWith(oldLeading)) {
    adapted = adapted.substring(oldLeading.length);
  }
  if (oldTrailing && adapted.endsWith(oldTrailing)) {
    adapted = adapted.substring(0, adapted.length - oldTrailing.length);
  }
  return adapted;
}
