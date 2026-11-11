/**
 * @fileoverview Connected apps: the miniapp websites a person has allowed to sign them in with Mentra, for
 * the sign-in site's `/connections` page. These run inside the provider, on the issuer's origin, and know
 * the person by the provider's own session cookie: no token is involved.
 *
 *   GET  /oidc/connections
 *        `{connections: [{clientId, name, scopes, grantedAt}]}`, one per website, oldest grant first; 401
 *        `{error: "sign_in_required"}` without a session Core still accepts. First-party clients are not
 *        listed: the person never granted them anything.
 *   POST /oidc/connections/revoke   `{clientId}`
 *        Ends every grant the person gave that website, with its codes and refresh tokens: the site's next
 *        refresh fails, and its next sign-in asks for consent again. `{revoked: true}` whether or not there
 *        was a grant, so the answer says nothing about which websites exist.
 *   GET  /oidc/connections/sign-in
 *        Sends a browser without a session through sign-in and back to `/connections`, as the sign-in
 *        site's own client. The page drops the code it comes back with; nothing ever redeems it.
 *
 * Every response is `no-store`. The POST is same-origin only and rate-limited per IP.
 */

import {randomBytes} from "node:crypto"

import {createLogger} from "@mentra/cloud-shared"
import type Provider from "oidc-provider"

import {loadAccount} from "../../services/oidc/account"
import {extendProvider} from "../../services/oidc/bridge"
import {ACCOUNT_CLIENT_ID, CONNECTIONS_PATH} from "../../services/oidc/clients"
import {OIDC_ROUTES, oidcIssuer} from "../../services/oidc/config"
import {listGrants, revokeGrantsOfClient} from "../../services/oidc/mongo-adapter"
import {isWebsiteClientId, websiteClientNames} from "../../services/oidc/website-clients.service"
import {s256} from "../../services/signin/random"
import {clientIp, isSameOrigin, json, readJsonBody, redirect, withinLimit, type KoaContext} from "./provider-http"

const logger = createLogger("core").child({service: "oidc-connections"})

const BASE = "/oidc/connections"
const REVOKE_LIMIT_PER_MINUTE = 30
const SIGN_IN_LIMIT_PER_MINUTE = 20

export interface Connection {
  clientId: string
  name: string
  scopes: string[]
  /** When the person first allowed the website, among the grants still alive. */
  grantedAt: string | null
}

/** The person this browser is signed in as at the sign-in server, or null when Core no longer accepts them. */
async function signedInPerson(provider: Provider, ctx: KoaContext): Promise<string | null> {
  const session = await provider.Session.get(ctx as Parameters<typeof provider.Session.get>[0])
  const accountId = session.accountId
  if (!accountId) return null
  return (await loadAccount(accountId, session.loginTs)) ? accountId : null
}

/** The websites a person has allowed, one entry each, however many times they signed in. */
export async function connectionsOf(mentraUserId: string): Promise<Connection[]> {
  const grants = (await listGrants(mentraUserId)).filter(grant => isWebsiteClientId(grant.clientId))
  const names = await websiteClientNames([...new Set(grants.map(grant => grant.clientId))])
  const byClient = new Map<string, Connection>()
  for (const grant of grants) {
    // A website that was removed has no name to show and no tokens to end.
    const name = names.get(grant.clientId)
    if (name === undefined) continue
    const existing = byClient.get(grant.clientId)
    if (existing) existing.scopes = [...new Set([...existing.scopes, ...grant.scopes])]
    else byClient.set(grant.clientId, {clientId: grant.clientId, name, scopes: grant.scopes, grantedAt: grant.grantedAt?.toISOString() ?? null})
  }
  return [...byClient.values()]
}

async function list(provider: Provider, ctx: KoaContext): Promise<void> {
  const mentraUserId = await signedInPerson(provider, ctx)
  if (!mentraUserId) return json(ctx, 401, {error: "sign_in_required"})
  return json(ctx, 200, {connections: await connectionsOf(mentraUserId)})
}

async function revoke(provider: Provider, ctx: KoaContext, issuer: string): Promise<void> {
  // The body is read in full before anything else, so every answer leaves the connection clean.
  const body = await readJsonBody(ctx.req)
  if (!isSameOrigin(ctx, issuer)) return json(ctx, 403, {error: "forbidden"})
  if (!(await withinLimit(`oidc-connections-revoke:ip:${clientIp(ctx)}`, REVOKE_LIMIT_PER_MINUTE))) return json(ctx, 429, {error: "too_many_requests"})
  const mentraUserId = await signedInPerson(provider, ctx)
  if (!mentraUserId) return json(ctx, 401, {error: "sign_in_required"})
  const clientId = typeof body?.clientId === "string" ? body.clientId : ""
  if (!isWebsiteClientId(clientId) || clientId.length > 64) return json(ctx, 400, {error: "invalid_request"})
  const ended = await revokeGrantsOfClient(mentraUserId, clientId)
  if (ended > 0) logger.info({mentraUserId, clientId, grants: ended}, "a person revoked a website")
  return json(ctx, 200, {revoked: true})
}

async function signIn(ctx: KoaContext, issuer: string): Promise<void> {
  if (!(await withinLimit(`oidc-connections-sign-in:ip:${clientIp(ctx)}`, SIGN_IN_LIMIT_PER_MINUTE))) return json(ctx, 429, {error: "too_many_requests"})
  const url = new URL(`${issuer}${OIDC_ROUTES.authorization}`)
  url.search = new URLSearchParams({
    client_id: ACCOUNT_CLIENT_ID,
    response_type: "code",
    scope: "openid",
    redirect_uri: `${issuer}${CONNECTIONS_PATH}`,
    // The verifier is thrown away here: the code this request ends in can never be redeemed.
    code_challenge: s256(randomBytes(32).toString("base64url")),
    code_challenge_method: "S256",
    state: randomBytes(16).toString("base64url"),
  }).toString()
  return redirect(ctx, url.href)
}

/** Mount Connected apps on a provider. */
export function installConnectionRoutes(provider: Provider): void {
  provider.use(async (ctx, next) => {
    if (ctx.path !== BASE && !ctx.path.startsWith(`${BASE}/`)) return next()
    const issuer = oidcIssuer()
    if (!issuer) return json(ctx, 404, {error: "not_found"})
    try {
      if (ctx.path === BASE && ctx.method === "GET") return await list(provider, ctx)
      if (ctx.path === `${BASE}/revoke` && ctx.method === "POST") return await revoke(provider, ctx, issuer)
      if (ctx.path === `${BASE}/sign-in` && ctx.method === "GET") return await signIn(ctx, issuer)
      return json(ctx, 404, {error: "not_found"})
    } catch (err) {
      logger.error({errorName: (err as Error)?.name}, "connected apps request failed")
      return json(ctx, 503, {error: "temporarily_unavailable"})
    }
  })
}

extendProvider(installConnectionRoutes)
