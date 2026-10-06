/**
 * @fileoverview Core's seam to the optional Fleet integration.
 *
 * Fleet is a separately deployed service. Core stores none of its data: it authenticates the caller,
 * then forwards the request to Fleet and relays the answer. With no Fleet configured the routes
 * answer 404 and `GET /api/client/capabilities` says so, so a client can hide Fleet features.
 *
 *   /api/client/fleet/<rest>  ->  ${CLOUD_CORE_FLEET_URL}/v1/client/<rest>   (a signed-in phone)
 *   /api/admin/fleet/<rest>   ->  ${CLOUD_CORE_FLEET_URL}/v1/admin/<rest>    (any admin-surface principal)
 *
 * The admin forwarder needs a principal and no organization capability: a workspace admin who is not
 * an Organization Admin must reach it, and Fleet decides what that caller may do (through Core's
 * internal workspace API).
 *
 * Configuration (read on use, so a changed value takes effect on the next request):
 *  - `CLOUD_CORE_FLEET_URL`: Fleet's base URL, with an optional path prefix. Unset or blank means
 *    Fleet is not installed. It must be `https`; in production (`NODE_ENV=production`) plain `http`
 *    is accepted only for `localhost` and `127.0.0.1`. No credentials, query or fragment.
 *  - `CLOUD_CORE_FLEET_SECRET`: the shared secret that signs what Core sends. Required when the URL
 *    is set.
 *  - `CLOUD_CORE_FLEET_MAX_BODY_BYTES` (default 1048576) and `CLOUD_CORE_FLEET_TIMEOUT_MS` (default
 *    10000): the largest request body Core reads, and how long the upstream answer, body included,
 *    may take. A value that is not a positive integer falls back to the default.
 *
 * Outcomes:
 *  - not installed: 404 `{error: "fleet_not_installed"}`;
 *  - the URL is set but unusable or the secret is missing: 503 `{error: "fleet_unavailable"}` and an
 *    error log that names the variable (never its value);
 *  - a network error, a timeout, an upstream 5xx or any upstream 3xx (redirects are never followed):
 *    503 `{error: "fleet_unavailable"}`. Never an empty success;
 *  - a body over the limit: 413 `{error: "payload_too_large"}`; a body that is not valid UTF-8: 400
 *    `{error: "invalid_body"}`; a path with a `.` / `..` segment, an encoded or literal separator
 *    (`%2f`, `%5c`, `\`), a control character or a bad escape: 400 `{error: "invalid_path"}`;
 *  - any other upstream status and body pass through, with `content-type` and `cache-control` only.
 *
 * What Fleet receives. Core copies the method, the query, the body and the `content-type` and
 * `accept` headers. Every other inbound header is dropped, so nothing the caller sent under
 * `x-mentra-*`, `authorization` or `cookie` reaches Fleet. Core then adds, with `<ts>` the request
 * time in milliseconds:
 *
 *  - `x-mentra-service: core`, `x-mentra-service-timestamp: <ts>` and `x-mentra-service-signature`:
 *    `signServiceRequest` from `@mentra/workspace-contract/server` over `<ts>`, the method, the
 *    upstream path with its query (as sent, prefix included) and the body. Verify it with
 *    `verifyServiceRequest`;
 *  - `x-mentra-organization-id`: this Core's organization id;
 *  - `x-mentra-principal`: who is calling, as base64url JSON, one of
 *      `{kind: "phone", mentraUserId, tenantId, sessionId}`,
 *      `{kind: "user", mentraUserId, email, isOrganizationAdmin}` or
 *      `{kind: "credential", credentialId, credentialKind, workspaceId, scopes}`;
 *  - `x-mentra-principal-signature`: base64url HMAC-SHA256, keyed with the same secret, of
 *    `<ts>\n<x-mentra-organization-id value>\n<x-mentra-principal value>`, using the same `<ts>`.
 *
 * The service signature does not cover the two identity headers, so without the principal signature
 * anyone who captured one signed request could replay it with another identity inside the skew
 * window. Fleet must verify both signatures before it trusts either header. The two signed strings
 * cannot be mistaken for each other: the service one has three newlines, this one has two, and
 * neither a header value nor a path can contain a newline.
 *
 * Request bodies are treated as UTF-8 text (the Fleet API is JSON): the signature covers the text
 * and the same bytes are sent.
 */

import {createHmac} from "node:crypto"
import {createLogger} from "@mentra/cloud-shared"
import {SERVICE_HEADERS, signServiceRequest} from "@mentra/workspace-contract/server"
import {Hono, type Handler, type MiddlewareHandler} from "hono"
import {bodyLimit} from "hono/body-limit"
import {organizationId} from "../../services/workspaces/organization"
import type {AppContext, AppEnv} from "../../types/hono.types"

const logger = createLogger("core").child({service: "fleet-forwarding"})

/** Headers Core adds beyond `SERVICE_HEADERS`, for the Fleet service to read and verify. */
export const FLEET_HEADERS = {
  organizationId: "x-mentra-organization-id",
  principal: "x-mentra-principal",
  principalSignature: "x-mentra-principal-signature",
} as const

