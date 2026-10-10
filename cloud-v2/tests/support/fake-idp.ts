/**
 * @fileoverview A fake identity provider for Core's sign-in tests.
 *
 * It plays either side Core trusts:
 *  - `kind: "supabase"` behaves like Supabase Auth's OAuth 2.1 server on an
 *    HS256 project: discovery with no `revocation_endpoint` and no
 *    `end_session_endpoint`; an authorization-code grant with S256 PKCE that
 *    issues HS256 access tokens (`aud: "authenticated"`, `client_id`, `sub`,
 *    `email`, `session_id`, `amr` with the session's start) and never an ID
 *    token; a code exchange that asks for `openid` fails with HTTP 500 after
 *    creating a session, as Supabase does; confidential clients authenticate
 *    with `client_secret_post`, and a Basic header whose client ID was
 *    form-encoded (`-` sent as `%2D`) is refused; GoTrue's
 *    `POST /logout?scope=local|global`; and the admin user lookup Core uses for
 *    email confirmation (`GET /admin/users/:id`).
 *  - `kind: "oidc"` behaves like Microsoft Entra: RS256 ID tokens with `nonce`,
 *    `oid` and `tid`, and RS256 access tokens for the Core API.
 *
 * `mint` signs arbitrary tokens with the provider's keys (HS256 with the
 * shared secret, or RS256 / ES256 with the published keys) for bearer tests.
 *
 * `installFakeIdp` intercepts `fetch` for the issuer's origin in this process.
 * `startFakeIdpServer` serves the same handler on 127.0.0.1 over HTTP, for a
 * Core running in another process.
 */

import {createHash, randomBytes, randomUUID} from "node:crypto"

import * as jose from "jose"

export type FakeIdpKind = "supabase" | "oidc"
export type FakeAlg = "RS256" | "ES256" | "HS256"

export interface FakeClient {
  id: string
  /** Absent for a public client (`token_endpoint_auth_method: none`). */
  secret?: string
  redirectUris: string[]
}

export interface FakePerson {
  sub: string
  email?: string
  /** Supabase: the account's `email_confirmed_at` is set. Default true. */
  emailConfirmed?: boolean
  /** Extra claims for the tokens (for example `oid`, `tid`, `email_verified`). */
  claims?: Record<string, unknown>
}

export interface FakeIdpOptions {
  issuer: string
  jwksUrl?: string
  kind?: FakeIdpKind
  hs256Secret?: string
  clients?: FakeClient[]
  /** Supabase only: the project URL whose `/auth/v1/admin/users/:id` and `/auth/v1/logout` this fake answers. */
  projectUrl?: string
  /** Access token lifetime in seconds. Default 3600. */
  accessTokenTtlSec?: number
}

export interface TokenRequestRecord {
  grantType: string
  auth: "client_secret_post" | "client_secret_basic" | "none"
  clientId: string | null
  status: number
}

export interface LogoutRecord {
  scope: string
  sub: string | null
  sessionId: string | null
  apikey: string | null
  status: number
}

export interface FakeSession {
  sessionId: string
  sub: string
  clientId: string | null
  startedAt: number
  endedAt: number | null
}

export interface FakeIdp {
  readonly kind: FakeIdpKind
  readonly issuer: string
  readonly jwksUrl: string
  /** Sign a token. Adds `iss`, `iat` and `exp` unless the claims set them, and on Supabase an `amr` entry at `iat`. */
  mint(
    claims: Record<string, unknown>,
    opts?: {alg?: FakeAlg; kid?: string; header?: Record<string, unknown>; key?: "attacker"},
  ): Promise<string>
  /** Replace the published RS256 and ES256 keys with new ones under new key IDs. */
  rotateKey(): Promise<void>
  registerClient(client: FakeClient): void
  registerUser(person: FakePerson): void
  /** Complete an authorization request as the signed-in `person`; returns the client's callback URL. */
  approve(authorizeUrl: URL | string, person: FakePerson, opts?: {sessionStartedAt?: number}): Promise<URL>
  /** Answer a request for this provider, or null when it is not one of its URLs. */
  handle(request: Request): Promise<Response | null>
  /** Uninstall the fetch interceptor (installFakeIdp) or stop the server (startFakeIdpServer). */
  restore(): void

