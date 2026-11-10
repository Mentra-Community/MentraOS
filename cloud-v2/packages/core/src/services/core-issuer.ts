/**
 * @fileoverview Startup check for Core's issuer, `CLOUD_CORE_ISSUER`: the name
 * Core puts in the `iss` of every token it signs, miniapp tokens included. It
 * is `cloud-core` by default, or this Core's public origin, such as
 * `https://core.mentraglass.com`. A miniapp backend bound to this Core
 * (`MENTRA_CORE_URL` in `@mentra/auth`) accepts either, and only from this
 * Core's key set. See `packages/auth/CORE-BINDING.md`.
 */

import {allowsInsecureIssuer} from "./oidc/config"
import {ConfigurationError} from "./signin/config"

const LEGACY_ISSUER = "cloud-core"

/**
 * Refuse a `CLOUD_CORE_ISSUER` that is neither `cloud-core` nor an origin
 * written exactly as a backend derives it from its Core URL (lowercase, no
 * path or trailing slash): Core puts the value in every token as it is, so
 * anything else would fail every miniapp token at a bound backend. HTTPS,
 * except a loopback origin on an undeployed Core (local runs and tests).
 */
export function assertCoreIssuerConfiguration(): void {
  const value = process.env.CLOUD_CORE_ISSUER
  if (value === undefined || value === LEGACY_ISSUER) return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigurationError(`CLOUD_CORE_ISSUER must be ${LEGACY_ISSUER} or this Core's origin`)
  }
  if (url.origin !== value) {
    throw new ConfigurationError(
      `CLOUD_CORE_ISSUER must be ${LEGACY_ISSUER} or an origin written exactly, such as https://core.example.com (no path or trailing slash)`,
    )
  }
  if (url.protocol !== "https:" && !allowsInsecureIssuer(value)) {
    throw new ConfigurationError("CLOUD_CORE_ISSUER must be an HTTPS origin")
  }
}