const URL_VARIABLE = "CLOUD_CORE_FLEET_URL"
const SECRET_VARIABLE = "CLOUD_CORE_FLEET_SECRET"
const MAX_BODY_VARIABLE = "CLOUD_CORE_FLEET_MAX_BODY_BYTES"
const TIMEOUT_VARIABLE = "CLOUD_CORE_FLEET_TIMEOUT_MS"

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

/** The only hosts that may use plain `http` in production. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"])

/** The only inbound headers copied upstream. Everything else, `x-mentra-*` included, is dropped. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept"] as const

/** The only upstream headers copied back. */
const PASSED_RESPONSE_HEADERS = ["content-type", "cache-control"] as const

/** Statuses a `Response` cannot carry a body with. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205])

type Audience = "client" | "admin"

/** Where each surface is mounted in the app: the part of the path that is not forwarded. */
const MOUNT_PREFIX: Record<Audience, string> = {
  client: "/api/client/fleet",
  admin: "/api/admin/fleet",
}

type FleetConfig = {state: "unset"} | {state: "misconfigured"} | {state: "ready"; baseUrl: URL; secret: string}

// Read on every request so a changed value takes effect at once; the parse is cached by the raw
// values so a bad one is logged once rather than on every request.
let parsed: {key: string; config: FleetConfig} | undefined

function fleetConfig(): FleetConfig {
  const rawUrl = (process.env[URL_VARIABLE] ?? "").trim()
  const secret = process.env[SECRET_VARIABLE] ?? ""
  const production = process.env.NODE_ENV === "production"
  const key = JSON.stringify([rawUrl, secret, production])
  if (parsed?.key !== key) parsed = {key, config: parseConfig(rawUrl, secret, production)}
  return parsed.config
}

function parseConfig(rawUrl: string, secret: string, production: boolean): FleetConfig {
  // The URL decides whether Fleet is installed; a secret without one is inert.
  if (!rawUrl) return {state: "unset"}
  const baseUrl = parseFleetUrl(rawUrl, production)
  if (!baseUrl) {
    logger.error(
      {variable: URL_VARIABLE},
      `${URL_VARIABLE} is not a usable Fleet URL (an http(s) URL without credentials, query or fragment; https is required in production except on localhost); refusing Fleet requests`,
    )
  }
  if (!secret.trim()) {
    logger.error(
      {variable: SECRET_VARIABLE},
      `${SECRET_VARIABLE} is required when ${URL_VARIABLE} is set; refusing Fleet requests`,
    )
  }
  return baseUrl && secret.trim() ? {state: "ready", baseUrl, secret} : {state: "misconfigured"}
}

function parseFleetUrl(raw: string, production: boolean): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null
  if (production && url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) return null
  return url
}

const reportedValues = new Set<string>()

/** A positive integer from the environment, or `fallback` when it is unset, blank or not one. */
function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (/^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0) return value
  const report = `${name}=${raw}`
  if (!reportedValues.has(report)) {
    reportedValues.add(report)
    logger.warn({variable: name}, `${name} is not a positive integer; using the default of ${fallback}`)
  }
  return fallback
}

const maxBodyBytes = () => positiveInteger(MAX_BODY_VARIABLE, DEFAULT_MAX_BODY_BYTES)
const timeoutMs = () => positiveInteger(TIMEOUT_VARIABLE, DEFAULT_TIMEOUT_MS)

const unavailable = (c: AppContext) => c.json({error: "fleet_unavailable"}, 503)

/** The part of a request URL after the host, as sent: `new URL` would collapse `..` segments. */
function rawPathAndQuery(url: string): {path: string; query: string} {
  const afterOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
  const withoutFragment = afterOrigin.split("#", 1)[0]
  const queryStart = withoutFragment.indexOf("?")
  if (queryStart === -1) return {path: withoutFragment || "/", query: ""}
  return {path: withoutFragment.slice(0, queryStart) || "/", query: withoutFragment.slice(queryStart)}
}

/**
 * Whether a forwarded path is safe to append to Fleet's: no segment may be a dot segment or hold a
 * separator, a control character or a bad escape once decoded, however it is spelled.
 */
function isSafeSuffix(suffix: string): boolean {
  for (const segment of suffix.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false
    for (const char of decoded) {
      const code = char.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) return false
    }
  }
  return true
}

/** The caller as Fleet is told about it, or null when the request has none. */
function callerPrincipal(c: AppContext, audience: Audience): Record<string, unknown> | null {
  if (audience === "client") {
    const user = c.get("user")
    if (!user) return null
    return {kind: "phone", mentraUserId: user.mentraUserId, tenantId: user.tenantId, sessionId: user.sessionId}
  }
  const principal = c.get("principal")
  if (!principal) return null
  if (principal.kind === "user") {
    return {
      kind: "user",
      mentraUserId: principal.mentraUserId,
      email: principal.email,
      isOrganizationAdmin: principal.isOrganizationAdmin,
    }
  }
  return {
    kind: "credential",
    credentialId: principal.credentialId,
    credentialKind: principal.credentialKind,
    workspaceId: principal.workspaceId,
    scopes: principal.scopes,
  }
}

