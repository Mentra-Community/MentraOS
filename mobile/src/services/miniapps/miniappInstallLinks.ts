/**
 * The links people install miniapps from (spec, "Installing"), read the same way wherever they arrive: a Universal
 * Link or App Link, the QR scanner, or the paste box.
 *
 * - **An open link,** `https://apps.mentraglass.com/open?url=<miniapp URL>`, names a miniapp URL.
 * - **A package link,** `https://apps.mentraglass.com/package/<packageName>`, names a listed miniapp; the directory
 *   says which URL serves it. `/app/<packageName>`, the directory's older page, reads the same.
 * - **A miniapp URL** on its own, as `mentra pack` or a developer's site gives it. A pasted `.../miniapp.json` means
 *   the URL that serves it, and an address without a scheme means HTTPS.
 *
 * `apps.mentra.glass` and the Mentra App's own scheme (`com.mentra://open?url=…`) are read the same way.
 */
import {MINIAPP_PACKAGE_NAME_PATTERN, normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"

/** The hosts the Mentra App claims app links on: the directory website, and its former name. */
export const MENTRA_APP_LINK_HOSTS: readonly string[] = ["apps.mentraglass.com", "apps.mentra.glass"]

/** The Mentra App's own URL scheme. */
export const MENTRA_APP_SCHEME = "com.mentra"

/** Where a package link opens without a directory to look it up in. */
const DIRECTORY_WEBSITE = "https://apps.mentraglass.com"

export type MiniappInstallLink =
  /** A miniapp URL, normalized (it ends in `/`). `local`: a local-network address. */
  | {kind: "url"; url: string; local: boolean}
  /** A package link: the directory names the URL. */
  | {kind: "package"; packageName: string}

/** The open link's and the package link's paths. */
const OPEN_PATH = /^\/open\/?$/
const PACKAGE_PATH = /^\/(?:package|app)\/([^/]+)\/?$/
/** A scheme, as opposed to a host and port (`localhost:8080`). */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i

/** Read what a person scanned, pasted or opened, or null when it names no miniapp. */
export function parseMiniappInstallLink(input: string): MiniappInstallLink | null {
  if (typeof input !== "string") return null
  const text = withScheme(input.trim())
  if (!text) return null
  const link = appLinkPath(text)
  if (link) {
    if (OPEN_PATH.test(link.path)) {
      const named = link.query.get("url")
      // An open link names a miniapp URL, never another link.
      if (!named || appLinkPath(named.trim())) return null
      return miniappUrl(named)
    }
    const pkg = PACKAGE_PATH.exec(link.path)?.[1]
    if (pkg && MINIAPP_PACKAGE_NAME_PATTERN.test(pkg)) return {kind: "package", packageName: pkg}
    return null
  }
  return miniappUrl(text)
}

/**
 * Whether a link the system hands the app is an open link or a package link, valid or not: the app's link handling
 * reads it (`DeeplinkContext`), and says so when it names no miniapp. Takes a full URL or a path (`/open?url=…`).
 */
export function isMiniappInstallLinkPath(path: string): boolean {
  if (typeof path !== "string") return false
  const link = appLinkPath(path.startsWith("/") ? `${DIRECTORY_WEBSITE}${path}` : path)
  return link !== null && (OPEN_PATH.test(link.path) || PACKAGE_PATH.test(link.path))
}

/** The package's page on the directory website. */
export function directoryPackageLink(packageName: string): string {
  return `${DIRECTORY_WEBSITE}/package/${encodeURIComponent(packageName)}`
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

/** The path and query of an app link (an app-link host, or the app's own scheme), or null for any other URL. */
function appLinkPath(text: string): {path: string; query: URLSearchParams} | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol === `${MENTRA_APP_SCHEME}:`) {
    // `com.mentra://open?url=…`: the host is the first part of the path.
    return {path: `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}`, query: url.searchParams}
  }
  if (protocol !== "https:" && protocol !== "http:") return null
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  return MENTRA_APP_LINK_HOSTS.includes(host) ? {path: url.pathname, query: url.searchParams} : null
}

/** An address a person typed without a scheme (`notes.example.com`, `apps.mentraglass.com/package/…`) is HTTPS. */
function withScheme(text: string): string {
  return text && !text.includes("://") && !SCHEME.test(text) ? `https://${text}` : text
}

/** A miniapp URL as a person gave it: a `.../miniapp.json` is the URL that serves it; no scheme means HTTPS. */
function miniappUrl(text: string): MiniappInstallLink | null {
  let value = withScheme(text.trim())
  // Only the path: anything with a query or a fragment isn't a miniapp URL.
  if (!/[?#]/.test(value)) value = value.replace(/\/miniapp\.json\/?$/i, "/")
  const normalized = normalizeMiniappUrl(value)
  return normalized ? {kind: "url", url: normalized.url, local: normalized.kind === "local"} : null
}
