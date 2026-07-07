/**
 * @fileoverview `refreshTokens` collection. One document per active session.
 *
 * Stores the HMAC-SHA256 hash (not the plaintext) of each refresh token Mentra
 * has issued. The plaintext exists only on the SDK that received it; if the
 * DB leaks, the hashes are not directly usable because the HMAC key
 * (`REFRESH_TOKEN_PEPPER` env var) lives outside the DB.
 *
 * **Why not bcrypt/argon2.** Those exist to make low-entropy human passwords
 * expensive to brute-force. Refresh tokens are 256-bit random opaque
 * strings; a single SHA-256 already costs ~2^256 to forge. HMAC with a
 * server-held pepper protects against DB-only leaks just as well, with no
 * per-refresh CPU cost.
 *
 * **Rotation.** Every successful refresh deletes the old document and inserts
 * a new one. A token can only be used once. Reusing a previously-rotated
 * token (e.g. by a thief who grabbed it before the legitimate client
 * refreshed) yields `invalid_grant`, surfacing the breach to the legitimate
 * client on its next refresh attempt.
 *
 * **TTL.** A TTL index on `expiresAt` lets Mongo auto-delete expired
 * sessions; no background cleanup job needed.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "refreshTokens")
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const RefreshTokenSchema = new Schema(
  {
    /**
     * Stable session identifier. Distinct from the refresh-token hash so
     * admin tooling can target a session without knowing the token value.
     * Format: `sess_<ULID>`.
     */
    sessionId: { type: String, required: true, unique: true },

    /**
     * HMAC-SHA256(REFRESH_TOKEN_PEPPER, refreshToken) as base64url. Lookup
     * field on refresh: hash the presented token, find by this field.
     */
    refreshTokenHash: { type: String, required: true, unique: true },

    /** Whose session this is. Matches `users.mentraUserId`. */
    mentraUserId: { type: String, required: true },

    /** Attesting OEM at the time this session was issued. */
    tenantId: { type: String, required: true },

    issuedAt: { type: Date, required: true, default: () => new Date() },

    /** Mongo TTL index field: documents past this date are auto-deleted. */
    expiresAt: { type: Date, required: true },
  },
  { collection: "refreshTokens" },
);

// TTL index. `expireAfterSeconds: 0` means "delete the doc as soon as the
// indexed field's date is in the past." Mongo scans every ~60s.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Revocation queries: "kill every session belonging to this user / OEM."
RefreshTokenSchema.index({ mentraUserId: 1, tenantId: 1 });
RefreshTokenSchema.index({ tenantId: 1 });

export type RefreshToken = InferSchemaType<typeof RefreshTokenSchema>;
export const RefreshTokenModel = model("RefreshToken", RefreshTokenSchema);
