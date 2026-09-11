/**
 * @fileoverview `seenJtis` collection. Replay-protection cache for
 * OEM-issued JWT jtis.
 *
 * Every successful token exchange records the OEM JWT's `jti` here. If the
 * same `jti` is presented again before its natural expiry, exchange is
 * rejected with `invalid_grant`. Prevents an attacker who captured one OEM
 * JWT in transit from re-presenting it for additional sessions.
 *
 * Kept separate from `revokedJtis` because the use cases and lifetimes
 * differ: `seenJtis` populates on every successful exchange and TTLs out
 * shortly after the short-lived OEM JWT's `exp`; `revokedJtis` populates
 * only on explicit revocation and TTLs out when the longer-lived Mentra
 * access token would have expired.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "seenJtis")
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const SeenJtiSchema = new Schema(
  {
    /** The jti claim of the OEM-issued JWT. */
    jti: { type: String, required: true },

    /** Issuing OEM. Scopes the uniqueness check. */
    tenantId: { type: String, required: true },

    /**
     * Natural expiry of the OEM JWT plus a small buffer for clock skew.
     * After this point, replay protection is moot (the JWT fails its own
     * `exp` check), so Mongo TTL-deletes the row.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "seenJtis" },
);

SeenJtiSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Uniqueness scoped per-OEM. Two different OEMs could in principle issue
// jtis that happen to collide; we only care about replay within one OEM.
SeenJtiSchema.index({ jti: 1, tenantId: 1 }, { unique: true });

export type SeenJti = InferSchemaType<typeof SeenJtiSchema>;
export const SeenJtiModel = registerModel("SeenJti", SeenJtiSchema);
