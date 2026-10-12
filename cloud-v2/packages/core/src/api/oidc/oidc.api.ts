/**
 * @fileoverview Core's sign-in server, on Core's HTTP server.
 *
 *   GET  /.well-known/openid-configuration   discovery
 *   *    /oidc/*                              authorization, token, revocation, end-session
 *   *    /interaction/*                       the provider's sign-in steps
 *   GET|POST /oidc/me                         userinfo, answered by Core itself
 *
 * Everything but userinfo is relayed to the provider's own listener
 * (`services/oidc/bridge.ts`). The relay builds the request for the
 * configured issuer: `Host` and `X-Forwarded-Proto` come from
 * `CLOUD_CORE_OIDC_ISSUER`, and the client's forwarding headers are dropped.
 * Responses pass through unchanged (status, `Location`, every `Set-Cookie`),
 * always `no-store`. With `CLOUD_CORE_OIDC_ISSUER` unset these routes answer
 * 404.
 *
 * On hosted Core these paths reach Core through the environment's sign-in
 * site (`account.*`), which relays them; on a Private Cloud the issuer is
 * Core's own host.
 */

import {createLogger} from "@mentra/cloud-shared"
import {Hono, type Context} from "hono"

import {BRIDGE_SECRET_HEADER, oidcBridge} from "../../services/oidc/bridge"
import {OIDC_DISCOVERY_PATH, OIDC_ROUTES} from "../../services/oidc/config"
import {verifyCoreAccessToken} from "../../services/oidc/core-access-token"
import {bearerToken} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
// The sign-in steps run inside the provider; importing them installs them.
import "./interaction.api"

const logger = createLogger("core").child({service: "oidc-relay"})

/** Request headers never passed to the provider: hop-by-hop, and anything describing the client's view of the host. */
const DROPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-mentra-public-origin",
  BRIDGE_SECRET_HEADER,
]

async function relay(c: Context<AppEnv>): Promise<Response> {
  const bridge = await oidcBridge().catch(err => {
    logger.error({errorName: (err as Error)?.name}, "sign-in server unavailable")
    return undefined
  })
  if (bridge === null) return c.json({error: "not_found"}, 404)
  if (!bridge) return unavailable(c)

  const issuer = new URL(bridge.issuer)
  const source = new URL(c.req.url)
  const headers = new Headers(c.req.raw.headers)
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)
  headers.set("host", issuer.host)
  headers.set("x-forwarded-proto", issuer.protocol.slice(0, -1))
  headers.set(BRIDGE_SECRET_HEADER, bridge.secret)
  const method = c.req.method
  let response: Response
  try {
    response = await fetch(`${bridge.origin}${source.pathname}${source.search}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer(),
      redirect: "manual",
    })
  } catch (err) {
    logger.error({errorName: (err as Error)?.name}, "sign-in server relay failed")
    return unavailable(c)
  }
  const out = new Headers(response.headers)
  for (const name of ["connection", "keep-alive", "transfer-encoding"]) out.delete(name)
  out.set("cache-control", "no-store")
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers: out})
}

function unavailable(c: Context<AppEnv>): Response {
  c.header("cache-control", "no-store")
  return c.json({error: "temporarily_unavailable", error_description: "the sign-in server is unavailable"}, 503)
}

/**
 * Userinfo for Core access tokens. The token must carry the `openid` scope;
 * `email` adds `email` and `email_verified`, `profile` adds `name`.
 */
async function userinfo(c: Context<AppEnv>): Promise<Response> {
  c.header("cache-control", "no-store")
  let token = bearerToken(c.req.header("authorization"))
  if (!token && c.req.method === "POST" && (c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody()
    token = typeof form.access_token === "string" ? form.access_token : null
  }
  const identity = token ? await verifyCoreAccessToken(token) : null
  if (!identity || !identity.scopes.has("openid")) {
    c.header("www-authenticate", 'Bearer error="invalid_token"')
    return c.json({error: "invalid_token"}, 401)
  }
  return c.json({
    sub: identity.mentraUserId,
    ...(identity.scopes.has("email") && identity.email ? {email: identity.email, email_verified: identity.emailVerified} : {}),
    ...(identity.scopes.has("profile") && identity.name ? {name: identity.name} : {}),
  })
}

export function createOidcApi(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.on(["GET", "POST"], OIDC_ROUTES.userinfo, userinfo)
  app.get(OIDC_DISCOVERY_PATH, relay)
  app.all("/oidc/*", relay)
  app.all("/interaction/*", relay)
  return app
}
