/**
 * ⏰ TimeUtils — Stateless Timezone Utilities
 *
 * Pure utility class for timezone-aware date operations. Uses the built-in
 * `Intl.DateTimeFormat` API for formatting — no external dependencies.
 *
 * This class has **no transport layer**, no subscriptions, and no wire
 * messages. It is a convenience wrapper for apps that need to display
 * or reason about times in the user's local timezone (which may differ
 * from the server's timezone).
 *
 * @example
 * ```ts
 * const time = new TimeUtils("America/New_York");
 *
 * // Current time in the user's timezone
 * const now = time.now();
 *
 * // Format a date for display
 * const formatted = time.format(now, { hour: "numeric", minute: "2-digit" });
 * // => "3:45 PM"
 *
 * // Convert a UTC date to the user's local timezone
 * const local = time.toLocal(new Date("2024-01-15T20:00:00Z"));
 *
 * // Change timezone at runtime (e.g., user travelled)
 * time.setTimezone("Europe/London");
 * ```
 *
 * @module
 */

// ─── TimeUtils ──────────────────────────────────────────────────────────────

/**
 * Timezone-aware date utility class.
 *
 * Wraps the `Intl.DateTimeFormat` API to provide convenient methods for
 * creating, converting, and formatting dates in a specific timezone.
 *
 * The timezone can be changed at runtime via {@link setTimezone}, making
 * this class suitable for long-lived sessions where the user may travel
 * across timezone boundaries.
 */
export class TimeUtils {
  /**
   * The current IANA timezone identifier (e.g., `"America/New_York"`,
   * `"Europe/London"`, `"Asia/Tokyo"`).
   */
  private _zone: string;

  /**
   * Create a new TimeUtils instance.
   *
   * @param timezone - IANA timezone identifier. Must be a valid timezone
   *   string recognised by `Intl.DateTimeFormat` (e.g., `"America/New_York"`,
   *   `"UTC"`, `"Asia/Tokyo"`).
   *
   * @throws {RangeError} If the provided timezone string is not a valid
   *   IANA timezone identifier.
   *
   * @example
   * ```ts
   * const time = new TimeUtils("America/Los_Angeles");
   * ```
   */
  constructor(timezone: string) {
    // Validate the timezone by attempting to create a formatter with it.
    // Intl.DateTimeFormat will throw a RangeError for invalid timezones.
    TimeUtils.validateTimezone(timezone);
    this._zone = timezone;
  }

  // ─── Accessors ──────────────────────────────────────────────────────────

  /**
   * The current IANA timezone identifier.
   *
   * @example
   * ```ts
   * console.log(time.zone); // "America/New_York"
   * ```
   */
  get zone(): string {
    return this._zone;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Get the current date/time.
   *
   * Returns a standard `Date` object representing the current instant.
   * The `Date` itself is always UTC internally — use {@link format} or
   * {@link toLocal} to interpret it in the configured timezone.
   *
   * @returns A `Date` representing the current moment.
   *
   * @example
   * ```ts
   * const now = time.now();
   * console.log(time.format(now)); // formatted in the configured timezone
   * ```
   */
  now(): Date {
    return new Date();
  }

  /**
   * Convert a `Date` to a new `Date` whose UTC fields represent the
   * wall-clock time in the configured timezone.
   *
   * This is useful when you need to extract hours/minutes/seconds that
   * correspond to the local timezone without using `Intl` formatting.
   *
   * **Note:** The returned `Date` is a synthetic object — its
   * `getUTCHours()` etc. return the *local* values, but calling
   * `toISOString()` on it will produce a misleading string. Prefer
   * {@link format} for display purposes.
   *
   * @param date - The date to convert. Defaults to `new Date()` (now).
   * @returns A new `Date` whose UTC methods return local-timezone values.
   *
   * @example
   * ```ts
   * const utcDate = new Date("2024-01-15T20:00:00Z");
   * const local = time.toLocal(utcDate);
   * console.log(local.getUTCHours()); // 15 if timezone is "America/New_York" (EST = UTC-5)
   * ```
   */
  toLocal(date: Date = new Date()): Date {
    // Use Intl to get the timezone offset, then shift the date.
    // formatToParts gives us the local components — we reconstruct a Date from them.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this._zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const get = (type: string): string => {
      const part = parts.find((p) => p.type === type);
      return part?.value ?? "0";
    };

    const year = parseInt(get("year"), 10);
    const month = parseInt(get("month"), 10) - 1; // JS months are 0-indexed
    const day = parseInt(get("day"), 10);
    let hour = parseInt(get("hour"), 10);
    const minute = parseInt(get("minute"), 10);
    const second = parseInt(get("second"), 10);

    // hour12: false can yield "24" for midnight in some locales — normalise
    if (hour === 24) hour = 0;

    // Construct a Date using UTC setters so the UTC fields hold local values
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  /**
   * Format a `Date` for display in the configured timezone.
   *
   * Delegates to `Intl.DateTimeFormat` with the configured timezone
   * injected automatically. Any valid `Intl.DateTimeFormatOptions` can
   * be passed through.
   *
   * If no options are provided, a sensible default is used:
   * `"1/15/2024, 3:45:00 PM"` (locale-dependent).
   *
   * @param date - The date to format.
   * @param opts - Optional `Intl.DateTimeFormatOptions` to control output.
   * @returns The formatted date string.
   *
   * @example
   * ```ts
   * // Default format
   * time.format(new Date());
   * // => "1/15/2024, 3:45:00 PM"
   *
   * // Custom format — time only
   * time.format(new Date(), { hour: "numeric", minute: "2-digit" });
   * // => "3:45 PM"
   *
   * // Custom format — full date
   * time.format(new Date(), {
   *   weekday: "long",
   *   year: "numeric",
   *   month: "long",
   *   day: "numeric",
   * });
   * // => "Monday, January 15, 2024"
   *
   * // With a specific locale
   * time.format(new Date(), { hour: "numeric", minute: "2-digit" });
   * ```
   */
  format(date: Date, opts?: Intl.DateTimeFormatOptions): string {
    const mergedOpts: Intl.DateTimeFormatOptions = {
      ...opts,
      timeZone: this._zone,
    };

    return new Intl.DateTimeFormat(undefined, mergedOpts).format(date);
  }

  /**
   * Change the timezone at runtime.
   *
   * Validates the new timezone before applying it. If the timezone is
   * invalid, a `RangeError` is thrown and the previous timezone is retained.
   *
   * @param tz - New IANA timezone identifier.
   * @throws {RangeError} If the timezone string is not valid.
   *
   * @example
   * ```ts
   * time.setTimezone("Europe/London");
   * console.log(time.zone); // "Europe/London"
   * ```
   */
  setTimezone(tz: string): void {
    TimeUtils.validateTimezone(tz);
    this._zone = tz;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Validate that a timezone string is recognised by the runtime's
   * `Intl.DateTimeFormat` implementation.
   *
   * @param tz - The timezone string to validate.
   * @throws {RangeError} If the timezone is not valid.
   */
  private static validateTimezone(tz: string): void {
    // Intl.DateTimeFormat throws RangeError for unrecognised timeZone values.
    // We intentionally let that error propagate with a clear message.
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      throw new RangeError(
        `Invalid timezone: "${tz}". ` +
          `Must be a valid IANA timezone identifier (e.g., "America/New_York", "UTC", "Asia/Tokyo").`,
      );
    }
  }
}
