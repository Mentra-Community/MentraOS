/**
 * @fileoverview `users` collection. One document per `mentraUserId`.
 *
 * Identity-only record. No PII (no email, no display name, no avatar). The
 * sole purpose is to give Mentra a stable internal identifier for an
 * (tenantId, tenantUserId) pair.
 *
 * Created on first sight during token exchange: if the (tenantId, tenantUserId)
 * pair has no existing record, generate a new ULID-prefixed `mentraUserId`
 * and insert. Subsequent exchanges for the same pair reuse the existing row.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "Collection: users")
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const UserSchema = new Schema(
  {
    /**
     * Opaque Mentra-internal user identifier. Format: `mu_<ULID>`.
     * Stable across the user's lifetime under this OEM.
     */
    mentraUserId: {type: String, required: true, unique: true},

    /** Attesting OEM. Matches `oems.tenantId`. */
    tenantId: {type: String, required: true},

    /** The OEM's own user identifier (their `sub` claim). */
    tenantUserId: {type: String, required: true},

    /** Prevents an already-leased support event from being delivered after account deletion. */
    supportTelemetryDeletedAt: {type: Date, default: null},

    /** Expiring distributed delivery lease; deletion waits for it to clear or expire. */
    supportTelemetryDeliveryLeaseUntil: {type: Date, default: null},
  },
  {timestamps: {createdAt: true, updatedAt: false}, collection: "users"},
)

// Compound uniqueness: one user record per (tenantId, tenantUserId) pair. Lookup
// during token exchange to find existing or create on first sight.
UserSchema.index({tenantId: 1, tenantUserId: 1}, {unique: true})

export type User = InferSchemaType<typeof UserSchema>
export const UserModel = registerModel("User", UserSchema)
