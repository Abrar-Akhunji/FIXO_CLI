/**
 * duration.ts — Human-readable formatting for millisecond durations
 * surfaced in user-facing messages (cooldown errors, telemetry
 * summaries, status bar tooltips).
 *
 * The previous CLI showed raw `134555ms` in messages like
 *   "Provider 'zen' is in cooldown for 134555ms"
 * which forced the user to mentally divide. This helper turns that
 * into "2m 14s" or "45s" or "1h 3m" — exactly the granularity humans
 * read durations at.
 */

/**
 * Format a millisecond duration as a compact human-readable string.
 *
 *   formatDuration(750)       → "750ms"
 *   formatDuration(45_000)    → "45s"
 *   formatDuration(134_555)   → "2m 14s"
 *   formatDuration(3_750_000) → "1h 2m"
 *
 * Returns `"0ms"` for non-finite or negative values rather than
 * throwing, so it is always safe to interpolate into error strings.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    // For multi-hour spans we drop seconds — humans read "1h 3m",
    // not "1h 3m 47s".
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}
