import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"
import {exportJWK, generateKeyPair, SignJWT} from "jose"
import {createApp} from "../app"

const names = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "ADMIN_URL",
  "CLOUD_CORE_ADMIN_EMAILS",
  "NODE_ENV",
] as const
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const clientId = "client_cookie_contract"
const origin = "https://admin.contract.test"
const user = {
  object: "user",
  id: "user_cookie_contract",
  email: "admin@contract.test",
  email_verified: true,
  first_name: "Test",
  last_name: "Admin",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
let network: ReturnType<typeof spyOn>
let initialToken: string
let validToken: string
let refreshRejected = false
const grants: Array<Record<string, unknown>> = []
let jwksRequests: string[] = []

beforeEach(async () => {
  process.env.WORKOS_API_KEY = "sk_test_cookie_contract"
  process.env.WORKOS_CLIENT_ID = clientId
  process.env.WORKOS_COOKIE_PASSWORD = "cookie-contract-password-at-least-32-characters"
  process.env.ADMIN_URL = origin
  process.env.CLOUD_CORE_ADMIN_EMAILS = user.email
  process.env.NODE_ENV = "production"
  grants.length = 0
  jwksRequests = []
  refreshRejected = false
  const {privateKey, publicKey} = await generateKeyPair("RS256")
  const key = {...(await exportJWK(publicKey)), kid: "cookie-contract", alg: "RS256", use: "sig"}
  const token = (expiration: string) =>
    new SignJWT({sid: "session_contract", org_id: "org_contract"})
      .setProtectedHeader({alg: "RS256", kid: key.kid})
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(privateKey)
  validToken = await token("10m")
  initialToken = validToken
  const expiredToken = await token("-1m")
  network = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== "https://api.workos.com") throw new Error(`Unexpected network request: ${url}`)
    if (url.pathname === `/sso/jwks/${clientId}`) {
      jwksRequests.push(url.toString())
      return Response.json({keys: [key]})
    }
    if (url.pathname === "/user_management/authenticate") {
      const grant = JSON.parse(String(init?.body)) as Record<string, unknown>
      grants.push(grant)
      if (grant.grant_type === "refresh_token" && refreshRejected)
        return Response.json({error: "invalid_grant", error_description: "Session revoked"}, {status: 400})
      return Response.json({
        user,
        organization_id: "org_contract",
        authentication_method: "SSO",
        access_token:
          grant.grant_type === "refresh_token"
            ? validToken
            : grant.code === "expired-code"
              ? expiredToken
              : initialToken,
        refresh_token: "refresh-contract",
      })
    }
    throw new Error(`Unexpected WorkOS request: ${url}`)
  }) as typeof fetch)
})
afterEach(() => {
  network?.mockRestore()
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})
function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))
  expect(value).toBeDefined()
  return value!.split(";")[0]!
}
async function signedInCore(code = "valid-code") {
  const app = createApp({readinessChecks: []})
  const headers = {"x-mentra-public-origin": origin}
  const login = await app.request(
    `/api/console/auth/login?return_to=${encodeURIComponent(`${origin}/?report=rep_contract`)}`,
    {headers},
  )
  expect(login.status).toBe(302)
  const authorization = new URL(login.headers.get("location")!)
  const callback = await app.request(
    `/api/console/auth/callback?code=${code}&state=${authorization.searchParams.get("state")}`,
    {headers: {...headers, cookie: cookie(login, "mentra_core_auth")}},
  )
  expect(callback.status).toBe(302)
  expect(callback.headers.get("location")).toBe(`${origin}/?report=rep_contract`)
  return {app, session: cookie(callback, "mentra_console_session")}
}

test("Core's actual WorkOS callback cookie authenticates /me through the shared adapter", async () => {
  const {app, session} = await signedInCore()
  const response = await app.request("/api/admin/me", {headers: {cookie: session}})
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({authenticated: true, admin: true, user: {email: user.email}})
  expect(jwksRequests).toEqual([`https://api.workos.com/sso/jwks/${clientId}`])
})
test("expired cookie tokens refresh using the configured client ID and rotate the cookie", async () => {
  const {app, session} = await signedInCore("expired-code")
  const response = await app.request("/api/admin/me", {headers: {cookie: session}})
  expect(response.status).toBe(200)
  expect(grants.find((grant) => grant.grant_type === "refresh_token")).toMatchObject({
    client_id: clientId,
    refresh_token: "refresh-contract",
  })
  const replacement = cookie(response, "mentra_console_session")
  expect(replacement).not.toBe(session)
  expect((await app.request("/api/admin/me", {headers: {cookie: replacement}})).status).toBe(200)
})
test("revoked refresh credentials clear the browser cookie and deny admin access", async () => {
  const {app, session} = await signedInCore("expired-code")
  refreshRejected = true
  const response = await app.request("/api/admin/me", {headers: {cookie: session}})
  expect(response.status).toBe(401)
  expect(
    response.headers
      .getSetCookie()
      .some((value) => value.startsWith("mentra_console_session=") && value.includes("Max-Age=0")),
  ).toBe(true)
})
