import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import {createBrowserAuthApp, type BrowserAuthProvider} from "./browser-auth.api"
import {createApp} from "../app"

const authPath = "/api/console/auth"
const saved = {...process.env}
let exchange = mock(
  async (_code: string, _verifier: string): Promise<{sealedSession?: string}> => ({
    sealedSession: "sealed-test-session",
  }),
)
let select = mock(async (_organization: string, _pending: string) => ({sealedSession: "selected-test-session"}))
let logout = mock(async (_session: string, _returnTo: string) => "https://api.workos.com/logout/test")
const authorization = mock(async (_redirectUri: string) => ({
  url: "https://api.workos.com/authorize",
  state: "random-state",
  codeVerifier: "random-verifier",
}))
const provider: BrowserAuthProvider = {
  authorize: authorization,
  exchange: (...args) => exchange(...args),
  select: (...args) => select(...args),
  logout: (...args) => logout(...args),
}
const app = createBrowserAuthApp(() => provider)

beforeEach(() => {
  process.env.WORKOS_COOKIE_PASSWORD = "test-password-at-least-thirty-two-characters"
  process.env.ADMIN_URL = "https://admin.test.example"
  process.env.PORTAL_URL = "https://portal.test.example"
  process.env.NODE_ENV = "production"
  exchange = mock(async () => ({sealedSession: "sealed-test-session"}))
  select = mock(async () => ({sealedSession: "selected-test-session"}))
  logout = mock(async () => "https://api.workos.com/logout/test")
  authorization.mockClear()
})
afterEach(() => {
  for (const name of ["WORKOS_COOKIE_PASSWORD", "ADMIN_URL", "PORTAL_URL", "NODE_ENV"]) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})
function headers(cookie?: string) {
  return {"x-mentra-public-origin": "https://admin.test.example", ...(cookie ? {cookie} : {})}
}
function transactionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("mentra_core_auth="))!
    .split(";")[0]!
}
async function login(returnTo = "https://admin.test.example/?report=rep_test") {
  return app.request(`/login?return_to=${encodeURIComponent(returnTo)}`, {headers: headers()})
}

describe("Core browser sign-in without Store", () => {
  test("mounts login and logout on Core's existing browser API paths", async () => {
    const core = createApp({readinessChecks: []})
    const response = await core.request(`${authPath}/logout`, {method: "POST"})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ok: true, logoutUrl: null})
  })
  test("preserves incident deep links through PKCE login and sets the Core session", async () => {
    const started = await login()
    expect(authorization).toHaveBeenCalledWith("https://admin.test.example/api/console/auth/callback")
    const cookie = transactionCookie(started)
    expect(cookie).not.toContain("random-verifier")
    const response = await app.request("/callback?code=code&state=random-state", {headers: headers(cookie)})
    expect(exchange).toHaveBeenCalledWith("code", "random-verifier")
    expect(response.headers.get("location")).toBe("https://admin.test.example/?report=rep_test")
    expect(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("mentra_console_session=sealed-test-session;") &&
            value.includes("HttpOnly") &&
            value.includes("Secure"),
        ),
    ).toBe(true)
  })
  test("rejects missing, tampered, or mismatched state without exchanging a code", async () => {
    const cookie = transactionCookie(await login())
    for (const [sent, state] of [
      [undefined, "random-state"],
      [`${cookie}tampered`, "random-state"],
      [cookie, "wrong-state"],
    ]) {
      const response = await app.request(`/callback?code=code&state=${state}`, {headers: headers(sent)})
      expect(response.status).toBe(400)
    }
    expect(exchange).not.toHaveBeenCalled()
  })
  test("rejects off-site return URLs and ignores untrusted proxy origins", async () => {
    const cookie = transactionCookie(await login("https://attacker.example"))
    const response = await app.request("/callback?code=code&state=random-state", {headers: headers(cookie)})
    expect(response.headers.get("location")).toBe("https://admin.test.example/")
    await app.request("/login", {headers: {"x-mentra-public-origin": "https://attacker.example"}})
    expect(authorization.mock.calls.at(-1)).toEqual(["https://admin.test.example/api/console/auth/callback"])
  })
  test("supports WorkOS organization selection with authenticated choices and CSRF state", async () => {
    exchange.mockRejectedValueOnce({
      code: "organization_selection_required",
      pendingAuthenticationToken: "pending-test-token",
      rawData: {organizations: [{id: "org_internal", name: "Mentra"}]},
    })
    const started = await login()
    const callback = await app.request("/callback?code=code&state=random-state", {
      headers: headers(transactionCookie(started)),
    })
    expect(callback.headers.get("location")).toBe(`${authPath}/organization`)
    const cookie = transactionCookie(callback)
    const denied = await app.request("/organization", {
      method: "POST",
      headers: {...headers(cookie), "content-type": "application/x-www-form-urlencoded"},
      body: "organizationId=org_internal&state=wrong",
    })
    expect(denied.status).toBe(400)
    const wrongOrganization = await app.request("/organization", {
      method: "POST",
      headers: {...headers(cookie), "content-type": "application/x-www-form-urlencoded"},
      body: "organizationId=org_attacker&state=random-state",
    })
    expect(wrongOrganization.status).toBe(400)
    expect(select).not.toHaveBeenCalled()
    const response = await app.request("/organization", {
      method: "POST",
      headers: {...headers(cookie), "content-type": "application/x-www-form-urlencoded"},
      body: "organizationId=org_internal&state=random-state",
    })
    expect(select).toHaveBeenCalledWith("org_internal", "pending-test-token")
    expect(response.headers.get("location")).toBe("https://admin.test.example/?report=rep_test")
  })
  test("keeps the enterprise portal callback and return URL on the portal origin", async () => {
    const origin = "https://portal.test.example"
    const started = await app.request(`/login?return_to=${encodeURIComponent(`${origin}/?page=access`)}`, {
      headers: {"x-mentra-public-origin": origin},
    })
    expect(authorization).toHaveBeenCalledWith(`${origin}${authPath}/callback`)
    const response = await app.request("/callback?code=code&state=random-state", {
      headers: {"cookie": transactionCookie(started), "x-mentra-public-origin": origin},
    })
    expect(response.headers.get("location")).toBe(`${origin}/?page=access`)
  })
  test("clears the Core cookie and returns the hosted session logout URL", async () => {
    const response = await app.request("/logout", {
      method: "POST",
      headers: headers("mentra_console_session=sealed-test-session"),
    })
    expect(logout).toHaveBeenCalledWith("sealed-test-session", "https://admin.test.example/")
    expect(await response.json()).toEqual({ok: true, logoutUrl: "https://api.workos.com/logout/test"})
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("mentra_console_session=") && value.includes("Max-Age=0")),
    ).toBe(true)
  })
})
