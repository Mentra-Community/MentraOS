/**
 * @fileoverview Core's sign-in server: an OpenID Connect provider on panva's
 * `oidc-provider` (pinned exactly in package.json).
 *
 * Profile:
 * - Issuer `CLOUD_CORE_OIDC_ISSUER`; every endpoint is a fixed path under it
 *   (`config.ts`). Discovery names Core's key set as `jwks_uri`.
 * - The authorization code flow only, with S256 PKCE required for every client
 *   and exact redirect URIs. No implicit or hybrid flow, no device or
 *   client-credentials grant, no dynamic registration, no PAR or DPoP.
 * - Refresh tokens go to clients registered for them (the Developer Console
 *   and the CLI). They rotate; reusing a spent one fails and ends its grant.
 *   They do not end with the sign-in site's session.
 * - Access tokens are JWTs for Core's API (`aud` `urn:mentra:core`, `typ`
 *   `at+jwt`) and carry `client_id`; ID tokens carry the client in `aud` and
 *   the person's `email`, `email_verified` and `name`. Both are signed with
 *   Core's key under `kid` `mentra-oidc-1`.
 * - `sub` is the person's `mentraUserId`. `findAccount` refuses a deleted
 *   account, a sign-in from before the person's `webSignInsRevokedAt`, and a
 *   person whose sign-in source is no longer configured.
 * - Revocation and RP-initiated logout (end-session) are on. Userinfo is
 *   served by Core itself (`api/oidc/oidc.api.ts`), because the library's
 *   userinfo refuses JWT access tokens.
 * - End-session from a registered client that names a registered
 *   `post_logout_redirect_uri` (the portals' sign-out) signs the person out
 *   of the sign-in server at once and returns them there; the page only
 *   submits itself. A request that names no client or no return address (a
 *   bare link, the sign-in site's `/signout`) asks the person to confirm.
 * - The provider's own cookies are signed with `CLOUD_CORE_OIDC_COOKIE_KEYS`,
 *   `__Host-`/`__Secure-` prefixed on HTTPS, and authenticate nothing outside
 *   the provider.
 */

import {createLogger} from "@mentra/cloud-shared"
import type {KoaContextWithOIDC} from "oidc-provider"
import Provider, {errors, interactionPolicy} from "oidc-provider"

import {loadAccount} from "./account"
import {findClient} from "./clients"
import {CORE_API_RESOURCE, OIDC_ROUTES, OIDC_SCOPES} from "./config"
import {OIDC_TOKEN_ALG, oidcSigningJwk} from "./keys"
import {MongoAdapter} from "./mongo-adapter"
import {cspOrigin, renderPage} from "./pages"

const logger = createLogger("core").child({service: "oidc-provider"})

const ACCESS_TOKEN_TTL_SEC = 60 * 60
const ID_TOKEN_TTL_SEC = 60 * 60
const AUTHORIZATION_CODE_TTL_SEC = 60
const INTERACTION_TTL_SEC = 60 * 60
const SESSION_TTL_SEC = 14 * 24 * 60 * 60
const GRANT_TTL_SEC = 30 * 24 * 60 * 60
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60

export interface ProviderSettings {
  issuer: string
  cookieKeys: string[]
}

function authTimeOf(ctx: KoaContextWithOIDC | undefined, token: unknown): number | undefined {
  const fromToken = (token as {authTime?: unknown} | undefined)?.authTime
  if (typeof fromToken === "number") return fromToken
  const session = ctx?.oidc?.session as {authTime?: () => number | undefined} | undefined
  return session?.authTime?.()
}

const ERROR_TEXT: Record<string, string> = {
  invalid_client: "This site is not registered to sign in with Mentra.",
  invalid_redirect_uri: "This site is not registered to sign in with Mentra.",
  invalid_request: "The sign-in request was not valid. Start again from the site you were using.",
  session_not_found: "This sign-in has expired. Start again from the site you were using.",
}

/**
 * The end-session page for a signed-in person. `form` is the provider's
 * `op.logoutForm` (its XSRF token); its button signs the person out of the
 * whole sign-in server session (`logout=yes`).
 *
 * The provider has already checked that a named client is registered and
 * that its `post_logout_redirect_uri` is one the client registered. When the
 * request names both, a registered site is signing the person out and asks to
 * have them back: the page submits itself, and the button is only the
 * fallback when script does not run. Otherwise (a bare link, which anyone can
 * send) it asks the person to confirm.
 */
