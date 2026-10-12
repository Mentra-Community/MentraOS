/**
 * @fileoverview Startup checks for Core's sign-in server. Core refuses to start
 * with a provider configuration that is malformed or unsafe, naming the
 * variable; with `CLOUD_CORE_OIDC_ISSUER` unset there is nothing to check.
 */

import {assertClientConfiguration, configuredClients} from "./clients"
import {assertOidcIssuerConfiguration, oidcIssuer} from "./config"

export function assertOidcConfiguration(): void {
  assertOidcIssuerConfiguration()
  if (!oidcIssuer()) return
  configuredClients()
  assertClientConfiguration()
}
