/**
 * The workspace portal's public build-time configuration. build.ts replaces each `process.env.X` read
 * here with the value the build ran with. `scripts/deploy-pages.ts` sets them for each Mentra
 * environment; a build without them (a Private Cloud's, CI's or a local one) leaves them empty.
 */

/**
 * The Developer Console the sidebar links to, from `DEVELOPER_CONSOLE_URL`: an absolute http(s) URL
 * without a trailing slash, or null when unset or unusable. A Private Cloud runs Core without the
 * Mentra Miniapp Store, so it has no Developer Console and its portal shows no link.
 */
export function developerConsoleUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** This build's Developer Console, or null. */
export const DEVELOPER_CONSOLE_URL = developerConsoleUrl(process.env.DEVELOPER_CONSOLE_URL);
