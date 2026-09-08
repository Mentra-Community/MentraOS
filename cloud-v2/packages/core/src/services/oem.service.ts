/**
 * @fileoverview OEM aggregate. Public-key resolution, OEM JWT verification,
 * replay protection.
 *
 * What this service owns:
 *   - OEM record reads (by tenantId).
 *   - Resolving an OEM's current public key — either parsing a stored PEM
 *     (static mode) or fetching the OEM's JWKS URL via jose's cached fetcher
 *     (JWKS-URL mode).
 *   - End-to-end verification of an OEM-signed JWT: signature + claims
 *     (aud, exp, iat skew).
 *   - Recording accepted OEM JWT `jti` values after session creation.
 *
 * What it does NOT own:
 *   - Issuing Mentra access/refresh tokens (session.service).
 *   - User row creation (user.service).
 *
 * Spec: docs/issues/001-oem-auth/design.md
 *       ("Endpoints" / "Token formats" / "Lifecycles: Issue session" steps 1–5)
 */

import crypto from "node:crypto"
import * as jose from "jose"
import {createLogger, OidcTokenError, verifyOidcToken, type FederatedIdentity} from "@mentra/cloud-shared"
import {EnterpriseOrgModel} from "../models/enterprise-org.model"
import {OemModel, type Oem} from "../models/oem.model"
import {SeenJtiModel} from "../models/seen-jti.model"
import {TrustedIssuerModel, type TrustedIssuer} from "../models/trusted-issuer.model"
import {InvalidGrant, InvalidRequest, OauthServerError, UnauthorizedClient} from "../types/oauth.types"

const logger = createLogger("core").child({service: "oem.service"})

/** Algorithms Mentra accepts on OEM-signed JWTs. `none` is rejected. */
const SUPPORTED_ALGS = ["EdDSA", "RS256", "ES256"] as const
type SupportedAlg = (typeof SUPPORTED_ALGS)[number]
const RESERVED_TENANT_IDS = new Set(["mentra"])

/** Required claim shape on an OEM JWT. */
export interface VerifiedTenantJwt {
  tenantId: string // = `iss`
  tenantUserId: string // = `sub`
  jti?: string
  exp: number // Unix seconds
  iat: number // Unix seconds
  /** Any non-standard claims the OEM passed through (e.g. `oem_display_name`). */
  passthroughClaims: Record<string, unknown>
  federatedIdentity?: FederatedIdentity
}

interface ConfiguredOidcProvider {
  id: string
  protocol: "oidc"
  providerKind: string
  tenantId: string
  issuer: string
  jwksUrl: string
  audience: string
  subjectClaim: string
  directoryTenantClaim?: string
  expectedDirectoryTenantId?: string
  algorithms?: string[]
  requiredScopes?: string[]
  allowedClientIds?: string[]
}

/** Look up an OEM by external `tenantId`. Returns null if unknown. */
export async function getOem(tenantId: string): Promise<Oem | null> {
  return OemModel.findOne({tenantId}).lean()
}

/**
 * Verify an OEM-signed JWT end-to-end. On success, returns the parsed
 * identity claims. On failure, throws an `OauthError` subclass whose
 * `code`/`httpStatus` map to the right RFC 8693 response.
 *
 * Flow (matches design.md "Issue session" steps 1–5):
 *   1. Decode header + payload without verification, read `iss` (tenantId).
 *   2. Look up OEM. Unknown or disabled → `unauthorized_client`.
 *   3. Resolve public key (static PEM or JWKS URL).
 *   4. Verify signature + standard claims (aud, exp, iat skew).
 *   5. Return verified identity; session.service records `jti` only after
 *      the Mentra session is persisted.
 */
