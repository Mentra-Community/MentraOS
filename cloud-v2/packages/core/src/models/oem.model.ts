/**
 * @fileoverview `oems` collection. One document per registered OEM.
 *
 * The OEM record holds the public key Mentra uses to verify OEM-signed JWTs
 * during token exchange. Two key-source modes:
 *
 *   - "static": OEM pasted a PEM-encoded public key into the portal. Stored
 *     on this document directly. Rotating means re-pasting.
 *   - "jwks-url": OEM hosts a JWKS document at a URL. Mentra fetches and
 *     caches the keys here on this document; cache refreshes on a TTL and
 *     on verification failure. Supports multi-key rotation windows.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Data model" / "Collection: oems")
 */

import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const OEM_PUBLIC_KEY_MODES = ["static", "jwks-url"] as const;
export type OemPublicKeyMode = (typeof OEM_PUBLIC_KEY_MODES)[number];

const OemSchema = new Schema(
  {
    /** Stable external identifier. Used as the `iss` claim on OEM-signed JWTs. */
    tenantId: { type: String, required: true, unique: true },

    /** Human-readable name for portal display. */
    displayName: { type: String, required: true },

    /** Which key-source mode this OEM uses. */
    publicKeyMode: {
      type: String,
      enum: OEM_PUBLIC_KEY_MODES,
      required: true,
    },

    /** PEM-encoded public key. Present iff `publicKeyMode === "static"`. */
    publicKey: { type: String, default: null },

    /** JWKS endpoint URL. Present iff `publicKeyMode === "jwks-url"`. */
    jwksUrl: { type: String, default: null },

    /** Last-fetched JWKS document for `publicKeyMode === "jwks-url"`. */
    cachedJwks: { type: Schema.Types.Mixed, default: null },

    /** When `cachedJwks` was last refreshed. */
    cachedJwksFetchedAt: { type: Date, default: null },

    /**
     * If true, token exchange and refresh are rejected for this OEM. Set
     * during OEM termination; flipped by Mentra admin.
     */
    disabled: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: "oems" },
);

export type Oem = InferSchemaType<typeof OemSchema>;
export const OemModel = registerModel("Oem", OemSchema);
