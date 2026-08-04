/**
 * @fileoverview `revokedJtis` collection. Blacklist for revoked
 * Mentra-issued access-token jtis.
 *
 * Mentra access tokens are JWTs. Their signatures stay cryptographically
 * valid until natural expiry; to revoke one early (admin action, OEM
 * termination, session kill), we add its `jti` to this collection. Every
 * access-token verification consults this blacklist.
 *
 * Entries TTL out at the time the access token would have expired anyway,
 * since after that point the token fails the `exp` check on its own and the
 * blacklist entry is redundant.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "revokedJtis")
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const RevokedJtiSchema = new Schema(
  {
    /** The jti claim of the revoked access token. */
    jti: { type: String, required: true, unique: true },

    /**
     * When the access token would have expired naturally. After this point
     * the blacklist entry has no further effect, so Mongo TTL-deletes it.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "revokedJtis" },
);

RevokedJtiSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RevokedJti = InferSchemaType<typeof RevokedJtiSchema>;
export const RevokedJtiModel = registerModel("RevokedJti", RevokedJtiSchema);
