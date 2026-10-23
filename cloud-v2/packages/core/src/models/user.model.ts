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

    /** Tombstone set when account deletion is confirmed, once, and never
     * lifted. From then on the account is no principal (`isDeletedAccount`):
     * no sign-in, token exchange or refresh, portal session, identity-provider
     * token or key of it is accepted, and it cannot join a workspace. It also
     * prevents new support telemetry storage or delivery; a capture already in
     * flight when it is set may still reach PostHog, whose retention policy
     * governs delivered data (see confirmAccountDeletion). */
    supportTelemetryDeletedAt: {type: Date, default: null},

    /** When every step of the account's deletion had run (account.service
     * `finishAccountDeletion`). A tombstone without it is a deletion Core
     * still has to finish, which it does on its own. */
    accountDeletionCompletedAt: {type: Date, default: null},

    /**
     * Set by an account-wide revocation (logout everywhere, password change or
     * reset, account deletion). Core refuses identity-provider tokens from a
     * sign-in before it: for Supabase, a session whose start (the earliest
     * `amr[].timestamp`) precedes it, even after a refresh; for other
     * providers, a token issued (`iat`) before it.
     */
    webSignInsRevokedAt: {type: Date, default: null},

    /**
     * When the person last asked for their workspace (`POST /workspaces/ensure`,
     * `automatic-workspace.service`). The write is what serializes those asks:
     * each one writes this row in its transaction before it looks for the
     * person's memberships, so two at once conflict here and the one retried
     * finds the workspace the other made. Every write moves it forward, so no
     * write is a no-op that would conflict with nothing. Not indexed: it is
     * never searched.
     */
    portalWorkspaceAt: {type: Date, default: null},
  },
  {timestamps: {createdAt: true, updatedAt: false}, collection: "users"},
)

// Compound uniqueness: one user record per (tenantId, tenantUserId) pair. Lookup
// during token exchange to find existing or create on first sight.
UserSchema.index({tenantId: 1, tenantUserId: 1}, {unique: true})
// The deletions Core still has to finish: a tombstone without a completion.
UserSchema.index({supportTelemetryDeletedAt: 1, accountDeletionCompletedAt: 1})

export type User = InferSchemaType<typeof UserSchema>
export const UserModel = registerModel("User", UserSchema)
