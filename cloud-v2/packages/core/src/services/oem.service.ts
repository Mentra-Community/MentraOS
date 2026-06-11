/**
 * @fileoverview OEM aggregate. Public-key resolution, OEM JWT verification,
 * replay protection.
 *
 * What this service owns:
 *   - OEM record reads (by oemId).
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

import crypto from "node:crypto";
import * as jose from "jose";
import { createLogger } from "@mentra/cloud-shared";
import { OemModel, type Oem } from "../models/oem.model";
import { SeenJtiModel } from "../models/seen-jti.model";
import {
  InvalidGrant,
  InvalidRequest,
  OauthServerError,
  UnauthorizedClient,
} from "../types/oauth.types";

const logger = createLogger("core").child({ service: "oem.service" });

/** Algorithms Mentra accepts on OEM-signed JWTs. `none` is rejected. */
const SUPPORTED_ALGS = ["EdDSA", "RS256", "ES256"] as const;
type SupportedAlg = (typeof SUPPORTED_ALGS)[number];

/** Required claim shape on an OEM JWT. */
export interface VerifiedOemJwt {
  oemId: string; // = `iss`
  oemUserId: string; // = `sub`
  jti: string;
  exp: number; // Unix seconds
  iat: number; // Unix seconds
  /** Any non-standard claims the OEM passed through (e.g. `oem_display_name`). */
  passthroughClaims: Record<string, unknown>;
}

/** Look up an OEM by external `oemId`. Returns null if unknown. */
export async function getOem(oemId: string): Promise<Oem | null> {
  return OemModel.findOne({ oemId }).lean();
}

/**
 * Verify an OEM-signed JWT end-to-end. On success, returns the parsed
 * identity claims. On failure, throws an `OauthError` subclass whose
 * `code`/`httpStatus` map to the right RFC 8693 response.
 *
 * Flow (matches design.md "Issue session" steps 1–5):
 *   1. Decode header + payload without verification, read `iss` (oemId).
 *   2. Look up OEM. Unknown or disabled → `unauthorized_client`.
 *   3. Resolve public key (static PEM or JWKS URL).
 *   4. Verify signature + standard claims (aud, exp, iat skew).
 *   5. Return verified identity; session.service records `jti` only after
 *      the Mentra session is persisted.
 */
export async function verifyOemJwt(jwt: string): Promise<VerifiedOemJwt> {
  // Step 1 — peek at iss without verifying. If the JWT is so malformed we
  // can't even decode it, surface invalid_request rather than invalid_grant
  // (the latter implies we tried to verify and rejected).
  let unverified: jose.JWTPayload;
  try {
    unverified = jose.decodeJwt(jwt);
  } catch {
    throw new InvalidRequest("subject_token is not a parseable JWT");
  }

  const oemId = typeof unverified.iss === "string" ? unverified.iss : null;
  if (!oemId) throw new InvalidRequest("subject_token missing 'iss' claim");

  // Step 2 — look up OEM, reject if unknown or disabled.
  const oem = await getOem(oemId);
  if (!oem) throw new UnauthorizedClient(`unknown oem: ${oemId}`);
  if (oem.disabled) throw new UnauthorizedClient(`oem disabled: ${oemId}`);

  // Steps 3 + 4 — verify signature and standard claims in one call.
  const { payload } = await verifySignatureWithOemKey(jwt, oem);

  // Required claims beyond what jwtVerify checks for us.
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) throw new InvalidGrant("subject_token missing 'sub' claim");

  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (!jti) throw new InvalidGrant("subject_token missing 'jti' claim");

  if (typeof payload.exp !== "number") {
    throw new InvalidGrant("subject_token missing 'exp' claim");
  }
  if (typeof payload.iat !== "number") {
    throw new InvalidGrant("subject_token missing 'iat' claim");
  }

  // Pass through anything that isn't a standard claim, for the audio path or
  // downstream services that want OEM-supplied metadata (e.g. display name).
  const passthroughClaims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!STANDARD_CLAIMS.has(k)) passthroughClaims[k] = v;
  }

  return {
    oemId,
    oemUserId: sub,
    jti,
    exp: payload.exp,
    iat: payload.iat,
    passthroughClaims,
  };
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
]);

