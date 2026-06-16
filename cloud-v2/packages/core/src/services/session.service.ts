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
  InvalidRequest,
  OauthServerError,
  UnauthorizedClient,
  type TokenResponse,
} from "../types/oauth.types";
import { findOrCreateUser } from "./user.service";
import { recordSeenJti, verifyOemJwt } from "./oem.service";

const logger = createLogger("core").child({ service: "session.service" });

// === Token lifetimes ===

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const MENTRA_ISSUER = "mentra-cloud";
const MENTRA_AUDIENCE = "mentra-cloud";
const MENTRA_ALG = "EdDSA";

// Miniapp-scoped tokens use "mentra" as the issuer (per auth/spec.md "Miniapp-
// scoped token") rather than "mentra-cloud", because developer backends key
// their trust policy on this value and the spec pins it.
const MINIAPP_ISSUER = "mentra";

// The built-in "OEM zero". Mentra's own users (a phone logging in with a
// Supabase session, or a legacy mentra-core token) resolve to this oemId. It
// has no `oems` record and no JWKS: the subject token is verified with a shared
// HS256 secret, not an OEM public key.
const MENTRA_OEM_ID = "mentra";

// Default miniapp-token lifetime. Env-overridable (MENTRA_MINIAPP_TOKEN_TTL_SEC)
// so tests can shorten it without touching code.
const MINIAPP_TOKEN_DEFAULT_TTL_SEC = 60 * 60; // 1 hour

// JWKS key ids. Each published public key carries a stable `kid` so verifiers
// (developer backends, internal services) select the right key by header,
// which is what makes key rotation a no-coordination change. Access tokens and
// miniapp tokens are signed with separate keys, so they get separate kids.
const ACCESS_TOKEN_KID = "mentra-access-1";
const MINIAPP_TOKEN_KID = "mentra-miniapp-1";

// === Public API ===

/**
 * Token exchange. Resolves the subject token to an (oemId, oemUserId) identity,
 * finds/creates the user, and mints a fresh access + refresh token pair. Returns
 * the RFC 6749 token-response shape.
 *
 * The subject token is one of three kinds, all presented under the single JWT
 * token-type URN and dispatched by `resolveSubjectIdentity`:
 *   - an OEM-signed JWT (verified against the OEM's JWKS), or
 *   - a Mentra Supabase session / legacy mentra-core token (verified with a
 *     shared HS256 secret; oemId "mentra").
 *
 * Step-by-step matches design.md "Lifecycles / Issue session":
 *   1–5. Delegated to `resolveSubjectIdentity`.
 *   6.   findOrCreateUser by (oemId, oemUserId).
 *   7–8. Mint access + refresh, persist refresh-token hash, return.
 */
