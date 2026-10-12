/**
 * @fileoverview Shared setup for the suites of Core's sign-in server.
 *
 * - `OIDC_ISSUER` is the sign-in site of the test environment. Core's app
 *   answers it in-process, as the sign-in site's relay does in production:
 *   `routeOriginsToApp` sends this process's `fetch` for those origins to
 *   `app.request`, so openid-client (as a relying party, or Core's own portal
 *   sign-in) reaches the provider exactly as it would over the network.
 * - `Browser` is a small cookie-keeping browser that follows the provider's
 *   redirects by hand.
 * - `finishInteraction` completes a provider interaction as a signed-in person
 *   through the provider's own Interaction model, for suites that test the
 *   provider without its sign-in steps.
 */

import crypto from "node:crypto"

import type {Hono} from "hono"

import {SigninIdentityModel} from "../../packages/core/src/models/signin-identity.model"
import {oidcBridge} from "../../packages/core/src/services/oidc/bridge"
import {CORE_API_RESOURCE} from "../../packages/core/src/services/oidc/config"
import {findOrCreateUser} from "../../packages/core/src/services/user.service"

export const OIDC_ISSUER = "https://account.test"
export const ADMIN_ORIGIN = "https://admin.test"
export const PORTAL_ORIGIN = "https://portal.test"
export const CONSOLE_ORIGIN = "https://console.test"
export const ADMIN_CALLBACK = `${ADMIN_ORIGIN}/api/admin/auth/callback`
export const PORTAL_CALLBACK = `${PORTAL_ORIGIN}/api/portal/auth/callback`
export const CONSOLE_CALLBACK = `${CONSOLE_ORIGIN}/api/console/auth/callback`
export const CLI_CALLBACK = "http://127.0.0.1:53682/callback"

export const CLIENT_SECRETS = {
  CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: "admin-portal-secret-0123456789abcdef0123",
  CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET: "workspace-portal-secret-0123456789abcdef",
  CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: "console-secret-0123456789abcdef0123456789",
}

export const CLIENTS = [
  {clientId: "admin-portal", kind: "admin_portal", secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET", redirectUris: [ADMIN_CALLBACK]},
  {clientId: "workspace-portal", kind: "workspace_portal", secretEnv: "CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET", redirectUris: [PORTAL_CALLBACK]},
  {clientId: "console", kind: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUris: [CONSOLE_CALLBACK]},
  {clientId: "mentra-cli", kind: "cli", redirectUris: [CLI_CALLBACK]},
]

function pemBody(key: crypto.KeyObject, type: "pkcs8" | "spki"): string {
  return key
    .export({type, format: "pem"})
    .toString()
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "")
}

/** Fresh Ed25519 key pairs for Core's access, miniapp and account keys. */
export function coreKeyEnv(): Record<string, string> {
  const access = crypto.generateKeyPairSync("ed25519")
  const miniapp = crypto.generateKeyPairSync("ed25519")
  const account = crypto.generateKeyPairSync("ed25519")
  return {
    MENTRA_JWT_PRIVATE_KEY: pemBody(access.privateKey, "pkcs8"),
    MENTRA_JWT_PUBLIC_KEY: pemBody(access.publicKey, "spki"),
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: pemBody(miniapp.privateKey, "pkcs8"),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: pemBody(miniapp.publicKey, "spki"),
    MENTRA_ACCOUNT_JWT_PRIVATE_KEY: pemBody(account.privateKey, "pkcs8"),
    MENTRA_ACCOUNT_JWT_PUBLIC_KEY: pemBody(account.publicKey, "spki"),
  }
}

/** The environment of a Core whose sign-in server runs at `OIDC_ISSUER` with the four first-party clients. */
export function providerEnv(overrides: {clients?: unknown[]} = {}): Record<string, string | undefined> {
  return {
    CLOUD_CORE_ISSUER: "cloud-core",
    CLOUD_CORE_OIDC_ISSUER: OIDC_ISSUER,
    CLOUD_CORE_OIDC_COOKIE_KEYS: "oidc-cookie-key-0123456789abcdef0123456789",
    CLOUD_CORE_OIDC_CLIENTS: JSON.stringify(overrides.clients ?? CLIENTS),
    ...CLIENT_SECRETS,
  }
}

/**
 * Route this process's `fetch` for `origins` to Core's app (the sign-in
 * site's relay, in-process). Returns a function that restores `fetch`.
 */
