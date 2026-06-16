/**
 * @fileoverview `users` collection. One document per `mentraUserId`.
 *
 * Identity-only record. No PII (no email, no display name, no avatar). The
 * sole purpose is to give Mentra a stable internal identifier for an
 * (oemId, oemUserId) pair.
 *
 * Created on first sight during token exchange: if the (oemId, oemUserId)
 * pair has no existing record, generate a new ULID-prefixed `mentraUserId`
 * and insert. Subsequent exchanges for the same pair reuse the existing row.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "Collection: users")
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const UserSchema = new Schema(
  {
    /**
     * Opaque Mentra-internal user identifier. Format: `mu_<ULID>`.
     * Stable across the user's lifetime under this OEM.
     */
    mentraUserId: { type: String, required: true, unique: true },

    /** Attesting OEM. Matches `oems.oemId`. */
    oemId: { type: String, required: true },

    /** The OEM's own user identifier (their `sub` claim). */
    oemUserId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "users" },
);

// Compound uniqueness: one user record per (oemId, oemUserId) pair. Lookup
// during token exchange to find existing or create on first sight.
UserSchema.index({ oemId: 1, oemUserId: 1 }, { unique: true });

export type User = InferSchemaType<typeof UserSchema>;
export const UserModel = model("User", UserSchema);
