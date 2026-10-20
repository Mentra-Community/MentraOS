/**
 * @fileoverview Where Core forwards to, which paths it is willing to send there, and how much it takes back.
 *
 * Core forwards to services it does not own (Fleet, the portal modules). These things about the address are
 * the same for all of them, and are decided here, once:
 *
 *  - which URLs may be configured as a service's base (`parseUpstreamUrl`): `https` anywhere, plain `http`
 *    on a local or test Core for any host and on a deployed Core only for `localhost` and `127.0.0.1`, and
 *    never credentials, a query or a fragment;
 *  - how that base and a path are joined into the one URL that is signed and sent (`joinUpstreamUrl`): the
 *    base's path prefix is kept and its trailing slashes are dropped;
 *  - which paths are safe to append to it (`isSafeSuffix`, with `rawPathAndQuery` for reading a request's
 *    path as it arrived): no segment may be a dot segment or hold a separator, a control character or a bad
 *    escape, once decoded, however it is spelled. A segment that is still an escaped dot or separator after
 *    one decoding (a double encoding) is refused as well, so a service that decodes a second time cannot be
 *    handed a dot segment or a separator;
 *  - the default byte and time limits on the seam (`DEFAULT_FORWARDING_LIMITS`). Fleet reads its own from the
 *    environment; a portal module uses the defaults.
 */

/** The byte and time limits on Core's side of one forwarding seam. */
export interface ForwardingLimits {
  /** The largest request body Core reads. */
  maxBodyBytes: number
  /** The largest upstream response body Core buffers on a JSON route. */
  maxResponseBytes: number
  /** How long an upstream answer may take, headers and body both. */
  timeoutMs: number
  /** The largest UI asset Core relays. */
  maxAssetBytes: number
}

export const DEFAULT_FORWARDING_LIMITS: ForwardingLimits = {
  maxBodyBytes: 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  timeoutMs: 10_000,
  maxAssetBytes: 25 * 1024 * 1024,
}

/** The only hosts a deployed Core may reach over plain `http`. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"])

/**
 * `raw` as a service's base URL, or null when it may not be one. `deployed` is whether this Core is a
 * deployed one (`isDeployedEnvironment()`), which accepts plain `http` only for a local host.
 */
export function parseUpstreamUrl(raw: string, deployed: boolean): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null
  if (deployed && url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) return null
  return url
}

/**
 * The URL a request is sent to: the base URL (its path prefix, if any, kept), then `path` and `query` as
 * given. The base's trailing slashes are dropped, so `https://mfm.example` and `https://mfm.example/fleet/`
 * join the same way as `https://mfm.example/fleet`.
 */
export function joinUpstreamUrl(baseUrl: URL, path: string, query: string): URL {
  const prefix = baseUrl.pathname.replace(/\/+$/, "")
  return new URL(`${baseUrl.origin}${prefix}${path}${query}`)
}

/** The part of a request URL after the host, as sent: `new URL` would collapse `..` segments. */
export function rawPathAndQuery(url: string): {path: string; query: string} {
  const afterOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
  const withoutFragment = afterOrigin.split("#", 1)[0]
  const queryStart = withoutFragment.indexOf("?")
  if (queryStart === -1) return {path: withoutFragment || "/", query: ""}
  // A lone "?" is no query: the URL parser drops it from `search`, so it would be sent but not signed.
  const query = withoutFragment.slice(queryStart)
  return {path: withoutFragment.slice(0, queryStart) || "/", query: query === "?" ? "" : query}
}

/** What a once-decoded segment must not still hold: an escaped dot or separator a second decoding would expose. */
const STILL_ESCAPED = /%(?:2e|2f|5c)/i

/**
 * Whether a path is safe to append to a service's URL: no segment may be a dot segment or hold a
 * separator, a control character or a bad escape once decoded, however it is spelled. A segment that
 * is still an escaped dot or separator after one decoding is refused as well (double encoding), so
 * the check does not depend on the service decoding only once.
 */
export function isSafeSuffix(suffix: string): boolean {
  for (const segment of suffix.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false
    if (STILL_ESCAPED.test(decoded)) return false
    for (const char of decoded) {
      const code = char.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) return false
    }
  }
  return true
}
