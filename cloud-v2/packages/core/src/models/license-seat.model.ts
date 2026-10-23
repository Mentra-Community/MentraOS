/**
 * @fileoverview `license_seats` collection. One document per assigned seat of a workspace license: the
 * membership that holds it. A seat belongs to a membership, not a person, so a member who leaves and
 * rejoins (a new membership) has no seat until one is assigned again.
 *
 * Releasing a seat deletes its document; its history is the audit trail (`seat.assigned`,
 * `seat.released`). Ending a membership releases its seats in the same transaction.
 *
 * At most one seat per license and membership (unique `{licenseId, membershipId}`). `mentraUserId` is the
 * membership's person, for "which seats does this person hold"; `workspaceId` is the license's workspace.
 * `assignedBy` is the Core user who assigned it (null when nobody did, such as the system), an opaque id.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const LicenseSeatSchema = new Schema(
  {
    licenseId: {type: String, required: true},
    workspaceId: {type: String, required: true},
    membershipId: {type: String, required: true},
    mentraUserId: {type: String, required: true},
    assignedAt: {type: Date, required: true},
    assignedBy: {type: String, default: null},
  },
  {timestamps: true, collection: "license_seats"},
)

// One seat per member per license. The collection is new, so the unique index builds on an empty one
// (Azure Cosmos DB cannot add a unique index to a collection that already holds documents).
LicenseSeatSchema.index({licenseId: 1, membershipId: 1}, {unique: true})
// "Which seats does this person hold?" (the features in their miniapp tokens).
LicenseSeatSchema.index({mentraUserId: 1})
// A workspace's seats.
LicenseSeatSchema.index({workspaceId: 1})

export type LicenseSeatRow = InferSchemaType<typeof LicenseSeatSchema>
export const LicenseSeatModel = registerModel("LicenseSeat", LicenseSeatSchema)