export async function verifyTenantJwt(jwt: string): Promise<VerifiedTenantJwt> {
  // Step 1 — peek at iss without verifying. If the JWT is so malformed we
  // can't even decode it, surface invalid_request rather than invalid_grant
  // (the latter implies we tried to verify and rejected).
  let unverified: jose.JWTPayload
  try {
    unverified = jose.decodeJwt(jwt)
  } catch {
    throw new InvalidRequest("subject_token is not a parseable JWT")
  }

  const configuredProvider = configuredOidcProviders().find((provider) => provider.issuer === unverified.iss)
  if (configuredProvider) {
    return verifyConfiguredOidcJwt(jwt, configuredProvider)
  }

  // Enterprise trusted-issuer path. Keyed on the custom (tenantId, env) claims we
  // mint and hand the enterprise — NOT on iss. iss stays an exact HTTPS issuer
  // URL and is still pinned at signature-verification time (see
  // verifySignatureWithTrustedIssuer); it is just no longer the lookup key. A
  // token that carries tenantId is unambiguously an enterprise token, so a lookup
  // miss is a hard failure, not a fall-through to the legacy OEM table.
  const tenantIdClaim = typeof unverified.tenantId === "string" ? unverified.tenantId : null
  if (tenantIdClaim) {
    const env = typeof unverified.env === "string" ? unverified.env : null
    if (!env) throw new InvalidRequest("subject_token missing 'env' claim")
    return verifyTrustedIssuerJwt(jwt, tenantIdClaim, env)
  }

  // Legacy OEM path. Keyed on iss == tenantId, verified against the OEM's
  // registered key (static PEM or JWKS URL).
  const tenantId = typeof unverified.iss === "string" ? unverified.iss : null
  if (!tenantId) throw new InvalidRequest("subject_token missing 'iss' claim")

  // Step 2 — look up OEM, reject if unknown or disabled.
  const oem = await getOem(tenantId)
  if (!oem) throw new UnauthorizedClient(`unknown oem: ${tenantId}`)
  if (oem.disabled) throw new UnauthorizedClient(`oem disabled: ${tenantId}`)

  // Steps 3 + 4 — verify signature and standard claims in one call.
  const {payload} = await verifySignatureWithOemKey(jwt, oem)

  // Required claims beyond what jwtVerify checks for us.
  const sub = typeof payload.sub === "string" ? payload.sub : null
  if (!sub) throw new InvalidGrant("subject_token missing 'sub' claim")

  const jti = typeof payload.jti === "string" ? payload.jti : null
  if (!jti) throw new InvalidGrant("subject_token missing 'jti' claim")

  if (typeof payload.exp !== "number") {
    throw new InvalidGrant("subject_token missing 'exp' claim")
  }
  if (typeof payload.iat !== "number") {
    throw new InvalidGrant("subject_token missing 'iat' claim")
  }

  // Pass through anything that isn't a standard claim, for the audio path or
  // downstream services that want OEM-supplied metadata (e.g. display name).
  const passthroughClaims: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (!STANDARD_CLAIMS.has(k)) passthroughClaims[k] = v
  }

  return {
    tenantId,
    tenantUserId: sub,
    jti,
    exp: payload.exp,
    iat: payload.iat,
    passthroughClaims,
  }
}

export function isConfiguredOidcTenant(tenantId: string): boolean {
  return configuredOidcProviders().some((provider) => provider.tenantId === tenantId)
}

async function verifyConfiguredOidcJwt(jwt: string, provider: ConfiguredOidcProvider): Promise<VerifiedTenantJwt> {
  let payload: jose.JWTPayload
  try {
    payload = await verifyOidcToken(jwt, provider)
  } catch (err) {
    if (err instanceof OidcTokenError) {
      throw new InvalidGrant(err.message)
    }
    throw err
  }

  const subject = stringClaim(payload[provider.subjectClaim])
  if (!subject) {
    throw new InvalidGrant(`subject_token missing '${provider.subjectClaim}' claim`)
  }
  const directoryTenantId = provider.directoryTenantClaim
    ? stringClaim(payload[provider.directoryTenantClaim])
    : undefined
  if (provider.expectedDirectoryTenantId && directoryTenantId !== provider.expectedDirectoryTenantId) {
    throw new InvalidGrant("subject_token directory tenant is not allowed")
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    throw new InvalidGrant("subject_token missing time claims")
  }

  return {
    tenantId: provider.tenantId,
    tenantUserId: subject,
    // Workforce access tokens are reusable bearer tokens, not one-time OEM
    // assertions. Do not consume their provider jti in Mentra's replay table.
    exp: payload.exp,
    iat: payload.iat,
    passthroughClaims: {},
    federatedIdentity: {
      providerId: provider.id,
      providerKind: provider.providerKind,
      issuer: provider.issuer,
      subject,
      ...(directoryTenantId ? {directoryTenantId} : {}),
    },
  }
}

