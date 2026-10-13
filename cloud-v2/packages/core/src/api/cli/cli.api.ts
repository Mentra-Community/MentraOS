/**
 * @fileoverview What the `mentra` CLI needs to sign in to this Core
 * (`/api/cli/*`), unauthenticated.
 *
 *   GET /api/cli/config   {issuer, clientId}
 *
 * The issuer is Core's sign-in server (`CLOUD_CORE_OIDC_ISSUER`) and the
 * client ID is its registered `cli` client's. The CLI reads this on a Core
 * without a Mentra Miniapp Store (a Private Cloud); against a Store it reads
 * the Store's own `/api/console/auth/cli-config`, which answers the same for
 * the Core it serves. Both values are public. With the sign-in server off, or
 * no `cli` client registered, the answer is 404 `not_configured`.
 */

import {Hono} from "hono"

import {clientOfKind} from "../../services/oidc/clients"
import {oidcIssuer} from "../../services/oidc/config"
import type {AppEnv} from "../../types/hono.types"

/** What `GET /api/cli/config` answers. */
export interface CliConfigResponse {
  issuer: string
  clientId: string
}

const app = new Hono<AppEnv>()

app.get("/config", c => {
  c.header("cache-control", "no-store")
  const issuer = oidcIssuer()
  const cli = issuer ? clientOfKind("cli") : null
  if (!issuer || !cli) {
    return c.json({error: "not_configured", error_description: "This Core does not offer CLI sign-in"}, 404)
  }
  const body: CliConfigResponse = {issuer, clientId: cli.clientId}
  return c.json(body)
})

export default app
