/**
 * @fileoverview The sign-in steps of Core's sign-in server (provider
 * interactions), on the issuer's origin. They run inside the provider's own
 * application (`provider.use`), because finishing an interaction needs the
 * provider's interaction cookie and Node's request and response.
 *
 *   GET  /interaction/:uid
 *        Login, hosted Core: 303 to the sign-in page's `/login?interaction=<uid>`.
 *        Login, Private Cloud: start the code flow at the customer's identity
 *        provider (rate-limited).
 *        Consent: a first-party client is granted without a screen; any other
 *        client goes to the sign-in page's `/consent?interaction=<uid>`.
 *   GET  /interaction/:uid/details
 *        `{prompt, client: {name}, scopes}` for the sign-in page.
 *   POST /interaction/:uid/supabase   (hosted)
 *        The sign-in page's hand-off: `{access_token}` of the person's Supabase
 *        session. Core verifies it, resolves `("mentra", sub)`, records the
 *        sign-in, ends that Supabase session and answers `{redirectTo}`, the
 *        provider's own continuation.
 *   POST /interaction/:uid/consent
 *        `{decision: "allow" | "deny"}` from the consent screen; `{redirectTo}`.
 *   GET  /interaction/callback/:provider   (Private Cloud)
 *        The customer's identity provider's redirect back; finishes the login.
 *
 * Every response is `no-store`. POSTs are same-origin only (`Origin` equal to
 * the issuer's origin, or `Sec-Fetch-Site: same-origin` without one) and
 * rate-limited per IP. Pages show fixed text and never echo request
 * parameters. The only redirect the page is ever given is the provider's
 * continuation for this interaction.
 */

import type {IncomingMessage} from "node:http"

import {createLogger} from "@mentra/cloud-shared"
import type Provider from "oidc-provider"

import {extendProvider} from "../../services/oidc/bridge"
import {findClient} from "../../services/oidc/clients"
import {oidcIssuer} from "../../services/oidc/config"
import {grantableScopes, recordSignIn, saveGrant} from "../../services/oidc/interactions"
import {renderPage} from "../../services/oidc/pages"
import {
  finishUpstreamSignIn,
  upstreamAuthorizationUrl,
  upstreamRedirectUri,
  UpstreamSignInRefused,
} from "../../services/oidc/upstream"
import {
  ConfigurationError,
  findProviderBySourceId,
  portalIdentityProvider,
  type WebIdentityProvider,
} from "../../services/signin/config"
import {endSupabaseSession, IdentityProviderUnavailableError, verifySupabaseHandoffToken} from "../../services/signin/idp-tokens"
import {consumeLoginTransaction, LOGIN_TRANSACTION_TTL_MS, startLoginTransaction} from "../../services/signin/login-transaction.service"
import {s256} from "../../services/signin/random"
import {consumeRateLimit} from "../../services/signin/rate-limit.service"
import {findOrCreateUser, isDeletedAccount} from "../../services/user.service"

const logger = createLogger("core").child({service: "oidc-interaction"})

const HANDOFF_LIMIT_PER_MINUTE = 30
const UPSTREAM_START_LIMIT_PER_MINUTE = 20
const UPSTREAM_CALLBACK_LIMIT_PER_MINUTE = 30
const CONSENT_LIMIT_PER_MINUTE = 30
const MAX_BODY_BYTES = 16 * 1024
const UID = /^[A-Za-z0-9_-]{10,64}$/

type KoaContext = Parameters<Parameters<Provider["use"]>[0]>[0]

// --- responses ---------------------------------------------------------------------

function json(ctx: KoaContext, status: number, body: unknown): void {
  ctx.status = status
  ctx.set("cache-control", "no-store")
  ctx.type = "application/json"
  ctx.body = JSON.stringify(body)
}

function page(ctx: KoaContext, status: number, title: string, text: string): void {
  const rendered = renderPage({title, notice: text})
  ctx.status = status
  ctx.set(rendered.headers)
  ctx.body = rendered.html
}

const expiredPage = (ctx: KoaContext) =>
  page(ctx, 400, "Sign-in expired", "This sign-in has expired or was already used. Start again from the site you were using.")
const refusedPage = (ctx: KoaContext) =>
  page(ctx, 400, "Sign-in did not complete", "Your sign-in could not be completed. Start again from the site you were using.")