export function logoutPage(ctx: KoaContextWithOIDC, form: string) {
  const returnTo = typeof ctx.oidc.params?.post_logout_redirect_uri === "string" ? ctx.oidc.params.post_logout_redirect_uri : undefined
  const returnOrigin = ctx.oidc.client && returnTo ? cspOrigin(returnTo) : null
  if (returnOrigin) {
    return renderPage({
      title: "Signing you out…",
      bodyHtml: `${form}<div class="stack"><button class="button button-primary" id="auto-submit" type="submit" form="op.logoutForm" name="logout" value="yes">Sign out</button></div>`,
      autoSubmit: {redirectsTo: returnOrigin},
    })
  }
  return renderPage({
    title: "Sign out of Mentra?",
    paragraphs: ["You will need to sign in again the next time a Mentra site asks. Sites where you are signed in stay signed in until you sign out of them."],
    bodyHtml: `${form}<div class="stack"><button class="button button-primary" type="submit" form="op.logoutForm" name="logout" value="yes" autofocus>Sign out</button><a class="button button-secondary" href="/">Stay signed in</a></div>`,
  })
}

/** The scopes Core grants a first-party client: what it asked for, among the scopes Core knows. */
const GRANTABLE_SCOPES = new Set(["openid", "email", "profile"])

/**
 * The grant for this authorization. A grant the person already has is reused.
 * A first-party client is granted the scopes it asked for without a consent
 * screen; any other client gets no implicit grant, so the consent prompt runs.
 */
export async function firstPartyGrant(ctx: KoaContextWithOIDC) {
  const {oidc} = ctx
  const clientId = oidc.client!.clientId
  const existingId = (oidc.result?.consent as {grantId?: string} | undefined)?.grantId || oidc.session!.grantIdFor(clientId)
  if (existingId) {
    const existing = await oidc.provider.Grant.find(existingId)
    if (existing) return existing
  }
  const client = await findClient(clientId)
  if (!client?.firstParty || !oidc.session?.accountId) return undefined
  const requested = String(oidc.params?.scope ?? "")
    .split(" ")
    .filter(scope => GRANTABLE_SCOPES.has(scope))
    .join(" ")
  const grant = new oidc.provider.Grant({accountId: oidc.session.accountId, clientId})
  if (requested) {
    grant.addOIDCScope(requested)
    grant.addResourceScope(CORE_API_RESOURCE, requested)
  }
  await grant.save()
  return grant
}