export async function createSession(args: {
  subjectToken: string;
}): Promise<TokenResponse> {
  const identity = await resolveSubjectIdentity(args.subjectToken);

  const user = await findOrCreateUser({
    oemId: identity.oemId,
    oemUserId: identity.oemUserId,
  });

  // Burn the subject token's jti BEFORE minting anything. The unique-index
  // insert makes exactly one concurrent presentation win; doing it first means
  // a replayed jti never has tokens minted or persisted for it, so there is no
  // rollback path that can fail and leave a valid session behind.
  if (identity.jti) {
    if (typeof identity.exp !== "number") {
      throw new InvalidGrant("subject_token missing 'exp' claim");
    }
    await recordSeenJti({
      jti: identity.jti,
      oemId: identity.oemId,
      expUnixSec: identity.exp,
    });
  }

  const sessionId = `sess_${ulid()}`;
  const { token: accessToken } = await issueAccessToken({
    mentraUserId: user.mentraUserId,
    oemId: identity.oemId,
    sessionId,
  });
  const refreshToken = await issueRefreshToken({
    sessionId,
    mentraUserId: user.mentraUserId,
    oemId: identity.oemId,
  });

  logger.info(
    { sessionId, mentraUserId: user.mentraUserId, oemId: identity.oemId },
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
 * checks the OEM is still enabled, rotates the stored refresh-token hash in
 * place, and returns fresh access + refresh tokens.
 */
export async function refreshSession(args: {
  refreshToken: string;
}): Promise<TokenResponse> {
  const presentedHash = hashRefreshToken(args.refreshToken);

  const now = new Date();
  const oldDoc = await RefreshTokenModel.findOne({
    refreshTokenHash: presentedHash,
    expiresAt: { $gt: now },
  }).lean();
  if (!oldDoc) {
    throw new InvalidGrant("refresh_token unknown, expired, or already used");
  }

  // OEM-disabled mid-session check. If the OEM was terminated after this
  // session was issued, refuse to re-up. The built-in "mentra" OEM has no oems
  // record (its users authenticate with a shared secret, not a JWKS), so skip
  // the lookup for it.
  if (oldDoc.oemId !== MENTRA_OEM_ID) {
    const oem = await OemModel.findOne({ oemId: oldDoc.oemId }).lean();
    if (!oem || oem.disabled) {
      throw new UnauthorizedClient(`oem ${oldDoc.oemId} unknown or disabled`);
    }
  }

  // Mint fresh tokens. We reuse the existing sessionId so admin handles
  // remain stable across refreshes.
  const { token: accessToken } = await issueAccessToken({
    mentraUserId: oldDoc.mentraUserId,
    oemId: oldDoc.oemId,
    sessionId: oldDoc.sessionId,
  });
  const nextRefresh = mintRefreshToken();

  // Single-use guarantee: only the request still holding the current hash can
  // rotate it. A concurrent refresh that arrives milliseconds later sees no
  // matching current hash and fails instead of minting a second live token.
  const rotated = await RefreshTokenModel.findOneAndUpdate(
    {
      refreshTokenHash: presentedHash,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        refreshTokenHash: nextRefresh.hash,
        issuedAt: new Date(),
        expiresAt: nextRefresh.expiresAt,
      },
    },
  ).lean();
  if (!rotated) {
    throw new InvalidGrant("refresh_token unknown, expired, or already used");
  }

  return {
    access_token: accessToken,
    refresh_token: nextRefresh.plaintext,
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

  // Core-only blacklist check. NOTE: nothing currently WRITES RevokedJtiModel —
  // revokeSession / revokeAllForOem only delete the refresh token (the access
  // jti isn't stored at issue time), so this lookup is effectively a no-op today
  // and a revoked session's access token stays valid until natural expiry (≤1h).
  // Refresh-token deletion is the real revocation mechanism. To make access-token
  // revocation take effect, store the access jti at issue and populate this model
  // in the revoke paths. Audio/proxy skip this check entirely (no Mongo).
  const revoked = await RevokedJtiModel.findOne({ jti: verified.jti }).lean();
  if (revoked) throw new InvalidGrant("access_token revoked");

  return verified;
}

/**
 * Mint a miniapp-scoped token for one packageName.
 *
 * The caller has already verified the device's access token and read the
 * identity from it (mentraUserId + oemId). This token is audience-pinned to a
 * single miniapp (`aud = packageName`) and signed with the separate
 * miniapp-token key, so it is only ever valid against that one miniapp's
 * developer backend. It is the only token a miniapp ever holds; the access
 * token never leaves the device.
 *
 * No install or entitlement check happens here: per auth/spec.md, a valid
 * access token plus the requested packageName is sufficient, and the on-device
 * Runtime enforces that a bundle can only request its own packageName.
 *
 * TTL defaults to 1h and is env-overridable via MENTRA_MINIAPP_TOKEN_TTL_SEC
 * so tests can shorten it. Returns the token and its absolute expiry as Unix
 * seconds (what the client caches against).
 */
export async function issueMiniappToken(args: {
  mentraUserId: string;
  oemId: string;
  packageName: string;
}): Promise<{ token: string; expiresAt: number }> {
  const { privateKey } = await getMiniappKeys();
  const ttlSec = miniappTokenTtlSec();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;

  const token = await new jose.SignJWT({ oemId: args.oemId })
    // The `kid` points the developer backend at the miniapp-token public key.
    .setProtectedHeader({ alg: MENTRA_ALG, kid: MINIAPP_TOKEN_KID })
    .setIssuer(MINIAPP_ISSUER)
    .setAudience(args.packageName)
    .setSubject(args.mentraUserId)
    .setJti(ulid())
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);

  return { token, expiresAt };
}

/**
 * Resolve the miniapp-token TTL: the env override if a positive integer is
 * set, otherwise the 1h default. Parsed per call (not cached) so tests can
 * flip it between cases.
 */
function miniappTokenTtlSec(): number {
  const raw = process.env.MENTRA_MINIAPP_TOKEN_TTL_SEC;
  if (!raw) return MINIAPP_TOKEN_DEFAULT_TTL_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MINIAPP_TOKEN_DEFAULT_TTL_SEC;
  }
  return Math.floor(parsed);
}

