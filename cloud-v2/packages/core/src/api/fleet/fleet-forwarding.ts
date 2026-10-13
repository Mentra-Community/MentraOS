/**
 * @fileoverview Core's seam to the optional Fleet integration.
 *
 * Fleet is a separately deployed service (MFM). Core stores none of its data: it authenticates the
 * caller, decides what the caller may do, then forwards the request to Fleet and relays the answer.
 *
 *   /api/client/fleet/<rest>  ->  ${CLOUD_CORE_FLEET_URL}/v1/client/<rest>   (a signed-in phone)
 *   /api/admin/fleet/<rest>   ->  ${CLOUD_CORE_FLEET_URL}/v1/admin/<rest>    (an Organization Admin)
 *
 * Who may call. Only people reach Fleet.
 *  - `/api/client/fleet`: a phone, by its access token (`userAuth`). Anything else, an admin portal
 *    session cookie included, is 401 and nothing is forwarded.
 *  - `/api/admin/fleet`: a signed-in person (`requireUserPrincipal("admin")`: a workspace key or an
 *    operator key is 403) who holds `organization.fleet.administer` (an Organization Admin; 403
 *    otherwise). The gates are this router's own, so every path under it has them, `ui/*` included.
 *
 * The scope is Core's decision. A person's Fleet request covers the organization (`scope:
 * {kind: "organization"}`) and nothing the request carries, in its query, body or headers, can say
 * otherwise: the principal is built from the authenticated caller and from nothing else.
 *
 * Configuration comes from `fleetConfig()` and `fleetLimits()` (`services/fleet/fleet-config.ts`),
 * read on every request. Outcomes, in this order:
 *  - the caller is not authenticated (or not allowed): 401 or 403, as above;
 *  - Fleet is not installed (no `CLOUD_CORE_FLEET_URL`, or `CLOUD_CORE_ENABLED_FEATURES` is set
 *    without `fleet.managed`): 404 `{error: "fleet_not_installed"}`. This is how a phone learns
 *    that Fleet is absent, from the answer to its first report;
 *  - the URL is set but unusable or the secret is missing: 503 `{error: "fleet_unavailable"}`;
 *  - a body over `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: 413 `{error: "payload_too_large"}`; a body that
 *    is not valid UTF-8: 400 `{error: "invalid_body"}`; a path with a `.` / `..` segment, an encoded
 *    or literal separator (`%2f`, `%5c`, `\`), a control character or a bad escape: 400
 *    `{error: "invalid_path"}`. Each segment is checked after one decoding and the path is forwarded
 *    exactly as received. A segment that is still `%2e`, `%2f` or `%5c` after that decoding (a
 *    double-encoded `%252e`) is refused too, so a Fleet that decodes a second time cannot be handed
 *    a dot segment or a separator;
 *  - a network error, a timeout, an upstream 5xx, an upstream 3xx other than 304 (redirects are
 *    never followed) or an upstream body over `CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES`: 503
 *    `{error: "fleet_unavailable"}`. Never an empty success;
 *  - an upstream 401 reaches the caller as a 403 with Fleet's body: phones and the admin dashboard
 *    read a 401 as "your session ended, sign in again", and a Fleet answer never means that. Fleet
 *    should answer 403 for "not allowed" itself;
 *  - any other upstream status and body pass through, with `content-type`, `cache-control` and
 *    `retry-after` only. A 204, 205 or 304, and any answer to a `HEAD`, has no body: Core does not
 *    read one and adds no `content-type` of its own.
 *
 * Correlation. Core sends Fleet its request id (`x-request-id`, the id `requestContext` gave this
 * request) and answers with Fleet's `x-request-id` when Fleet returns one, Core's otherwise. Each
 * forwarded request is logged once with `{reqId, upstreamRequestId, status, ms}`; never a body, a
 * header, a query or a secret.
 *
 * What Fleet receives. Core copies the method, the query, the body and the `content-type` and
 * `accept` headers. Every other inbound header is dropped, so nothing the caller sent under
 * `x-mentra-*`, `authorization` or `cookie` reaches Fleet. Core then adds, with `<ts>` the request
 * time in milliseconds:
 *
 *  - `x-mentra-service: core`, `x-mentra-service-timestamp: <ts>` and `x-mentra-service-signature`:
 *    `signServiceRequest` from `@mentra/workspace-contract/server` over `<ts>`, the method, the
 *    upstream path with its query (as sent, prefix included) and the body;
 *  - `x-mentra-principal` and `x-mentra-principal-signature` (`FORWARDED_PRINCIPAL_HEADERS`): who is
 *    calling, a `ForwardedPrincipal` as base64url JSON, and its signature with the same secret and
 *    `<ts>` (`signForwardedPrincipal`):
 *      - `{kind: "phone", mentraUserId, tenantId, sessionId, email}`, where `email` is the account's
 *        verified email or null (a display attribute, never an identity key);
 *      - `{kind: "user", mentraUserId, email, emailVerified, isOrganizationAdmin,
 *        organizationCapabilities, scope}`;
 *  - `x-request-id`: Core's request id.
 *
 * Fleet verifies all of it with `verifyForwardedPrincipal` from `@mentra/workspace-contract/server`,
 * which checks both signatures against the same timestamp and secret and returns the typed
 * principal. Fleet knows which organization is calling from the secret it shares with that Core, so
 * no header names the organization. The service signature does not cover the identity header, so
 * without the principal signature anyone who captured one signed request could replay it with
 * another identity inside the skew window. The two signed strings cannot be mistaken for each other:
 * the service one has three newlines, this one has one, and neither a header value nor a path can
 * contain a newline.
 *
 * Request bodies are treated as UTF-8 text (the Fleet API is JSON): the signature covers the text
 * and the same bytes are sent. The path Core signs is the path and query of the URL it sends, taken
 * from the same URL object.
 */

