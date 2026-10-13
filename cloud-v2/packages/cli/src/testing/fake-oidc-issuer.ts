/**
 * @fileoverview A fake OpenID Connect issuer for the CLI's tests. It behaves
 * like Core's sign-in server toward a public client:
 *
 * - discovery, and a key set with one Ed25519 key; ID tokens are EdDSA;
 * - authorization: `approveInBrowser` plays the browser, checks the request
 *   (client, exact loopback redirect URI, S256 PKCE, `openid` scope), and
 *   follows the redirect to the CLI's loopback callback with a code (or
 *   `denyInBrowser` with an error);
 * - the token endpoint: the code grant with PKCE, one redemption per code; the
 *   refresh grant with rotation, where reusing a spent refresh token fails and
 *   ends its grant;
 * - revocation: revoking a refresh token ends its grant.
 *
 * Every grant is one login: a second login gets its own grant.
 */

import {createHash, generateKeyPairSync, randomBytes, sign} from "node:crypto"
import type {Server} from "bun"

export const FAKE_CLI_REDIRECT_URIS = [
  "http://127.0.0.1:53682/callback",
  "http://127.0.0.1:53683/callback",
  "http://127.0.0.1:53684/callback",
]

export interface FakePerson {
  sub: string
  email?: string
}

interface PendingCode {
  person: FakePerson
  clientId: string
  redirectUri: string
  codeChallenge: string
  nonce: string | null
  redeemed: boolean
  grantId: string
}

interface Grant {
  id: string
  person: FakePerson
  clientId: string
  ended: boolean
}

interface RefreshToken {
  grantId: string
  spent: boolean
}

export interface FakeOidcIssuer {
  readonly issuer: string
  /** Successful code redemptions. */
  readonly codeRedemptions: number
  /** Successful refreshes. */
  readonly refreshes: number
  /** Every revocation request, successful or not. */
  readonly revocations: Array<{token: string; hint: string | null; clientId: string | null}>
  /** Every authorization request the browser carried, as URLs. */
  readonly authorizationRequests: URL[]
  /** Every request this issuer received, as "METHOD /path". */
  readonly requests: string[]
  /** Answer the revocation endpoint with 503. */
  failRevocation: boolean
  /** Delay before the token endpoint answers a refresh, in ms (widens refresh races). */
  refreshDelayMs: number
  /** Sign `person` in and follow the redirect to the client's callback, as a browser would. */
  approveInBrowser(authorizationUrl: string, person: FakePerson): Promise<{status: number; text: string}>
  /** Decline the sign-in (`error=access_denied` by default) and follow the redirect. */
  denyInBrowser(authorizationUrl: string, error?: string): Promise<{status: number; text: string}>
  /** The person an access token belongs to, or null when it is unknown or its grant has ended. */
  accessTokenOwner(token: string): FakePerson | null
  /** Whether a refresh token would still be accepted. */
  refreshTokenActive(token: string): boolean
  stop(): void
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url")
}

