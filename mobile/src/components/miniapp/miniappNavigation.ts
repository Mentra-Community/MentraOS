/**
 * What a miniapp's WebView may load, in which frame.
 *
 * The miniapp's own document always comes from its page's origin (the
 * package's own origin, or a development build's server), so the host's bridge
 * only ever talks to that page. Frames inside it may show ordinary web content
 * (a stream player, a `srcdoc` map). A top-level navigation anywhere else opens
 * in the system browser instead, as a link does.
 *
 * react-native-webview checks `originWhitelist` for every frame and hands any
 * URL outside it to the system (`Linking.openURL`), so the whitelist names the
 * page's origin plus the schemes a frame may use, and
 * {@link decideMiniappNavigation} (the WebView's `onShouldStartLoadWithRequest`)
 * makes the per-frame decision. File URLs are refused natively before either
 * runs.
 *
 * A miniapp never opens the Mentra App's own links (`isMentraAppLink`): they
 * reach the app's link handling, which installs miniapps, signs in and runs
 * test commands. The app's own schemes are in the whitelist only so they reach
 * {@link decideMiniappNavigation}, which refuses them; outside it, the library
 * would hand them to the system, which opens the Mentra App.
 */

import {isMentraAppLink, MENTRA_APP_SCHEME_PATTERNS} from "@/services/miniapps/miniappInstallLinks"

export type MiniappNavigationDecision = "load" | "open_externally" | "refuse"

/** Schemes a frame inside the miniapp's page may load. */
const FRAME_SCHEMES = ["https://*", "http://*", "about:*", "blob:*", "data:*"]
/**
 * Android intent URIs, which can name any app's activity, the Mentra App's included. Listed only so they reach
 * {@link decideMiniappNavigation}, which refuses them, rather than the library's hand-off to the system.
 */
const INTENT_SCHEMES = ["intent:*"]
/** Schemes a top-level link may hand to the system. */
const EXTERNAL_SCHEMES = ["mailto:*", "tel:*"]

/** The WebView's `originWhitelist` for a page at `pageOrigin`. */
export function miniappOriginWhitelist(pageOrigin: string): string[] {
  return [pageOrigin, ...FRAME_SCHEMES, ...EXTERNAL_SCHEMES, ...MENTRA_APP_SCHEME_PATTERNS, ...INTENT_SCHEMES]
}

/** A URL on another package's Android origin; it is never a website. */
function isMiniappOriginHost(url: string): boolean {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url)
  return !!match && match[1].toLowerCase().endsWith(".miniapp.invalid")
}

function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  return match ? match[1].toLowerCase() : ""
}

/**
 * True for a URL on `origin` itself (`scheme://host[:port]`). http(s) hosts are
 * case-insensitive; a `miniapp:` host keeps its case (the WebView serves only
 * the exact package name), so it must match exactly.
 */
function isOnOrigin(url: string, origin: string): boolean {
  const prefix = url.slice(0, origin.length)
  const same = schemeOf(origin) === "miniapp" ? prefix === origin : prefix.toLowerCase() === origin.toLowerCase()
  if (!same) return false
  const next = url.charAt(origin.length)
  return next === "" || next === "/" || next === "?" || next === "#"
}

/**
 * Whether the WebView loads `request`, hands it to the system, or refuses it.
 * Both platforms report the frame (`isTopFrame`; Android through the patched
 * WebView's request callback). A navigation that doesn't say is treated as
 * the top frame.
 */
export function decideMiniappNavigation(
  request: {url: string; isTopFrame?: boolean},
  pageOrigin: string,
): MiniappNavigationDecision {
  const {url} = request
  const origin = pageOrigin
  const scheme = schemeOf(url)
  if (scheme === "file" || scheme === "content") return "refuse"
  if (isOnOrigin(url, origin)) return "load"
  if (isMiniappOriginHost(url)) return "refuse"

  if (request.isTopFrame === false) {
    const frameScheme = scheme === "https" || scheme === "http" || scheme === "about"
    return frameScheme || scheme === "blob" || scheme === "data" ? "load" : "refuse"
  }

  if (url === "about:blank") return "load"
  // The Mentra App's install links, sign-in callbacks and test commands are never a miniapp's to open.
  if (isMentraAppLink(url)) return "refuse"
  // Blob URLs name their creator's origin: the top frame may show the page's own.
  if (scheme === "blob" && isOnOrigin(url.slice("blob:".length), origin)) return "load"
  if (scheme === "https" || scheme === "http" || scheme === "mailto" || scheme === "tel") return "open_externally"
  return "refuse"
}
