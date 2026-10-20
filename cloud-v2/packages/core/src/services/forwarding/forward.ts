/**
 * @fileoverview What Core does to forward a request to a service it does not own, and to relay the answer.
 *
 * Core forwards to Fleet (the MFM service) and to the portal modules (billing). Core authenticates the
 * caller, decides what the caller may do and what the request covers, then forwards it with a signed
 * statement of that. Everything below is the same for each of them; what differs is a parameter: the
 * `Upstream` (its URL and secret, the name its lines are logged under, the `error` of Core's 503, its
 * limits) and the caller's `ForwardedPrincipal`, which the route builds from the authenticated caller and
 * from nothing else. The gates, the scope and the paths are the routes' own (`api/fleet/fleet-forwarding.ts`,
 * `api/portal/portal-modules.api.ts`). Assets (the UI module a service serves) are `assets.ts`.
 *
 * What a service receives. Core copies the method, the query, the body and the `content-type` and `accept`
 * headers (the asset route copies two others). Every other inbound header is dropped, so nothing the caller
 * sent under `x-mentra-*`, `authorization` or `cookie` reaches the service. Core then adds, with `<ts>` the
 * request time in milliseconds:
 *
 *  - `x-mentra-service: core`, `x-mentra-service-timestamp: <ts>` and `x-mentra-service-signature`:
 *    `signServiceRequest` from `@mentra/workspace-contract/server` over `<ts>`, the method, the upstream path
 *    with its query (as sent, the base URL's path prefix included) and the body;
 *  - `x-mentra-principal` and `x-mentra-principal-signature` (`FORWARDED_PRINCIPAL_HEADERS`): who is
 *    calling, a `ForwardedPrincipal` as base64url JSON, and its signature with the same secret and `<ts>`
 *    (`signForwardedPrincipal`);
 *  - `x-request-id`: Core's request id.
 *
 * The service verifies all of it with `verifyForwardedPrincipal` from `@mentra/workspace-contract/server`,
 * which checks both signatures against the same timestamp and secret and returns the typed principal. The
 * service knows which Core is calling from the secret it shares with it, so no header names the
 * organization. The service signature does not cover the identity header, so without the principal
 * signature anyone who captured one signed request could replay it with another identity inside the skew
 * window. The two signed strings cannot be mistaken for each other: the service one has three newlines,
 * this one has one, and neither a header value nor a path can contain a newline.
 *
 * Request bodies are treated as UTF-8 text (the services speak JSON): the signature covers the text and the
 * same bytes are sent. A body over `limits.maxBodyBytes` is 413 `{error: "payload_too_large"}`; one that is
 * not valid UTF-8 is 400 `{error: "invalid_body"}`. The path Core signs is the path and query of the URL it
 * sends, taken from the same URL object.
 *
 * What the caller gets. Outcomes, with `<unavailable>` the upstream's `unavailableError`:
 *  - a network error, a timeout, an upstream 5xx, an upstream 3xx other than 304 (redirects are never
 *    followed) or a body over `limits.maxResponseBytes`: 503 `{error: <unavailable>}`. Never an empty success;
 *  - an upstream 401 reaches the caller as a 403 with the service's body: phones and the portals read a 401 as
 *    "your session ended, sign in again", and a service's answer never means that. A service should answer
 *    403 for "not allowed" itself;
 *  - an upstream 2xx whose body is not JSON (a `content-type` other than `application/json`, with or without
 *    parameters, or none): 503, logged at warn with the `reason` `content_type_not_json`. A 204, 205 or 304,
 *    a `HEAD` answer and an empty body have nothing to render and are not checked;
 *  - any other upstream status and body pass through, with `content-type`, `cache-control` and `retry-after`
 *    only. A 204, 205 or 304, and any answer to a `HEAD`, has no body: Core does not read one and adds no
 *    `content-type` of its own.
 * A 503 Core gives for an upstream 5xx repeats the service's `Retry-After` when it is a whole number of seconds.
 *
 * What the browser is told. A portal session cookie is `SameSite=Lax`, so a top-level `GET` to a forwarded
 * route carries it and what comes back is read as a document of the portal's origin. Every answer of a JSON
 * route therefore carries `x-content-type-options: nosniff` and `content-security-policy: default-src 'none';
 * frame-ancestors 'none'; sandbox` (`jsonAnswerHeaders`), Core's own refusals and the service's relayed
 * answers alike, and only JSON is relayed as a success. The labels are set before the gates run and the
 * service cannot replace them: its `content-security-policy` and `x-content-type-options` are not among the
 * headers relayed.
 *
 * Correlation. Core sends the service its request id (`x-request-id`, the id `requestContext` gave this
 * request) and answers with the service's `x-request-id` when it returns one, Core's otherwise. Each request
 * that reaches the service is logged once, as `<label> request forwarded`, with `{audience, reqId,
 * upstreamRequestId, status, ms}`: at debug for a success, at info for an answer the service gave that is not
 * one (a 403, a 429, a 404...), and at warn for what Core could not relay as the service said it (a failure,
 * a timeout, an upstream 401, a success that is not JSON). Never a body, a header, a query or a secret.
 *
 * The answer is built through the context, never returned as a raw `Response`: Hono replaces the context's
 * headers with a raw Response's, and the context holds the caller's rotated portal-session cookie
 * (`principalAuth` sets it before the handler runs). Lose it and the person is signed out a minute after Core
 * rotated their session.
 */

