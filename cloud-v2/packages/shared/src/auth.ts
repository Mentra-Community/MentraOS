/**
 * @fileoverview Mentra access-token verification, shared across packages.
 *
 * Pure-crypto: signature + claims. **Does not check revocation.** Revocation
 * lives in core's Mongo, and only core's wrapper consults it. Other packages
 * (audio, proxy) accept up-to-1h staleness on revoked access tokens — the
 * actual revocation surface is the refresh token, which core owns.
 *
 * Both Mentra-issued private and public keys are PEM bodies (base64, no
 * BEGIN/END wrapper) in env. See cloud-v2/docs/issues/001-oem-auth/design.md
 * "Mentra-issued access token" for the claim shape.
 */

import crypto from "node:crypto";
import * as jose from "jose";

const ALG = "EdDSA";
const CORE_ISSUER = "cloud-core";
const CORE_AUDIENCE = "cloud-core";

export interface VerifiedAccessToken {
  mentraUserId: string;
  tenantId: string;
  sessionId: string;
  jti: string;
}

/**
 * Thrown when an access token fails signature or claim verification. Marker
 * class so callers can catch via `instanceof AccessTokenError` without
 * coupling to specific error messages.
 */
export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenError";
  }
}

let publicKeyPromise: Promise<jose.KeyLike> | null = null;
const RUNTIME_DEFAULT_AUDIENCE = "cloud-runtime";
const RUNTIME_DEFAULT_ALGORITHMS = ["EdDSA", "RS256", "ES256"] as const;

interface RuntimeIssuerConfig {
  issuer: string;
  jwksUrl?: string;
  publicKey?: string;
  publicKeyEnv?: string;
  userIdClaim?: string;
  tenantIdClaim?: string;
  legacyTenantIdClaim?: string;
  fixedTenantId?: string;
  algorithms?: string[];
}

const runtimeRemoteJwks = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();
const runtimeStaticKeys = new Map<string, Promise<jose.KeyLike>>();

/** Reset the cached public key. Test-only — call after mutating env. */
export function resetMentraKeyCache(): void {
  publicKeyPromise = null;
  resetRuntimeAuthCache();
}

async function getPublicKey(): Promise<jose.KeyLike> {
  if (!publicKeyPromise) {
    const pubBody = process.env.MENTRA_JWT_PUBLIC_KEY;
    if (!pubBody) {
      throw new AccessTokenError("env var MENTRA_JWT_PUBLIC_KEY is not set");
    }
    const pem = `-----BEGIN PUBLIC KEY-----\n${pubBody}\n-----END PUBLIC KEY-----`;
    publicKeyPromise = jose.importSPKI(pem, ALG, { extractable: false });
  }
  return publicKeyPromise;
}

/**
 * Verify signature, issuer, audience, and expiry on a Mentra-issued access
 * token. Throws `AccessTokenError` on failure. Does NOT check the revocation
 * blacklist — see file header.
 */
export async function verifyAccessTokenSignature(
  token: string,
): Promise<VerifiedAccessToken> {
  const publicKey = await getPublicKey();

  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, publicKey, {
      audience: CORE_AUDIENCE,
      issuer: CORE_ISSUER,
      algorithms: [ALG],
    });
    payload = result.payload;
  } catch (err) {
    throw new AccessTokenError(
      `access_token rejected: ${(err as Error).message}`,
    );
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : null;
  const jti = typeof payload.jti === "string" ? payload.jti : null;

  const missingClaims = [
    !sub ? "sub" : null,
    !tenantId ? "tenant_id" : null,
    !sessionId ? "session_id" : null,
    !jti ? "jti" : null,
  ].filter((claim): claim is string => Boolean(claim));
  if (missingClaims.length > 0) {
    throw new AccessTokenError(`access_token missing required claims: ${missingClaims.join(", ")}`);
  }

  return { mentraUserId: sub!, tenantId: tenantId!, sessionId: sessionId!, jti: jti! };
}