async function verifySignatureWithOemKey(
  jwt: string,
  oem: Oem,
): Promise<jose.JWTVerifyResult> {
  const verifyOpts: jose.JWTVerifyOptions = {
    audience: "mentra",
    algorithms: [...SUPPORTED_ALGS],
    // jose enforces `exp` and `iat` automatically. Allow 5 min clock skew
    // either side (matches spec's "5 min clock skew" allowance).
    clockTolerance: "5 minutes",
  };

  try {
    if (oem.publicKeyMode === "static") {
      if (!oem.publicKey) {
        throw new OauthServerError(`oem ${oem.oemId} static-mode but no key on file`);
      }
      const { key, alg } = await importStaticPublicKey(oem.publicKey);
      return await jose.jwtVerify(jwt, key, { ...verifyOpts, algorithms: [alg] });
    }

    if (oem.publicKeyMode === "jwks-url") {
      if (!oem.jwksUrl) {
        throw new OauthServerError(`oem ${oem.oemId} jwks-mode but no url on file`);
      }
      const jwks = getJwksFetcher(oem.jwksUrl);
      return await jose.jwtVerify(jwt, jwks, verifyOpts);
    }

    throw new OauthServerError(`oem ${oem.oemId} has unknown publicKeyMode`);
  } catch (err) {
    if (err instanceof Error && err.name?.startsWith("JWT")) {
      // jose throws JWTExpired, JWTClaimValidationFailed, JWSSignatureVerificationFailed, etc.
      throw new InvalidGrant(`subject_token rejected: ${err.message}`);
    }
    throw err;
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
async function importStaticPublicKey(
  pem: string,
): Promise<{ key: jose.KeyLike; alg: SupportedAlg }> {
  const alg = detectAlgFromPem(pem);
  const key = await jose.importSPKI(pem, alg, { extractable: false });
  return { key, alg };
}

function detectAlgFromPem(pem: string): SupportedAlg {
  let keyObj: crypto.KeyObject;
  try {
    keyObj = crypto.createPublicKey(pem);
  } catch (err) {
    throw new InvalidGrant(
      `could not parse public key: ${(err as Error).message}`,
    );
  }
  switch (keyObj.asymmetricKeyType) {
    case "ed25519":
      return "EdDSA";
    case "rsa":
      return "RS256";
    case "ec": {
      const curve = keyObj.asymmetricKeyDetails?.namedCurve;
      if (curve === "prime256v1") return "ES256";
      throw new OauthServerError(`unsupported EC curve: ${curve ?? "unknown"}`);
    }
    default:
      throw new OauthServerError(
        `unsupported key type: ${keyObj.asymmetricKeyType ?? "unknown"}`,
      );
  }
}

/**
 * Per-URL cache of jose remote JWKS fetchers. Each fetcher has its own
 * internal caching (default cool-down + cache TTL) so repeated verifications
 * against the same URL share network state.
 */
const jwksFetchers = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwksFetcher(url: string) {
  let cached = jwksFetchers.get(url);
  if (!cached) {
    cached = jose.createRemoteJWKSet(new URL(url), {
      cooldownDuration: 30_000, // min ms between refetches on miss
      cacheMaxAge: 5 * 60_000, // 5 min cache TTL
    });
    jwksFetchers.set(url, cached);
  }
  return cached;
}

/**
 * Record a successful OEM JWT acceptance for replay protection. Call this
 * after the Mentra session is persisted, so a transient session-creation
 * failure does not consume the OEM JWT's one-time `jti`. Throws
 * `invalid_grant` if the same (jti, oemId) was already recorded — that's a
 * replay attempt.
 */
export async function recordSeenJti(args: {
  jti: string;
  oemId: string;
  expUnixSec: number;
}): Promise<void> {
  const expiresAt = new Date(args.expUnixSec * 1000 + 60_000); // +60s buffer
  try {
    await SeenJtiModel.create({ jti: args.jti, oemId: args.oemId, expiresAt });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      logger.warn({ jti: args.jti, oemId: args.oemId }, "replay detected");
      throw new InvalidGrant("subject_token jti has already been used");
    }
    throw err;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}