  readonly authorizeRequests: URL[]
  readonly tokenRequests: TokenRequestRecord[]
  readonly logoutCalls: LogoutRecord[]
  readonly sessions: Map<string, FakeSession>
  readonly userLookups: string[]
  jwksFetches: number
  discoveryFetches: number
  /** Make every request to this provider fail with 503 (an outage). */
  outage: boolean
  /** Make GoTrue's logout answer 500. */
  failLogout: boolean
}

interface CodeGrant {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  nonce: string | null
  person: FakePerson
  sessionStartedAt: number
  used: boolean
}

interface KeyPair {
  kid: string
  privateKey: jose.KeyLike
  publicJwk: jose.JWK
}

async function keyPair(alg: "RS256" | "ES256"): Promise<KeyPair> {
  const {privateKey, publicKey} = await jose.generateKeyPair(alg, {extractable: true})
  const publicJwk = await jose.exportJWK(publicKey)
  return {kid: `${alg.toLowerCase()}-${randomBytes(6).toString("hex")}`, privateKey, publicJwk: {...publicJwk, alg, use: "sig"}}
}

const nowSec = () => Math.floor(Date.now() / 1000)

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}})
}

export async function createFakeIdp(opts: FakeIdpOptions): Promise<FakeIdp> {
  const kind = opts.kind ?? "supabase"
  const issuer = opts.issuer.replace(/\/+$/, "")
  const jwksUrl = opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`
  const hs256 = opts.hs256Secret ? new TextEncoder().encode(opts.hs256Secret) : null
  const ttl = opts.accessTokenTtlSec ?? 3600
  const projectUrl = opts.projectUrl?.replace(/\/+$/, "") ?? null
  let rsa = await keyPair("RS256")
  let ec = await keyPair("ES256")
  const attacker = await keyPair("RS256")
  const clients = new Map<string, FakeClient>()
  for (const client of opts.clients ?? []) clients.set(client.id, client)
  const users = new Map<string, FakePerson>()
  const codes = new Map<string, CodeGrant>()

  const idp: FakeIdp = {
    kind,
    issuer,
    jwksUrl,
    authorizeRequests: [],
    tokenRequests: [],
    logoutCalls: [],
    sessions: new Map(),
    userLookups: [],
    jwksFetches: 0,
    discoveryFetches: 0,
    outage: false,
    failLogout: false,

    async mint(claims, mintOpts = {}) {
      const alg = mintOpts.alg ?? (kind === "supabase" ? "HS256" : "RS256")
      const iat = typeof claims.iat === "number" ? claims.iat : nowSec()
      const payload: Record<string, unknown> = {iss: issuer, iat, exp: iat + ttl, ...claims}
      if (kind === "supabase" && !("amr" in claims)) {
        payload.amr = [{method: "oauth_provider/authorization_code", timestamp: iat}]
      }
      let key: jose.KeyLike | Uint8Array
      let kid: string | undefined
      if (alg === "HS256") {
        if (!hs256) throw new Error("this fake IdP has no HS256 secret")
        key = hs256
      } else if (mintOpts.key === "attacker") {
        key = attacker.privateKey
        kid = attacker.kid
      } else {
        const pair = alg === "RS256" ? rsa : ec
        key = pair.privateKey
        kid = pair.kid
      }
      const header = {alg, typ: "JWT", ...(kid ? {kid} : {}), ...(mintOpts.kid ? {kid: mintOpts.kid} : {}), ...mintOpts.header}
      return new jose.SignJWT(payload).setProtectedHeader(header as jose.JWTHeaderParameters).sign(key)
    },

    async rotateKey() {
      rsa = await keyPair("RS256")
      ec = await keyPair("ES256")
    },

    registerClient(client) {
      clients.set(client.id, client)
    },

    registerUser(person) {
      users.set(person.sub, person)
    },

    async approve(authorizeUrl, person, approveOpts = {}) {
      const url = new URL(authorizeUrl)
      idp.authorizeRequests.push(url)
      const clientId = url.searchParams.get("client_id") ?? ""
      const redirectUri = url.searchParams.get("redirect_uri") ?? ""
      const client = clients.get(clientId)
      if (!client) throw new Error(`fake IdP: unknown client ${clientId}`)
      if (!client.redirectUris.includes(redirectUri)) throw new Error("fake IdP: invalid redirect_uri")
      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("fake IdP: S256 PKCE required")
      const code = randomBytes(16).toString("base64url")
      users.set(person.sub, {...users.get(person.sub), ...person})
      codes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        scope: url.searchParams.get("scope") ?? "email",
        nonce: url.searchParams.get("nonce"),
        person,
        sessionStartedAt: approveOpts.sessionStartedAt ?? nowSec(),
        used: false,
      })
      const callback = new URL(redirectUri)
      callback.searchParams.set("code", code)
      const state = url.searchParams.get("state")
      if (state !== null) callback.searchParams.set("state", state)
      return callback
    },

    async handle(request) {
      const url = new URL(request.url)
      const href = url.origin + url.pathname
      const issuerUrl = new URL(issuer)
      const ownsIssuer = url.origin === issuerUrl.origin && (url.pathname === issuerUrl.pathname || url.pathname.startsWith(`${issuerUrl.pathname}/`))
      const ownsProject = projectUrl !== null && href.startsWith(`${projectUrl}/auth/v1/`)
      if (!ownsIssuer && !ownsProject && href !== jwksUrl) return null
      if (idp.outage) return json({error: "unavailable"}, 503)

      if (href === jwksUrl) {
        idp.jwksFetches++
        return json({keys: [{...rsa.publicJwk, kid: rsa.kid}, {...ec.publicJwk, kid: ec.kid}]})
      }
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        idp.discoveryFetches++
        return json({
          issuer,
          authorization_endpoint: `${issuer}/${kind === "supabase" ? "oauth/" : ""}authorize`,
          token_endpoint: `${issuer}/${kind === "supabase" ? "oauth/" : ""}token`,
          userinfo_endpoint: `${issuer}/${kind === "supabase" ? "oauth/" : ""}userinfo`,
          jwks_uri: jwksUrl,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          subject_types_supported: ["public"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
          code_challenge_methods_supported: ["S256", "plain"],
          scopes_supported: ["openid", "profile", "email", "phone"],
          id_token_signing_alg_values_supported: ["RS256", "ES256"],
        })
      }
      if (request.method === "POST" && /\/(oauth\/)?token$/.test(url.pathname) && ownsIssuer) {
        return tokenEndpoint(request)
      }
      if (request.method === "POST" && url.pathname.endsWith("/logout")) {
        return logout(request, url)
      }
      const adminUser = url.pathname.match(/\/admin\/users\/([^/]+)$/)
      if (request.method === "GET" && adminUser) {
        const id = decodeURIComponent(adminUser[1]!)
        idp.userLookups.push(id)
        const person = users.get(id)
        if (!person) return json({code: 404, msg: "User not found"}, 404)
        return json({
          id,
          email: person.email ?? null,
          email_confirmed_at: person.emailConfirmed === false ? null : "2026-01-01T00:00:00Z",
          user_metadata: {email_verified: true},
        })
      }
      return json({error: "not_found"}, 404)
    },

    restore() {},
  }

  async function tokenEndpoint(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const grantType = form.get("grant_type") ?? ""
    let auth: TokenRequestRecord["auth"] = "none"
    let clientId = form.get("client_id")
    let secret = form.get("client_secret")
    const basic = request.headers.get("authorization")
    const record = (status: number, body: unknown) => {
      idp.tokenRequests.push({grantType, auth, clientId, status})
      return json(body, status)
    }
    if (basic?.startsWith("Basic ")) {
      auth = "client_secret_basic"
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8")
      const colon = decoded.indexOf(":")
      clientId = decoded.slice(0, colon)
      secret = decoded.slice(colon + 1)
      // Supabase does not form-decode Basic credentials, so a library that
      // form-encodes the client ID (as RFC 6749 requires) is refused.
      if (kind === "supabase" && clientId.includes("%")) {
        return record(400, {error: "invalid_client", error_description: "Invalid client_id format"})
      }
    } else if (secret) {
      auth = "client_secret_post"
    }
    const client = clientId ? clients.get(clientId) : undefined
    if (!client) return record(400, {error: "invalid_client"})
    if (client.secret !== undefined && client.secret !== secret) return record(400, {error: "invalid_client"})
    if (client.secret === undefined && secret) return record(400, {error: "invalid_client"})
    if (grantType !== "authorization_code") return record(400, {error: "unsupported_grant_type"})

    const code = form.get("code") ?? ""
    const grant = codes.get(code)
    if (!grant || grant.used) return record(400, {error: "invalid_grant", error_description: "Invalid authorization code"})
    if (grant.clientId !== client.id) return record(400, {error: "invalid_grant"})
    if (form.get("redirect_uri") !== grant.redirectUri) return record(400, {error: "invalid_grant"})
    if (s256(form.get("code_verifier") ?? "") !== grant.codeChallenge) return record(400, {error: "invalid_grant"})
    grant.used = true

    const sessionId = randomUUID()
    idp.sessions.set(sessionId, {sessionId, sub: grant.person.sub, clientId: client.id, startedAt: grant.sessionStartedAt, endedAt: null})
    const scopes = grant.scope.split(" ")
    if (kind === "supabase" && scopes.includes("openid")) {
      // Supabase on HS256 fails here, after creating the session.
      return record(500, {code: 500, error_code: "unexpected_failure", msg: "Error generating ID token"})
    }

    const iat = nowSec()
    if (kind === "supabase") {
      const accessToken = await idp.mint(
        {
          sub: grant.person.sub,
          aud: "authenticated",
          email: grant.person.email ?? "",
          role: "authenticated",
          session_id: sessionId,
          client_id: client.id,
          scope: grant.scope,
          iat,
          amr: [{method: "oauth_provider/authorization_code", timestamp: grant.sessionStartedAt}],
          user_metadata: {email_verified: true},
          ...grant.person.claims,
        },
        {alg: "HS256"},
      )
      return record(200, {access_token: accessToken, token_type: "bearer", expires_in: ttl, refresh_token: randomBytes(12).toString("hex")})
    }

    const claims = {sub: grant.person.sub, email: grant.person.email, ...grant.person.claims}
    const idToken = await idp.mint({...claims, aud: client.id, iat, ...(grant.nonce ? {nonce: grant.nonce} : {})}, {alg: "RS256"})
    const accessToken = await idp.mint({...claims, aud: "api://core", iat, azp: client.id}, {alg: "RS256"})
    return record(200, {access_token: accessToken, id_token: idToken, token_type: "Bearer", expires_in: ttl})
  }

  async function logout(request: Request, url: URL): Promise<Response> {
    const scope = url.searchParams.get("scope") ?? "global"
    const apikey = request.headers.get("apikey")
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const record = (status: number, sub: string | null, sessionId: string | null) => {
      idp.logoutCalls.push({scope, sub, sessionId, apikey, status})
      return status === 204 ? new Response(null, {status}) : json({error: "logout_failed"}, status)
    }
    if (idp.failLogout) return record(500, null, null)
    if (!hs256) return record(401, null, null)
    let payload: jose.JWTPayload
    try {
      ;({payload} = await jose.jwtVerify(bearer, hs256, {algorithms: ["HS256"]}))
    } catch {
      return record(401, null, null)
    }
    const sub = typeof payload.sub === "string" ? payload.sub : null
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : null
    const now = Date.now()
    for (const session of idp.sessions.values()) {
      if (session.sub !== sub || session.endedAt !== null) continue
      // GoTrue treats a token without session_id as a global logout.
      if (scope === "local" && sessionId && session.sessionId !== sessionId) continue
      session.endedAt = now
    }
    return record(204, sub, sessionId)
  }

  return idp
}

/** Create a fake identity provider and route this process's `fetch` for its URLs to it. */
export async function installFakeIdp(opts: FakeIdpOptions): Promise<FakeIdp> {
  const idp = await createFakeIdp(opts)
  const previous = globalThis.fetch
  const intercepted = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const answered = await idp.handle(request.clone())
    return answered ?? previous(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = intercepted
  idp.restore = () => {
    if (globalThis.fetch === intercepted) globalThis.fetch = previous
  }
  return idp
}

/**
 * Serve a fake identity provider on `http://127.0.0.1:<port>`, for a Core in
 * another process. The issuer is `http://127.0.0.1:<port>/auth/v1`, and the
 * Supabase project URL is `http://127.0.0.1:<port>`.
 */
export async function startFakeIdpServer(opts: Omit<FakeIdpOptions, "issuer" | "projectUrl" | "jwksUrl">): Promise<FakeIdp> {
  let handler: ((request: Request) => Promise<Response>) | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => (handler ? handler(request) : new Response("starting", {status: 503})),
  })
  const origin = `http://127.0.0.1:${server.port}`
  const idp = await createFakeIdp({...opts, issuer: `${origin}/auth/v1`, projectUrl: origin})
  handler = async request => (await idp.handle(request)) ?? new Response("not found", {status: 404})
  idp.restore = () => {
    server.stop(true)
  }
  return idp
}
