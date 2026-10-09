/**
 * @fileoverview `workspaces` collection. One document per workspace: a group of
 * people with permissions inside this organization (one Core deployment).
 *
 * `authorizationRevision` is bumped by every change that can alter what a
 * member or credential may do (role change, removal, deletion), so signed
 * workspace assertions and caches can be invalidated cheaply.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_STATUSES = ["active", "deleted"] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

const WorkspaceSchema = new Schema(
  {
    /** `ws_<ulid>`. Migrated enterprise orgs keep their original `dorg_<ulid>` id. */
    workspaceId: {type: String, required: true, unique: true},
    name: {type: String, required: true},
    status: {type: String, enum: WORKSPACE_STATUSES, default: "active", index: true},
    authorizationRevision: {type: Number, default: 0},
    createdByMentraUserId: {type: String, default: null},
    deletedAt: {type: Date, default: null},
  },
  {timestamps: true, collection: "workspaces"},
)

export type WorkspaceRow = InferSchemaType<typeof WorkspaceSchema>
export const WorkspaceModel = registerModel("Workspace", WorkspaceSchema)