import {createLogger, type Logger} from "@mentra/cloud-shared"
import {
  FORWARDED_PRINCIPAL_HEADERS,
  FORWARDING_SERVICE,
  SERVICE_HEADERS,
  signForwardedPrincipal,
  signServiceRequest,
  type ForwardedPrincipal,
  type ForwardedScope,
} from "@mentra/workspace-contract/server"
import type {MiddlewareHandler} from "hono"
import {bodyLimit} from "hono/body-limit"
import type {StatusCode} from "hono/utils/http-status"
import {ulid} from "ulid"
import type {AppContext, AppEnv} from "../../types/hono.types"
import type {UserPrincipal} from "../signin/principal.service"
import {organizationCapabilities} from "../workspaces/authorization.service"
import {joinUpstreamUrl, type ForwardingLimits} from "./upstream-url"

const logger = createLogger("core")

/** A service Core forwards to, installed and usable. */
export interface Upstream {
  /** The `service` field of the lines Core logs outside a request, such as `fleet-forwarding`. */
  service: string
  /** Names the service in its log lines: `Fleet` gives `Fleet request forwarded`. */
  label: string
  /** The `error` of the 503 Core answers when the service cannot, such as `fleet_unavailable`. */
  unavailableError: string
  baseUrl: URL
  /** The shared secret that signs what Core sends. */
  secret: string
  limits: ForwardingLimits
}

/** One request to forward: where to, and as whom. The route has settled both before it calls. */
export interface ForwardRequest {
  upstream: Upstream
  /** The upstream path after the base URL's prefix, such as `/v1/admin/overview`. The route has checked it with `isSafeSuffix`. */
  path: string
  /** The query as received, with its "?" (or ""). */
  query: string
  /** Who the caller is to the service, as logged: `client`, `admin`, `portal`. */
  audience: string
  /**
   * The caller as the service is told about it, built from the authenticated caller only. Asked for after
   * the request is known to be forwardable, so a refused request costs no lookup. `log` is the request's logger.
   */
  principal(log: Logger): ForwardedPrincipal | Promise<ForwardedPrincipal>
}

/** Core's labels on every answer of a JSON route: data, which nothing may render, frame or run. */
const JSON_ANSWER_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
} as const

/** The only inbound headers copied upstream. Everything else, `x-mentra-*` included, is dropped. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept"] as const

/** The only upstream headers copied back, besides `x-request-id`. */
const PASSED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"] as const

/** The only media type a successful JSON-route answer may have: what the services speak, and nothing a browser renders. */
const JSON_MEDIA_TYPE = "application/json"

/** Statuses that never carry a body. */
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

export const REQUEST_ID_HEADER = "x-request-id"

/**
 * Core's labels on every answer of a JSON route, set ahead of the gates so that their refusals carry them
 * too. They are set on the context, so a relayed answer, a refusal and the caller's rotated session cookie
 * all keep them; the service's headers are copied one by one and none of these is among them.
 */
export const jsonAnswerHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  for (const [name, value] of Object.entries(JSON_ANSWER_HEADERS)) c.header(name, value)
  await next()
}

/**
 * Limits the request body to `maxBytes(c)` before anything reads it. `null` means the request will be
 * answered without reading its body (the service is not installed, not usable or not for this caller), so
 * there is nothing to limit.
 */
