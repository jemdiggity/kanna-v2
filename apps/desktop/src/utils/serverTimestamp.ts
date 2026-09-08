/**
 * Timestamps that reach the desktop come from two places with two shapes:
 * the server writes SQLite's `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, UTC
 * with no zone designator — while optimistic local state writes
 * `Date.prototype.toISOString()`, which carries `Z`.
 *
 * `new Date()` reads the zone-less form as LOCAL time, so west of UTC every
 * server timestamp lands hours in the future and east of UTC hours in the
 * past. That silently broke the "don't mark a just-unread task read" guard in
 * `stores/selection.ts`: in a negative-offset zone the guard matched forever
 * and selecting an unread task never marked it read.
 */
const ZONED_TIMESTAMP = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseServerTimestamp(value: string): Date {
  const trimmed = value.trim();
  if (ZONED_TIMESTAMP.test(trimmed)) return new Date(trimmed);
  return new Date(`${trimmed.replace(" ", "T")}Z`);
}