// === Internals: subject-token identity resolution ===

/**
 * Resolve a subject token to an (oemId, oemUserId) identity. All three accepted
 * subject tokens arrive as a JWT under the one RFC 8693 JWT token-type URN, so
 * we dispatch on the token itself:
 *   - HS* (symmetric) tokens are Mentra-internal. A Supabase session (its `iss`
 *     points at Supabase) verifies with SUPABASE_JWT_SECRET; anything else
 *     symmetric is treated as a legacy mentra-core token (MENTRA_CORE_JWT_SECRET).
 *     Both resolve to oemId "mentra".
 *   - Everything else is an OEM-signed JWT, verified against that OEM's JWKS.
 */
async function resolveSubjectIdentity(
  subjectToken: string,
): Promise<{
  oemId: string;
  oemUserId: string;
  jti?: string;
  exp?: number;
}> {
  let alg: string;
  let iss: string | undefined;
  try {
    alg = jose.decodeProtectedHeader(subjectToken).alg ?? "";
    const claims = jose.decodeJwt(subjectToken);
    iss = typeof claims.iss === "string" ? claims.iss : undefined;
  } catch {
    throw new InvalidRequest("subject_token is not a parseable JWT");
  }

  if (alg.startsWith("HS")) {
    const secretEnv = looksLikeSupabase(iss)
      ? "SUPABASE_JWT_SECRET"
      : "MENTRA_CORE_JWT_SECRET";
    const oemUserId = await verifyHs256Subject(subjectToken, secretEnv);
    return { oemId: MENTRA_OEM_ID, oemUserId };
  }

  const verified = await verifyOemJwt(subjectToken);
  return {
    oemId: verified.oemId,
    oemUserId: verified.oemUserId,
    jti: verified.jti,
    exp: verified.exp,
  };
}

/**
 * A Supabase session JWT carries an `iss` pointing at the project's auth
 * endpoint (e.g. https://<ref>.supabase.co/auth/v1). Match that, or the
 * configured SUPABASE_URL, so we pick the Supabase secret rather than the
 * mentra-core one.
 */
function looksLikeSupabase(iss: string | undefined): boolean {
  if (!iss) return false;
  if (iss.includes("supabase.")) return true;
  const supabaseUrl = process.env.SUPABASE_URL;
  return !!supabaseUrl && iss.startsWith(supabaseUrl);
}

/**
 * Verify a symmetric (HS*) subject token with the named env secret and return
 * its `sub`. Signature + expiry are enforced; we deliberately do not pin
 * `aud`/`iss` (Supabase sets aud "authenticated"), as the shared secret is the
 * trust anchor.
 */
async function verifyHs256Subject(
  token: string,
  secretEnv: string,
): Promise<string> {
  const secret = requireEnv(secretEnv);
  const key = new TextEncoder().encode(secret);
  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(token, key, {
      algorithms: ["HS256", "HS384", "HS512"],
    }));
  } catch (err) {
    throw new InvalidGrant(
      `subject token verification failed: ${(err as Error).message}`,
    );
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new InvalidGrant("subject token missing 'sub' claim");
  return sub;
}

// === Internals: Mentra signing keys ===

/**
 * Lazy-loaded Mentra signing keypair for **access tokens**. We hold both
 * halves on `core` so we can sign and verify in this same process. Audio/proxy
 * will receive only the public half.
 */
let mentraKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;

/**
 * Lazy-loaded Mentra signing keypair for **miniapp tokens**. Kept separate
 * from the access-token key on purpose: per auth/spec.md "Signing keys", two
 * keys limit blast radius, a leak of the miniapp key can't forge access
 * tokens, and vice versa. The public half is published in the JWKS so
 * developer backends can verify miniapp tokens.
 */
let miniappKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;

async function getMentraKeys() {
  if (!mentraKeys) {
    mentraKeys = loadMentraKeys();
  }
  return mentraKeys;
}

async function getMiniappKeys() {
  if (!miniappKeys) {
    miniappKeys = loadMiniappKeys();
  }
  return miniappKeys;
}

