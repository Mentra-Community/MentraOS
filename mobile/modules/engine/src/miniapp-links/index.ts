/**
 * Miniapp links: the links people install and open miniapps from, read the same way wherever they arrive (a Universal
 * Link or App Link, a QR scanner, a paste box).
 *
 * - **An open link,** `https://apps.mentraglass.com/open?url=<miniapp URL>`, names a miniapp URL.
 * - **A package link,** `https://apps.mentraglass.com/package/<packageName>`, names a listed miniapp; the directory
 *   says which URL serves it. `/app/<packageName>`, the directory's older page, reads the same.
 * - **A miniapp URL** on its own, as `mentra pack` or a developer's site gives it. A pasted `.../miniapp.json` means
 *   the URL that serves it, and an address without a scheme means HTTPS.
 *
 * `apps.mentra.glass`, the directory's former name, reads the same way. So do the host app's own URL schemes, when it
 * names them (`myapp://open?url=…`).
 *
 * This entry point has no engine runtime behind it: a host app can read a link before the engine starts.
 */
import {MINIAPP_PACKAGE_NAME_PATTERN, normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"

/**
 * The hosts miniapp links live on: the directory website, and its former name. A host app claims them as Universal
 * Links and App Links (the `@mentra/engine` config plugin does), and Mentra lists the app on them.
 */
export const MINIAPP_LINK_HOSTS: readonly string[] = ["apps.mentraglass.com", "apps.mentra.glass"]

/** The directory website: where a package link opens in a browser, and the directory that resolves one. */
export const MINIAPP_DIRECTORY_URL = "https://apps.mentraglass.com"

export interface MiniappLinkOptions {
  /**
   * The host app's own URL schemes, without `://` (`myapp` for `myapp://open?url=…`). A link on one of them reads as
   * a link on the link hosts does. None by default.
   */
  schemes?: readonly string[]
}

export type MiniappLink =
  /** A miniapp URL, normalized (it ends in `/`). `local`: a local-network address. */
  | {kind: "url"; url: string; local: boolean}
  /** A package link: the directory names the URL. */
  | {kind: "package"; packageName: string}

/** The open link's and the package link's paths. */
const OPEN_PATH = /^\/open\/?$/
const PACKAGE_PATH = /^\/(?:package|app)\/([^/]+)\/?$/
/** A scheme, as opposed to a host and port (`localhost:8080`). */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i

/** How long a package link waits for the directory. */
const DIRECTORY_TIMEOUT_MS = 15_000

/** Read what a person scanned, pasted or opened, or null when it names no miniapp. */
export function parseMiniappLink(input: string, options: MiniappLinkOptions = {}): MiniappLink | null {
  if (typeof input !== "string") return null
  const text = withScheme(input.trim())
  if (!text) return null
  const link = linkPath(text, options)
  if (link) {
    if (OPEN_PATH.test(link.path)) {
      const named = link.query.get("url")
      // An open link names a miniapp URL, never another link.
      if (!named || linkPath(named.trim(), options)) return null
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
 * reads it, and says so when it names no miniapp. Takes a full URL, or a path on the link hosts (`/open?url=…`).
 */
export function isMiniappLink(link: string, options: MiniappLinkOptions = {}): boolean {
  if (typeof link !== "string") return false
  const target = linkPath(link.startsWith("/") ? `${MINIAPP_DIRECTORY_URL}${link}` : link, options)
  return target !== null && (OPEN_PATH.test(target.path) || PACKAGE_PATH.test(target.path))
}

/**
 * Whether a URL is the host app's to open once it claims the miniapp links: any address on the link hosts, or
 * anything on one of its own schemes. A host names these in `config.isHostLink`, so no miniapp can open its install
 * sheet (`session.system.openUrl`, or a link on the miniapp's screen).
 */
export function isOnMiniappLinkHost(url: string, options: MiniappLinkOptions = {}): boolean {
  if (typeof url !== "string") return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase()
  if (!scheme) return false
  if (options.schemes?.some((own) => own.toLowerCase() === scheme)) return true
  if (scheme !== "https" && scheme !== "http") return false
  try {
    return MINIAPP_LINK_HOSTS.includes(new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, ""))
  } catch {
    return false
  }
}

/** A package's page on the directory website: its package link. */
export function miniappPackageLink(packageName: string): string {
  return `${MINIAPP_DIRECTORY_URL}/package/${encodeURIComponent(packageName)}`
}

/**
 * The miniapp URL a directory lists for a package, or null when it lists none. Throws when the directory can't
 * answer. The directory is public: the request carries no account, token or cookie.
 */
export async function fetchListedMiniappUrl(directoryUrl: string, packageName: string): Promise<string | null> {
  const lookup = `${directoryUrl.replace(/\/+$/, "")}/api/directory/miniapps/${encodeURIComponent(packageName)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS)
  try {
    const response = await fetch(lookup, {credentials: "omit", signal: controller.signal})
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`The directory answered ${response.status}`)
    const listed = (await response.json()) as {packageName?: unknown; url?: unknown} | null
    if (listed?.packageName !== packageName || typeof listed.url !== "string") return null
    const target = normalizeMiniappUrl(listed.url)
    return target?.kind === "public" ? target.url : null
  } finally {
    clearTimeout(timer)
  }
}

/** The path and query of a link on a link host, or on one of the host app's own schemes; null for any other URL. */
function linkPath(text: string, options: MiniappLinkOptions): {path: string; query: URLSearchParams} | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const scheme = url.protocol.toLowerCase().replace(/:$/, "")
  if (options.schemes?.some((own) => own.toLowerCase() === scheme)) {
    // `myapp://open?url=…`: the host is the first part of the path.
    return {path: `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}`, query: url.searchParams}
  }
  if (scheme !== "https" && scheme !== "http") return null
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  return MINIAPP_LINK_HOSTS.includes(host) ? {path: url.pathname, query: url.searchParams} : null
}

/**
 * An address a person typed without a scheme (`notes.example.com`, `apps.mentraglass.com/package/…`) is HTTPS. Only
 * a scheme at the start counts: `apps.mentraglass.com/open?url=https://…` has none.
 */
function withScheme(text: string): string {
  return text && !SCHEME.test(text) ? `https://${text}` : text
}

/** A miniapp URL as a person gave it: a `.../miniapp.json` is the URL that serves it; no scheme means HTTPS. */
function miniappUrl(text: string): MiniappLink | null {
  let value = withScheme(text.trim())
  // Only the path: anything with a query or a fragment isn't a miniapp URL.
  if (!/[?#]/.test(value)) value = value.replace(/\/miniapp\.json\/?$/i, "/")
  const normalized = normalizeMiniappUrl(value)
  return normalized ? {kind: "url", url: normalized.url, local: normalized.kind === "local"} : null
}
