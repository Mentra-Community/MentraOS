/** Core-owned browser sign-in for incident admin and the enterprise portal. */
import {createHash} from "node:crypto"
import {WorkOS} from "@workos-inc/node"
import {Hono} from "hono"
import {getCookie, setCookie, deleteCookie} from "hono/cookie"
import {html} from "hono/html"
import {EncryptJWT, jwtDecrypt} from "jose"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {OauthServerError} from "../../types/oauth.types"

const AUTH_PATH = "/api/console/auth"
const TRANSACTION_COOKIE = "mentra_core_auth"
const SESSION_COOKIE = "mentra_console_session"
type Choice = {id: string; name: string}
type Transaction = {
  state: string
  codeVerifier: string
  returnTo: string
  origin: string
  selection?: {pendingAuthenticationToken: string; organizations: Choice[]}
}
export interface BrowserAuthProvider {
  authorize(redirectUri: string): Promise<{url: string; state: string; codeVerifier: string}>
  exchange(code: string, codeVerifier: string): Promise<{sealedSession?: string}>
  select(organizationId: string, pendingAuthenticationToken: string): Promise<{sealedSession?: string}>
  logout(sessionData: string, returnTo: string): Promise<string>
}

function provider(): BrowserAuthProvider {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD
  if (!apiKey || !clientId || !cookiePassword) throw new OauthServerError("Core WorkOS sign-in is not configured")
  const userManagement = new WorkOS(apiKey, {clientId}).userManagement
  const session = {sealSession: true, cookiePassword} as const
  return {
    authorize: (redirectUri) =>
      userManagement.getAuthorizationUrlWithPKCE({provider: "authkit", clientId, redirectUri}),
    exchange: (code, codeVerifier) => userManagement.authenticateWithCode({code, codeVerifier, clientId, session}),
    select: (organizationId, pendingAuthenticationToken) =>
      userManagement.authenticateWithOrganizationSelection({
        organizationId,
        pendingAuthenticationToken,
        clientId,
        session,
      }),
    logout: (sessionData, returnTo) =>
      userManagement.loadSealedSession({sessionData, cookiePassword}).getLogoutUrl({returnTo}),
  }
}

