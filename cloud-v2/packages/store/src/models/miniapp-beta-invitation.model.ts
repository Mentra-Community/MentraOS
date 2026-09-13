import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const MINIAPP_BETA_INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const

/**
 * Developer-issued access to one miniapp's private beta. The email is retained
 * for Console display, while Store authorization uses the resolved opaque
 * Mentra user id so catalog reads never need to query the identity provider.
 */
const MiniAppBetaInvitationSchema = new Schema(
  {
    invitationId: {type: String, required: true, unique: true},
    orgId: {type: String, required: true, index: true},
    miniAppId: {type: String, required: true, index: true},
    packageName: {type: String, required: true},
    email: {type: String, required: true},
    mentraUserId: {type: String, required: true, index: true},
    status: {
      type: String,
      enum: MINIAPP_BETA_INVITATION_STATUSES,
      required: true,
      default: "pending",
    },
    invitedByUserId: {type: String, required: true},
    expiresAt: {type: Date, required: true},
    acceptedAt: {type: Date, default: null},
  },
  {timestamps: true, collection: "miniapp_beta_invitations"},
)

MiniAppBetaInvitationSchema.index({miniAppId: 1, email: 1}, {unique: true})
MiniAppBetaInvitationSchema.index({miniAppId: 1, mentraUserId: 1}, {unique: true})

export type MiniAppBetaInvitation = InferSchemaType<typeof MiniAppBetaInvitationSchema>
export const MiniAppBetaInvitationModel = registerModel("MiniAppBetaInvitation", MiniAppBetaInvitationSchema)