export function routeOriginsToApp(app: Hono<any>, origins: string[]): () => void {
  const previous = globalThis.fetch
  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (origins.includes(new URL(request.url).origin)) return app.request(request)
    return previous(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = routed
  return () => {
    if (globalThis.fetch === routed) globalThis.fetch = previous
  }
}

interface StoredCookie {
  value: string
  path: string
  secure: boolean
}

type Send = (url: string, init: RequestInit) => Promise<Response>

/**
 * A browser for one person: a cookie jar per origin and manual redirects.
 * Requests go to Core's app in-process, or through `send` (for a Core in
 * another process).
 */
export class Browser {
  readonly jar = new Map<string, Map<string, StoredCookie>>()
  private readonly send: Send

  constructor(target: Hono<any> | Send) {
    this.send = typeof target === "function" ? target : (url, init) => target.request(url, init)
  }

  cookies(origin: string): Map<string, StoredCookie> {
    let cookies = this.jar.get(origin)
    if (!cookies) {
      cookies = new Map()
      this.jar.set(origin, cookies)
    }
    return cookies
  }

  /** The latest full `Set-Cookie` line seen for each cookie name. */
  readonly setCookieLines = new Map<string, string>()

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url)
    const cookies = [...this.cookies(target.origin)]
      .filter(([, cookie]) => target.pathname.startsWith(cookie.path) && (!cookie.secure || target.protocol === "https:"))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ")
    const headers = new Headers(init.headers)
    if (cookies) headers.set("cookie", cookies)
    const response = await this.send(target.href, {...init, headers, redirect: "manual"})
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map(part => part.trim())
      const name = pair!.slice(0, pair!.indexOf("="))
      const value = pair!.slice(pair!.indexOf("=") + 1)
      this.setCookieLines.set(name, line)
      const path = attributes.find(attribute => /^path=/i.test(attribute))?.slice(5) ?? "/"
      const expired = attributes.some(attribute => /^max-age=0$/i.test(attribute) || /^expires=thu, 01 jan 1970/i.test(attribute))
      if (!value || expired) this.cookies(target.origin).delete(name)
      else this.cookies(target.origin).set(name, {value, path, secure: attributes.some(attribute => /^secure$/i.test(attribute))})
    }
    return response
  }

  /** Follow redirects from `url` until one leaves for `stopAt` (returned) or a page answers (returned as a Response). */
  async follow(url: string, stopAt: (location: URL) => boolean, maxHops = 10): Promise<{stoppedAt: URL} | {page: Response; url: URL}> {
    let current = new URL(url)
    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(current)
      const location = response.headers.get("location")
      if (!location || response.status < 300 || response.status >= 400) return {page: response, url: current}
      const next = new URL(location, current)
      if (stopAt(next)) return {stoppedAt: next}
      current = next
    }
    throw new Error("too many redirects")
  }
}

/** A Core user and their sign-in identity, as a provider sign-in records it. */
export async function signedInPerson(opts: {
  tenantId?: string
  sourceId?: string
  subject: string
  email?: string | null
  emailVerified?: boolean
  name?: string | null
  signedInAt?: Date
}): Promise<{mentraUserId: string}> {
  const tenantId = opts.tenantId ?? "mentra"
  const user = await findOrCreateUser({tenantId, tenantUserId: opts.subject})
  await SigninIdentityModel.updateOne(
    {mentraUserId: user.mentraUserId},
    {
      $set: {
        tenantId,
        sourceId: opts.sourceId ?? "mentra",
        subject: opts.subject,
        email: opts.email ?? null,
        emailVerified: opts.emailVerified ?? false,
        name: opts.name ?? null,
        signedInAt: opts.signedInAt ?? new Date(),
      },
    },
    {upsert: true},
  )
  return {mentraUserId: user.mentraUserId}
}

/**
 * Finish the provider interaction at `interactionUrl` as `accountId` (and,
 * unless `consent: false`, with a grant for the requested scopes), as a
 * completed sign-in step would. Returns the provider's continuation URL.
 */
export async function finishInteraction(
  interactionUrl: URL,
  accountId: string,
  opts: {consent?: boolean; authTime?: number} = {},
): Promise<URL> {
  const bridge = await oidcBridge()
  if (!bridge) throw new Error("the provider is off")
  const uid = interactionUrl.pathname.split("/")[2]!
  const interaction = await bridge.provider.Interaction.find(uid)
  if (!interaction) throw new Error("no such interaction")
  const result: Record<string, unknown> = {login: {accountId, ...(opts.authTime ? {ts: opts.authTime} : {})}}
  if (opts.consent !== false) {
    const grant = new bridge.provider.Grant({accountId, clientId: interaction.params.client_id as string})
    grant.addOIDCScope("openid email profile")
    grant.addResourceScope(CORE_API_RESOURCE, "openid email profile")
    result.consent = {grantId: await grant.save()}
  }
  interaction.result = result
  await interaction.save(interaction.exp - Math.floor(Date.now() / 1000))
  return new URL(interaction.returnTo, OIDC_ISSUER)
}
