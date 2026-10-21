/**
 * The portal's own locale: the one it renders its pages in and asks billing to answer in.
 *
 * It is the first of the browser's languages (`navigator.languages`) whose language the portal has strings for,
 * with that language's region (`en-GB`), or `en-US` when there is none. It is not the browser's raw preferences
 * (an `accept-language` header would list languages the page cannot show), so billing is told the language the
 * person actually reads, and the dates and amounts Core formats agree with it.
 */

/** The languages the portal has strings for. Today that is English. */
export const PORTAL_LANGUAGES: readonly string[] = ["en"];

/** The locale when none of the browser's languages is one the portal has strings for. */
export const DEFAULT_PORTAL_LOCALE = "en-US";

/** The browser's languages in order of preference, or none where there is no browser (a server render, a test). */
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** The language and region of a BCP 47 tag, spelled canonically (`en-GB`); null when it isn't a well-formed tag. */
function parse(tag: string): { language: string; region: string | undefined } | null {
  try {
    const { language, region } = new Intl.Locale(tag);
    return { language, region };
  } catch {
    return null;
  }
}

/**
 * The portal's locale for `languages` (the browser's, in order of preference; `navigator.languages` when not
 * given). A tag that isn't well formed is passed over.
 */
export function portalLocale(languages: readonly string[] | undefined = browserLanguages()): string {
  for (const tag of languages ?? []) {
    const parsed = parse(tag);
    if (parsed && PORTAL_LANGUAGES.includes(parsed.language)) {
      return parsed.region ? `${parsed.language}-${parsed.region}` : parsed.language;
    }
  }
  return DEFAULT_PORTAL_LOCALE;
}