function random(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`
}

function tokenError(error: string, status = 400): Response {
  return Response.json({error, error_description: error}, {status, headers: {"cache-control": "no-store"}})
}

export async function startFakeOidcIssuer(options: {
  publicClientId: string
  redirectUris?: string[]
  accessTokenTtlSec?: number
}): Promise<FakeOidcIssuer> {
  const redirectUris = options.redirectUris ?? FAKE_CLI_REDIRECT_URIS
  const accessTokenTtlSec = options.accessTokenTtlSec ?? 3600
  const keys = generateKeyPairSync("ed25519")
  const kid = "fake-oidc-1"
  const publicJwk = {...(keys.publicKey.export({format: "jwk"}) as Record<string, string>), kid, alg: "EdDSA", use: "sig"}

  const codes = new Map<string, PendingCode>()
  const grants = new Map<string, Grant>()
  const refreshTokens = new Map<string, RefreshToken>()
  const accessTokens = new Map<string, string>()
  const state = {
    codeRedemptions: 0,
    refreshes: 0,
    revocations: [] as FakeOidcIssuer["revocations"],
    authorizationRequests: [] as URL[],
    requests: [] as string[],
    failRevocation: false,
    refreshDelayMs: 0,
  }

  let issuer = ""

  function signJwt(payload: Record<string, unknown>): string {
    const input = `${base64url(JSON.stringify({alg: "EdDSA", typ: "JWT", kid}))}.${base64url(JSON.stringify(payload))}`
    return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`
  }

  function endGrant(grantId: string): void {
    const grant = grants.get(grantId)
    if (grant) grant.ended = true
  }

  function issueTokens(grant: Grant, nonce: string | null): Response {
    const now = Math.floor(Date.now() / 1000)
    const accessToken = random("at")
    const refreshToken = random("rt")
    accessTokens.set(accessToken, grant.id)
    refreshTokens.set(refreshToken, {grantId: grant.id, spent: false})
    const idToken = signJwt({
      iss: issuer,
      sub: grant.person.sub,
      aud: grant.clientId,
      iat: now,
      exp: now + 3600,
      auth_time: now,
      ...(nonce ? {nonce} : {}),
      ...(grant.person.email ? {email: grant.person.email, email_verified: true} : {}),
    })
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: accessTokenTtlSec,
        refresh_token: refreshToken,
        id_token: idToken,
        scope: "openid email profile",
      },
      {headers: {"cache-control": "no-store"}},
    )
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    // A public client: its ID in the form, and no client authentication.
    if (form.get("client_id") !== options.publicClientId || request.headers.get("authorization")) {
      return tokenError("invalid_client", 401)
    }
    const grantType = form.get("grant_type")
    if (grantType === "authorization_code") {
      const pending = codes.get(form.get("code") ?? "")
      if (!pending) return tokenError("invalid_grant")
      if (pending.redeemed) {
        endGrant(pending.grantId)
        return tokenError("invalid_grant")
      }
      pending.redeemed = true
      const verifier = form.get("code_verifier") ?? ""
      if (createHash("sha256").update(verifier).digest("base64url") !== pending.codeChallenge) return tokenError("invalid_grant")
      if (form.get("redirect_uri") !== pending.redirectUri) return tokenError("invalid_grant")
      state.codeRedemptions++
      return issueTokens(grants.get(pending.grantId)!, pending.nonce)
    }
    if (grantType === "refresh_token") {
      if (state.refreshDelayMs > 0) await Bun.sleep(state.refreshDelayMs)
      const presented = refreshTokens.get(form.get("refresh_token") ?? "")
      const grant = presented ? grants.get(presented.grantId) : undefined
      if (!presented || !grant || grant.ended) return tokenError("invalid_grant")
      if (presented.spent) {
        // Reusing a spent refresh token ends its grant.
        endGrant(grant.id)
        return tokenError("invalid_grant")
      }
      presented.spent = true
      state.refreshes++
      return issueTokens(grant, null)
    }
    return tokenError("unsupported_grant_type")
  }

  async function revocation(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const presented = form.get("token") ?? ""
    state.revocations.push({token: presented, hint: form.get("token_type_hint"), clientId: form.get("client_id")})
    if (state.failRevocation) return new Response("unavailable", {status: 503})
    if (form.get("client_id") !== options.publicClientId) return tokenError("invalid_client", 401)
    const refreshToken = refreshTokens.get(presented)
    if (refreshToken) endGrant(refreshToken.grantId)
    return new Response(null, {status: 200})
  }

  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    async fetch(request) {
      const url = new URL(request.url)
      state.requests.push(`${request.method} ${url.pathname}`)
      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["EdDSA"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ["openid", "email", "profile", "offline_access"],
        })
      }
      if (request.method === "GET" && url.pathname === "/jwks") return Response.json({keys: [publicJwk]})
      if (request.method === "POST" && url.pathname === "/token") return token(request)
      if (request.method === "POST" && url.pathname === "/revoke") return revocation(request)
      return new Response("not found", {status: 404})
    },
  })
  issuer = `http://127.0.0.1:${server.port}`

  /** Check an authorization request as the provider would. Returns its parameters. */
  function authorizationRequest(authorizationUrl: string) {
    const url = new URL(authorizationUrl)
    state.authorizationRequests.push(url)
    if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`) throw new Error(`not this issuer's authorization endpoint: ${url.href}`)
    const params = url.searchParams
    const redirectUri = params.get("redirect_uri") ?? ""
    if (params.get("client_id") !== options.publicClientId) throw new Error("unknown client")
    if (!redirectUris.includes(redirectUri)) throw new Error(`unregistered redirect URI ${redirectUri}`)
    if (params.get("response_type") !== "code") throw new Error("response_type must be code")
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) throw new Error("S256 PKCE is required")
    if (!(params.get("scope") ?? "").split(" ").includes("openid")) throw new Error("openid scope is required")
    return {redirectUri, state: params.get("state"), nonce: params.get("nonce"), codeChallenge: params.get("code_challenge")!}
  }

  /** Follow the provider's redirect to the client's callback, as a browser. */
  async function followRedirect(redirectUri: string, query: Record<string, string | null>) {
    const callback = new URL(redirectUri)
    for (const [name, value] of Object.entries(query)) if (value !== null) callback.searchParams.set(name, value)
    // A fresh connection each time, as a browser would after the CLI's listener closed.
    const response = await fetch(callback, {redirect: "manual", keepalive: false, headers: {connection: "close"}})
    return {status: response.status, text: await response.text()}
  }

  return {
    issuer,
    get codeRedemptions() {
      return state.codeRedemptions
    },
    get refreshes() {
      return state.refreshes
    },
    get revocations() {
      return state.revocations
    },
    get authorizationRequests() {
      return state.authorizationRequests
    },
    get requests() {
      return state.requests
    },
    get failRevocation() {
      return state.failRevocation
    },
    get refreshDelayMs() {
      return state.refreshDelayMs
    },
    set refreshDelayMs(value: number) {
      state.refreshDelayMs = value
    },
    set failRevocation(value: boolean) {
      state.failRevocation = value
    },
    async approveInBrowser(authorizationUrl, person) {
      const request = authorizationRequest(authorizationUrl)
      const grantId = random("grant")
      grants.set(grantId, {id: grantId, person, clientId: options.publicClientId, ended: false})
      const code = random("code")
      codes.set(code, {
        person,
        clientId: options.publicClientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        nonce: request.nonce,
        redeemed: false,
        grantId,
      })
      return followRedirect(request.redirectUri, {code, state: request.state, iss: issuer})
    },
    async denyInBrowser(authorizationUrl, error = "access_denied") {
      const request = authorizationRequest(authorizationUrl)
      return followRedirect(request.redirectUri, {error, state: request.state, iss: issuer})
    },
    accessTokenOwner(token) {
      const grant = grants.get(accessTokens.get(token) ?? "")
      return grant && !grant.ended ? grant.person : null
    },
    refreshTokenActive(token) {
      const refreshToken = refreshTokens.get(token)
      const grant = refreshToken ? grants.get(refreshToken.grantId) : undefined
      return Boolean(refreshToken && !refreshToken.spent && grant && !grant.ended)
    },
    stop() {
      server.stop(true)
    },
  }
}
