/**
 * @fileoverview `asOf` instants for deletion hold calls in tests.
 *
 * Core ignores a set or clear that is not newer than the last one it applied from the same service, so a
 * test that makes several calls in a row stamps each with `nextHoldAsOf()`: a millisecond after the one
 * before, starting a minute in the past (well clear of Core's limit on future instants).
 */

let last = Date.now() - 60_000

/** An ISO 8601 UTC instant later than every one this function returned before. */
export function nextHoldAsOf(): string {
  last = Math.max(last + 1, Date.now() - 60_000)
  return new Date(last).toISOString()
}
