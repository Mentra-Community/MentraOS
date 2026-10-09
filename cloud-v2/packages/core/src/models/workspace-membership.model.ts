/**
 * @fileoverview `workspace_memberships` collection. One document per membership
 * generation: ending a membership (`status: "ended"`) keeps the row as history,
 * and a later re-join inserts a new row.
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
 * Identity is `mentraUserId`. Rows migrated from the previous enterprise-org
 * model carry only `pendingWorkosUserId` until that person first signs in, at
 * which point Core fills `mentraUserId` and clears the pending id. `email` and
 * `name` are display-only and never used for authorization.
 */

import {MEMBERSHIP_ENDED_REASONS, WORKSPACE_ROLES} from "@mentra/workspace-contract"
import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_MEMBERSHIP_STATUSES = ["active", "ended"] as const
export type WorkspaceMembershipStatus = (typeof WORKSPACE_MEMBERSHIP_STATUSES)[number]

export const WORKSPACE_MEMBERSHIP_ENDED_REASONS = MEMBERSHIP_ENDED_REASONS
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
    mentraUserId: {type: String, default: null},
    /** Migrated rows only: WorkOS user id, replaced by `mentraUserId` on first sign-in. */
    pendingWorkosUserId: {type: String, default: null},
    email: {type: String, default: null},
    name: {type: String, default: null},
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
    endedAt: {type: Date, default: null},
    endedReason: {type: String, enum: [...WORKSPACE_MEMBERSHIP_ENDED_REASONS, null], default: null},
  },
  {timestamps: true, collection: "workspace_memberships"},
)

// At most one active membership per person per workspace. Partial on real
// string ids: `null` defaults would otherwise collide with each other, and
// ended rows must be free to accumulate as history.
WorkspaceMembershipSchema.index(
  {workspaceId: 1, mentraUserId: 1},
  {unique: true, partialFilterExpression: {status: "active", mentraUserId: {$type: "string"}}},
)
WorkspaceMembershipSchema.index(
  {workspaceId: 1, pendingWorkosUserId: 1},
  {unique: true, partialFilterExpression: {status: "active", pendingWorkosUserId: {$type: "string"}}},
)

// "Which workspaces is this person in?" and the pending-link lookup at sign-in.
WorkspaceMembershipSchema.index({mentraUserId: 1, status: 1})
WorkspaceMembershipSchema.index({pendingWorkosUserId: 1, status: 1})
// Last-owner checks and role listings.
WorkspaceMembershipSchema.index({workspaceId: 1, role: 1, status: 1})
// Fleet's history and as-of lookups: one person's generations in one workspace, in start order.
WorkspaceMembershipSchema.index({workspaceId: 1, mentraUserId: 1, startedAt: 1})

export type WorkspaceMembershipRow = InferSchemaType<typeof WorkspaceMembershipSchema>
export const WorkspaceMembershipModel = registerModel("WorkspaceMembership", WorkspaceMembershipSchema)