export function createBrowserAuthApp(getProvider: () => BrowserAuthProvider = provider) {
  const app = new Hono<AppEnv>()
  app.get("/login", async (c) => {
    const origin = requestOrigin(c)
    const returnTo = allowedReturnTo(c.req.query("return_to"), origin) ?? `${origin}/`
    const auth = await getProvider().authorize(`${origin}${AUTH_PATH}/callback`)
    await writeTransaction(c, {state: auth.state, codeVerifier: auth.codeVerifier, origin, returnTo})
    return c.redirect(auth.url)
  })
  app.get("/callback", async (c) => {
    const transaction = await readTransaction(c)
    const code = c.req.query("code")
    if (!transaction || !code || transaction.state !== c.req.query("state")) {
      deleteCookie(c, TRANSACTION_COOKIE, {path: AUTH_PATH})
      return c.json({error: "invalid_request", error_description: "Sign-in expired. Please sign in again."}, 400)
    }
    try {
      const result = await getProvider().exchange(code, transaction.codeVerifier)
      return complete(c, result.sealedSession, transaction)
    } catch (error) {
      const selection = organizationSelection(error)
      if (!selection) {
        deleteCookie(c, TRANSACTION_COOKIE, {path: AUTH_PATH})
        return c.json(
          {error: "sign_in_failed", error_description: "Sign-in could not be completed. Please try again."},
          401,
        )
      }
      await writeTransaction(c, {...transaction, selection})
      return c.redirect(`${AUTH_PATH}/organization`)
    }
  })
  app.get("/organization", async (c) => {
    const transaction = await readTransaction(c)
    if (!transaction?.selection) return c.redirect(`${AUTH_PATH}/login`)
    c.header("cache-control", "no-store")
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <meta name="viewport" content="width=device-width" /><title>Sign into Mentra</title>
          <body>
            <main>
              <h1>Choose your organization</h1>
              <form method="post" action="${AUTH_PATH}/organization">
                <input
                  type="hidden"
                  name="state"
                  value="${transaction.state}" />${transaction.selection.organizations.map(
                  (org) => html`<p><button name="organizationId" value="${org.id}">${org.name}</button></p>`,
                )}
              </form>
            </main>
          </body>
        </html>`,
    )
  })
  app.post("/organization", async (c) => {
    const transaction = await readTransaction(c)
    const form = await c.req.parseBody()
    const selection = transaction?.selection
    if (
      !transaction ||
      !selection ||
      form.state !== transaction.state ||
      typeof form.organizationId !== "string" ||
      !selection.organizations.some((org) => org.id === form.organizationId)
    ) {
      return c.json({error: "invalid_request"}, 400)
    }
    try {
      const result = await getProvider().select(form.organizationId, selection.pendingAuthenticationToken)
      return complete(c, result.sealedSession, transaction)
    } catch {
      deleteCookie(c, TRANSACTION_COOKIE, {path: AUTH_PATH})
      return c.json({error: "sign_in_failed", error_description: "Sign-in expired. Please sign in again."}, 401)
    }
  })
  app.post("/logout", async (c) => {
    const sessionData = getCookie(c, SESSION_COOKIE)
    deleteCookie(c, SESSION_COOKIE, {path: "/"})
    deleteCookie(c, TRANSACTION_COOKIE, {path: AUTH_PATH})
    const logoutUrl = sessionData ? await getProvider().logout(sessionData, `${requestOrigin(c)}/`) : null
    return c.json({ok: true, logoutUrl})
  })
  return app
}

function complete(c: AppContext, sealedSession: string | undefined, transaction: Transaction) {
  if (!sealedSession) throw new OauthServerError("WorkOS did not return a sealed session")
  deleteCookie(c, TRANSACTION_COOKIE, {path: AUTH_PATH})
  setCookie(c, SESSION_COOKIE, sealedSession, {
    path: "/",
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60,
  })
  return c.redirect(transaction.returnTo)
}
function secureCookies() {
  return process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true"
}
function allowedOrigins(): string[] {
  const defaults = secureCookies()
    ? ["https://admin.mentraglass.com"]
    : ["http://localhost:5174", "http://localhost:5175"]
  return [
    ...new Set(
      [process.env.ADMIN_URL, process.env.CLOUD_ADMIN_CONSOLE_URL, process.env.PORTAL_URL, ...defaults]
        .filter((url): url is string => Boolean(url))
        .map((url) => new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin),
    ),
  ]
}
function requestOrigin(c: AppContext): string {
  const allowed = allowedOrigins()
  const candidate = c.req.header("x-mentra-public-origin") ?? new URL(c.req.url).origin
  return allowed.includes(candidate) ? candidate : allowed[0]!
}
function allowedReturnTo(value: string | undefined, origin: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    // A cookie issued through one website must return to that same website.
    if (url.origin !== origin || url.username || url.password || !["http:", "https:"].includes(url.protocol))
      return null
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}
function transactionKey(): Uint8Array {
  const secret = process.env.WORKOS_COOKIE_PASSWORD
  if (!secret) throw new OauthServerError("WORKOS_COOKIE_PASSWORD is not configured")
  return createHash("sha256").update(secret).digest()
}
async function writeTransaction(c: AppContext, transaction: Transaction) {
  const value = await new EncryptJWT({...transaction})
    .setProtectedHeader({alg: "dir", enc: "A256GCM"})
    .setIssuer("mentra-core-browser-auth")
    .setAudience("mentra-core-browser-auth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(transactionKey())
  setCookie(c, TRANSACTION_COOKIE, value, {
    path: AUTH_PATH,
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    maxAge: 600,
  })
}
async function readTransaction(c: AppContext): Promise<Transaction | null> {
  const value = getCookie(c, TRANSACTION_COOKIE)
  if (!value) return null
  try {
    const {payload} = await jwtDecrypt(value, transactionKey(), {
      issuer: "mentra-core-browser-auth",
      audience: "mentra-core-browser-auth",
    })
    if (
      typeof payload.state !== "string" ||
      typeof payload.codeVerifier !== "string" ||
      typeof payload.origin !== "string" ||
      !allowedOrigins().includes(payload.origin) ||
      typeof payload.returnTo !== "string" ||
      !allowedReturnTo(payload.returnTo, payload.origin)
    )
      return null
    return payload as unknown as Transaction
  } catch {
    return null
  }
}
function organizationSelection(error: unknown): Transaction["selection"] | null {
  const value = error as {
    code?: string
    pendingAuthenticationToken?: string
    rawData?: {code?: string; error?: string; pending_authentication_token?: string; organizations?: unknown}
  }
  const code = value?.code ?? value?.rawData?.code ?? value?.rawData?.error
  const pendingAuthenticationToken = value?.pendingAuthenticationToken ?? value?.rawData?.pending_authentication_token
  if (
    code !== "organization_selection_required" ||
    !pendingAuthenticationToken ||
    !Array.isArray(value.rawData?.organizations)
  )
    return null
  const organizations = value.rawData.organizations.flatMap(
    (org: {id?: unknown; name?: unknown; organization_id?: unknown; organization_name?: unknown}) => {
      const id = org?.id ?? org?.organization_id
      const name = org?.name ?? org?.organization_name ?? id
      return typeof id === "string" && typeof name === "string" ? [{id, name}] : []
    },
  )
  return organizations.length ? {pendingAuthenticationToken, organizations} : null
}

export default createBrowserAuthApp()