const unavailablePage = (ctx: KoaContext) =>
  page(ctx, 503, "Sign-in is unavailable", "The sign-in service could not be reached. Try again in a moment.")
const tooManyPage = (ctx: KoaContext) =>
  page(ctx, 429, "Too many attempts", "Too many sign-in attempts from this network. Wait a minute and try again.")
const notConfiguredPage = (ctx: KoaContext) =>
  page(ctx, 503, "Sign-in is not configured", "Sign-in is not configured on this deployment.")

function redirect(ctx: KoaContext, location: string): void {
  ctx.status = 303
  ctx.set("cache-control", "no-store")
  ctx.set("location", location)
}

// --- request helpers ---------------------------------------------------------------------

/** The caller's IP for rate limits: the first `x-forwarded-for` hop (the ingress sets it). */
function clientIp(ctx: KoaContext): string {
  return ctx.get("x-forwarded-for").split(",")[0]?.trim() || "unknown"
}

/** CSRF: `Origin` must be the issuer's origin, or, without one, `Sec-Fetch-Site: same-origin`. */
function isSameOrigin(ctx: KoaContext, issuer: string): boolean {
  const origin = ctx.get("origin")
  if (origin) return origin === new URL(issuer).origin
  return ctx.get("sec-fetch-site") === "same-origin"
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const isJson = (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  // Drain the whole body even past the limit, so the connection stays usable.
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) tooLarge = true
    else chunks.push(chunk as Buffer)
  }
  if (tooLarge || !isJson) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function withinLimit(key: string, limit: number): Promise<boolean> {
  return consumeRateLimit(key, limit, 60)
}

function txCookieName(issuer: string): string {
  return issuer.startsWith("https:") ? "__Host-mentra_signin_tx" : "mentra_signin_tx"
}

/** The identity provider behind this Core's sign-in: Supabase (hosted) or the customer's (Private Cloud); null when neither is configured. */
function signInSource(): WebIdentityProvider | null {
  try {
    return portalIdentityProvider()
  } catch (err) {
    if (err instanceof ConfigurationError) return null
    throw err
  }
}

type Details = Awaited<ReturnType<Provider["interactionDetails"]>>

/** The interaction this browser holds for `uid`, or null when it is missing, expired or another one. */
async function interactionFor(provider: Provider, ctx: KoaContext, uid: string): Promise<Details | null> {
  try {
    const details = await provider.interactionDetails(ctx.req, ctx.res)
    return details.uid === uid ? details : null
  } catch {
    return null
  }
}

// --- routes ---------------------------------------------------------------------------

async function showInteraction(provider: Provider, ctx: KoaContext, issuer: string, uid: string): Promise<void> {
  const details = await interactionFor(provider, ctx, uid)
  if (!details) return expiredPage(ctx)
  const clientId = String(details.params.client_id ?? "")
  if (details.prompt.name === "login") {
    const source = signInSource()
    if (!source) return notConfiguredPage(ctx)
    if (source.kind === "supabase") return redirect(ctx, `${issuer}/login?interaction=${encodeURIComponent(uid)}`)
    return startUpstream(ctx, issuer, source, uid)
  }
  if (details.prompt.name === "consent") {
    const client = await findClient(clientId)
    if (client?.firstParty && details.session?.accountId) {
      const grantId = await saveGrant(provider, details.session.accountId, clientId, grantableScopes(details.params.scope))
      const returnTo = await provider.interactionResult(ctx.req, ctx.res, {consent: {grantId}}, {mergeWithLastSubmission: true})
      return redirect(ctx, returnTo)
    }
    return redirect(ctx, `${issuer}/consent?interaction=${encodeURIComponent(uid)}`)
  }
  return refusedPage(ctx)
}

async function describeInteraction(provider: Provider, ctx: KoaContext, uid: string): Promise<void> {
  const details = await interactionFor(provider, ctx, uid)
  if (!details) return json(ctx, 400, {error: "interaction_expired"})
  const client = await findClient(String(details.params.client_id ?? ""))
  if (!client) return json(ctx, 400, {error: "interaction_expired"})
  return json(ctx, 200, {
    prompt: details.prompt.name,
    client: {name: client.name},
    scopes: grantableScopes(details.params.scope).split(" ").filter(Boolean),
  })
}

