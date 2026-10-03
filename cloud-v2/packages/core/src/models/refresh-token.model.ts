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
 * **Rotation.** Every successful refresh rotates the stored hash in place and
 * records the presented hash in `prevTokenHash`. A rotated-away token stays
 * honored until its successor is first USED (OS-1703): a client that sent a
 * refresh but never received the response (killed mid-rotation, dropped
 * connection) still holds the predecessor, and re-presenting it rotates again
 * instead of bricking the session. The displaced successor is retained as one
 * bounded alternate so either response from a duplicate refresh remains
 * usable until the client presents one branch. Anything older than the
 * immediate predecessor still yields `invalid_grant`.
 *
 * **TTL.** A TTL index on `expiresAt` lets Mongo auto-delete expired
 * sessions; no background cleanup job needed.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "refreshTokens")
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const FederatedIdentitySchema = new Schema(
  {
    providerId: {type: String},
    providerKind: {type: String},
    issuer: {type: String},
    subject: {type: String},
    directoryTenantId: {type: String},
  },
  {_id: false},
)

const RefreshTokenSchema = new Schema(
  {
    /**
     * Stable session identifier. Distinct from the refresh-token hash so
     * admin tooling can target a session without knowing the token value.
     * Format: `sess_<ULID>`.
     */
    sessionId: {type: String, required: true, unique: true},

    /**
     * HMAC-SHA256(REFRESH_TOKEN_PEPPER, refreshToken) as base64url. Lookup
     * field on refresh: hash the presented token, find by this field.
     */
    refreshTokenHash: {type: String, required: true, unique: true},

    /**
     * Hash of the immediately-superseded refresh token, set on every
     * rotation. Recovery lookup field (OS-1703): a client that lost the
     * rotation response re-presents its old token, which matches here as
     * long as the successor was never used. Absent on brand-new sessions.
     */
    prevTokenHash: {type: String},

    /**
     * Hash of a live successor displaced by a predecessor-path recovery
     * rotation. Both responses from a duplicate refresh remain usable until
     * the client proves which branch it persisted by presenting one of them.
     */
    altTokenHash: {type: String},

    /** Whose session this is. Matches `users.mentraUserId`. */
    mentraUserId: {type: String, required: true},

    /** Attesting OEM at the time this session was issued. */
    tenantId: {type: String, required: true},

    /** Upstream workforce identity, retained across Core refresh rotation. */
    federatedIdentity: {type: FederatedIdentitySchema},

    issuedAt: {type: Date, required: true, default: () => new Date()},

    /** Mongo TTL index field: documents past this date are auto-deleted. */
    expiresAt: {type: Date, required: true},
  },
  {collection: "refreshTokens"},
)

// TTL index. `expireAfterSeconds: 0` means "delete the doc as soon as the
// indexed field's date is in the past." Mongo scans every ~60s.
RefreshTokenSchema.index({expiresAt: 1}, {expireAfterSeconds: 0})

// Recovery lookup: refresh presented with the immediately-superseded token
// (OS-1703). Sparse — brand-new sessions have no predecessor.
RefreshTokenSchema.index({prevTokenHash: 1}, {sparse: true})

// Displaced-sibling lookup for duplicate refresh responses. Sparse because a
// normal session has no alternate branch.
RefreshTokenSchema.index({altTokenHash: 1}, {sparse: true})

// Revocation queries: "kill every session belonging to this user / OEM."
RefreshTokenSchema.index({mentraUserId: 1, tenantId: 1})
RefreshTokenSchema.index({tenantId: 1})

export type RefreshToken = InferSchemaType<typeof RefreshTokenSchema>
export const RefreshTokenModel = registerModel("RefreshToken", RefreshTokenSchema)
