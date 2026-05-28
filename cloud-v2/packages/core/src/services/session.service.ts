/**
 * @fileoverview Session aggregate. Token-exchange orchestration, refresh,
 * revocation, and Mentra access-token verification.
 *
 * What this service owns:
 *   - Orchestrating RFC 8693 token exchange (verify OEM JWT → find/create
 *     user → mint Mentra tokens).
 *   - Refresh-token rotation.
 *   - Session revocation (single and bulk-by-OEM).
 *   - Verifying Mentra-issued access tokens, including the revocation
 *     blacklist check.
 *
 * Mentra's own Ed25519 signing keypair is loaded lazily from env on first
 * use. Refresh tokens are HMAC-SHA256 hashed with a server-side pepper
 * (`REFRESH_TOKEN_PEPPER`) before storage; the plaintext exists only on
 * the SDK that received it.
 *
 * Spec: docs/issues/001-oem-auth/design.md
 *       ("Lifecycles" / "Token formats" / "Endpoints")
 */

import crypto from "node:crypto";
import * as jose from "jose";
import { ulid } from "ulid";
import {
  createLogger,
  verifyAccessTokenSignature,
  AccessTokenError,
  type VerifiedAccessToken,
} from "@mentra/cloud-shared";
import { RefreshTokenModel } from "../models/refresh-token.model";
import { RevokedJtiModel } from "../models/revoked-jti.model";
import { OemModel } from "../models/oem.model";
import {
  InvalidGrant,
  OauthServerError,
  UnauthorizedClient,
  type TokenResponse,
} from "../types/oauth.types";
import { findOrCreateUser } from "./user.service";
import { verifyOemJwt } from "./oem.service";

const logger = createLogger("core").child({ service: "session.service" });

// === Token lifetimes ===

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const MENTRA_ISSUER = "mentra-cloud";
const MENTRA_AUDIENCE = "mentra-cloud";
const MENTRA_ALG = "EdDSA";

// === Public API ===

/**
 * Token exchange. Verifies the OEM-signed JWT, resolves the user, mints a
 * fresh access + refresh token pair. Returns the RFC 6749 token-response
 * shape.
 *
 * Step-by-step matches design.md "Lifecycles / Issue session":
 *   1–5. Delegated to `oem.verifyOemJwt`.
 *   6.   findOrCreateUser by (oemId, oemUserId).
 *   7–8. Mint access + refresh, persist refresh-token hash, return.
 */
export async function createSession(args: {
  oemJwt: string;
}): Promise<TokenResponse> {
  const verified = await verifyOemJwt(args.oemJwt);

  const user = await findOrCreateUser({
    oemId: verified.oemId,
    oemUserId: verified.oemUserId,
  });

  const sessionId = `sess_${ulid()}`;
  const { token: accessToken } = await issueAccessToken({
    mentraUserId: user.mentraUserId,
    oemId: verified.oemId,
    sessionId,
  });
  const refreshToken = await issueRefreshToken({
    sessionId,
    mentraUserId: user.mentraUserId,
    oemId: verified.oemId,
  });

  logger.info(
    { sessionId, mentraUserId: user.mentraUserId, oemId: verified.oemId },
    "session created",
  );

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
  };
}

/**
 * Refresh flow. Hashes the presented refresh token, looks up the session,
 * checks the OEM is still enabled, rotates: deletes the old refresh-token
 * doc and inserts a new one. Returns fresh access + refresh tokens.
 */
export async function refreshSession(args: {
  refreshToken: string;
}): Promise<TokenResponse> {
  const presentedHash = hashRefreshToken(args.refreshToken);

  // Atomically grab and delete the old row. If it's gone (already rotated
  // or revoked), the refresh fails. This single-shot delete is the
  // single-use guarantee.
  const oldDoc = await RefreshTokenModel.findOneAndDelete({
    refreshTokenHash: presentedHash,
  }).lean();
  if (!oldDoc) {
    throw new InvalidGrant("refresh_token unknown, expired, or already used");
  }

  // OEM-disabled mid-session check. If the OEM was terminated after this
  // session was issued, refuse to re-up.
  const oem = await OemModel.findOne({ oemId: oldDoc.oemId }).lean();
  if (!oem || oem.disabled) {
    throw new UnauthorizedClient(`oem ${oldDoc.oemId} unknown or disabled`);
  }

  // Mint fresh tokens. We reuse the existing sessionId so admin handles
  // remain stable across refreshes.
  const { token: accessToken } = await issueAccessToken({
    mentraUserId: oldDoc.mentraUserId,
    oemId: oldDoc.oemId,
    sessionId: oldDoc.sessionId,
  });
  const refreshToken = await issueRefreshToken({
    sessionId: oldDoc.sessionId,
    mentraUserId: oldDoc.mentraUserId,
    oemId: oldDoc.oemId,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
  };
}

/**
 * Revoke a single session. Deletes its refresh-token doc. The associated
 * access-token jti is not known here (we didn't store it), so until the
 * access token's natural expiry, callers must either accept a 1-hour
 * blast-radius window or extend this service to also write a per-session
 * blacklist entry. For now: refresh dies immediately, access token expires
 * within the hour.
 */
export async function revokeSession(args: { sessionId: string }): Promise<void> {
  await RefreshTokenModel.deleteOne({ sessionId: args.sessionId });
  logger.info({ sessionId: args.sessionId }, "session revoked");
}

/**
 * Revoke every session belonging to an OEM. Sets `oems.disabled = true`
 * (which alone blocks future exchanges and refreshes via the disabled
 * checks elsewhere) and deletes all of the OEM's refresh tokens.
 *
 * Does not currently enumerate outstanding access-token jtis into
 * `revokedJtis`. Active access tokens for revoked OEMs remain
 * cryptographically valid until natural expiry (≤1 hour). Tightening this
 * requires storing the access-token jti at issue time so we can blacklist
 * them here.
 */
export async function revokeAllForOem(oemId: string): Promise<{ deletedSessions: number }> {
  await OemModel.updateOne({ oemId }, { $set: { disabled: true } });
  const result = await RefreshTokenModel.deleteMany({ oemId });
  logger.info(
    { oemId, deletedSessions: result.deletedCount },
    "bulk-revoked oem sessions",
  );
  return { deletedSessions: result.deletedCount ?? 0 };
}

/**
 * Verify a Mentra-issued access token. Returns the parsed claims on
 * success, throws on bad signature / expired / revoked.
 *
 * Auth middleware calls this on inbound requests bearing
 * `Authorization: Bearer <token>`.
 *
 * Delegates signature/claims/expiry to the shared verifier and layers on
 * the core-only Mongo revocation blacklist check.
 */
export type { VerifiedAccessToken } from "@mentra/cloud-shared";

export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  // Signature + claims + expiry come from shared. Translate the shared error
  // type into the RFC 8693 InvalidGrant the API layer expects.
  let verified: VerifiedAccessToken;
  try {
    verified = await verifyAccessTokenSignature(token);
  } catch (err) {
    if (err instanceof AccessTokenError) {
      throw new InvalidGrant(err.message);
    }
    throw err;
  }

  // Core-only: blacklist check. Audio/proxy skip this (they don't have Mongo);
  // refresh-token revocation is the real teeth, and the access token expires
  // within an hour anyway.
  const revoked = await RevokedJtiModel.findOne({ jti: verified.jti }).lean();
  if (revoked) throw new InvalidGrant("access_token revoked");

  return verified;
}