async function supabaseHandoff(provider: Provider, ctx: KoaContext, issuer: string, uid: string, body: Record<string, unknown> | null): Promise<void> {
  if (!isSameOrigin(ctx, issuer)) return json(ctx, 403, {error: "forbidden"})
  const source = signInSource()
  if (source?.kind !== "supabase") return json(ctx, 404, {error: "not_found"})
  if (!(await withinLimit(`oidc-handoff:ip:${clientIp(ctx)}`, HANDOFF_LIMIT_PER_MINUTE))) return json(ctx, 429, {error: "too_many_requests"})
  const accessToken = typeof body?.access_token === "string" ? body.access_token : ""
  if (!accessToken) return json(ctx, 400, {error: "invalid_request"})
  const details = await interactionFor(provider, ctx, uid)
  if (!details || details.prompt.name !== "login") return json(ctx, 400, {error: "interaction_expired"})

  let handoff
  try {
    handoff = await verifySupabaseHandoffToken(accessToken)
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) return json(ctx, 503, {error: "temporarily_unavailable"})
    throw err
  }
  if (!handoff) {
    logger.warn("sign-in hand-off refused")
    return json(ctx, 401, {error: "sign_in_refused"})
  }
  const authTime = new Date()
  await recordSignIn({
    mentraUserId: handoff.mentraUserId,
    tenantId: handoff.provider.tenantId,
    sourceId: handoff.provider.sourceId,
    subject: handoff.subject,
    email: handoff.email,
    emailVerified: handoff.emailVerified,
    name: handoff.name,
    authTime,
  })
  // The token has done its job: Core ends that Supabase session, so the page keeps none.
  await endSupabaseSession(handoff.provider.issuer, accessToken)
  const redirectTo = await provider.interactionResult(
    ctx.req,
    ctx.res,
    {login: {accountId: handoff.mentraUserId, ts: Math.floor(authTime.getTime() / 1000)}},
    {mergeWithLastSubmission: false},
  )
  logger.info({mentraUserId: handoff.mentraUserId}, "signed in through the sign-in page")
  return json(ctx, 200, {redirectTo})
}

async function consentDecision(provider: Provider, ctx: KoaContext, issuer: string, uid: string, body: Record<string, unknown> | null): Promise<void> {
  if (!isSameOrigin(ctx, issuer)) return json(ctx, 403, {error: "forbidden"})
  if (!(await withinLimit(`oidc-consent:ip:${clientIp(ctx)}`, CONSENT_LIMIT_PER_MINUTE))) return json(ctx, 429, {error: "too_many_requests"})
  const decision = body?.decision
  if (decision !== "allow" && decision !== "deny") return json(ctx, 400, {error: "invalid_request"})
  const details = await interactionFor(provider, ctx, uid)
  const accountId = details?.session?.accountId
  if (!details || details.prompt.name !== "consent" || !accountId) return json(ctx, 400, {error: "interaction_expired"})
  const result =
    decision === "allow"
      ? {consent: {grantId: await saveGrant(provider, accountId, String(details.params.client_id), grantableScopes(details.params.scope))}}
      : {error: "access_denied", error_description: "the person declined"}
  const redirectTo = await provider.interactionResult(ctx.req, ctx.res, result, {mergeWithLastSubmission: true})
  return json(ctx, 200, {redirectTo})
}

async function startUpstream(ctx: KoaContext, issuer: string, source: WebIdentityProvider, uid: string): Promise<void> {
  if (!(await withinLimit(`oidc-upstream-start:ip:${clientIp(ctx)}`, UPSTREAM_START_LIMIT_PER_MINUTE))) return tooManyPage(ctx)
  let authorizationUrl: URL
  let cookieValue: string
  try {
    const started = await startLoginTransaction("provider", "/", new Date(), {interactionUid: uid})
    cookieValue = started.cookieValue
    authorizationUrl = await upstreamAuthorizationUrl(source, upstreamRedirectUri(issuer, source), {
      state: started.tx.state,
      nonce: started.tx.nonce,
      codeChallenge: s256(started.tx.pkceVerifier),
    })
  } catch (err) {
    logger.error({errorName: (err as Error)?.name}, "could not start the identity provider sign-in")
    return unavailablePage(ctx)
  }
  ctx.cookies.set(txCookieName(issuer), cookieValue, {
    httpOnly: true,
    secure: issuer.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    signed: false,
    maxAge: LOGIN_TRANSACTION_TTL_MS,
    overwrite: true,
  })
  return redirect(ctx, authorizationUrl.href)
}

