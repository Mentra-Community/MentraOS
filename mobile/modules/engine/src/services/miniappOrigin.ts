/**
 * Each installed miniapp's screen loads from an origin of its own (spec, "Each
 * miniapp's screen has its own origin"). The Mentra App's patched
 * react-native-webview serves it when the WebView's `miniappOrigin` prop names
 * the package and its bundle root:
 *
 * - iOS: `miniapp://<packageName>/`, through a WKURLSchemeHandler;
 * - Android: `https://<host>.miniapp.invalid/`, intercepted, where `<host>` is
 *   the package name with `_` written as `-`. `.invalid` never resolves, so a
 *   request the WebView doesn't intercept fails.
 *
 * The native side applies the same rules and serves nothing for a package
 * name that breaks them, so these return null exactly when it would.
 *
 * A development build's installed files (a development snapshot, or a
 * local-network install while its server is away) load from an origin of their
 * own, {@link developmentOriginName}, so they never share web storage with an
 * installed release of the same name.
 */

export type MiniappOriginPlatform = "ios" | "android"

export const MINIAPP_ORIGIN_SCHEME = "miniapp"
export const MINIAPP_ORIGIN_HOST_SUFFIX = ".miniapp.invalid"

const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
/**
 * Names under `invalid.` are served from `.invalid` hosts, which have no registrable domain, so no miniapp URL can
 * serve one and no URL install gets this origin.
 */
const DEVELOPMENT_ORIGIN_PREFIX = "invalid.dev."
const MAX_HOST = 253
const MAX_LABEL = 63

/** The Android host for a package, or null when its name is invalid or the host would break DNS limits. */
export function miniappOriginHost(packageName: string): string | null {
  if (!PACKAGE_NAME.test(packageName)) return null
  const host = `${packageName.replace(/_/g, "-")}${MINIAPP_ORIGIN_HOST_SUFFIX}`
  if (host.length > MAX_HOST || host.split(".").some((label) => label.length > MAX_LABEL)) return null
  return host
}

/**
 * The package's origin, as the page's `location.origin` reads it and as the
 * WebView's `originWhitelist` takes it. Null when the package can't have one.
 */
export function miniappOrigin(packageName: string, platform: MiniappOriginPlatform): string | null {
  if (platform === "android") {
    const host = miniappOriginHost(packageName)
    return host ? `https://${host}` : null
  }
  if (!PACKAGE_NAME.test(packageName) || packageName.length > MAX_HOST) return null
  return `${MINIAPP_ORIGIN_SCHEME}://${packageName}`
}

/**
 * The URL of a file in the package's bundle, from its path relative to the
 * bundle root (for example a manifest's `entry.ui`). Null when the package
 * can't have an origin or the path leaves the bundle.
 */
export function miniappOriginUrl(
  packageName: string,
  relativePath: string,
  platform: MiniappOriginPlatform,
): string | null {
  const origin = miniappOrigin(packageName, platform)
  if (!origin) return null
  const segments = relativePath
    .replace(/^\.?\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    return null
  }
  return `${origin}/${segments.map(encodeURIComponent).join("/")}`
}

/**
 * The name whose origin a development build's installed files load from: the
 * package's own name under `invalid.dev.`, so its web storage is apart from an
 * installed release's (`miniapp://invalid.dev.<packageName>/` on iOS,
 * `https://invalid.dev.<host>.miniapp.invalid/` on Android). The WebView's
 * `miniappOrigin` takes it in place of the package name.
 */
export function developmentOriginName(packageName: string): string {
  return `${DEVELOPMENT_ORIGIN_PREFIX}${packageName}`
}
