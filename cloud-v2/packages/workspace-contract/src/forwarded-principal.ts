/**
 * Signing and verifying the principal Core attaches to a request it forwards to the Fleet
 * integration. Core signs with {@link signForwardedPrincipal}; the receiver verifies with
 * {@link verifyForwardedPrincipal}, which checks the service signature and the principal signature
 * against the same timestamp and secret before it decodes the principal.
 */
import {createHmac, timingSafeEqual} from "node:crypto"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import {FORWARDED_PRINCIPAL_HEADERS, FORWARDING_SERVICE, type ForwardedPrincipal} from "./types"

const isBlank = (secret: string) => secret.trim().length === 0

/** base64url HMAC-SHA256 of `<timestampMs>\n<principalHeader>`. Throws on an empty secret. */
function principalSignature(secret: string, timestampMs: number | string, principalHeader: string): string {
  if (isBlank(secret)) throw new Error("A service secret must not be empty")
  return createHmac("sha256", secret).update(`${timestampMs}\n${principalHeader}`).digest("base64url")
}

/**
 * The two principal headers for `principal`: its base64url JSON and the signature binding it to the
 * request's service-signature timestamp. Use the same `timestampMs` and secret as the request's
 * `signServiceRequest`.
 */
export function signForwardedPrincipal(input: {secret: string; timestampMs: number; principal: ForwardedPrincipal}): {
  principal: string
  signature: string
} {
  const principal = Buffer.from(JSON.stringify(input.principal)).toString("base64url")
  return {principal, signature: principalSignature(input.secret, input.timestampMs, principal)}
}

export interface ForwardedRequest {
  method: string
  /** The URL path and query exactly as received; Core signs the path it sent, any Fleet path prefix included. */
  pathWithQuery: string
  /** The body text exactly as received; `""` when there is none. */
  body: string
  /** The request headers: a `Headers`, or a plain object such as Node's `IncomingHttpHeaders`. */
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

export interface VerifyForwardedPrincipalOptions {
  /** Defaults to `Date.now()`. */
  nowMs?: number
  /** Allowed clock skew; defaults to the service signature's 60 seconds. */
  maxSkewMs?: number
}

/**
 * The principal of a request Core forwarded, or null unless all of this holds: `x-mentra-service` is
 * `core`; the service signature verifies (method, path with query, body, timestamp within the skew)
 * with one of `secrets`; the principal signature verifies with that same secret and timestamp; and
 * the principal decodes to one of the {@link ForwardedPrincipal} shapes. Only the documented fields
 * are returned. Empty or whitespace-only secrets are ignored.
 *
 * Which kinds a route accepts is the caller's decision: `/v1/client` serves phones and `/v1/admin`
 * users and credentials.
 */
export function verifyForwardedPrincipal(
  request: ForwardedRequest,
  secrets: readonly string[],
  options: VerifyForwardedPrincipalOptions = {},
): ForwardedPrincipal | null {
  const header = headerReader(request.headers)
  const service = header(SERVICE_HEADERS.service)
  const timestamp = header(SERVICE_HEADERS.timestamp)
  const serviceSignature = header(SERVICE_HEADERS.signature)
  const principalHeader = header(FORWARDED_PRINCIPAL_HEADERS.principal)
  const givenPrincipalSignature = header(FORWARDED_PRINCIPAL_HEADERS.principalSignature)
  if (service !== FORWARDING_SERVICE || !timestamp || !serviceSignature || !principalHeader || !givenPrincipalSignature) {
    return null
  }
  // The timestamp both signatures cover, spelled exactly as Core sent it.
  if (!/^[1-9]\d{0,15}$/.test(timestamp)) return null
  const timestampMs = Number(timestamp)

  const given = Buffer.from(givenPrincipalSignature)
  let verified = false
  for (const secret of secrets.filter((candidate) => !isBlank(candidate))) {
    const serviceOk = verifyServiceRequest({
      method: request.method,
      pathWithQuery: request.pathWithQuery,
      body: request.body,
      timestampMs,
      signature: serviceSignature,
      secrets: [secret],
      nowMs: options.nowMs ?? Date.now(),
      maxSkewMs: options.maxSkewMs,
    })
    const expected = Buffer.from(principalSignature(secret, timestamp, principalHeader))
    const principalOk = expected.length === given.length && timingSafeEqual(expected, given)
    if (serviceOk && principalOk) verified = true
  }
  if (!verified) return null

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(principalHeader, "base64url").toString("utf8"))
  } catch {
    return null
  }
  return parseForwardedPrincipal(decoded)
}

/** `value` as a {@link ForwardedPrincipal} with only its documented fields, or null when it is not one. */
export function parseForwardedPrincipal(value: unknown): ForwardedPrincipal | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case "phone":
      if (!isId(value.mentraUserId) || typeof value.tenantId !== "string" || typeof value.sessionId !== "string") {
        return null
      }
      return {kind: "phone", mentraUserId: value.mentraUserId, tenantId: value.tenantId, sessionId: value.sessionId}
    case "user":
      if (
        !isId(value.mentraUserId) ||
        (value.email !== null && typeof value.email !== "string") ||
        typeof value.emailVerified !== "boolean" ||
        typeof value.isOrganizationAdmin !== "boolean"
      ) {
        return null
      }
      return {
        kind: "user",
        mentraUserId: value.mentraUserId,
        email: value.email,
        emailVerified: value.emailVerified,
        isOrganizationAdmin: value.isOrganizationAdmin,
      }
    case "credential":
      if (
        !isId(value.credentialId) ||
        (value.credentialKind !== "workspace" && value.credentialKind !== "organization") ||
        (value.workspaceId !== null && typeof value.workspaceId !== "string") ||
        !isStringArray(value.scopes) ||
        !isStringArray(value.packageNames)
      ) {
        return null
      }
      return {
        kind: "credential",
        credentialId: value.credentialId,
        credentialKind: value.credentialKind,
        workspaceId: value.workspaceId,
        scopes: [...value.scopes],
        packageNames: [...value.packageNames],
      }
    default:
      return null
  }
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

/** A case-insensitive single-value header lookup; a repeated header counts as missing. */
function headerReader(headers: ForwardedRequest["headers"]): (name: string) => string | undefined {
  if (headers instanceof Headers) return (name) => headers.get(name) ?? undefined
  const lowered = new Map<string, string | readonly string[] | undefined>()
  for (const [name, value] of Object.entries(headers)) lowered.set(name.toLowerCase(), value)
  return (name) => {
    const value = lowered.get(name)
    return typeof value === "string" ? value : undefined
  }
}
