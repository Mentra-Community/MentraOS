/**
 * @fileoverview Startup checks for Core's sign-in server. Core refuses to start
 * with a provider configuration that is malformed or unsafe, naming the
 * variable; with `CLOUD_CORE_OIDC_ISSUER` unset there is nothing to check.
 *
 * With the provider on, each portal whose URL is configured must have its
 * first-party client, with its callback registered exactly, so a portal never
 * starts unable to sign anyone in.
 */

import {portalClient, portalSite} from "../signin/portal-signin.service"
import {assertClientConfiguration, configuredClients} from "./clients"
import {assertOidcIssuerConfiguration, oidcIssuer} from "./config"

export function assertOidcConfiguration(): void {
  assertOidcIssuerConfiguration()
  if (!oidcIssuer()) return
  configuredClients()
  assertClientConfiguration()
  for (const portal of ["admin", "portal"] as const) {
    if (portalSite(portal)) portalClient(portal)
  }
}
