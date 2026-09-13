import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const MINIAPP_ACCESS_INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const

/** A developer-issued entitlement to discover and install one private miniapp. */
const MiniAppAccessInvitationSchema = new Schema(
  {
    invitationId: {type: String, required: true, unique: true},
    orgId: {type: String, required: true, index: true},
    miniAppId: {type: String, required: true, index: true},
    packageName: {type: String, required: true},
    email: {type: String, required: true},
    mentraUserId: {type: String, required: true, index: true},
    status: {
      type: String,
      enum: MINIAPP_ACCESS_INVITATION_STATUSES,
      required: true,
      default: "pending",
    },
    invitedByUserId: {type: String, required: true},
    expiresAt: {type: Date, required: true},
    acceptedAt: {type: Date, default: null},
  },
  {timestamps: true, collection: "miniapp_access_invitations"},
)

MiniAppAccessInvitationSchema.index({miniAppId: 1, email: 1}, {unique: true})
MiniAppAccessInvitationSchema.index({miniAppId: 1, mentraUserId: 1}, {unique: true})

export type MiniAppAccessInvitation = InferSchemaType<typeof MiniAppAccessInvitationSchema>
export const MiniAppAccessInvitationModel = registerModel("MiniAppAccessInvitation", MiniAppAccessInvitationSchema)
