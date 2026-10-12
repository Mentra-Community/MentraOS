/**
 * @fileoverview The provider's own listener inside Core's process.
 *
 * `oidc-provider` is a Koa application and needs Node's `IncomingMessage` and
 * `ServerResponse` (Koa reads `req.socket`, so a Fetch-to-Node shim does not
 * work). Core serves HTTP with `Bun.serve`, so the provider runs on its own
 * `node:http` listener on 127.0.0.1 at an ephemeral port, and Core's Hono app
 * relays the provider's routes to it (`api/oidc/oidc.api.ts`).
 *
 * - The relay sets `Host` and `X-Forwarded-Proto` from `CLOUD_CORE_OIDC_ISSUER`
 *   and drops every forwarding header the client sent, so the provider builds
 *   its URLs and cookies for the issuer only.
 * - Each listener has a random secret; a request without it gets 404, so only
 *   Core's relay reaches the provider.
 * - The provider is built on first use and rebuilt when its settings (issuer,
 *   cookie keys, signing key) change, so a changed environment takes effect on
 *   the next request, as the rest of Core's sign-in configuration does.
 */

import {randomBytes} from "node:crypto"
import http from "node:http"
import type {AddressInfo} from "node:net"

import type Provider from "oidc-provider"

import {oidcCookieKeys, oidcIssuer} from "./config"
import {createOidcProvider} from "./provider"

export const BRIDGE_SECRET_HEADER = "x-mentra-oidc-bridge"

export interface OidcBridge {
  provider: Provider
  issuer: string
  /** `http://127.0.0.1:<port>` */
  origin: string
  secret: string
}

type ProviderExtension = (provider: Provider) => void
const extensions = new Set<ProviderExtension>()

/** Add middleware to every provider this bridge builds (the interaction routes). */
export function extendProvider(extension: ProviderExtension): void {
  extensions.add(extension)
}

let current: {fingerprint: string; bridge: Promise<OidcBridge>; server: Promise<http.Server>} | null = null

function settingsFingerprint(issuer: string): string {
  return JSON.stringify([issuer, oidcCookieKeys(), process.env.MENTRA_JWT_PRIVATE_KEY ?? ""])
}

async function start(issuer: string): Promise<{bridge: OidcBridge; server: http.Server}> {
  const provider = await createOidcProvider({issuer, cookieKeys: oidcCookieKeys()})
  for (const extension of extensions) extension(provider)
  const secret = randomBytes(32).toString("base64url")
  const callback = provider.callback()
  const server = http.createServer((req, res) => {
    if (req.headers[BRIDGE_SECRET_HEADER] !== secret) {
      res.statusCode = 404
      res.end()
      return
    }
    delete req.headers[BRIDGE_SECRET_HEADER]
    void callback(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const {port} = server.address() as AddressInfo
  return {bridge: {provider, issuer, origin: `http://127.0.0.1:${port}`, secret}, server}
}

/** The provider and its listener, or null when Core's sign-in server is off. */
export async function oidcBridge(): Promise<OidcBridge | null> {
  const issuer = oidcIssuer()
  if (!issuer) return null
  const fingerprint = settingsFingerprint(issuer)
  if (current?.fingerprint !== fingerprint) {
    const previous = current
    const started = start(issuer)
    current = {fingerprint, bridge: started.then(s => s.bridge), server: started.then(s => s.server)}
    // A failed start is retried on the next request.
    started.catch(() => {
      if (current?.fingerprint === fingerprint) current = null
    })
    if (previous) void closeServer(previous.server)
  }
  return current!.bridge
}

async function closeServer(server: Promise<http.Server>): Promise<void> {
  try {
    const listener = await server
    const closed = new Promise<void>(resolve => listener.close(() => resolve()))
    listener.closeAllConnections?.()
    // Never let a lingering connection hold Core's shutdown.
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2_000).unref?.())])
  } catch {
    // It never started.
  }
}

/** Stop the provider's listener (Core's shutdown, and tests). */
export async function stopOidcBridge(): Promise<void> {
  const previous = current
  current = null
  if (previous) await closeServer(previous.server)
}
