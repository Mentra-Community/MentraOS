/**
 * @fileoverview The UI assets a service Core forwards to serves, relayed through Core.
 *
 * Fleet and the portal modules each serve a UI module (`ui/entry.js` and what it loads) that a portal page
 * imports. `GET` and `HEAD` `<mount>/ui/<rest>` have a route of their own, ahead of the JSON forwarder and
 * behind the same gates. It relays the module the portal imports through Core, so that it loads from the
 * portal's own origin under `script-src 'self'`, and what it relays therefore runs there. The rules differ
 * from the JSON routes' (`forward.ts`):
 *  - any other method is 405 (`Allow: GET, HEAD`, `methodNotAllowed`). Nothing under `ui` is ever relayed by
 *    the JSON rules;
 *  - the service receives `if-none-match` and `if-modified-since` from the caller and no other header of
 *    theirs, plus Core's `accept-encoding: identity` (outside the signature) so the bytes Core relays are the
 *    bytes the service sent. The request is signed and carries the principal like any other;
 *  - the caller gets `content-type`, `etag`, `last-modified`, `cache-control` and `vary` (added to any `Vary`
 *    already on the response), `content-length` (the length of the body it gets) and `x-request-id`. Core adds
 *    `x-content-type-options: nosniff` and `cross-origin-resource-policy: same-origin` to every answer of the
 *    route, its own refusals included (`assetResponseHeaders`). The JSON routes' sandbox policy is on the
 *    route's own JSON refusals but not on a relayed asset, which has to run in the portal: it carries only
 *    SVG's policy, below;
 *  - the content type is checked first, for an error answer too: `text/javascript`, `application/javascript`,
 *    `text/css`, `image/png|jpeg|webp|gif|avif`, `font/woff2|woff` and `application/json` are relayed as the
 *    service sent them. `image/svg+xml` is relayed under Core's own `content-security-policy: default-src
 *    'none'; style-src 'unsafe-inline'`, which replaces any the service sent. Anything else, `text/html`
 *    above all, is a 503; so is a value holding a comma (a browser keeps the last of several, so
 *    `text/javascript, text/html` would be read as html) and an answer with no content type, unless it
 *    declares an empty body. A 204, 205 or 304 has no representation, so it is relayed with its validators and
 *    is not checked;
 *  - the body is read whole and checked before any of it is relayed; it is not streamed. The status is final
 *    once the headers are out, and Bun turns a stream that fails (a short body, a reset, a timeout, the cap)
 *    into a normal end of the response, without the declared length, so a browser would take a truncated
 *    module for a complete, cacheable 200 with the service's `etag` and `cache-control`. Core reads under
 *    `limits.maxAssetBytes` (not the JSON routes' response cap) and `limits.timeoutMs` (the wait for the
 *    answer and the read of the whole body), and answers only when the body is complete and as long as the
 *    `content-length` the service declared. Otherwise the answer is a 503 `{error: <unavailable>}` with none
 *    of the service's headers, logged at warn with a `reason`: a declared length over the cap (a HEAD's
 *    included, refused before any of the body is read), a body over the cap with no (or a wrong) length, a
 *    body of another length than declared, a service that resets the connection or stalls past the timeout
 *    after its headers, and any `content-encoding` but `identity` (Core asks for none; `fetch` would decode
 *    it and the declared length would no longer describe the body). Core sets the true `content-length`
 *    itself, from the bytes it holds;
 *  - a request Core stops reading (these refusals, and the JSON routes' over-cap, 5xx and redirect answers)
 *    is aborted, not just cancelled: see `fetchUpstream`;
 *  - everything else (a 5xx, a redirect, a 401 turned into a 403, a network error, a timeout before the
 *    headers) and its logging are the JSON forwarder's.
 */

import type {MiddlewareHandler} from "hono"
import type {StatusCode} from "hono/utils/http-status"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {
  discard,
  fetchUpstream,
  isNotRelayed,
  mediaType,
  NULL_BODY_STATUSES,
  outcomeLogger,
  readCapped,
  REQUEST_ID_HEADER,
  requestLogger,
  signRequest,
  unavailable,
  validRetryAfter,
  type ForwardRequest,
  type UpstreamCall,
} from "./forward"

/** The first path segment under a mount that holds a service's UI assets. */
export const UI_ASSET_SEGMENT = "ui"

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

/** Core's security headers on every answer of the asset route, its own refusals included. */
export const assetResponseHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("x-content-type-options", "nosniff")
  c.header("cross-origin-resource-policy", "same-origin")
  await next()
}

/** The answer to any method but `GET` and `HEAD` on the asset route. */
export const methodNotAllowed = (c: AppContext) => {
  c.header("allow", "GET, HEAD")
  return c.json({error: "method_not_allowed"}, 405)
}