import {createLogger} from "@mentra/cloud-shared"
import {
  FORWARDED_PRINCIPAL_HEADERS,
  FORWARDING_SERVICE,
  SERVICE_HEADERS,
  signForwardedPrincipal,
  signServiceRequest,
  type ForwardedPrincipal,
} from "@mentra/workspace-contract/server"
import {Hono, type Handler, type MiddlewareHandler} from "hono"
import {bodyLimit} from "hono/body-limit"
import {ulid} from "ulid"
import {fleetConfig, fleetLimits} from "../../services/fleet/fleet-config"
import {phoneEmail} from "../../services/fleet/phone-email"
import type {UserPrincipal} from "../../services/signin/principal.service"
import {organizationCapabilities} from "../../services/workspaces/authorization.service"
import type {AppContext, AppEnv, AppVariables} from "../../types/hono.types"
import {InvalidGrant, InvalidRequest} from "../../types/oauth.types"
import {requireOrganizationCapability, requireUserPrincipal} from "../middleware/principal.middleware"
import {userAuth} from "../middleware/user-auth.middleware"

const logger = createLogger("core").child({service: "fleet-forwarding"})

/** The only inbound headers copied upstream. Everything else, `x-mentra-*` included, is dropped. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept"] as const

/** The only upstream headers copied back, besides `x-request-id`. */
const PASSED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"] as const

/** Statuses that never carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

const REQUEST_ID_HEADER = "x-request-id"

type Audience = "client" | "admin"

/** Where each surface is mounted in the app: the part of the path that is not forwarded. */
const MOUNT_PREFIX: Record<Audience, string> = {
  client: "/api/client/fleet",
  admin: "/api/admin/fleet",
}

/** What a person's Fleet request covers: the organization. Core decides; nothing in a request can change it. */
const ORGANIZATION_SCOPE = {kind: "organization"} as const

const unavailable = (c: AppContext) => c.json({error: "fleet_unavailable"}, 503)

/** The part of a request URL after the host, as sent: `new URL` would collapse `..` segments. */
function rawPathAndQuery(url: string): {path: string; query: string} {
  const afterOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
  const withoutFragment = afterOrigin.split("#", 1)[0]
  const queryStart = withoutFragment.indexOf("?")
  if (queryStart === -1) return {path: withoutFragment || "/", query: ""}
  // A lone "?" is no query: the URL parser drops it from `search`, so it would be sent but not signed.
  const query = withoutFragment.slice(queryStart)
  return {path: withoutFragment.slice(0, queryStart) || "/", query: query === "?" ? "" : query}
}

/** What a once-decoded segment must not still hold: an escaped dot or separator a second decoding would expose. */
const STILL_ESCAPED = /%(?:2e|2f|5c)/i

