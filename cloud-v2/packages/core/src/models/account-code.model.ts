/**
 * @fileoverview One-time codes for account flows (password reset, email change,
 * account-deletion confirmation, and the OAuth handoff code).
 *
 * Codes are stored HASHED (never plaintext), single-use, and TTL-expired by
 * Mongo. `purpose` scopes a code so a reset code can't be replayed as a
 * deletion code. `subject` is the thing the code authorizes (email for reset,
 * user id for deletion, the PKCE challenge for oauth).
 */
import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const ACCOUNT_CODE_PURPOSES = [
  "password_reset",
  "email_change",
  "account_deletion",
  "oauth_handoff",
] as const;
export type AccountCodePurpose = (typeof ACCOUNT_CODE_PURPOSES)[number];

const AccountCodeSchema = new Schema(
  {
    /** SHA-256 hash of the code value. The plaintext is emailed/deep-linked once. */
    codeHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ACCOUNT_CODE_PURPOSES, required: true, index: true },
    /** What the code authorizes: email, userId, or the PKCE code_challenge. */
    subject: { type: String, required: true },
    /** Free-form payload for the flow (e.g. oauth: the stored TokenResponse). */
    payload: { type: Schema.Types.Mixed, default: null },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "account_codes" },
);

// TTL: Mongo deletes the doc once expiresAt passes.
AccountCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AccountCode = InferSchemaType<typeof AccountCodeSchema>;
export const AccountCodeModel = registerModel("AccountCode", AccountCodeSchema);
