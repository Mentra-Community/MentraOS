import Constants from "expo-constants"

/** The rating used when the build carries none it can read: the lowest, so every rated miniapp is gated. */
const LOWEST_RATING = "4+"

/**
 * The Mentra App's own App Store age rating, from `MENTRA_APP_AGE_RATING` in `app.config.ts` `extra`. The engine
 * gates miniapps rated above it (`hostAgeRating`). A build without a readable rating gets the lowest, 4+, so a
 * configuration mistake gates more miniapps, never fewer.
 */
export function mentraAppAgeRating(extra: unknown = Constants.expoConfig?.extra): string {
  const rating =
    typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>).MENTRA_APP_AGE_RATING : undefined
  return typeof rating === "string" && /^\d{1,2}\+$/.test(rating) ? rating : LOWEST_RATING
}
