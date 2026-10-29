/**
 * @fileoverview `workspaces` collection. One document per workspace: a group of
 * people with permissions inside this organization (one Core deployment).
 *
 * `authorizationRevision` is bumped by every change that can alter what a
 * member or credential may do (role change, removal, deletion), so signed
 * workspace assertions and caches can be invalidated cheaply. Deletion holds
 * (`deletionHolds`) live here too, so setting one and deleting the workspace
 * write the same document and conflict.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_STATUSES = ["active", "deleted"] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

/**
 * A service's hold on the workspace (`deletion-hold.service.ts`): at most one per service. `count` is
 * null when the service gave none.
 */
const DeletionHoldSchema = new Schema(
  {
    service: {type: String, required: true},
    reason: {type: String, required: true},
    count: {type: Number, default: null},
  },
  {_id: false},
)

/**
 * The `asOf` of the newest set or clear of one service's hold that Core applied
 * (`deletion-hold.service.ts`). Kept after a clear too, so a set computed before
 * the clear and applied late is recognized as stale.
 */
const DeletionHoldAsOfSchema = new Schema(
  {
    service: {type: String, required: true},
    asOf: {type: Date, required: true},
  },
  {_id: false},
)

const WorkspaceSchema = new Schema(
  {
    /** `ws_<ulid>`. */
    workspaceId: {type: String, required: true, unique: true},
    name: {type: String, required: true},
    status: {type: String, enum: WORKSPACE_STATUSES, default: "active", index: true},
    authorizationRevision: {type: Number, default: 0},
    /** Staging reset IDs, including licenses whose first billing delivery has not arrived yet. */
    retiredLicenseIds: {type: [String], default: undefined},
    createdByMentraUserId: {type: String, default: null},
    deletedAt: {type: Date, default: null},
    /**
     * What holds the workspace from deletion, sorted by service. Workspaces written before holds have no
     * such field, which means none. Not indexed: it is read with the workspace, never searched.
     */
    deletionHolds: {type: [DeletionHoldSchema], default: undefined},
    /**
     * For each service that has set or cleared a hold, the `asOf` of the newest call Core applied,
     * sorted by service. Absent until the first; not indexed, like `deletionHolds`.
     */
    deletionHoldAsOf: {type: [DeletionHoldAsOfSchema], default: undefined},
    /**
     * `true` for a person's automatic workspace, the one Core made for them when they had none
     * (`automatic-workspace.service`); absent on every other workspace. It stays when the workspace grows:
     * whether it can give way to another is what it holds, not this flag. Not indexed: it is read with the
     * workspace, never searched.
     */
    automatic: {type: Boolean, default: undefined},
  },
  {timestamps: true, collection: "workspaces"},
)

export type WorkspaceRow = InferSchemaType<typeof WorkspaceSchema>
export const WorkspaceModel = registerModel("Workspace", WorkspaceSchema)
