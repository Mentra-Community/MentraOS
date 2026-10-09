/**
 * @fileoverview `workspace_invitations` collection. One document per invitation.
 *
 * Only the SHA-256 hash of the invitation token is stored (`tokenHash`); the
 * token itself exists only in the invitation link. At most one invitation can
 * be pending per workspace and email; revoked and accepted rows stay as history.
 */

import {WORKSPACE_ROLES} from "@mentra/workspace-contract"
import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const
export type WorkspaceInvitationStatus = (typeof WORKSPACE_INVITATION_STATUSES)[number]

const WorkspaceInvitationSchema = new Schema(
  {
    /** `winv_<ulid>`. */
    invitationId: {type: String, required: true, unique: true},
    workspaceId: {type: String, required: true, index: true},
    email: {type: String, required: true, lowercase: true, trim: true},
    role: {type: String, enum: WORKSPACE_ROLES, required: true},
    tokenHash: {type: String, required: true, index: true},
    status: {type: String, enum: WORKSPACE_INVITATION_STATUSES, default: "pending"},
    invitedByMembershipId: {type: String, default: null},
    expiresAt: {type: Date, required: true},
    acceptedMembershipId: {type: String, default: null},
  },
  {timestamps: true, collection: "workspace_invitations"},
)

WorkspaceInvitationSchema.index(
  {workspaceId: 1, email: 1},
  {unique: true, partialFilterExpression: {status: "pending"}},
)

export type WorkspaceInvitationRow = InferSchemaType<typeof WorkspaceInvitationSchema>
export const WorkspaceInvitationModel = registerModel("WorkspaceInvitation", WorkspaceInvitationSchema)
