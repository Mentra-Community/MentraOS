/**
 * The links people install miniapps from (spec, "Installing"), read the same way wherever they arrive: a Universal
 * Link or App Link, the QR scanner, or the paste box. The engine reads them (`@mentra/engine/miniapp-links`); this is
 * the Mentra App's reading of them, which adds its own scheme.
 *
 * - **An open link,** `https://apps.mentraglass.com/open?url=<miniapp URL>`, names a miniapp URL.
 * - **A package link,** `https://apps.mentraglass.com/package/<packageName>`, names a listed miniapp; the directory
 *   says which URL serves it. `/app/<packageName>`, the directory's older page, reads the same.
 * - **A miniapp URL** on its own, as `mentra pack` or a developer's site gives it. A pasted `.../miniapp.json` means
 *   the URL that serves it, and an address without a scheme means HTTPS.
 *
 * `apps.mentra.glass` and the Mentra App's own scheme (`com.mentra://open?url=…`, or the dev app's
 * `com.mentra.dev://open?url=…`) are read the same way.
 */
import {
  isMiniappLink,
  MINIAPP_LINK_HOSTS,
  miniappPackageLink,
  parseMiniappLink,
  type MiniappLink,
} from "@mentra/engine/miniapp-links"

/** The hosts the Mentra App claims app links on: the directory website, and its former name. */
export const MENTRA_APP_LINK_HOSTS: readonly string[] = MINIAPP_LINK_HOSTS

/** The Mentra App's own URL scheme. */
export const MENTRA_APP_SCHEME = "com.mentra"

/** The schemes the Mentra App reads miniapp links on: its own, and the dev app's. */
const MINIAPP_LINK_SCHEMES: readonly string[] = [MENTRA_APP_SCHEME, `${MENTRA_APP_SCHEME}.dev`]

export type MiniappInstallLink = MiniappLink

/** Read what a person scanned, pasted or opened, or null when it names no miniapp. */
export function parseMiniappInstallLink(input: string): MiniappInstallLink | null {
  return parseMiniappLink(input, {schemes: MINIAPP_LINK_SCHEMES})
}

/**
 * Whether a link the system hands the app is an open link or a package link, valid or not: the app's link handling
 * reads it (`DeeplinkContext`), and says so when it names no miniapp. Takes a full URL or a path (`/open?url=…`).
 */
export function isMiniappInstallLinkPath(path: string): boolean {
  return isMiniappLink(path, {schemes: MINIAPP_LINK_SCHEMES})
}

/** The package's page on the directory website. */
export function directoryPackageLink(packageName: string): string {
  return miniappPackageLink(packageName)
}

/**
 * The URL schemes the Mentra App registers: `com.mentra`, its package name (`com.mentra.mentra` and each build
 * variant's), and the `msauth` sign-in callbacks, as `originWhitelist` patterns.
 */
export const MENTRA_APP_SCHEME_PATTERNS: readonly string[] = [
  `${MENTRA_APP_SCHEME}:*`,
  `${MENTRA_APP_SCHEME}.*`,
  "msauth*",
]

/**
 * Whether a URL opens the Mentra App itself: one of its own schemes (`com.mentra:`, its package name, and the
 * `msauth` sign-in callbacks) or any address on the hosts it claims app links on. A miniapp never opens these (`session.system.openUrl`, or a link
 * on its screen): they reach the app's own link handling, which installs miniapps, signs in and runs test commands.
 */
export function isMentraAppLink(url: string): boolean {
  if (typeof url !== "string") return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase()
  if (!scheme) return false
  if (scheme === MENTRA_APP_SCHEME || scheme.startsWith(`${MENTRA_APP_SCHEME}.`) || scheme.startsWith("msauth")) {
    return true
  }
  if (scheme !== "https" && scheme !== "http") return false
  try {
    return MENTRA_APP_LINK_HOSTS.includes(new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, ""))
  } catch {
    return false
  }
}