async function upstreamCallback(provider: Provider, ctx: KoaContext, issuer: string, sourceId: string): Promise<void> {
  const source = findProviderBySourceId(sourceId)
  if (!source || source.kind !== "oidc_provider" || !source.browser) return refusedPage(ctx)
  try {
    if (!(await withinLimit(`oidc-upstream-callback:ip:${clientIp(ctx)}`, UPSTREAM_CALLBACK_LIMIT_PER_MINUTE))) return tooManyPage(ctx)
    const cookieValue = ctx.cookies.get(txCookieName(issuer), {signed: false})
    const state = typeof ctx.query.state === "string" ? ctx.query.state : ""
    const tx = cookieValue && state ? await consumeLoginTransaction(cookieValue, state) : null
    ctx.cookies.set(txCookieName(issuer), null, {path: "/", secure: issuer.startsWith("https:"), signed: false, overwrite: true})
    if (!tx || tx.portal !== "provider" || !tx.interactionUid) return expiredPage(ctx)

    // The callback Core verifies is its configured redirect URI with the query the provider sent.
    const callbackUrl = new URL(upstreamRedirectUri(issuer, source))
    callbackUrl.search = new URL(ctx.originalUrl, issuer).search
    const identity = await finishUpstreamSignIn(source, callbackUrl, tx)
    const user = await findOrCreateUser({tenantId: source.tenantId, tenantUserId: identity.subject})
    if (isDeletedAccount(user)) return refusedPage(ctx)

    // This browser started this sign-in from the interaction (the transaction cookie and its state prove it),
    // so the interaction is finished here; its own cookie is scoped to the interaction's path.
    const interaction = await provider.Interaction.find(tx.interactionUid)
    if (!interaction) return expiredPage(ctx)
    const authTime = new Date()
    await recordSignIn({
      mentraUserId: user.mentraUserId,
      tenantId: source.tenantId,
      sourceId: source.sourceId,
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      name: identity.name,
      authTime,
    })
    interaction.result = {login: {accountId: user.mentraUserId, ts: Math.floor(authTime.getTime() / 1000)}}
    await interaction.save(interaction.exp - Math.floor(Date.now() / 1000))
    logger.info({mentraUserId: user.mentraUserId, tenantId: source.tenantId}, "signed in through the identity provider")
    return redirect(ctx, new URL(interaction.returnTo, issuer).href)
  } catch (err) {
    if (err instanceof UpstreamSignInRefused) {
      logger.warn({reason: err.message}, "identity provider sign-in refused")
      return refusedPage(ctx)
    }
    logger.error({errorName: (err as Error)?.name}, "identity provider sign-in failed")
    return unavailablePage(ctx)
  }
}

/** Mount the sign-in steps on a provider. */
export function installInteractionRoutes(provider: Provider): void {
  provider.use(async (ctx, next) => {
    if (!ctx.path.startsWith("/interaction/")) return next()
    const issuer = oidcIssuer()
    if (!issuer) return json(ctx, 404, {error: "not_found"})
    const parts = ctx.path.split("/").slice(2)
    try {
      if (parts[0] === "callback" && parts.length === 2 && ctx.method === "GET") {
        return await upstreamCallback(provider, ctx, issuer, decodeURIComponent(parts[1]!))
      }
      const uid = parts[0] ?? ""
      if (!UID.test(uid)) return json(ctx, 404, {error: "not_found"})
      if (parts.length === 1 && ctx.method === "GET") return await showInteraction(provider, ctx, issuer, uid)
      if (parts.length === 2 && parts[1] === "details" && ctx.method === "GET") return await describeInteraction(provider, ctx, uid)
      if (ctx.method === "POST" && parts.length === 2 && (parts[1] === "supabase" || parts[1] === "consent")) {
        // The body is read in full before anything else, so every answer leaves the connection clean.
        const body = await readJsonBody(ctx.req)
        if (parts[1] === "supabase") return await supabaseHandoff(provider, ctx, issuer, uid, body)
        return await consentDecision(provider, ctx, issuer, uid, body)
      }
      return json(ctx, 404, {error: "not_found"})
    } catch (err) {
      logger.error({errorName: (err as Error)?.name}, "sign-in step failed")
      return ctx.method === "GET" ? unavailablePage(ctx) : json(ctx, 503, {error: "temporarily_unavailable"})
    }
  })
}

extendProvider(installInteractionRoutes)