/**
 * Whether a forwarded path is safe to append to Fleet's: no segment may be a dot segment or hold a
 * separator, a control character or a bad escape once decoded, however it is spelled. A segment that
 * is still an escaped dot or separator after one decoding is refused as well (double encoding), so
 * the check does not depend on Fleet decoding only once.
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
    if (STILL_ESCAPED.test(decoded)) return false
    for (const char of decoded) {
      const code = char.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) return false
    }
  }
  return true
}

/**
 * The URL a request is sent to: Fleet's base URL (its path prefix, if any, kept), `/v1/<audience>`,
 * then the caller's own path suffix and query. The base's trailing slashes are dropped, so
 * `https://mfm.example` and `https://mfm.example/fleet/` join the same way as `https://mfm.example/fleet`.
 */
export function upstreamTarget(baseUrl: URL, audience: Audience, suffix: string, query: string): URL {
  const prefix = baseUrl.pathname.replace(/\/+$/, "")
  return new URL(`${baseUrl.origin}${prefix}/v1/${audience}${suffix}${query}`)
}

/**
 * The body of `upstream` as bytes, or null once it passes `limit`: a declared length over it is refused
 * before anything is read, and a stream with no (or a wrong) length is cancelled as soon as it is over.
 */
async function readCapped(upstream: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(upstream.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await upstream.body?.cancel()
    return null
  }
  const reader = upstream.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The authenticated caller of a forwarded request. */
type Caller = {audience: "client"; phone: NonNullable<AppVariables["user"]>} | {audience: "admin"; person: UserPrincipal}

/**
 * The caller, or the refusal to send. Fail closed: the gates in front of a route set the caller, and a
 * route mounted without them must not forward an anonymous request, nor a credential as a person.
 */
function callerOf(c: AppContext, audience: Audience): Caller | Response {
  if (audience === "client") {
    const phone = c.get("user")
    return phone ? {audience, phone} : c.json({error: "unauthorized"}, 401)
  }
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  return principal.kind === "user" ? {audience, person: principal} : c.json({error: "forbidden"}, 403)
}

/**
 * The caller as Fleet is told about it. Built from the authenticated caller only: nothing in the
 * request's query, body or headers reaches it.
 */
async function principalOf(caller: Caller): Promise<ForwardedPrincipal> {
  if (caller.audience === "client") {
    const {mentraUserId, tenantId, sessionId} = caller.phone
    return {kind: "phone", mentraUserId, tenantId, sessionId, email: await phoneEmail(mentraUserId)}
  }
  const {person} = caller
  return {
    kind: "user",
    mentraUserId: person.mentraUserId,
    email: person.email,
    emailVerified: person.emailVerified,
    isOrganizationAdmin: person.isOrganizationAdmin,
    organizationCapabilities: [...organizationCapabilities(person)],
    scope: ORGANIZATION_SCOPE,
  }
}

/** Limits the request body to `CLOUD_CORE_FLEET_MAX_BODY_BYTES` before anything reads it. */
const limitBody: MiddlewareHandler<AppEnv> = (c, next) => {
  // Without a usable Fleet the handler answers without reading the body, so there is nothing to limit.
  if (fleetConfig().state !== "ready") return next()
  return bodyLimit({
    maxSize: fleetLimits().maxBodyBytes,
    onError: context => context.json({error: "payload_too_large"}, 413),
  })(c, next)
}

function forward(audience: Audience): Handler<AppEnv> {
  return async c => {
    const caller = callerOf(c, audience)
    if (caller instanceof Response) return caller

    const fleet = fleetConfig()
    if (fleet.state === "not_installed") return c.json({error: "fleet_not_installed"}, 404)
    if (fleet.state === "misconfigured") return unavailable(c)
    const limits = fleetLimits()

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
      if (bytes.byteLength > limits.maxBodyBytes) return c.json({error: "payload_too_large"}, 413)
      try {
        body = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)
      } catch {
        return c.json({error: "invalid_body"}, 400)
      }
    }

    const principal = await principalOf(caller)
    // The one URL that is signed and sent, so the signature covers exactly the path and query on the wire.
    const target = upstreamTarget(fleet.baseUrl, audience, suffix, query)
    const method = c.req.method
    const timestampMs = Date.now()
    const requestId = c.get("reqId") ?? ulid()

    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }
    headers.set(SERVICE_HEADERS.service, FORWARDING_SERVICE)
    headers.set(SERVICE_HEADERS.timestamp, String(timestampMs))
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
    const signed = signForwardedPrincipal({secret: fleet.secret, timestampMs, principal})
    headers.set(FORWARDED_PRINCIPAL_HEADERS.principal, signed.principal)
    headers.set(FORWARDED_PRINCIPAL_HEADERS.principalSignature, signed.principalSignature)
    headers.set(REQUEST_ID_HEADER, requestId)

    const log = c.get("logger") ?? logger.child({reqId: requestId})
    const started = performance.now()
    const logged = (outcome: {
      status: number
      upstreamStatus: number | null
      upstreamRequestId: string | null
      reason?: string
    }) => {
      const fields = {audience, ...outcome, ms: Math.round(performance.now() - started)}
      // An answer Fleet gave is routine; one Core could not relay, or Fleet refusing Core's signature, is not.
      const routine = outcome.status === outcome.upstreamStatus
      log[routine ? "debug" : "warn"](fields, "Fleet request forwarded")
    }

    let status: number
    let payload: Uint8Array | null = null
    let upstreamHeaders: Headers
    try {
      // One signal covers the wait for the answer and the read of its body.
      const upstream = await fetch(target, {
        method,
        headers,
        // Bytes, not the string: the fetch spec gives a string body a `text/plain` content-type of its own.
        body: method === "GET" || method === "HEAD" ? undefined : new TextEncoder().encode(body),
        redirect: "manual",
        signal: AbortSignal.timeout(limits.timeoutMs),
      })
      status = upstream.status
      upstreamHeaders = upstream.headers
      const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
      if (status >= 500 || (status >= 300 && status < 400 && status !== 304)) {
        // Not an answer Core relays: a failure, or a redirect it never follows.
        await upstream.body?.cancel()
        logged({status: 503, upstreamStatus: status, upstreamRequestId})
        return unavailable(c)
      }
      if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
        // No body to relay. A HEAD answer's `content-length` describes the body a GET would get, so it
        // is not checked against the response cap either.
        await upstream.body?.cancel()
      } else {
        payload = await readCapped(upstream, limits.maxResponseBytes)
        if (!payload) {
          logged({status: 503, upstreamStatus: status, upstreamRequestId})
          return unavailable(c)
        }
      }
    } catch (err) {
      // A network error or the timeout: what failed is named, never what was said.
      logged({
        status: 503,
        upstreamStatus: null,
        upstreamRequestId: null,
        reason: err instanceof Error ? err.name : "unknown",
      })
      return unavailable(c)
    }

    const responseHeaders = new Headers()
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstreamHeaders.get(name)
      if (value) responseHeaders.set(name, value)
    }
    const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
    responseHeaders.set(REQUEST_ID_HEADER, upstreamRequestId || requestId)
    // A 401 from Core means "sign in again" to every client; Fleet's never does, so it is relayed as a 403.
    const relayed = status === 401 ? 403 : status
    logged({status: relayed, upstreamStatus: status, upstreamRequestId})
    return new Response(payload, {status: relayed, headers: responseHeaders})
  }
}

