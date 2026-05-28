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

import * as jose from "jose";

const ALG = "EdDSA";
const ISSUER = "mentra-cloud";
const AUDIENCE = "mentra-cloud";

export interface VerifiedAccessToken {
  mentraUserId: string;
  oemId: string;
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

/** Reset the cached public key. Test-only — call after mutating env. */
export function resetMentraKeyCache(): void {
  publicKeyPromise = null;
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
      audience: AUDIENCE,
      issuer: ISSUER,
      algorithms: [ALG],
    });
    payload = result.payload;
  } catch (err) {
    throw new AccessTokenError(
      `access_token rejected: ${(err as Error).message}`,
    );
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const oemId = typeof payload.oem_id === "string" ? payload.oem_id : null;
  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : null;
  const jti = typeof payload.jti === "string" ? payload.jti : null;

  if (!sub || !oemId || !sessionId || !jti) {
    throw new AccessTokenError("access_token missing required claims");
  }

  return { mentraUserId: sub, oemId, sessionId, jti };
}
