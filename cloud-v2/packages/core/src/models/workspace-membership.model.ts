/**
 * @fileoverview `workspace_memberships` collection. One document per membership
 * generation: ending a membership (`status: "ended"`) keeps the row as history,
 * and a later re-join inserts a new row with a new `membershipId`.
 *
 * `role` is the current (or, once ended, the last) role. `roleHistory` is the
 * append-only record of every role held in this generation, oldest first: each
 * entry is the role, when it took effect and the workspace's
 * `authorizationRevision` from the change that made it. An entry lasts until the
 * next entry's `from`, and the last one until `endedAt` (or is still held). The
 * first entry starts at `startedAt`. Every write that creates a membership or
 * changes its role appends to it in the same update, so `role` and the last entry
 * always agree.
 *
 * Identity is `mentraUserId`, the Core user. A membership imported from the
 * Store's developer organizations (`scripts/migrate-store-developer-orgs.ts`)
 * waits for its person instead: it has no `mentraUserId` and carries the
 * Store's former user id as `pendingWorkosUserId` until that person's first
 * sign-in with a matching verified email claims it
 * (`services/workspaces/membership-claim.service.ts`), which sets
 * `mentraUserId` and clears the pending id. A pending membership authorizes no
 * one, but it holds its role: it counts as an owner, and the keys it created
 * validate. Rows Core creates itself never carry `pendingWorkosUserId`. `email`
 * is display-only and never used for authorization.
 */

import {WORKSPACE_ROLES} from "@mentra/workspace-contract"
import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_MEMBERSHIP_STATUSES = ["active", "ended"] as const
export type WorkspaceMembershipStatus = (typeof WORKSPACE_MEMBERSHIP_STATUSES)[number]

/** Why a membership generation ended. */
export const WORKSPACE_MEMBERSHIP_ENDED_REASONS = ["removed", "left", "workspace_deleted", "account_deleted"] as const
export type WorkspaceMembershipEndedReason = (typeof WORKSPACE_MEMBERSHIP_ENDED_REASONS)[number]

/** One `roleHistory` entry: `role` held from `from`, granted at workspace revision `authorizationRevision`. */
const RoleIntervalSchema = new Schema(
  {
    role: {type: String, enum: WORKSPACE_ROLES, required: true},
    from: {type: Date, required: true},
    authorizationRevision: {type: Number, required: true},
  },
  {_id: false},
)

const WorkspaceMembershipSchema = new Schema(
  {
    /** `wm_<ulid>`. */
    membershipId: {type: String, required: true, unique: true},
    workspaceId: {type: String, required: true, index: true},
    /** The Core user; null only while an imported membership waits for its person's first sign-in. */
    mentraUserId: {type: String, default: null},
    /** Imported memberships only: the Store's former user id, until the person claims the membership. */
    pendingWorkosUserId: {type: String},
    email: {type: String, default: null},
    role: {type: String, enum: WORKSPACE_ROLES, required: true},
    roleHistory: {
      type: [RoleIntervalSchema],
      validate: {
        validator: (entries: unknown[]) => Array.isArray(entries) && entries.length > 0,
        message: "a membership records at least the role it started with",
      },
    },
    status: {type: String, enum: WORKSPACE_MEMBERSHIP_STATUSES, default: "active"},
    startedAt: {type: Date, required: true},
    /**
     * When the person took up an imported membership (its claim). Null for a membership Core created for a known
     * person, and for one claimed before this was recorded (its claim event, `membership.claimed`, has the time).
     * Fleet's membership intervals begin here, not at `startedAt`, so what a phone sent before its person joined
     * is never counted for the workspace.
     */
    claimedAt: {type: Date, default: null},
    endedAt: {type: Date, default: null},
    endedReason: {type: String, enum: [...WORKSPACE_MEMBERSHIP_ENDED_REASONS, null], default: null},
  },
  {timestamps: true, collection: "workspace_memberships"},
)

// Every membership names its person: a Core user, or (imported, unclaimed) the Store's former user id.
WorkspaceMembershipSchema.pre("validate", function (next) {
  const named = (value: unknown) => typeof value === "string" && value.trim().length > 0
  if (!named(this.mentraUserId) && !named(this.pendingWorkosUserId)) {
    this.invalidate("mentraUserId", "a membership needs a mentraUserId, or a pendingWorkosUserId until it is claimed")
  }
  next()
})

// At most one active membership per person per workspace. Partial so ended rows
// are free to accumulate as history, and on string ids so memberships waiting for
// their person (`mentraUserId` null) never meet it.
WorkspaceMembershipSchema.index(
  {workspaceId: 1, mentraUserId: 1},
  {unique: true, partialFilterExpression: {status: "active", mentraUserId: {$type: "string"}}},
)
// "Which workspaces is this person in?"
WorkspaceMembershipSchema.index({mentraUserId: 1, status: 1})
// The claim at first sign-in: one former Store user's pending memberships. Deliberately not unique:
// Azure Cosmos DB cannot add a unique index to a collection that already holds documents, so the
// import script, the only writer of pending memberships, keeps one active pending membership per
// former Store user per workspace inside its transaction.
WorkspaceMembershipSchema.index({pendingWorkosUserId: 1, status: 1})
// Last-owner checks and role listings.
WorkspaceMembershipSchema.index({workspaceId: 1, role: 1, status: 1})

export type WorkspaceMembershipRow = InferSchemaType<typeof WorkspaceMembershipSchema>
export const WorkspaceMembershipModel = registerModel("WorkspaceMembership", WorkspaceMembershipSchema)