/** The provider's configuration (exported for tests that inspect it). */
export async function providerConfiguration(settings: ProviderSettings) {
  const policy = interactionPolicy.base()
  // A provider session whose person Core no longer accepts (revoked, deleted, source removed) asks for a new sign-in.
  policy.get("login")!.checks.add(
    new interactionPolicy.Check("account_unavailable", "the signed-in person is no longer accepted", ctx =>
      ctx.oidc.session?.accountId && !ctx.oidc.account ? interactionPolicy.Check.REQUEST_PROMPT : interactionPolicy.Check.NO_NEED_TO_PROMPT,
    ),
  )
  const secure = settings.issuer.startsWith("https:")

  return {
    adapter: MongoAdapter,
    clients: [],
    clientDefaults: {
      grant_types: ["authorization_code"],
      id_token_signed_response_alg: OIDC_TOKEN_ALG,
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    },
    clientAuthMethods: ["client_secret_post", "none"],
    responseTypes: ["code"],
    pkce: {required: () => true},
    allowOmittingSingleRegisteredRedirectUri: false,
    conformIdTokenClaims: false,
    claims: {openid: ["sub"], email: ["email", "email_verified"], profile: ["name"]},
    scopes: [...OIDC_SCOPES],
    jwks: {keys: [await oidcSigningJwk()]},
    enabledJWA: {idTokenSigningAlgValues: [OIDC_TOKEN_ALG]},
    cookies: {
      keys: settings.cookieKeys,
      names: secure
        ? {session: "__Host-mentra_oidc_session", interaction: "__Secure-mentra_oidc_interaction", resume: "__Secure-mentra_oidc_resume"}
        : {session: "mentra_oidc_session", interaction: "mentra_oidc_interaction", resume: "mentra_oidc_resume"},
      long: {httpOnly: true, sameSite: "lax", signed: true},
      short: {httpOnly: true, sameSite: "lax", signed: true},
    },
    routes: {...OIDC_ROUTES},
    discovery: {userinfo_endpoint: `${settings.issuer}${OIDC_ROUTES.userinfo}`},
    features: {
      devInteractions: {enabled: false},
      dPoP: {enabled: false},
      pushedAuthorizationRequests: {enabled: false},
      registration: {enabled: false},
      registrationManagement: {enabled: false},
      clientCredentials: {enabled: false},
      deviceFlow: {enabled: false},
      introspection: {enabled: false},
      // Core serves userinfo itself, for its JWT access tokens.
      userinfo: {enabled: false},
      revocation: {
        enabled: true,
        // A client revokes only its own tokens.
        allowedPolicy: async (_ctx: unknown, client: {clientId: string}, token: {clientId?: string}) => token.clientId === client.clientId,
      },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx: KoaContextWithOIDC, form: string) => {
          const page = logoutPage(ctx, form)
          ctx.set(page.headers)
          ctx.body = page.html
        },
        postLogoutSuccessSource: async (ctx: KoaContextWithOIDC) => {
          const page = renderPage({
            title: "Signed out of Mentra",
            paragraphs: ["You are signed out of your Mentra account on this browser. You can close this tab."],
          })
          ctx.set(page.headers)
          ctx.body = page.html
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => CORE_API_RESOURCE,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx: unknown, resource: string) => {
          if (resource !== CORE_API_RESOURCE) throw new errors.InvalidTarget()
          return {
            scope: "openid email profile",
            audience: CORE_API_RESOURCE,
            accessTokenFormat: "jwt",
            accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
            jwt: {sign: {alg: OIDC_TOKEN_ALG}},
          }
        },
      },
    },
    loadExistingGrant: firstPartyGrant,
    rotateRefreshToken: true,
    issueRefreshToken: async (_ctx: unknown, client: {grantTypeAllowed(type: string): boolean}) => client.grantTypeAllowed("refresh_token"),
    // Refresh tokens outlive the sign-in site's session: signing out there leaves every site and the CLI signed in.
    expiresWithSession: async () => false,
    extraTokenClaims: async (_ctx: unknown, token: {clientId?: string}) => (token.clientId ? {client_id: token.clientId} : undefined),
    findAccount: async (ctx: KoaContextWithOIDC, sub: string, token?: unknown) => {
      const identity = await loadAccount(sub, authTimeOf(ctx, token))
      if (!identity) return undefined
      return {
        accountId: sub,
        claims: async () => ({
          sub,
          email: identity.email ?? undefined,
          email_verified: identity.email ? identity.emailVerified : undefined,
          name: identity.name ?? undefined,
        }),
      }
    },
    interactions: {
      policy,
      url: async (_ctx: unknown, interaction: {uid: string}) => `/interaction/${interaction.uid}`,
    },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_SEC,
      AuthorizationCode: AUTHORIZATION_CODE_TTL_SEC,
      IdToken: ID_TOKEN_TTL_SEC,
      Interaction: INTERACTION_TTL_SEC,
      Session: SESSION_TTL_SEC,
      Grant: GRANT_TTL_SEC,
      RefreshToken: REFRESH_TOKEN_TTL_SEC,
    },
    renderError: async (ctx: KoaContextWithOIDC, out: {error?: string}) => {
      const page = renderPage({
        title: "Sign-in did not complete",
        notice: ERROR_TEXT[out.error ?? ""] ?? "Something went wrong. Start again from the site you were using.",
      })
      ctx.set(page.headers)
      ctx.body = page.html
    },
  }
}

/** Build the provider. Its Koa app runs on Core's internal listener (`bridge.ts`). */
export async function createOidcProvider(settings: ProviderSettings): Promise<Provider> {
  const configuration = await providerConfiguration(settings)
  // The configuration's shape is checked by oidc-provider at construction.
  const provider = new Provider(settings.issuer, configuration as never)
  // Core's bridge sets Host and X-Forwarded-Proto from the configured issuer, never from the client.
  provider.proxy = true
  // Errors are reported through Core's logger without request details; Koa's own stderr logging is off.
  provider.app.silent = true
  provider.on("server_error", (_ctx: unknown, err: Error) => logger.error({errorName: err?.name}, "sign-in server error"))
  return provider
}