function configuredOidcProviders(): ConfiguredOidcProvider[] {
  const raw = process.env.CLOUD_CORE_OIDC_PROVIDERS
  if (!raw?.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new OauthServerError(`CLOUD_CORE_OIDC_PROVIDERS is invalid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new OauthServerError("CLOUD_CORE_OIDC_PROVIDERS must be an array")
  }
  if (parsed.length > 20) {
    throw new OauthServerError("CLOUD_CORE_OIDC_PROVIDERS may contain at most 20 providers")
  }
  const providers = parsed.map(parseConfiguredOidcProvider)
  for (const field of ["id", "issuer"] as const) {
    const values = providers.map((provider) => provider[field])
    if (new Set(values).size !== values.length) {
      throw new OauthServerError(`OIDC provider ${field} values must be unique`)
    }
  }
  return providers
}

function parseConfiguredOidcProvider(value: unknown, index: number): ConfiguredOidcProvider {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OauthServerError(`OIDC provider ${index} must be an object`)
  }
  const obj = value as Record<string, unknown>
  const required = (name: string): string => {
    const value = stringClaim(obj[name])
    if (!value) {
      throw new OauthServerError(`OIDC provider ${index} missing ${name}`)
    }
    return value
  }
  if (obj.protocol !== "oidc") {
    throw new OauthServerError(`OIDC provider ${index} protocol must be oidc`)
  }
  const issuer = required("issuer")
  const jwksUrl = required("jwksUrl")
  for (const [name, url] of [
    ["issuer", issuer],
    ["jwksUrl", jwksUrl],
  ] as const) {
    try {
      const parsedUrl = new URL(url)
      if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
        throw new Error("not credential-free HTTPS")
      }
    } catch {
      throw new OauthServerError(`OIDC provider ${index} ${name} must be an HTTPS URL`)
    }
  }
  const tenantId = required("tenantId")
  if (RESERVED_TENANT_IDS.has(tenantId)) {
    throw new OauthServerError(`OIDC provider ${index} tenantId is reserved`)
  }
  return {
    id: required("id"),
    protocol: "oidc",
    providerKind: required("providerKind"),
    tenantId,
    issuer,
    jwksUrl,
    audience: required("audience"),
    subjectClaim: stringClaim(obj.subjectClaim) ?? "sub",
    directoryTenantClaim: stringClaim(obj.directoryTenantClaim),
    expectedDirectoryTenantId: stringClaim(obj.expectedDirectoryTenantId),
    algorithms: stringArray(obj.algorithms, index, "algorithms"),
    requiredScopes: stringArray(obj.requiredScopes, index, "requiredScopes"),
    allowedClientIds: stringArray(obj.allowedClientIds, index, "allowedClientIds"),
  }
}

function stringArray(value: unknown, index: number, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new OauthServerError(`OIDC provider ${index} ${name} must be a string array`)
  }
  return value as string[]
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// === Internals ===

const STANDARD_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  // Enterprise routing claims — used to select the trusted issuer, not OEM
  // metadata, so they are excluded from passthroughClaims like the RFC claims.
  "tenantId",
  "env",
])

async function verifySignatureWithOemKey(jwt: string, oem: Oem): Promise<jose.JWTVerifyResult> {
  const verifyOpts: jose.JWTVerifyOptions = {
    audience: "mentra",
    algorithms: [...SUPPORTED_ALGS],
    // jose enforces `exp` and `iat` automatically. Allow 5 min clock skew
    // either side (matches spec's "5 min clock skew" allowance).
    clockTolerance: "5 minutes",
  }

  try {
    if (oem.publicKeyMode === "static") {
      if (!oem.publicKey) {
        throw new OauthServerError(`oem ${oem.tenantId} static-mode but no key on file`)
      }
      const {key, alg} = await importStaticPublicKey(oem.publicKey)
      return await jose.jwtVerify(jwt, key, {...verifyOpts, algorithms: [alg]})
    }

    if (oem.publicKeyMode === "jwks-url") {
      if (!oem.jwksUrl) {
        throw new OauthServerError(`oem ${oem.tenantId} jwks-mode but no url on file`)
      }
      const jwks = getJwksFetcher(oem.jwksUrl)
      return await jose.jwtVerify(jwt, jwks, verifyOpts)
    }

    throw new OauthServerError(`oem ${oem.tenantId} has unknown publicKeyMode`)
  } catch (err) {
    if (err instanceof Error && err.name?.startsWith("JWT")) {
      // jose throws JWTExpired, JWTClaimValidationFailed, JWSSignatureVerificationFailed, etc.
      throw new InvalidGrant(`subject_token rejected: ${err.message}`)
    }
    throw err
  }
}

async function verifyTrustedIssuerJwt(jwt: string, tenantId: string, env: string): Promise<VerifiedTenantJwt> {
  // Resolve the enterprise org from the minted `tenantId` claim (its customer-facing
  // id, EnterpriseOrg.tenantId), then the trusted issuer for that org + `env`. The
  // org must be active and the issuer enabled. iss is not consulted here — it is
  // pinned during signature verification below.
  // tenantId and environmentName are persisted trim+lowercased (see
  // normalizeTenantId / normalizeEnvironmentName in enterprise.service), so the
  // incoming claims must be normalized the same way to match.
  const normalizedOrgId = tenantId.trim().toLowerCase()
  const normalizedEnv = env.trim().toLowerCase()

  const enterpriseOrg = await EnterpriseOrgModel.findOne({
    tenantId: normalizedOrgId,
    status: "active",
  }).lean()
  if (!enterpriseOrg) throw new UnauthorizedClient(`unknown or disabled enterprise org: ${tenantId}`)

  const trustedIssuer = await TrustedIssuerModel.findOne({
    enterpriseOrgId: enterpriseOrg.enterpriseOrgId,
    environmentName: normalizedEnv,
    enabled: true,
  }).lean()
  if (!trustedIssuer) {
    throw new UnauthorizedClient(`no enabled trusted issuer for ${tenantId} / ${env}`)
  }

  const {payload} = await verifySignatureWithTrustedIssuer(jwt, trustedIssuer)
  const subject = payload[trustedIssuer.subjectClaim]
  if (typeof subject !== "string" || subject.length === 0) {
    throw new InvalidGrant(`subject_token missing '${trustedIssuer.subjectClaim}' claim`)
  }

  const jti = typeof payload.jti === "string" ? payload.jti : null
  if (!jti) throw new InvalidGrant("subject_token missing 'jti' claim")
  if (typeof payload.exp !== "number") throw new InvalidGrant("subject_token missing 'exp' claim")
  if (typeof payload.iat !== "number") throw new InvalidGrant("subject_token missing 'iat' claim")

  const passthroughClaims: Record<string, unknown> = {
    enterprise_org_id: enterpriseOrg.enterpriseOrgId,
    trusted_issuer_id: trustedIssuer.trustedIssuerId,
    trusted_issuer_environment: trustedIssuer.environmentName,
  }
  for (const [k, v] of Object.entries(payload)) {
    if (!STANDARD_CLAIMS.has(k)) passthroughClaims[k] = v
  }

  return {
    tenantId: enterpriseOrg.tenantId,
    tenantUserId: subject,
    jti,
    exp: payload.exp,
    iat: payload.iat,
    passthroughClaims,
  }
}

async function verifySignatureWithTrustedIssuer(
  jwt: string,
  trustedIssuer: TrustedIssuer,
): Promise<jose.JWTVerifyResult> {
  try {
    const jwks = getJwksFetcher(trustedIssuer.jwksUrl)
    return await jose.jwtVerify(jwt, jwks, {
      issuer: trustedIssuer.issuer,
      audience: ["cloud-core", "mentra"],
      algorithms: [...SUPPORTED_ALGS],
      clockTolerance: "5 minutes",
    })
  } catch (err) {
    if (err instanceof Error && err.name?.startsWith("JWT")) {
      throw new InvalidGrant(`subject_token rejected: ${err.message}`)
    }
    throw err
  }
}

/**
 * Parse a stored PEM public key into a CryptoKey, auto-detecting the
 * algorithm from the key material. Supports EdDSA (Ed25519), RS256, ES256
 * (P-256). Other curves/types are rejected.
 *
 * We sniff the algorithm via Node's `crypto.createPublicKey` so the OEM
 * portal doesn't have to make the user pick "what algorithm is this" when
 * pasting a PEM — the bytes carry the answer.
 */
async function importStaticPublicKey(pem: string): Promise<{key: jose.KeyLike; alg: SupportedAlg}> {
  const alg = detectAlgFromPem(pem)
  const key = await jose.importSPKI(pem, alg, {extractable: false})
  return {key, alg}
}

function detectAlgFromPem(pem: string): SupportedAlg {
  let keyObj: crypto.KeyObject
  try {
    keyObj = crypto.createPublicKey(pem)
  } catch (err) {
    throw new InvalidGrant(`could not parse public key: ${(err as Error).message}`)
  }
  switch (keyObj.asymmetricKeyType) {
    case "ed25519":
      return "EdDSA"
    case "rsa":
      return "RS256"
    case "ec": {
      const curve = keyObj.asymmetricKeyDetails?.namedCurve
      if (curve === "prime256v1") return "ES256"
      throw new OauthServerError(`unsupported EC curve: ${curve ?? "unknown"}`)
    }
    default:
      throw new OauthServerError(`unsupported key type: ${keyObj.asymmetricKeyType ?? "unknown"}`)
  }
}

/**
 * Per-URL cache of jose remote JWKS fetchers. Each fetcher has its own
 * internal caching (default cool-down + cache TTL) so repeated verifications
 * against the same URL share network state.
 */
const jwksFetchers = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>()

function getJwksFetcher(url: string) {
  let cached = jwksFetchers.get(url)
  if (!cached) {
    cached = jose.createRemoteJWKSet(new URL(url), {
      cooldownDuration: 30_000, // min ms between refetches on miss
      cacheMaxAge: 5 * 60_000, // 5 min cache TTL
    })
    jwksFetchers.set(url, cached)
  }
  return cached
}

/**
 * Record a successful OEM JWT acceptance for replay protection. Call this
 * after the Mentra session is persisted, so a transient session-creation
 * failure does not consume the OEM JWT's one-time `jti`. Throws
 * `invalid_grant` if the same (jti, tenantId) was already recorded — that's a
 * replay attempt.
 */
export async function recordSeenJti(args: {jti: string; tenantId: string; expUnixSec: number}): Promise<void> {
  const expiresAt = new Date(args.expUnixSec * 1000 + 60_000) // +60s buffer
  try {
    await SeenJtiModel.create({jti: args.jti, tenantId: args.tenantId, expiresAt})
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      logger.warn({jti: args.jti, tenantId: args.tenantId}, "replay detected")
      throw new InvalidGrant("subject_token jti has already been used")
    }
    throw err
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as {code?: number}).code === 11000
}