/** A content-length that is a plain count of bytes, or null when there is none (or it is not one). */
function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim()
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null
}

/** Whether the body is sent as it is (no content-encoding), so a declared length is the length of what is relayed. */
function isIdentityEncoded(headers: Headers): boolean {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase()
  return !encoding || encoding === "identity"
}

/**
 * Relays one UI asset: `request` is sent as a `GET` or `HEAD` (the caller's method), by the rules in the file
 * header. The route has settled who is calling, whether the service is usable and the path.
 *
 * The body is read whole, under the cap and the timeout, and checked against the length the service declared
 * before a byte of it is relayed. It is not streamed: see the header.
 */
export async function relayAsset(c: AppContext, request: ForwardRequest): Promise<Response> {
  const {upstream} = request
  const {limits} = upstream

  const method = c.req.method
  const signed = await signRequest(c, request, {method, body: "", copy: ASSET_REQUEST_HEADERS})
  // Not covered by the signature. The bytes Core relays are the bytes the service sent, so the length it declares
  // is the length of what the caller gets; a service that encodes anyway is refused below.
  signed.headers.set("accept-encoding", "identity")
  const logged = outcomeLogger(requestLogger(c, upstream, signed.requestId), upstream, request.audience)

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
    return unavailable(c, upstream)
  }

  const answer = call.response
  const status = answer.status
  const upstreamRequestId = answer.headers.get(REQUEST_ID_HEADER)
  /** Core's 503 instead of the answer, with none of the service's headers; a warning, as Core did not relay what it said. */
  const fail = (reason: string | null, retryAfter: string | null = null) => {
    logged({status: 503, upstreamStatus: status, upstreamRequestId, ...(reason ? {reason} : {})})
    return unavailable(c, upstream, retryAfter)
  }
  /** The same, for an answer that is not read: the request is ended and its body is never downloaded. */
  const refuse = async (reason: string | null, retryAfter: string | null = null) => {
    await discard(call)
    return fail(reason, retryAfter)
  }

  if (isNotRelayed(status)) {
    return refuse(null, status >= 500 ? validRetryAfter(answer.headers.get("retry-after")) : null)
  }

  // A 204, 205 or 304 has no representation, so there is no content type to check and no length to relay.
  const hasRepresentation = !NULL_BODY_STATUSES.has(status)
  const declared = declaredLength(answer.headers)
  const contentType = answer.headers.get("content-type")
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
    if (!isIdentityEncoded(answer.headers)) return refuse("content_encoding_not_identity")
    // A HEAD is held to the same size as the GET it describes. An answer that declares more than the cap is
    // refused here, before any of it is read.
    if (declared !== null && declared > limits.maxAssetBytes) return refuse("asset_over_cap")
  }

  let payload: Uint8Array<ArrayBuffer> | null = null
  if (method !== "HEAD" && hasRepresentation) {
    try {
      payload = await readCapped(call, limits.maxAssetBytes)
    } catch (err) {
      // The service reset the connection or outlasted the timeout after its headers: no partial module is relayed.
      call.abort()
      return fail(err instanceof Error ? err.name : "unknown")
    }
    if (!payload) return fail("asset_over_cap")
    // The service promised a length and the body is another: it was cut short, or is not the asset it declared.
    if (declared !== null && payload.byteLength !== declared) return fail("length_mismatch")
  } else {
    await answer.body?.cancel().catch(() => {})
  }

  // Never a raw `Response` (see `forwardJson`): the answer is built through the context.
  for (const name of ASSET_RESPONSE_HEADERS) {
    const value = answer.headers.get(name)
    if (value) c.header(name, value)
  }
  const vary = answer.headers.get("vary")
  // Appended: a middleware ahead of this route may have set its own `Vary`, such as `Origin`.
  if (vary) c.header("vary", vary, {append: true})
  if (hasRepresentation) {
    if (contentType) c.header("content-type", contentType)
    // The length of what is sent; for a HEAD, the length the service declared for the body a GET would get.
    if (payload) c.header("content-length", String(payload.byteLength))
    else if (declared !== null) c.header("content-length", String(declared))
  }
  // A relayed asset runs in the portal, so the JSON routes' sandbox policy (set ahead of the gates) must not
  // stay on it: it carries SVG's own policy, which replaces any the service sent, or none.
  c.header("content-security-policy", contentSecurityPolicy ?? undefined)
  // Replaces the id `requestContext` set: the caller gets the service's when it returned one.
  c.header(REQUEST_ID_HEADER, upstreamRequestId || signed.requestId)
  // A 401 from Core means "sign in again" to every client; a service's never does, so it is relayed as a 403.
  const relayed = (status === 401 ? 403 : status) as StatusCode
  logged({status: relayed, upstreamStatus: status, upstreamRequestId})
  return c.newResponse(payload, relayed)
}
