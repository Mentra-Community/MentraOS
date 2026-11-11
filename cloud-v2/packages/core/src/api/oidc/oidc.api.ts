/**
 * @fileoverview Core's sign-in server, on Core's HTTP server.
 *
 *   GET  /.well-known/openid-configuration   discovery
 *   *    /oidc/*                              authorization, token, revocation, end-session
 *   *    /interaction/*                       the provider's sign-in steps
 *   *    /oidc/connections*                   Connected apps (`connections.api.ts`)
 *   GET|POST /oidc/me                         userinfo, answered by Core itself
 *
 * The token and revocation endpoints are rate-limited per client and IP
 * (120 a minute). For a registered miniapp website the relay also does two
 * things the provider can't (`withHashedWebsiteSecret`, `websiteTokenAnswer`):
 * it hashes the secret the site presents, since only the hash is stored; and it
 * replaces the access token in the token endpoint's answer with the person's
 * miniapp token for the site's package, so a website never holds a token for
 * Core's API.
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
import {undoTokenExchange, type SpentCredential} from "../../services/oidc/mongo-adapter"
import {verifyCoreAccessToken} from "../../services/oidc/core-access-token"
import {hashWebsiteClientSecret, isWebsiteClientId} from "../../services/oidc/website-clients.service"
import {websiteTokenResponse} from "../../services/oidc/website-tokens"
import {bearerToken} from "../../services/signin/principal.service"
import {consumeRateLimit} from "../../services/signin/rate-limit.service"
import type {AppEnv} from "../../types/hono.types"
// The sign-in steps and Connected apps run inside the provider; importing them installs them.
import "./connections.api"
import "./interaction.api"

const logger = createLogger("core").child({service: "oidc-relay"})

const TOKEN_LIMIT_PER_MINUTE = 120
const RATE_LIMITED_PATHS: ReadonlySet<string> = new Set([OIDC_ROUTES.token, OIDC_ROUTES.revocation])

/** The client a token or revocation request names: `client_id` in the form, or the Basic credential's user. */
function requestClientId(body: ArrayBuffer, authorization: string | undefined): string {
  const fromForm = new URLSearchParams(new TextDecoder().decode(body)).get("client_id")
  if (fromForm) return fromForm.slice(0, 64)
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6))
      return decodeURIComponent(decoded.slice(0, decoded.indexOf(":"))).slice(0, 64)
    } catch {
      return "invalid"
    }
  }
  return "none"
}

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

const FORM = "application/x-www-form-urlencoded"

/**
 * A miniapp website's token or revocation request, as the provider must see it. Only the hash of a server
 * client's secret is stored, so the presented secret is hashed here and the provider compares hash with
 * hash. A stolen hash is useless: it would be hashed again.
 */
function withHashedWebsiteSecret(contentType: string | undefined, path: string, body: ArrayBuffer | undefined): ArrayBuffer | undefined {
  if (!body || (path !== OIDC_ROUTES.token && path !== OIDC_ROUTES.revocation)) return body
  if (!(contentType ?? "").toLowerCase().startsWith(FORM)) return body
  const form = new URLSearchParams(new TextDecoder().decode(body))
  const secret = form.get("client_secret")
  if (!isWebsiteClientId(form.get("client_id") ?? "") || secret === null) return body
  form.set("client_secret", hashWebsiteClientSecret(secret))
  return new TextEncoder().encode(form.toString()).buffer as ArrayBuffer
}

/** The client an access token was issued to, read from its claims without verifying it: enough to route on. */
function issuedTo(accessToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {client_id?: unknown}
    return typeof payload.client_id === "string" ? payload.client_id : ""
  } catch {
    return ""
  }
}

/**
 * The website a token answer belongs to, or "" when it is no website's. Either sign is enough: the client
 * the provider issued the access token to, or the client the request named. So a website's answer is always
 * handled as one, and an answer whose token does not say whose it is, to a request that named a website, is
 * refused downstream rather than passed through.
 */
export function websiteOfTokenAnswer(issuedTo: string, namedClient: string): string {
  if (isWebsiteClientId(issuedTo)) return issuedTo
  return isWebsiteClientId(namedClient) ? namedClient : ""
}

