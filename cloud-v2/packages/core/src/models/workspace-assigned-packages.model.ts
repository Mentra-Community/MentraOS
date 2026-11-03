/**
 * @fileoverview `workspace_assigned_packages` collection. One document per workspace: the package names of the
 * miniapps the workspace assigns through Fleet, as Fleet last pushed them
 * (`services/workspaces/assigned-packages.service.ts`).
 *
 * A miniapp token names the person's workspace only for a package in that workspace's set, so a company's
 * miniapp can admit exactly its own members and no other miniapp learns which workspace anyone belongs to.
 * Core learns the set from Fleet's pushes, never by asking Fleet, so minting a token never waits on Fleet.
 *
 * `packageNames` are unique and sorted. `revision` is Fleet's, and a push applies only when it is newer. Deleting
 * the workspace deletes its document. The collection is built empty at startup with its unique index.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const WorkspaceAssignedPackagesSchema = new Schema(
  {
    workspaceId: {type: String, required: true},
    packageNames: {type: [String], default: []},
    revision: {type: Number, required: true},
  },
  {timestamps: {createdAt: false, updatedAt: true}, collection: "workspace_assigned_packages"},
)

// One set per workspace, and the lookup a miniapp token makes for the person's workspace.
WorkspaceAssignedPackagesSchema.index({workspaceId: 1}, {unique: true})

export type WorkspaceAssignedPackagesRow = InferSchemaType<typeof WorkspaceAssignedPackagesSchema>
export const WorkspaceAssignedPackagesModel = registerModel("WorkspaceAssignedPackages", WorkspaceAssignedPackagesSchema)