/**
 * Reset the lazy-loaded signing keypair caches. **Test-only.** Production
 * has no reason to rotate keys mid-process; tests that mutate
 * `MENTRA_JWT_*` / `MENTRA_MINIAPP_JWT_*` env vars (e.g. running multiple test
 * files in the same Bun process) need to discard the cached imports so the
 * next call reads the new env.
 */
export function resetSigningKeyCache(): void {
  mentraKeys = null;
  miniappKeys = null;
}

async function loadMentraKeys() {
  const privB64 = requireEnv("MENTRA_JWT_PRIVATE_KEY");
  const pubB64 = requireEnv("MENTRA_JWT_PUBLIC_KEY");
  const privatePem = toPem(privB64, "PRIVATE KEY");
  const publicPem = toPem(pubB64, "PUBLIC KEY");
  const [privateKey, publicKey] = await Promise.all([
    // Public key stays extractable so we can export it to JWK form for the
    // /.well-known/jwks.json endpoint.
    jose.importPKCS8(privatePem, MENTRA_ALG, { extractable: false }),
    jose.importSPKI(publicPem, MENTRA_ALG, { extractable: true }),
  ]);
  logger.info("loaded Mentra access-token signing keypair");
  return { privateKey, publicKey };
}

/**
 * Load the miniapp-token signing keypair from env. Falls back to the
 * access-token key env vars is intentionally NOT done: the keys must be
 * distinct for the blast-radius guarantee, so the miniapp env vars are
 * required in their own right.
 */
async function loadMiniappKeys() {
  const privB64 = requireEnv("MENTRA_MINIAPP_JWT_PRIVATE_KEY");
  const pubB64 = requireEnv("MENTRA_MINIAPP_JWT_PUBLIC_KEY");
  const privatePem = toPem(privB64, "PRIVATE KEY");
  const publicPem = toPem(pubB64, "PUBLIC KEY");
  const [privateKey, publicKey] = await Promise.all([
    jose.importPKCS8(privatePem, MENTRA_ALG, { extractable: false }),
    jose.importSPKI(publicPem, MENTRA_ALG, { extractable: true }),
  ]);
  logger.info("loaded Mentra miniapp-token signing keypair");
  return { privateKey, publicKey };
}

/**
 * Build the public JWKS document Mentra publishes at /.well-known/jwks.json.
 *
 * Contains both public keys, each tagged with its `kid` (and `alg`/`use`), so
 * a verifier picks the right key by the JWT header's `kid`:
 *   - the access-token key, used by internal services to verify access tokens
 *   - the miniapp-token key, used by developer backends to verify miniapp tokens
 *
 * Publishing both from day one is what makes key rotation a no-coordination
 * change: a new key is added here alongside the old until old tokens expire.
 */
export async function getPublicJwks(): Promise<{ keys: jose.JWK[] }> {
  const [access, miniapp] = await Promise.all([getMentraKeys(), getMiniappKeys()]);
  const [accessJwk, miniappJwk] = await Promise.all([
    jose.exportJWK(access.publicKey),
    jose.exportJWK(miniapp.publicKey),
  ]);
  return {
    keys: [
      { ...accessJwk, alg: MENTRA_ALG, use: "sig", kid: ACCESS_TOKEN_KID },
      { ...miniappJwk, alg: MENTRA_ALG, use: "sig", kid: MINIAPP_TOKEN_KID },
    ],
  };
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
    // The `kid` points verifiers at the access-token public key in the JWKS.
    .setProtectedHeader({ alg: MENTRA_ALG, kid: ACCESS_TOKEN_KID })
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
  const token = mintRefreshToken();

  await RefreshTokenModel.create({
    sessionId: args.sessionId,
    refreshTokenHash: token.hash,
    mentraUserId: args.mentraUserId,
    oemId: args.oemId,
    issuedAt: new Date(),
    expiresAt: token.expiresAt,
  });

  return token.plaintext;
}

function mintRefreshToken(): {
  plaintext: string;
  hash: string;
  expiresAt: Date;
} {
  // 32 bytes of randomness, base64url-encoded → ~43 chars, 256 bits entropy.
  const plaintext = crypto.randomBytes(32).toString("base64url");
  return {
    plaintext,
    hash: hashRefreshToken(plaintext),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
  };
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
