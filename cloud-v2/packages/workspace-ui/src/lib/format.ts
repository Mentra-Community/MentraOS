/** Date formatting for the screens. The API sends ISO 8601 strings. */

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Sep 2, 2026, 10:00 AM" in the viewer's time zone; the raw string when it is not a date. */
export function formatDateTime(iso: string): string {
  const date = parse(iso);
  return date ? dateTime.format(date) : iso;
}

/** "Sep 2, 2026" in the viewer's time zone; the raw string when it is not a date. */
export function formatDate(iso: string): string {
  const date = parse(iso);
  return date ? dateOnly.format(date) : iso;
}