export async function verifyRuntimeToken(
  token: string,
): Promise<VerifiedAccessToken> {
  const issuers = configuredRuntimeIssuers();
  if (issuers.length === 0) {
    throw new AccessTokenError("runtime auth issuer config is required");
  }

  let payload: jose.JWTPayload;
  let iss: string | undefined;
  try {
    payload = jose.decodeJwt(token);
    iss = typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    throw new AccessTokenError("runtime_token is not a parseable JWT");
  }

  const issuer = issuers.find((entry) => entry.issuer === iss);
  if (!issuer) {
    throw new AccessTokenError(`runtime_token issuer not trusted: ${iss ?? "missing"}`);
  }

  const key = await runtimeKeyForIssuer(issuer);
  try {
    const result = await jose.jwtVerify(token, key as jose.JWTVerifyGetKey, {
      audience: process.env.CLOUD_RUNTIME_AUTH_AUDIENCE ?? RUNTIME_DEFAULT_AUDIENCE,
      issuer: issuer.issuer,
      algorithms: issuer.algorithms ?? [...RUNTIME_DEFAULT_ALGORITHMS],
      clockTolerance: "5 minutes",
    });
    payload = result.payload;
  } catch (err) {
    throw new AccessTokenError(
      `runtime_token rejected: ${(err as Error).message}`,
    );
  }

  const userIdClaim = issuer.userIdClaim ?? "sub";
  const userId = stringClaim(payload[userIdClaim]);
  const tenantId =
    issuer.fixedTenantId ??
    stringClaim(payload[issuer.tenantIdClaim ?? "tenant_id"]) ??
    (issuer.legacyTenantIdClaim
      ? stringClaim(payload[issuer.legacyTenantIdClaim])
      : undefined);
  const jti = stringClaim(payload.jti) ?? cryptoRandomId();
  const sessionId = stringClaim(payload.session_id) ?? `runtime_${jti}`;

  if (!userId || !tenantId) {
    throw new AccessTokenError("runtime_token missing required identity claims");
  }

  return { mentraUserId: userId, tenantId, sessionId, jti };
}

export async function signRuntimeToken(args: {
  privateKey: string;
  issuer: string;
  audience?: string;
  subject: string;
  tenantId: string;
  sessionId?: string;
  jti?: string;
  expiresInSeconds: number;
  kid?: string;
}): Promise<string> {
  const privateKey = await jose.importPKCS8(
    toPrivatePem(args.privateKey),
    "EdDSA",
    { extractable: false },
  );
  const claims: jose.JWTPayload = {
    tenant_id: args.tenantId,
  };
  if (args.sessionId) claims.session_id = args.sessionId;
  const jwt = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: args.kid ?? "cloud-runtime-1" })
    .setIssuer(args.issuer)
    .setAudience(args.audience ?? RUNTIME_DEFAULT_AUDIENCE)
    .setSubject(args.subject)
    .setIssuedAt()
    .setExpirationTime(`${args.expiresInSeconds}s`);
  if (args.jti) jwt.setJti(args.jti);
  return jwt.sign(privateKey);
}

export function resetRuntimeAuthCache(): void {
  runtimeRemoteJwks.clear();
  runtimeStaticKeys.clear();
}

export function assertRuntimeAuthConfigured(): void {
  const issuers = configuredRuntimeIssuers();
  if (issuers.length === 0) {
    throw new AccessTokenError(
      [
        "CLOUD_RUNTIME_AUTH_ISSUERS must configure at least one issuer.",
        "For local Cloud V2 development, run `bun run dev` from cloud-v2.",
        "That command starts the integrated dev stack and generates matching local Core/Runtime auth keys.",
        "Use `bun run dev:runtime` only when intentionally running Runtime in isolation with CLOUD_RUNTIME_AUTH_ISSUERS set yourself.",
      ].join(" "),
    );
  }
}

