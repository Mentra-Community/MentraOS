/**
 * @fileoverview `legacy_browser_identities` collection. One document per WorkOS
 * user the Store's developer organizations knew, written by the operator's
 * export (`scripts/export-legacy-browser-identities.ts`) only where WorkOS
 * reported the email verified.
 *
 * Memberships imported from the Store wait under the WorkOS user id
 * (`workspace_memberships.pendingWorkosUserId`), and enterprise orgs may still
 * name it as their owner. A person's first sign-in or first Core request with
 * exactly this verified `email` claims the identity, and everything waiting
 * under it, for their Core user (`services/workspaces/membership-claim.service.ts`):
 * `claimedAt` and `claimedBy` record when and by whom. A claimed identity is
 * never claimed by anyone else.
 *
 * The collection is new, so its unique index is built while it is empty (Azure
 * Cosmos DB refuses a unique index on a collection that already holds documents).
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const LegacyBrowserIdentitySchema = new Schema(
  {
    /** The Store's WorkOS user id (`user_…`). */
    workosUserId: {type: String, required: true, unique: true},
    /** The email WorkOS verified for that user, lowercased. */
    email: {type: String, required: true, lowercase: true, trim: true, index: true},
    claimedAt: {type: Date, default: null},
    /** The `mentraUserId` that claimed it. */
    claimedBy: {type: String, default: null},
  },
  {timestamps: true, collection: "legacy_browser_identities"},
)

// The claimant's later sign-ins pick up memberships an import re-run adds under an identity they claimed.
LegacyBrowserIdentitySchema.index({claimedBy: 1})

export type LegacyBrowserIdentityRow = InferSchemaType<typeof LegacyBrowserIdentitySchema>
export const LegacyBrowserIdentityModel = registerModel("LegacyBrowserIdentity", LegacyBrowserIdentitySchema)
