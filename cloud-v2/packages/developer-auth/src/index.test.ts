import {afterEach, beforeAll, beforeEach, expect, spyOn, test} from "bun:test"
import {WorkOS} from "@workos-inc/node"
import {Hono} from "hono"
import {exportJWK, generateKeyPair, SignJWT} from "jose"
import {
  authenticateWorkosAccessToken,
  authenticateWorkosRequest,
  type DeveloperAuthOptions,
  type DeveloperAuthResult,
  UNKNOWN_EMAIL,
} from "./index"

const clientId = "client_developer_auth_test"
const options: DeveloperAuthOptions = {
  apiKey: "sk_test_developer_auth",
  clientId,
  cookiePassword: "developer-auth-cookie-password-at-least-32-characters",
}
const cookieName = "mentra_console_session"
const userId = "user_01DEVAUTH"

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwks: {keys: unknown[]}
let network: ReturnType<typeof spyOn>
let emailVerified = true
let profileFails = false
let nextGrantToken = ""
/** JWKS requests the network stub has served, by path. */
let jwksFetches = new Map<string, number>()

function userPayload() {
  return {
    object: "user",
    id: userId,
    email: "dev@example.test",
    email_verified: emailVerified,
    first_name: "Dev",
    last_name: "One",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

async function token(expiration: string, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({sid: "session_1", org_id: "org_1", ...claims})
    .setProtectedHeader({alg: "RS256", kid: "developer-auth-test"})
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(privateKey)
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256")
  privateKey = pair.privateKey
  jwks = {keys: [{...(await exportJWK(pair.publicKey)), kid: "developer-auth-test", alg: "RS256", use: "sig"}]}
})

beforeEach(() => {
  emailVerified = true
  profileFails = false
  nextGrantToken = ""
  jwksFetches = new Map()
  network = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== "https://api.workos.com") throw new Error(`Unexpected network request: ${url}`)
    if (url.pathname.startsWith("/sso/jwks/")) {
      jwksFetches.set(url.pathname, (jwksFetches.get(url.pathname) ?? 0) + 1)
      return Response.json(jwks)
    }
    if (url.pathname === `/user_management/users/${userId}`) {
      if (profileFails) return Response.json({message: "unavailable"}, {status: 503})
      return Response.json(userPayload())
    }
    if (url.pathname === "/user_management/authenticate") {
      return Response.json({
        user: userPayload(),
        organization_id: "org_1",
        authentication_method: "Password",
        access_token: nextGrantToken,
        refresh_token: "refresh_1",
      })
    }
    throw new Error(`Unexpected WorkOS request: ${url}`)
  }) as typeof fetch)
})

afterEach(() => {
  network?.mockRestore()
})

async function authenticate(
  headers: Record<string, string>,
): Promise<{result: DeveloperAuthResult; response: Response}> {
  let result!: DeveloperAuthResult
  const app = new Hono()
  app.get("/", async c => {
    result = await authenticateWorkosRequest(c, options)
    return c.json({ok: true})
  })
  const response = await app.request("/", {headers})
  return {result, response}
}

/** A real sealed WorkOS session cookie holding `accessToken`. */
async function sealedSession(accessToken: string): Promise<string> {
  nextGrantToken = accessToken
  const workos = new WorkOS(options.apiKey, {clientId})
  const response = await workos.userManagement.authenticateWithCode({
    clientId,
    code: "code_1",
    session: {sealSession: true, cookiePassword: options.cookiePassword},
  })
  return response.sealedSession!
}

test("bearer path returns the bearer token and WorkOS's emailVerified", async () => {
  const bearer = await token("10m")

  const {result} = await authenticate({authorization: `Bearer ${bearer}`})

  expect(result).toMatchObject({
    authenticated: true,
    accessToken: bearer,
    user: {id: userId, email: "dev@example.test", emailVerified: true, firstName: "Dev", lastName: "One"},
    organizationId: "org_1",
  })
})

test("bearer path reports an unverified email as unverified", async () => {
  emailVerified = false
  const bearer = await token("10m")

  const {result} = await authenticate({authorization: `Bearer ${bearer}`})

  expect(result).toMatchObject({authenticated: true, accessToken: bearer, user: {emailVerified: false}})
})

test("bearer path never claims a verified email when the profile lookup is unavailable", async () => {
  profileFails = true
  const bearer = await token("10m", {email: "claim@example.test"})

  const {result} = await authenticate({authorization: `Bearer ${bearer}`})

  expect(result).toMatchObject({
    authenticated: true,
    accessToken: bearer,
    user: {id: userId, email: "claim@example.test", emailVerified: false},
  })
})

test("bearer path rejects a token the identity provider did not sign", async () => {
  const {privateKey: stranger} = await generateKeyPair("RS256")
  const forged = await new SignJWT({})
    .setProtectedHeader({alg: "RS256", kid: "developer-auth-test"})
    .setSubject(userId)
    .setExpirationTime("10m")
    .sign(stranger)

  const {result} = await authenticate({authorization: `Bearer ${forged}`})

  expect(result).toEqual({authenticated: false, reason: "invalid_bearer_token"})
})

test("sealed-session path returns the session's access token and user.emailVerified", async () => {
  const accessToken = await token("10m")
  const cookie = await sealedSession(accessToken)

  const {result} = await authenticate({cookie: `${cookieName}=${cookie}`})

  expect(result).toMatchObject({
    authenticated: true,
    accessToken,
    user: {id: userId, email: "dev@example.test", emailVerified: true},
    organizationId: "org_1",
  })
})