function configuredRuntimeIssuers(): RuntimeIssuerConfig[] {
  const raw = process.env.CLOUD_RUNTIME_AUTH_ISSUERS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("expected array");
    return parsed.map(parseRuntimeIssuerConfig);
  } catch (err) {
    throw new AccessTokenError(
      `CLOUD_RUNTIME_AUTH_ISSUERS is invalid: ${(err as Error).message}`,
    );
  }
}

function parseRuntimeIssuerConfig(value: unknown): RuntimeIssuerConfig {
  if (!value || typeof value !== "object") {
    throw new Error("issuer config must be an object");
  }
  const obj = value as Record<string, unknown>;
  const issuer = stringClaim(obj.issuer);
  if (!issuer) throw new Error("issuer config missing issuer");

  const legacyTenantIdClaim = stringClaim(obj.oemIdClaim);
  const legacyFixedTenantId = stringClaim(obj.fixedOemId);
  const tenantIdClaim = stringClaim(obj.tenantIdClaim) ?? (legacyTenantIdClaim ? "tenant_id" : undefined);
  const fixedTenantId = stringClaim(obj.fixedTenantId) ?? legacyFixedTenantId;
  if (!tenantIdClaim && !fixedTenantId) {
    throw new Error(`issuer ${issuer} must set tenantIdClaim or fixedTenantId`);
  }
  if (tenantIdClaim && fixedTenantId) {
    throw new Error(`issuer ${issuer} cannot set both tenantIdClaim and fixedTenantId`);
  }

  const algorithms = Array.isArray(obj.algorithms)
    ? obj.algorithms.filter((v): v is string => typeof v === "string")
    : undefined;

  return {
    issuer,
    jwksUrl: stringClaim(obj.jwksUrl),
    publicKey: stringClaim(obj.publicKey),
    publicKeyEnv: stringClaim(obj.publicKeyEnv),
    userIdClaim: stringClaim(obj.userIdClaim),
    tenantIdClaim,
    legacyTenantIdClaim,
    fixedTenantId,
    algorithms,
  };
}

async function runtimeKeyForIssuer(
  issuer: RuntimeIssuerConfig,
): Promise<jose.KeyLike | ReturnType<typeof jose.createRemoteJWKSet>> {
  if (issuer.jwksUrl) {
    let jwks = runtimeRemoteJwks.get(issuer.jwksUrl);
    if (!jwks) {
      jwks = jose.createRemoteJWKSet(new URL(issuer.jwksUrl), {
        cooldownDuration: 30_000,
        cacheMaxAge: 5 * 60_000,
      });
      runtimeRemoteJwks.set(issuer.jwksUrl, jwks);
    }
    return jwks;
  }

  const keyMaterial = issuer.publicKey ?? (issuer.publicKeyEnv ? process.env[issuer.publicKeyEnv] : undefined);
  if (!keyMaterial) {
    throw new AccessTokenError(`issuer ${issuer.issuer} has no key source`);
  }

  let key = runtimeStaticKeys.get(keyMaterial);
  if (!key) {
    key = jose.importSPKI(
      toPublicPem(keyMaterial),
      issuer.algorithms?.[0] ?? "EdDSA",
      { extractable: false },
    );
    runtimeStaticKeys.set(keyMaterial, key);
  }
  return key;
}

function toPublicPem(value: string): string {
  if (value.includes("BEGIN PUBLIC KEY")) return value;
  return `-----BEGIN PUBLIC KEY-----\n${value}\n-----END PUBLIC KEY-----`;
}

function toPrivatePem(value: string): string {
  if (value.includes("BEGIN PRIVATE KEY")) return value;
  return `-----BEGIN PRIVATE KEY-----\n${value}\n-----END PRIVATE KEY-----`;
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cryptoRandomId(): string {
  return crypto.randomBytes(16).toString("hex");
}