// === Internals: Mentra signing keys ===

/**
 * Lazy-loaded Mentra signing keypair. We hold both halves on `core` so we
 * can sign and verify in this same process. Audio/proxy will receive only
 * the public half.
 */
let mentraKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;

async function getMentraKeys() {
  if (!mentraKeys) {
    mentraKeys = loadMentraKeys();
  }
  return mentraKeys;
}

/**
 * Reset the lazy-loaded signing keypair cache. **Test-only.** Production
 * has no reason to rotate keys mid-process; tests that mutate
 * `MENTRA_JWT_*` env vars (e.g. running multiple test files in the same
 * Bun process) need to discard the cached import so the next call reads
 * the new env.
 */
export function resetSigningKeyCache(): void {
  mentraKeys = null;
}

async function loadMentraKeys() {
  const privB64 = requireEnv("MENTRA_JWT_PRIVATE_KEY");
  const pubB64 = requireEnv("MENTRA_JWT_PUBLIC_KEY");
  const privatePem = toPem(privB64, "PRIVATE KEY");
  const publicPem = toPem(pubB64, "PUBLIC KEY");
  const [privateKey, publicKey] = await Promise.all([
    jose.importPKCS8(privatePem, MENTRA_ALG, { extractable: false }),
    jose.importSPKI(publicPem, MENTRA_ALG, { extractable: false }),
  ]);
  logger.info("loaded Mentra JWT signing keypair");
  return { privateKey, publicKey };
}

/**
 * Reconstruct a PEM block from a stored base64 body. We store only the body
 * to keep env values short and free of `\n` escapes; the wrapper is
 * informationless for Ed25519 (always PKCS#8 / SPKI).
 */
function toPem(base64Body: string, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  return `-----BEGIN ${label}-----\n${base64Body}\n-----END ${label}-----`;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new OauthServerError(`env var ${name} is not set`);
  return v;
}

// === Internals: token issuance ===

async function issueAccessToken(args: {
  mentraUserId: string;
  oemId: string;
  sessionId: string;
}): Promise<{ token: string; jti: string }> {
  const { privateKey } = await getMentraKeys();
  const jti = ulid();
  const token = await new jose.SignJWT({
    oem_id: args.oemId,
    session_id: args.sessionId,
  })
    .setProtectedHeader({ alg: MENTRA_ALG })
    .setIssuer(MENTRA_ISSUER)
    .setAudience(MENTRA_AUDIENCE)
    .setSubject(args.mentraUserId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .sign(privateKey);
  return { token, jti };
}

async function issueRefreshToken(args: {
  sessionId: string;
  mentraUserId: string;
  oemId: string;
}): Promise<string> {
  // 32 bytes of randomness, base64url-encoded → ~43 chars, 256 bits entropy.
  const plaintext = crypto.randomBytes(32).toString("base64url");
  const hash = hashRefreshToken(plaintext);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000);

  await RefreshTokenModel.create({
    sessionId: args.sessionId,
    refreshTokenHash: hash,
    mentraUserId: args.mentraUserId,
    oemId: args.oemId,
    issuedAt: new Date(),
    expiresAt,
  });

  return plaintext;
}

/**
 * HMAC-SHA256 the plaintext refresh token with a server-side pepper.
 *
 * Why HMAC, not argon2/bcrypt: the input is a 256-bit random string, not a
 * low-entropy human password. There is nothing to "slow down brute force"
 * against — forging the input from the hash would require 2^256 work
 * already. The HMAC's job is to make a DB-only leak unusable (because the
 * attacker doesn't have the pepper, which lives in env, not in Mongo).
 */
function hashRefreshToken(plaintext: string): string {
  const pepper = requireEnv("REFRESH_TOKEN_PEPPER");
  return crypto
    .createHmac("sha256", pepper)
    .update(plaintext)
    .digest("base64url");
}