test("sealed-session path reports an unverified email as unverified", async () => {
  emailVerified = false
  const cookie = await sealedSession(await token("10m"))

  const {result} = await authenticate({cookie: `${cookieName}=${cookie}`})

  expect(result).toMatchObject({authenticated: true, user: {emailVerified: false}})
})

test("sealed-session path returns the refreshed access token after the old one expired", async () => {
  const expired = await token("-1m")
  const cookie = await sealedSession(expired)
  const refreshed = await token("10m")
  nextGrantToken = refreshed

  const {result, response} = await authenticate({cookie: `${cookieName}=${cookie}`})

  expect(result).toMatchObject({
    authenticated: true,
    accessToken: refreshed,
    user: {id: userId, emailVerified: true},
  })
  expect(response.headers.getSetCookie().some(value => value.startsWith(`${cookieName}=`))).toBe(true)
})

test("refresh path takes the user from the fresh session, not the sealed snapshot", async () => {
  // The sealed cookie holds a verified user; WorkOS now reports the email as unverified.
  const cookie = await sealedSession(await token("-1m"))
  emailVerified = false
  const refreshed = await token("10m")
  nextGrantToken = refreshed

  const {result} = await authenticate({cookie: `${cookieName}=${cookie}`})

  expect(result).toMatchObject({authenticated: true, accessToken: refreshed, user: {id: userId, emailVerified: false}})
})

test("no credentials is unauthenticated", async () => {
  const {result} = await authenticate({})
  expect(result).toEqual({authenticated: false, reason: "no_session_cookie_provided"})
})

test("a raw access token authenticates with no request context, like the bearer path", async () => {
  const bearer = await token("10m")

  const result = await authenticateWorkosAccessToken(bearer, options)

  expect(result).toMatchObject({
    authenticated: true,
    accessToken: bearer,
    user: {id: userId, email: "dev@example.test", emailVerified: true, firstName: "Dev", lastName: "One"},
    organizationId: "org_1",
  })
})

test("a raw access token keeps the email unverified when the profile lookup is unavailable", async () => {
  profileFails = true
  const bearer = await token("10m", {email: "claim@example.test"})

  const result = await authenticateWorkosAccessToken(bearer, options)

  expect(result).toMatchObject({authenticated: true, user: {email: "claim@example.test", emailVerified: false}})
})

test("a raw access token the identity provider did not sign is rejected", async () => {
  const {privateKey: stranger} = await generateKeyPair("RS256")
  const forged = await new SignJWT({})
    .setProtectedHeader({alg: "RS256", kid: "developer-auth-test"})
    .setSubject(userId)
    .setExpirationTime("10m")
    .sign(stranger)

  expect(await authenticateWorkosAccessToken(forged, options)).toEqual({
    authenticated: false,
    reason: "invalid_bearer_token",
  })
  expect(await authenticateWorkosAccessToken("not-a-jwt", options)).toEqual({
    authenticated: false,
    reason: "invalid_bearer_token",
  })
})

test("a raw access token reports an unavailable profile lookup, so unknown is not mistaken for unverified", async () => {
  profileFails = true
  const bearer = await token("10m", {email: "claim@example.test"})

  const result = await authenticateWorkosAccessToken(bearer, options)

  expect(result).toMatchObject({authenticated: true, profileUnavailable: true, user: {emailVerified: false}})
})

test("a successful profile lookup does not flag the profile unavailable", async () => {
  const bearer = await token("10m")

  const viaToken = await authenticateWorkosAccessToken(bearer, options)
  const {result: viaRequest} = await authenticate({authorization: `Bearer ${bearer}`})
  emailVerified = false
  const unverified = await authenticateWorkosAccessToken(bearer, options)

  for (const result of [viaToken, viaRequest, unverified]) {
    expect(result).toMatchObject({authenticated: true})
    expect((result as {profileUnavailable?: boolean}).profileUnavailable).toBeUndefined()
  }
})

test("an unavailable profile lookup is reported on the bearer path of a request too", async () => {
  profileFails = true
  const bearer = await token("10m")

  const {result} = await authenticate({authorization: `Bearer ${bearer}`})

  expect(result).toMatchObject({authenticated: true, profileUnavailable: true})
})

test("a token with no email claim and no profile email reports the UNKNOWN_EMAIL placeholder", async () => {
  profileFails = true
  const bearer = await token("10m")

  const result = await authenticateWorkosAccessToken(bearer, options)

  expect(result).toMatchObject({authenticated: true, user: {email: UNKNOWN_EMAIL}})
})

test("the JWKS is fetched once per client id and reused across verifications", async () => {
  const a: DeveloperAuthOptions = {...options, clientId: "client_jwks_reuse_a"}
  const b: DeveloperAuthOptions = {...options, clientId: "client_jwks_reuse_b"}

  expect(await authenticateWorkosAccessToken(await token("10m"), a)).toMatchObject({authenticated: true})
  expect(await authenticateWorkosAccessToken(await token("10m"), a)).toMatchObject({authenticated: true})
  expect(jwksFetches.get("/sso/jwks/client_jwks_reuse_a")).toBe(1)

  // Another client id is another key set, with its own fetcher.
  expect(await authenticateWorkosAccessToken(await token("10m"), b)).toMatchObject({authenticated: true})
  expect(jwksFetches.get("/sso/jwks/client_jwks_reuse_b")).toBe(1)
  expect(jwksFetches.get("/sso/jwks/client_jwks_reuse_a")).toBe(1)
})
