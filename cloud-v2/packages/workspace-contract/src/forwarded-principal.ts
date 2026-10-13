/**
 * Signing and verifying the principal Core attaches to a request it forwards to the Fleet
 * integration. Core signs with {@link signForwardedPrincipal}; the receiver verifies with
 * {@link verifyForwardedPrincipal}, which checks the service signature and the principal signature
 * against the same timestamp and secret before it decodes the principal.
 */
import {createHmac, timingSafeEqual} from "node:crypto"
import {ORGANIZATION_CAPABILITIES, type OrganizationCapability} from "./capabilities"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import {FORWARDED_PRINCIPAL_HEADERS, FORWARDING_SERVICE, type FleetScope, type ForwardedPrincipal} from "./types"

const isBlank = (secret: string) => secret.trim().length === 0

/** base64url HMAC-SHA256 of `<timestampMs>\n<principalHeader>`. Throws on an empty secret. */
function principalSignature(secret: string, timestampMs: number | string, principalHeader: string): string {
  if (isBlank(secret)) throw new Error("A service secret must not be empty")
  return createHmac("sha256", secret).update(`${timestampMs}\n${principalHeader}`).digest("base64url")
}

/**
 * The two principal headers for `principal`: its base64url JSON (`x-mentra-principal`) and the
 * signature binding it to the request's service-signature timestamp (`x-mentra-principal-signature`).
 * Use the same `timestampMs` and secret as the request's `signServiceRequest`.
 */
export function signForwardedPrincipal(input: {secret: string; timestampMs: number; principal: ForwardedPrincipal}): {
  principal: string
  principalSignature: string
} {
  const principal = Buffer.from(JSON.stringify(input.principal)).toString("base64url")
  return {principal, principalSignature: principalSignature(input.secret, input.timestampMs, principal)}
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
 * the principal decodes to one of the {@link ForwardedPrincipal} shapes. Empty or whitespace-only
 * secrets are ignored.
 *
 * Which kinds a route accepts is the caller's decision: `/v1/client` serves phones and `/v1/admin`
 * users.
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

/**
 * `value` as a {@link ForwardedPrincipal}, or null when it is not exactly one. The parse is strict
 * per kind: every documented field must be present and well-typed, and a field the kind does not
 * document (another kind's field, or an unknown one) refuses the principal.
 */
export function parseForwardedPrincipal(value: unknown): ForwardedPrincipal | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case "phone":
      if (
        !hasExactlyKeys(value, ["kind", "mentraUserId", "tenantId", "sessionId", "email"]) ||
        !isId(value.mentraUserId) ||
        typeof value.tenantId !== "string" ||
        typeof value.sessionId !== "string" ||
        !isNullableString(value.email)
      ) {
        return null
      }
      return {
        kind: "phone",
        mentraUserId: value.mentraUserId,
        tenantId: value.tenantId,
        sessionId: value.sessionId,
        email: value.email,
      }
    case "user": {
      if (
        !hasExactlyKeys(value, [
          "kind",
          "mentraUserId",
          "email",
          "emailVerified",
          "isOrganizationAdmin",
          "organizationCapabilities",
          "scope",
        ]) ||
        !isId(value.mentraUserId) ||
        !isNullableString(value.email) ||
        typeof value.emailVerified !== "boolean" ||
        typeof value.isOrganizationAdmin !== "boolean" ||
        !isOrganizationCapabilities(value.organizationCapabilities)
      ) {
        return null
      }
      const scope = parseFleetScope(value.scope)
      if (!scope) return null
      return {
        kind: "user",
        mentraUserId: value.mentraUserId,
        email: value.email,
        emailVerified: value.emailVerified,
        isOrganizationAdmin: value.isOrganizationAdmin,
        organizationCapabilities: [...value.organizationCapabilities],
        scope,
      }
    }
    default:
      return null
  }
}

function parseFleetScope(value: unknown): FleetScope | null {
  if (!isRecord(value)) return null
  if (value.kind === "organization") return hasExactlyKeys(value, ["kind"]) ? {kind: "organization"} : null
  if (value.kind === "workspace") {
    return hasExactlyKeys(value, ["kind", "workspaceId"]) && isId(value.workspaceId)
      ? {kind: "workspace", workspaceId: value.workspaceId}
      : null
  }
  return null
}

type Json = Record<string, unknown>

const KNOWN_ORGANIZATION_CAPABILITIES: ReadonlySet<string> = new Set(ORGANIZATION_CAPABILITIES)

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string"
const isOrganizationCapabilities = (value: unknown): value is OrganizationCapability[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && KNOWN_ORGANIZATION_CAPABILITIES.has(entry))
const hasExactlyKeys = (value: Json, keys: readonly string[]): boolean => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

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
