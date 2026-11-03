/** Date formatting for the screens. The API sends ISO 8601 strings. */

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** The locale the portal has strings for when none is given. */
export const DEFAULT_LOCALE = "en-US";

/**
 * `locale` when `Intl` can use it, else {@link DEFAULT_LOCALE}: a tag that isn't well formed makes `Intl` throw,
 * and a date or an amount on a page must never be the thing that fails it.
 */
export function usableLocale(locale: string): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Sep 2, 2026, 10:00 AM" in the viewer's time zone; the raw string when it is not a date. */
export function formatDateTime(iso: string): string {
  const date = parse(iso);
  return date ? dateTime.format(date) : iso;
}

/** The calendar day of `date` in the viewer's time zone, as a day number (so a difference of days is whole). */
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

/**
 * When something ends, as the Invited tab says it: "Today", "Tomorrow", "In 6 days", counted in the viewer's calendar
 * days, and "Expired" once it has passed. The raw string when it is not a date. `now` is for tests.
 */
export function formatExpiry(iso: string, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return iso;
  if (date.getTime() <= now.getTime()) return "Expired";
  const days = dayNumber(date) - dayNumber(now);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

/**
 * "Sep 2, 2026" in the viewer's time zone, in the portal's `locale` (`en-US` unless given: "2 Sep 2026" for
 * `en-GB`); the raw string when it is not a date. The zone is read on every call, not once at load.
 */
export function formatDate(iso: string, locale: string = DEFAULT_LOCALE): string {
  const date = parse(iso);
  return date ? new Intl.DateTimeFormat(usableLocale(locale), { dateStyle: "medium" }).format(date) : iso;
}
