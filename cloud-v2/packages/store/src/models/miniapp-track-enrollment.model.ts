import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

/**
 * Per-user opt-in to a miniapp's beta release track. Stable is represented by
 * the absence of a row, keeping the default fail-closed for all existing users.
 */
const MiniAppTrackEnrollmentSchema = new Schema(
  {
    mentraUserId: {type: String, required: true, index: true},
    tenantId: {type: String, required: true},
    miniAppId: {type: String, required: true, index: true},
    packageName: {type: String, required: true},
    releaseTrack: {type: String, enum: ["beta"], required: true, default: "beta"},
  },
  {timestamps: true, collection: "miniapp_track_enrollments"},
)

MiniAppTrackEnrollmentSchema.index({mentraUserId: 1, miniAppId: 1}, {unique: true})

export type MiniAppTrackEnrollment = InferSchemaType<typeof MiniAppTrackEnrollmentSchema>
export const MiniAppTrackEnrollmentModel = registerModel("MiniAppTrackEnrollment", MiniAppTrackEnrollmentSchema)