export function limitBody(maxBytes: (c: AppContext) => number | null): MiddlewareHandler<AppEnv> {
  return (c, next) => {
    const maxSize = maxBytes(c)
    if (maxSize === null) return next()
    return bodyLimit({maxSize, onError: context => context.json({error: "payload_too_large"}, 413)})(c, next)
  }
}

/** The signed-in person as a service is told about them: who they are, what Core lets them do to the organization, and what this request covers. */
export function forwardedUser(person: UserPrincipal, scope: ForwardedScope): ForwardedPrincipal {
  return {
    kind: "user",
    mentraUserId: person.mentraUserId,
    email: person.email,
    emailVerified: person.emailVerified,
    isOrganizationAdmin: person.isOrganizationAdmin,
    organizationCapabilities: [...organizationCapabilities(person)],
    scope,
  }
}

/**
 * Core's own 503. `retryAfter` is the service's `Retry-After` when it answered with a failure and sent a
 * valid one, so a phone backs off for as long as the service asked rather than for its own guess.
 */
export function unavailable(c: AppContext, upstream: Upstream, retryAfter: string | null = null) {
  if (retryAfter) c.header("retry-after", retryAfter)
  return c.json({error: upstream.unavailableError}, 503)
}

/** A `Retry-After` Core will repeat to a phone: a whole number of seconds, which is all phones read. */
export function validRetryAfter(value: string | null): string | null {
  return value !== null && /^\d{1,9}$/.test(value) ? value : null
}

/** A request in flight to a service, which Core can end. */
export interface UpstreamCall {
  response: Response
  /** Ends the request: its connection closes and whatever is left of the body is not downloaded. */
  abort(): void
}

/**
 * Sends a request to a service. Redirects are never followed, and one signal covers the wait for the answer
 * and the read of its body (`timeoutMs`). Every route ends a request it stops reading through `abort`, here
 * and nowhere else: cancelling a response body does not close the connection (Bun's `fetch` keeps downloading
 * until the answer is complete or the timeout fires), aborting the request does.
 */
export async function fetchUpstream(
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
export async function discard(call: UpstreamCall): Promise<void> {
  call.abort()
  await call.response.body?.cancel().catch(() => {})
}

/**
 * The body of `call` as bytes, or null once it passes `limit`: a declared length over it is refused
 * before anything is read, and a stream with no (or a wrong) length is ended as soon as it is over.
 */
export async function readCapped(call: UpstreamCall, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
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

/** The request's logger: the one `requestContext` bound to the request id, or Core's own when there is none. */
export function requestLogger(c: AppContext, upstream: Upstream, requestId: string): Logger {
  return c.get("logger") ?? logger.child({service: upstream.service, reqId: requestId})
}

/** A request as sent to the service: the one URL that is signed and sent, with the headers that carry the signatures. */
export interface SignedRequest {
  target: URL
  headers: Headers
  requestId: string
}

/**
 * The request to send for `request`: the service's URL for the path, the inbound headers named in `copy` (and
 * no others), and Core's signatures and request id. The signature covers the method, the path and query of
 * that URL, and `body`.
 */
export async function signRequest(
  c: AppContext,
  request: ForwardRequest,
  wire: {method: string; body: string; copy: readonly string[]},
): Promise<SignedRequest> {
  const {upstream} = request
  const requestId = c.get("reqId") ?? ulid()
  const principal = await request.principal(requestLogger(c, upstream, requestId))
  // The one URL that is signed and sent, so the signature covers exactly the path and query on the wire.
  const target = joinUpstreamUrl(upstream.baseUrl, request.path, request.query)
  const timestampMs = Date.now()

  const headers = new Headers()
  for (const name of wire.copy) {
    const value = c.req.header(name)
    if (value) headers.set(name, value)
  }
  headers.set(SERVICE_HEADERS.service, FORWARDING_SERVICE)
  headers.set(SERVICE_HEADERS.timestamp, String(timestampMs))
  headers.set(
    SERVICE_HEADERS.signature,
    signServiceRequest({
      secret: upstream.secret,
      method: wire.method,
      pathWithQuery: target.pathname + target.search,
      body: wire.body,
      timestampMs,
    }),
  )
  const signed = signForwardedPrincipal({secret: upstream.secret, timestampMs, principal})
  headers.set(FORWARDED_PRINCIPAL_HEADERS.principal, signed.principal)
  headers.set(FORWARDED_PRINCIPAL_HEADERS.principalSignature, signed.principalSignature)
  headers.set(REQUEST_ID_HEADER, requestId)
  return {target, headers, requestId}
}

/** What one forwarded request came to. `reason` names what failed, never what was said. */
export interface Outcome {
  status: number
  upstreamStatus: number | null
  upstreamRequestId: string | null
  reason?: string
}

/** The log line for a forwarded request, once: `{reqId, upstreamRequestId, status, ms}` and nothing else of it. */
export function outcomeLogger(log: Logger, upstream: Upstream, audience: string): (outcome: Outcome) => void {
  const started = performance.now()
  return outcome => {
    const fields = {audience, ...outcome, ms: Math.round(performance.now() - started)}
    // A success is routine (debug). An answer the service gave that is not one (a 403 for a signature it
    // refused, a 429, a 404) is relayed as it is and logged at info, so it shows at the production log
    // level. What Core could not relay as the service said it (a failure, a redirect, an oversized body, a
    // 401 turned into a 403, no answer at all) is a warning.
    const relayedAsIs = outcome.status === outcome.upstreamStatus
    const success = outcome.status >= 200 && outcome.status < 300
    const level = !relayedAsIs ? "warn" : success || outcome.status === 304 ? "debug" : "info"
    log[level](fields, `${upstream.label} request forwarded`)
  }
}

/** An upstream status Core does not relay: a failure, or a redirect it never follows (it relays a 304). */
export function isNotRelayed(status: number): boolean {
  return status >= 500 || (status >= 300 && status < 400 && status !== 304)
}

/** The media type of a `content-type`: lowercase, no parameters (`Text/JavaScript; charset=x` is `text/javascript`). */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase()
}

/** Whether a `content-type` is JSON: `application/json` with or without parameters, and a single value (a comma means a list). */
function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && !contentType.includes(",") && mediaType(contentType) === JSON_MEDIA_TYPE
}