/** What a token request spent at the provider: its authorization code or its refresh token. */
function spentCredential(body: ArrayBuffer | undefined): SpentCredential | null {
  if (!body) return null
  const form = new URLSearchParams(new TextDecoder().decode(body))
  const grant = form.get("grant_type")
  if (grant === "authorization_code" && form.get("code")) return {model: "AuthorizationCode", value: form.get("code")!}
  if (grant === "refresh_token" && form.get("refresh_token")) return {model: "RefreshToken", value: form.get("refresh_token")!}
  return null
}

/**
 * The token endpoint's answer for a miniapp website: the provider's own, with its access token replaced by the
 * person's miniapp token for the website's package. Null for an answer that carries no tokens (an error) and
 * for any other client's, which pass through unchanged. A website's answer is rewritten or refused, never
 * passed through: the provider's own access token is for Core's API and must not leave Core.
 *
 * By the time Core mints, the provider has spent the site's code or refresh token and issued the next
 * refresh token. If the miniapp token then can't be minted for a passing reason, that exchange is undone
 * before the 503 goes out, so the site's retry with what it still holds works: otherwise it would hold only a
 * spent token, and its retry would look like a replay and end the person's sign-in.
 */
async function websiteTokenAnswer(
  response: Response,
  namedClient: string,
  spent: SpentCredential | null,
): Promise<{status: 200 | 400 | 503; body: Record<string, unknown>} | null> {
  if (response.status !== 200) return null
  const provided = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null
  const clientId = websiteOfTokenAnswer(typeof provided?.access_token === "string" ? issuedTo(provided.access_token) : "", namedClient)
  if (!clientId) return null
  const answer = provided ? await websiteTokenResponse(clientId, provided) : ({ok: false, error: "invalid_grant"} as const)
  if (answer.ok) return {status: 200, body: answer.body}
  logger.warn({clientId, reason: answer.error}, "miniapp website token refused")
  if (answer.error === "temporarily_unavailable") {
    if (spent) await undoTokenExchange(spent, typeof provided?.refresh_token === "string" ? provided.refresh_token : null)
    return {status: 503, body: {error: "temporarily_unavailable"}}
  }
  if (answer.error === "access_denied") {
    return {status: 400, body: {error: "access_denied", error_description: "this account may not use this website"}}
  }
  return {status: 400, body: {error: answer.error}}
}

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
  let body = method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer()
  // Read before the secret is hashed: the rate limit and the answer are for the client the request names.
  const namedClient = body ? requestClientId(body, c.req.header("authorization")) : ""
  const spent = source.pathname === OIDC_ROUTES.token ? spentCredential(body) : null
  const prepared = withHashedWebsiteSecret(c.req.header("content-type"), source.pathname, body)
  if (prepared !== body) {
    body = prepared
    headers.delete("content-length")
  }
  if (body && RATE_LIMITED_PATHS.has(source.pathname)) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
    const key = `oidc-token:${namedClient}:ip:${ip}`
    try {
      if (!(await consumeRateLimit(key, TOKEN_LIMIT_PER_MINUTE, 60))) {
        c.header("cache-control", "no-store")
        return c.json({error: "too_many_requests", error_description: "too many requests"}, 429)
      }
    } catch (err) {
      logger.error({errorName: (err as Error)?.name}, "sign-in server rate limit unavailable")
      return unavailable(c)
    }
  }
  let response: Response
  try {
    response = await fetch(`${bridge.origin}${source.pathname}${source.search}`, {method, headers, body, redirect: "manual"})
  } catch (err) {
    logger.error({errorName: (err as Error)?.name}, "sign-in server relay failed")
    return unavailable(c)
  }
  const out = new Headers(response.headers)
  for (const name of ["connection", "keep-alive", "transfer-encoding"]) out.delete(name)
  out.set("cache-control", "no-store")
  if (source.pathname === OIDC_ROUTES.token) {
    const rewritten = await websiteTokenAnswer(response, namedClient, spent)
    if (rewritten) {
      // The provider's other headers stay: above all its CORS headers, without which a browser-type site
      // could not read its own token answer.
      for (const name of ["content-length", "content-encoding", "etag"]) out.delete(name)
      out.set("content-type", "application/json; charset=utf-8")
      out.set("pragma", "no-cache")
      return new Response(JSON.stringify(rewritten.body), {status: rewritten.status, headers: out})
    }
  }
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
