/**
 * @fileoverview Configuration of Core's sign-in server, its OpenID Connect
 * provider.
 *
 * - `CLOUD_CORE_OIDC_ISSUER`: the issuer, which is the environment's sign-in
 *   site (`https://account.mentraglass.com` for hosted prod; Core's own host on
 *   a Private Cloud). Unset, the provider is off and its routes answer 404.
 * - `CLOUD_CORE_OIDC_COOKIE_KEYS`: comma-separated secrets that sign the
 *   provider's cookies. The first signs; every key verifies, so a new key is
 *   added in front and an old one removed later.
 * - `CLOUD_CORE_OIDC_CLIENTS`: the registered clients (`clients.ts`).
 *
 * Everything is read from the environment at use time. The provider's routes
 * are fixed paths under the issuer; nothing is built from `Host` or forwarding
 * headers.
 */

import {ConfigurationError, isDeployedEnvironment} from "../signin/config"

/** The provider's routes, relative to the issuer. */
export const OIDC_ROUTES = {
  authorization: "/oidc/auth",
  token: "/oidc/token",
  userinfo: "/oidc/me",
  revocation: "/oidc/token/revocation",
  end_session: "/oidc/session/end",
  /** Core's own key set, which the provider's discovery names as `jwks_uri`. */
  jwks: "/.well-known/jwks.json",
} as const

export const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration"

/** The audience of the access tokens Core's provider issues: Core's API. */
export const CORE_API_RESOURCE = "urn:mentra:core"

/** The scopes Core's provider knows. `offline_access` is accepted and has no effect: refresh tokens follow the client. */
export const OIDC_SCOPES = ["openid", "email", "profile", "offline_access"] as const

const MIN_COOKIE_KEY_LENGTH = 32

function clean(value: string | undefined): string {
  return (value ?? "").trim()
}

/** The provider's issuer, or null when Core's sign-in server is off. */
export function oidcIssuer(): string | null {
  const issuer = clean(process.env.CLOUD_CORE_OIDC_ISSUER)
  return issuer ? issuer.replace(/\/+$/, "") : null
}

/** The cookie signing keys, first one signing. */
export function oidcCookieKeys(): string[] {
  return clean(process.env.CLOUD_CORE_OIDC_COOKIE_KEYS)
    .split(",")
    .map(key => key.trim())
    .filter(Boolean)
}

/** The provider's end-session endpoint (the sign-in site's sign-out), or null when the provider is off. */
export function endSessionUrl(issuer: string | null = oidcIssuer()): string | null {
  return issuer ? `${issuer}${OIDC_ROUTES.end_session}` : null
}

/** Whether `issuer` may be plain HTTP: only a loopback issuer on an undeployed Core (local runs and tests). */
export function allowsInsecureIssuer(issuer: string): boolean {
  if (isDeployedEnvironment()) return false
  const url = new URL(issuer)
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
}

/**
 * Refuse a provider configuration that is malformed or unsafe, naming the
 * variable. With `CLOUD_CORE_OIDC_ISSUER` unset there is nothing to check.
 */
export function assertOidcIssuerConfiguration(): void {
  const issuer = oidcIssuer()
  if (!issuer) return
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new ConfigurationError("CLOUD_CORE_OIDC_ISSUER must be a URL")
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ConfigurationError("CLOUD_CORE_OIDC_ISSUER must be an origin, with no path, query or fragment")
  }
  if (url.protocol !== "https:" && !allowsInsecureIssuer(issuer)) {
    throw new ConfigurationError("CLOUD_CORE_OIDC_ISSUER must be an HTTPS URL")
  }
  // The phone's access tokens carry CLOUD_CORE_ISSUER; the two kinds must never share an issuer.
  if (clean(process.env.CLOUD_CORE_ISSUER).replace(/\/+$/, "") === issuer) {
    throw new ConfigurationError("CLOUD_CORE_OIDC_ISSUER must differ from CLOUD_CORE_ISSUER")
  }
  const keys = oidcCookieKeys()
  if (keys.length === 0) throw new ConfigurationError("CLOUD_CORE_OIDC_COOKIE_KEYS must be set when CLOUD_CORE_OIDC_ISSUER is set")
  if (keys.some(key => key.length < MIN_COOKIE_KEY_LENGTH)) {
    throw new ConfigurationError(`CLOUD_CORE_OIDC_COOKIE_KEYS entries must be at least ${MIN_COOKIE_KEY_LENGTH} characters`)
  }
  if (!clean(process.env.MENTRA_JWT_PRIVATE_KEY) || !clean(process.env.MENTRA_JWT_PUBLIC_KEY)) {
    throw new ConfigurationError("CLOUD_CORE_OIDC_ISSUER needs Core's signing key (MENTRA_JWT_PRIVATE_KEY and MENTRA_JWT_PUBLIC_KEY)")
  }
}