/**
 * Forwards `request` to its service and relays the answer, by the rules in the file header. The route has
 * settled who is calling, whether the service is usable and the path; this reads the body (its limit and
 * encoding), signs, sends and maps the answer.
 */
export async function forwardJson(c: AppContext, request: ForwardRequest): Promise<Response> {
  const {upstream} = request
  const {limits} = upstream

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
  const {target, headers, requestId} = await signRequest(c, request, {method, body, copy: FORWARDED_REQUEST_HEADERS})
  const logged = outcomeLogger(requestLogger(c, upstream, requestId), upstream, request.audience)

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
    const answer = call.response
    status = answer.status
    upstreamHeaders = answer.headers
    const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
    if (isNotRelayed(status)) {
      // Not an answer Core relays: a failure, or a redirect it never follows.
      await discard(call)
      logged({status: 503, upstreamStatus: status, upstreamRequestId})
      // The service's own backoff (it sends one on an outage and while it shuts down) belongs to a failure, not to a redirect.
      return unavailable(c, upstream, status >= 500 ? validRetryAfter(upstreamHeaders.get("retry-after")) : null)
    }
    if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
      // No body to relay. A HEAD answer's `content-length` describes the body a GET would get, so it
      // is not checked against the response cap either.
      await answer.body?.cancel()
    } else {
      payload = await readCapped(call, limits.maxResponseBytes)
      if (!payload) {
        logged({status: 503, upstreamStatus: status, upstreamRequestId})
        return unavailable(c, upstream)
      }
      // A success is JSON or it is not the service's API: what the caller's browser could render as a page is
      // not relayed. An empty body has nothing to render. An error answer is relayed as the service gave it,
      // under the labels every answer carries.
      if (status >= 200 && status < 300 && payload.byteLength > 0 && !isJsonContentType(upstreamHeaders.get("content-type"))) {
        logged({status: 503, upstreamStatus: status, upstreamRequestId, reason: "content_type_not_json"})
        return unavailable(c, upstream)
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
    return unavailable(c, upstream)
  }

  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name)
    if (value) c.header(name, value)
  }
  const upstreamRequestId = upstreamHeaders.get(REQUEST_ID_HEADER)
  // Replaces the id `requestContext` set: the caller gets the service's when it returned one.
  c.header(REQUEST_ID_HEADER, upstreamRequestId || requestId)
  // A 401 from Core means "sign in again" to every client; a service's never does, so it is relayed as a 403.
  const relayed = status === 401 ? 403 : status
  logged({status: relayed, upstreamStatus: status, upstreamRequestId})
  return c.newResponse(payload, relayed as StatusCode)
}