/** Limits the request body to `CLOUD_CORE_FLEET_MAX_BODY_BYTES` before anything reads it. */
const limitBody: MiddlewareHandler<AppEnv> = (c, next) => {
  // Without a usable Fleet the handler answers without reading the body, so there is nothing to limit.
  if (fleetConfig().state !== "ready") return next()
  return bodyLimit({
    maxSize: maxBodyBytes(),
    onError: (context) => context.json({error: "payload_too_large"}, 413),
  })(c, next)
}

function forward(audience: Audience): Handler<AppEnv> {
  return async (c) => {
    // Fail closed: the gate in front of this route sets the caller, and a route mounted without one
    // must not forward an anonymous request.
    const principal = callerPrincipal(c, audience)
    if (!principal) return c.json({error: "unauthorized"}, 401)

    const fleet = fleetConfig()
    if (fleet.state === "unset") return c.json({error: "fleet_not_installed"}, 404)
    if (fleet.state === "misconfigured") return unavailable(c)

    const {path, query} = rawPathAndQuery(c.req.url)
    const prefix = MOUNT_PREFIX[audience]
    const suffix = path.slice(prefix.length)
    if (!path.startsWith(prefix) || (suffix !== "" && !suffix.startsWith("/"))) {
      return c.json({error: "not_found"}, 404)
    }
    if (!isSafeSuffix(suffix)) return c.json({error: "invalid_path"}, 400)

    let body = ""
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const bytes = await c.req.arrayBuffer()
      // The middleware has already refused a larger body; this holds even for a length it could not read.
      if (bytes.byteLength > maxBodyBytes()) return c.json({error: "payload_too_large"}, 413)
      try {
        body = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)
      } catch {
        return c.json({error: "invalid_body"}, 400)
      }
    }

    const basePath = fleet.baseUrl.pathname.replace(/\/+$/, "")
    const target = new URL(`${fleet.baseUrl.origin}${basePath}/v1/${audience}${suffix}${query}`)
    const method = c.req.method
    const timestampMs = Date.now()
    const timestamp = String(timestampMs)
    const organization = organizationId()
    const principalHeader = Buffer.from(JSON.stringify(principal)).toString("base64url")

    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }
    headers.set(SERVICE_HEADERS.service, "core")
    headers.set(SERVICE_HEADERS.timestamp, timestamp)
    headers.set(
      SERVICE_HEADERS.signature,
      signServiceRequest({
        secret: fleet.secret,
        method,
        pathWithQuery: target.pathname + target.search,
        body,
        timestampMs,
      }),
    )
    headers.set(FLEET_HEADERS.organizationId, organization)
    headers.set(FLEET_HEADERS.principal, principalHeader)
    headers.set(
      FLEET_HEADERS.principalSignature,
      createHmac("sha256", fleet.secret)
        .update(`${timestamp}\n${organization}\n${principalHeader}`)
        .digest("base64url"),
    )

    const log = c.get("logger") ?? logger
    let status: number
    let payload: ArrayBuffer | null = null
    let upstreamHeaders: Headers
    try {
      // One signal covers the wait for the answer and the read of its body.
      const upstream = await fetch(target, {
        method,
        headers,
        // Bytes, not the string: the fetch spec gives a string body a `text/plain` content-type of its own.
        body: method === "GET" || method === "HEAD" ? undefined : new TextEncoder().encode(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs()),
      })
      status = upstream.status
      upstreamHeaders = upstream.headers
      if (status >= 500 || (status >= 300 && status < 400)) {
        // Not an answer Core relays: a failure, or a redirect it never follows.
        await upstream.body?.cancel()
        log.warn({audience, upstreamStatus: status}, "Fleet answered with a failure or a redirect")
        return unavailable(c)
      }
      payload = await upstream.arrayBuffer()
    } catch (err) {
      log.warn({audience, reason: err instanceof Error ? err.name : "unknown"}, "Fleet request failed")
      return unavailable(c)
    }

    const responseHeaders = new Headers()
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstreamHeaders.get(name)
      if (value) responseHeaders.set(name, value)
    }
    return new Response(NULL_BODY_STATUSES.has(status) ? null : payload, {status, headers: responseHeaders})
  }
}

/**
 * Routes for the phone, mounted at `/api/client` behind `userAuth`: `GET /capabilities` and
 * `ALL /fleet/*`. A request with no user on the context is refused (401).
 */
export const clientFleetApi = new Hono<AppEnv>()

clientFleetApi.get("/capabilities", (c) => {
  if (!c.get("user")) return c.json({error: "unauthorized"}, 401)
  return c.json({organizationId: organizationId(), fleet: {installed: fleetConfig().state === "ready"}})
})
clientFleetApi.all("/fleet/*", limitBody, forward("client"))

/**
 * The forwarder for the admin surface, mounted at `/fleet` inside the admin API, behind
 * `principalAuth` and no organization capability. A request with no principal is refused (401).
 */
export const adminFleetApi = new Hono<AppEnv>()

adminFleetApi.all("/*", limitBody, forward("admin"))
