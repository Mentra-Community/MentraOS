/**
 * @fileoverview `workspace_invitations` collection. One document per invitation.
 *
 * Only the SHA-256 hash of the invitation token is stored (`tokenHash`); the
 * token itself exists only in the invitation link. At most one invitation can
 * be pending per workspace and email; revoked and accepted rows stay as history.
 *
 * Every invitation records the authority it was sent with (`invitedByAuthority`),
 * which acceptance checks again:
 *  - `membership`: the inviter's membership (`invitedByMembershipId`) granted the role;
 *  - `organization_admin`: the inviter (`invitedByMentraUserId`) was an Organization
 *    Admin by the verified email `invitedByEmail`;
 *  - `system`: Core itself.
 * `invitedByMentraUserId` is the person who sent it, for both kinds a person can
 * send; account deletion revokes their pending invitations by it.
 */

import {WORKSPACE_ROLES} from "@mentra/workspace-contract"
import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WORKSPACE_INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const
export type WorkspaceInvitationStatus = (typeof WORKSPACE_INVITATION_STATUSES)[number]

export const INVITER_AUTHORITIES = ["membership", "organization_admin", "system"] as const
export type InviterAuthority = (typeof INVITER_AUTHORITIES)[number]

const WorkspaceInvitationSchema = new Schema(
  {
    /** `winv_<ulid>`. */
    invitationId: {type: String, required: true, unique: true},
    workspaceId: {type: String, required: true, index: true},
    email: {type: String, required: true, lowercase: true, trim: true},
    role: {type: String, enum: WORKSPACE_ROLES, required: true},
    tokenHash: {type: String, required: true, index: true},
    status: {type: String, enum: WORKSPACE_INVITATION_STATUSES, default: "pending"},
    invitedByAuthority: {type: String, enum: INVITER_AUTHORITIES, required: true},
    invitedByMembershipId: {type: String, default: null},
    invitedByMentraUserId: {type: String, default: null},
    invitedByEmail: {type: String, default: null},
    expiresAt: {type: Date, required: true},
    acceptedMembershipId: {type: String, default: null},
  },
  {timestamps: true, collection: "workspace_invitations"},
)

WorkspaceInvitationSchema.index(
  {workspaceId: 1, email: 1},
  {unique: true, partialFilterExpression: {status: "pending"}},
)
// Account deletion finds the invitations a person sent.
WorkspaceInvitationSchema.index({invitedByMentraUserId: 1, status: 1})

export type WorkspaceInvitationRow = InferSchemaType<typeof WorkspaceInvitationSchema>
export const WorkspaceInvitationModel = registerModel("WorkspaceInvitation", WorkspaceInvitationSchema)
