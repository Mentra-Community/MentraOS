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
 * request that reaches Fleet is logged once with `{reqId, upstreamRequestId, status, ms}`: at debug
 * for a success, at info for an answer Fleet gave that is not one (a 403, a 429, a 404...), and at
 * warn for what Core could not relay as Fleet said it (a failure, a timeout, an upstream 401).
 * Never a body, a header, a query or a secret.
 *
 * A 503 Core gives for an upstream 5xx repeats Fleet's `Retry-After` when it is a whole number of
 * seconds.
 *
 * What Fleet receives. Core copies the method, the query, the body and the `content-type` and
 * `accept` headers (the UI asset route copies two others, below). Every other inbound header is
 * dropped, so nothing the caller sent under `x-mentra-*`, `authorization` or `cookie` reaches Fleet.
 * Core then adds, with `<ts>` the request time in milliseconds:
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
 *
 * Fleet UI assets. `GET` and `HEAD` `/api/admin/fleet/ui/<rest>` -> `${CLOUD_CORE_FLEET_URL}/v1/admin/ui/<rest>`
 * have a route of their own, ahead of the forwarder and behind the same admin gates. It relays the module
 * the admin portal imports (`ui/entry.js`) through Core, so that it loads from the portal's own origin under
 * `script-src 'self'`, and what it relays therefore runs there. The rules differ from the JSON routes':
 *  - any other method is 405 (`Allow: GET, HEAD`). The forwarder refuses every other spelling of the `ui`
 *    segment (`UI`, `//ui`), so nothing under it is ever relayed by the JSON rules;
 *  - Fleet receives `if-none-match` and `if-modified-since` from the caller and no other header of theirs,
 *    plus Core's `accept-encoding: identity` (outside the signature) so the bytes Core relays are the bytes
 *    Fleet sent. The request is signed and carries the principal like any other;
 *  - the caller gets `content-type`, `etag`, `last-modified`, `cache-control` and `vary` (added to any `Vary`
 *    already on the response), `content-length` (the length of the body it gets) and `x-request-id` as above.
 *    Core adds `x-content-type-options: nosniff` and `cross-origin-resource-policy: same-origin` to every
 *    answer of the route, its own refusals included;
 *  - the content type is checked first, for an error answer too: `text/javascript`, `application/javascript`,
 *    `text/css`, `image/png|jpeg|webp|gif|avif`, `font/woff2|woff` and `application/json` are relayed as
 *    Fleet sent them. `image/svg+xml` is relayed under Core's own `content-security-policy: default-src 'none';
 *    style-src 'unsafe-inline'`, which replaces any Fleet sent. Anything else, `text/html` above all, is a 503
 *    `fleet_unavailable`; so is a value holding a comma (a browser keeps the last of several, so
 *    `text/javascript, text/html` would be read as html) and an answer with no content type, unless it
 *    declares an empty body. A 204, 205 or 304 has no representation, so it is relayed with its validators
 *    and is not checked;
 *  - the body is read whole and checked before any of it is relayed; it is not streamed. The status is final
 *    once the headers are out, and Bun turns a stream that fails (a short body, a reset, a timeout, the cap)
 *    into a normal end of the response, without the declared length, so a browser would take a truncated
 *    module for a complete, cacheable 200 with Fleet's `etag` and `cache-control`. Core reads under
 *    `CLOUD_CORE_FLEET_MAX_ASSET_BYTES` (default 25 MiB, not the JSON routes' response cap) and
 *    `CLOUD_CORE_FLEET_TIMEOUT_MS` (the wait for the answer and the read of the whole body), and answers
 *    only when the body is complete and as long as the `content-length` Fleet declared. Otherwise the answer
 *    is a 503 `fleet_unavailable` with none of Fleet's headers, logged at warn with a `reason`: a declared
 *    length over the cap (a HEAD's included, refused before any of the body is read), a body over the cap
 *    with no (or a wrong) length, a body of another length than declared, a Fleet that resets the connection
 *    or stalls past the timeout after its headers, and any `content-encoding` but `identity` (Core asks for
 *    none; `fetch` would decode it and the declared length would no longer describe the body). Core sets the
 *    true `content-length` itself, from the bytes it holds;
 *  - a request Core stops reading (these refusals, and the JSON routes' over-cap, 5xx and redirect answers)
 *    is aborted, not just cancelled: see `fetchUpstream`;
 *  - everything else (not installed, misconfigured, unsafe path, 5xx, redirect, a 401 turned into a 403, a
 *    network error, a timeout before the headers) and its logging are the forwarder's.
 */

import {createLogger, type Logger} from "@mentra/cloud-shared"
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
import type {StatusCode} from "hono/utils/http-status"
import {ulid} from "ulid"
import {fleetConfig, fleetLimits, type FleetConfig, type FleetLimits} from "../../services/fleet/fleet-config"
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

/** The first path segment under the admin mount that holds Fleet's UI assets. */
const UI_ASSET_SEGMENT = "ui"

/** The only inbound headers the asset route copies upstream: a browser revalidating what it has cached. */
const ASSET_REQUEST_HEADERS = ["if-none-match", "if-modified-since"] as const

/**
 * The upstream headers the asset route copies back, besides `content-type` (checked first), `content-length`
 * (set from the body Core holds), `vary` (appended to the context's) and `x-request-id`.
 */
const ASSET_RESPONSE_HEADERS = ["etag", "last-modified", "cache-control"] as const

/** What the asset route relays: what a page loads from its own origin. Anything else, `text/html` first, is refused. */
const ASSET_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/javascript",
  "application/javascript",
  "text/css",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "font/woff2",
  "font/woff",
  "application/json",
])

/** SVG can carry script, so it is relayed only under Core's own policy, which allows none. */
const SVG_CONTENT_TYPE = "image/svg+xml"
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'"

type Audience = "client" | "admin"

/** Where each surface is mounted in the app: the part of the path that is not forwarded. */
const MOUNT_PREFIX: Record<Audience, string> = {
  client: "/api/client/fleet",
  admin: "/api/admin/fleet",
}

/** What a person's Fleet request covers: the organization. Core decides; nothing in a request can change it. */
const ORGANIZATION_SCOPE = {kind: "organization"} as const

/**
 * Core's own 503. `retryAfter` is Fleet's `Retry-After` when it answered with a failure and sent a valid one,
 * so a phone backs off for as long as Fleet asked rather than for its own guess.
 */
function unavailable(c: AppContext, retryAfter: string | null = null) {
  if (retryAfter) c.header("retry-after", retryAfter)
  return c.json({error: "fleet_unavailable"}, 503)
}

/** A `Retry-After` Core will repeat to a phone: a whole number of seconds, which is all phones read. */
function validRetryAfter(value: string | null): string | null {
  return value !== null && /^\d{1,9}$/.test(value) ? value : null
}

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

/** A request in flight to Fleet, which Core can end. */
interface UpstreamCall {
  response: Response
  /** Ends the request: its connection closes and whatever is left of the body is not downloaded. */
  abort(): void
}

/**
 * Sends a request to Fleet. Redirects are never followed, and one signal covers the wait for the answer and
 * the read of its body (`timeoutMs`). Every route ends a request it stops reading through `abort`, here and
 * nowhere else: cancelling a response body does not close the connection (Bun's `fetch` keeps downloading
 * until the answer is complete or the timeout fires), aborting the request does.
 */
async function fetchUpstream(
  target: URL,
  init: {method: string; headers: Headers; body?: Uint8Array<ArrayBuffer>},
  timeoutMs: number,
): Promise<UpstreamCall> {
  const stop = new AbortController()
  const response = await fetch(target, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stop.signal]),
  })
  return {response, abort: () => stop.abort()}
}

/** Ends `call` without reading its body. */
async function discard(call: UpstreamCall): Promise<void> {
  call.abort()
  await call.response.body?.cancel().catch(() => {})
}

/**
 * The body of `call` as bytes, or null once it passes `limit`: a declared length over it is refused
 * before anything is read, and a stream with no (or a wrong) length is ended as soon as it is over.
 */
async function readCapped(call: UpstreamCall, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const upstream = call.response
  const declared = Number(upstream.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await discard(call)
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
      call.abort()
      await reader.cancel().catch(() => {})
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

/** A Fleet that is installed and usable. */
type ReadyFleet = Extract<FleetConfig, {state: "ready"}>

/** What a forwarded request has settled before anything is read, signed or sent. */
interface Admitted {
  caller: Caller
  fleet: ReadyFleet
  limits: FleetLimits
  /** The path after the mount prefix, as received. */
  suffix: string
  /** The query as received, with its "?" (or ""). */
  query: string
}

/**
 * What every forwarded route settles first, in this order: who is calling, whether Fleet is installed
 * and usable, then the path. Returns the answer Core gives when a step refuses, or what the route may send.
 */
function admit(c: AppContext, audience: Audience): Admitted | Response {
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
  return {caller, fleet, limits, suffix, query}
}

/** Whether a path is under Fleet's UI assets, however its first segment is cased or spaced from the mount. */
function isUiAssetPath(suffix: string): boolean {
  const first = suffix.split("/").find(segment => segment !== "")
  // `isSafeSuffix` has already decoded every segment once, so this cannot throw.
  return first !== undefined && decodeURIComponent(first).toLowerCase() === UI_ASSET_SEGMENT
}

/** A request as sent to Fleet: the one URL that is signed and sent, with the headers that carry the signatures. */
interface SignedRequest {
  target: URL
  headers: Headers
  requestId: string
}

/**
 * The request to send for `admitted`: Fleet's URL for the path, the inbound headers named in `copy` (and no
 * others), and Core's signatures and request id. The signature covers the method, the path and query of that
 * URL, and `body`.
 */
async function signRequest(
  c: AppContext,
  admitted: Admitted,
  request: {method: string; body: string; copy: readonly string[]},
): Promise<SignedRequest> {
  const {caller, fleet, suffix, query} = admitted
  const principal = await principalOf(caller)
  // The one URL that is signed and sent, so the signature covers exactly the path and query on the wire.
  const target = upstreamTarget(fleet.baseUrl, caller.audience, suffix, query)
  const timestampMs = Date.now()
  const requestId = c.get("reqId") ?? ulid()

  const headers = new Headers()
  for (const name of request.copy) {
    const value = c.req.header(name)
    if (value) headers.set(name, value)
  }
  headers.set(SERVICE_HEADERS.service, FORWARDING_SERVICE)
  headers.set(SERVICE_HEADERS.timestamp, String(timestampMs))
  headers.set(
    SERVICE_HEADERS.signature,
    signServiceRequest({
      secret: fleet.secret,
      method: request.method,
      pathWithQuery: target.pathname + target.search,
      body: request.body,
      timestampMs,
    }),
  )
  const signed = signForwardedPrincipal({secret: fleet.secret, timestampMs, principal})
  headers.set(FORWARDED_PRINCIPAL_HEADERS.principal, signed.principal)
  headers.set(FORWARDED_PRINCIPAL_HEADERS.principalSignature, signed.principalSignature)
  headers.set(REQUEST_ID_HEADER, requestId)
  return {target, headers, requestId}
}

/** The request's logger: the one `requestContext` bound to the request id, or Core's own when there is none. */
function requestLogger(c: AppContext, requestId: string): Logger {
  return c.get("logger") ?? logger.child({reqId: requestId})
}

/** What one forwarded request came to. `reason` names what failed, never what was said. */
interface Outcome {
  status: number
  upstreamStatus: number | null
  upstreamRequestId: string | null
  reason?: string
}

/** The log line for a forwarded request, once: `{reqId, upstreamRequestId, status, ms}` and nothing else of it. */
function outcomeLogger(log: Logger, audience: Audience): (outcome: Outcome) => void {
  const started = performance.now()
  return outcome => {
    const fields = {audience, ...outcome, ms: Math.round(performance.now() - started)}
    // A success is routine (debug). An answer Fleet gave that is not one (a 403 for a signature it
    // refused, a 429, a 404) is relayed as it is and logged at info, so it shows at the production log
    // level. What Core could not relay as Fleet said it (a failure, a redirect, an oversized body, a 401
    // turned into a 403, no answer at all) is a warning.
    const relayedAsIs = outcome.status === outcome.upstreamStatus
    const success = outcome.status >= 200 && outcome.status < 300
    const level = !relayedAsIs ? "warn" : success || outcome.status === 304 ? "debug" : "info"
    log[level](fields, "Fleet request forwarded")
  }
}

/** An upstream status Core does not relay: a failure, or a redirect it never follows (it relays a 304). */
function isNotRelayed(status: number): boolean {
  return status >= 500 || (status >= 300 && status < 400 && status !== 304)
}

function forward(audience: Audience): Handler<AppEnv> {
  return async c => {
    const admitted = admit(c, audience)
    if (admitted instanceof Response) return admitted
    const {caller, limits} = admitted
    // The UI assets have their own route and rules; however a path spells `ui`, it is not forwarded as JSON.
    if (audience === "admin" && isUiAssetPath(admitted.suffix)) return c.json({error: "not_found"}, 404)

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

    const method = c.req.method
    const {target, headers, requestId} = await signRequest(c, admitted, {method, body, copy: FORWARDED_REQUEST_HEADERS})
    const logged = outcomeLogger(requestLogger(c, requestId), caller.audience)

    let status: number
    let payload: Uint8Array<ArrayBuffer> | null = null
    let upstreamHeaders: Headers
    try {
      const call = await fetchUpstream(
        target,
        {
          method,
          headers,
          // Bytes, not the string: the fetch spec gives a string body a `text/plain` content-type of its own.
          body: method === "GET" || method === "HEAD" ? undefined : new TextEncoder().encode(body),
        },
        limits.timeoutMs,
      )
      const upstream = call.response
      status = upstream.status
      upstreamHeaders = upstream.headers
      const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
      if (isNotRelayed(status)) {
        // Not an answer Core relays: a failure, or a redirect it never follows.
        await discard(call)
        logged({status: 503, upstreamStatus: status, upstreamRequestId})
        // Fleet's own backoff (it sends one on an outage and while it shuts down) belongs to a failure, not to a redirect.
        return unavailable(c, status >= 500 ? validRetryAfter(upstreamHeaders.get("retry-after")) : null)
      }
      if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
        // No body to relay. A HEAD answer's `content-length` describes the body a GET would get, so it
        // is not checked against the response cap either.
        await upstream.body?.cancel()
      } else {
        payload = await readCapped(call, limits.maxResponseBytes)
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

    // Never return a raw `Response` from here (nor from any route that reuses this handler, such as the
    // Fleet UI asset route): Hono replaces the context's headers with a raw Response's, and the context
    // holds the caller's rotated portal-session cookie (`principalAuth` sets it before the handler runs).
    // Lose it and the Organization Admin is signed out a minute after Core rotated their session. Build
    // the answer through the context, so what was set on it is kept and only these headers are added.
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstreamHeaders.get(name)
      if (value) c.header(name, value)
    }
    const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
    // Replaces the id `requestContext` set: the caller gets Fleet's when Fleet returned one.
    c.header(REQUEST_ID_HEADER, upstreamRequestId || requestId)
    // A 401 from Core means "sign in again" to every client; Fleet's never does, so it is relayed as a 403.
    const relayed = status === 401 ? 403 : status
    logged({status: relayed, upstreamStatus: status, upstreamRequestId})
    return c.newResponse(payload, relayed as StatusCode)
  }
}

/** A content-length that is a plain count of bytes, or null when there is none (or it is not one). */
function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim()
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null
}

/** The media type of a `content-type`: lowercase, no parameters (`Text/JavaScript; charset=x` is `text/javascript`). */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase()
}

/** Whether the body is sent as it is (no content-encoding), so a declared length is the length of what is relayed. */
function isIdentityEncoded(headers: Headers): boolean {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase()
  return !encoding || encoding === "identity"
}

/**
 * The Fleet UI asset route: `GET` and `HEAD` `/api/admin/fleet/ui/<rest>` to `/v1/admin/ui/<rest>`, behind
 * the admin gates. See "Fleet UI assets" in the file header for the rules; this builds the answer through
 * the context, like `forward`, so the caller's rotated session cookie survives.
 *
 * The body is read whole, under the cap and the timeout, and checked against the length Fleet declared before
 * a byte of it is relayed. It is not streamed: the status is final once the headers are out, and Bun turns
 * a stream that fails (a short body, a reset, a timeout, the cap) into a normal end of the response, so the
 * browser would get a truncated module as a complete, cacheable 200 with Fleet's `etag` and `cache-control`.
 */
function forwardAsset(): Handler<AppEnv> {
  return async c => {
    const admitted = admit(c, "admin")
    if (admitted instanceof Response) return admitted
    const {limits} = admitted

    const method = c.req.method
    const signed = await signRequest(c, admitted, {method, body: "", copy: ASSET_REQUEST_HEADERS})
    // Not covered by the signature. The bytes Core relays are the bytes Fleet sent, so the length it declares
    // is the length of what the caller gets; a Fleet that encodes anyway is refused below.
    signed.headers.set("accept-encoding", "identity")
    const logged = outcomeLogger(requestLogger(c, signed.requestId), "admin")

    let call: UpstreamCall
    try {
      call = await fetchUpstream(signed.target, {method, headers: signed.headers}, limits.timeoutMs)
    } catch (err) {
      logged({
        status: 503,
        upstreamStatus: null,
        upstreamRequestId: null,
        reason: err instanceof Error ? err.name : "unknown",
      })
      return unavailable(c)
    }

    const upstream = call.response
    const status = upstream.status
    const upstreamRequestId = upstream.headers.get(REQUEST_ID_HEADER)
    /** Core's 503 instead of the answer, with none of Fleet's headers; a warning, as Core did not relay what Fleet said. */
    const fail = (reason: string | null, retryAfter: string | null = null) => {
      logged({status: 503, upstreamStatus: status, upstreamRequestId, ...(reason ? {reason} : {})})
      return unavailable(c, retryAfter)
    }
    /** The same, for an answer that is not read: the request is ended and its body is never downloaded. */
    const refuse = async (reason: string | null, retryAfter: string | null = null) => {
      await discard(call)
      return fail(reason, retryAfter)
    }

    if (isNotRelayed(status)) {
      return refuse(null, status >= 500 ? validRetryAfter(upstream.headers.get("retry-after")) : null)
    }

    // A 204, 205 or 304 has no representation, so there is no content type to check and no length to relay.
    const hasRepresentation = !NULL_BODY_STATUSES.has(status)
    const declared = declaredLength(upstream.headers)
    const contentType = upstream.headers.get("content-type")
    let contentSecurityPolicy: string | null = null
    if (hasRepresentation) {
      const type = mediaType(contentType)
      // A comma means more than one value, and a browser keeps the last of them: `text/javascript, text/html`
      // would be read as html.
      if (contentType?.includes(",")) return refuse("content_type_not_allowed")
      if (type === SVG_CONTENT_TYPE) contentSecurityPolicy = SVG_CONTENT_SECURITY_POLICY
      // An answer with no content type is allowed only when it has no body either (a bare 404).
      else if (!ASSET_CONTENT_TYPES.has(type) && !(contentType === null && declared === 0)) {
        return refuse("content_type_not_allowed")
      }
      // Core asked for no encoding. `fetch` decodes one, so a declared length would no longer describe the body.
      if (!isIdentityEncoded(upstream.headers)) return refuse("content_encoding_not_identity")
      // A HEAD is held to the same size as the GET it describes. An answer that declares more than the cap is
      // refused here, before any of it is read.
      if (declared !== null && declared > limits.maxAssetBytes) return refuse("asset_over_cap")
    }

    let payload: Uint8Array<ArrayBuffer> | null = null
    if (method !== "HEAD" && hasRepresentation) {
      try {
        payload = await readCapped(call, limits.maxAssetBytes)
      } catch (err) {
        // Fleet reset the connection or outlasted the timeout after its headers: no partial module is relayed.
        call.abort()
        return fail(err instanceof Error ? err.name : "unknown")
      }
      if (!payload) return fail("asset_over_cap")
      // Fleet promised a length and the body is another: it was cut short, or is not the asset it declared.
      if (declared !== null && payload.byteLength !== declared) return fail("length_mismatch")
    } else {
      await upstream.body?.cancel().catch(() => {})
    }

    // Never a raw `Response` (see `forward`): the answer is built through the context.
    for (const name of ASSET_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) c.header(name, value)
    }
    const vary = upstream.headers.get("vary")
    // Appended: a middleware ahead of this route may have set its own `Vary`, such as `Origin`.
    if (vary) c.header("vary", vary, {append: true})
    if (hasRepresentation) {
      if (contentType) c.header("content-type", contentType)
      if (contentSecurityPolicy) c.header("content-security-policy", contentSecurityPolicy)
      // The length of what is sent; for a HEAD, the length Fleet declared for the body a GET would get.
      if (payload) c.header("content-length", String(payload.byteLength))
      else if (declared !== null) c.header("content-length", String(declared))
    }
    // Replaces the id `requestContext` set: the caller gets Fleet's when Fleet returned one.
    c.header(REQUEST_ID_HEADER, upstreamRequestId || signed.requestId)
    // A 401 from Core means "sign in again" to every client; Fleet's never does, so it is relayed as a 403.
    const relayed = (status === 401 ? 403 : status) as StatusCode
    logged({status: relayed, upstreamStatus: status, upstreamRequestId})
    return c.newResponse(payload, relayed)
  }
}

/** Core's security headers on every answer of the asset route, its own refusals included. */
const assetResponseHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("x-content-type-options", "nosniff")
  c.header("cross-origin-resource-policy", "same-origin")
  await next()
}

const methodNotAllowed: Handler<AppEnv> = c => {
  c.header("allow", "GET, HEAD")
  return c.json({error: "method_not_allowed"}, 405)
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
// The UI assets, ahead of the JSON forwarder and behind the gates above: GET and HEAD relay the asset, any
// other method is a 405. Only the asset route may answer under `ui`; the forwarder refuses it.
adminFleetApi.use(`/${UI_ASSET_SEGMENT}/*`, assetResponseHeaders)
adminFleetApi.on(["GET", "HEAD"], `/${UI_ASSET_SEGMENT}/*`, forwardAsset())
adminFleetApi.all(`/${UI_ASSET_SEGMENT}/*`, methodNotAllowed)
adminFleetApi.all("/*", limitBody, forward("admin"))