/**
 * The phone's gate: its Core access token (`userAuth`). `userAuth` answers a missing or invalid token
 * as an OAuth error (400); on Fleet's routes the phone is told what every other caller is, 401, so it
 * refreshes its session instead of taking the answer for a bad request.
 */
const phoneAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    // `userAuth` sets `c.var.user`; the rest of the request runs here, not inside it.
    await userAuth(c, async () => {})
  } catch (err) {
    if (err instanceof InvalidRequest || err instanceof InvalidGrant) {
      return c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
    }
    throw err
  }
  return next()
}

/**
 * The phone's forwarder, mounted at `/api/client/fleet`. Its own gate is the phone's access token; a
 * request with no user on the context is refused (401).
 */
export const clientFleetApi = new Hono<AppEnv>()
clientFleetApi.use("*", phoneAuth)
clientFleetApi.all("/*", limitBody, forward("client"))

/**
 * The admin forwarder, mounted at `/fleet` inside the admin API. Its own gates are a signed-in person
 * (a key gets 403) who holds `organization.fleet.administer`. A request with no principal is refused (401).
 */
export const adminFleetApi = new Hono<AppEnv>()
adminFleetApi.use("*", requireUserPrincipal("admin"), requireOrganizationCapability("organization.fleet.administer"))
adminFleetApi.all("/*", limitBody, forward("admin"))
