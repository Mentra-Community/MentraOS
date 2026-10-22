/**
 * @fileoverview `licenses` collection. One document per license: Core's copy of a license as billing last
 * wrote it (`services/licenses/license.service.ts`). `_id` is billing's license id, a ULID.
 *
 * The owner is a workspace (`{type: "workspace", workspaceId}`), whose Admins and Owners assign its seats; a
 * license has no other kind of owner. Its seats are `license_seats` documents, and `seatsUsed` counts them:
 * assigning a seat increments it only while it is below `quantity`, in the same transaction as the seat's
 * insert, which is what caps the seats.
 *
 * `revision` is billing's, and a write applies only when it is newer. `endedAt` and `endedReason` are set
 * when its workspace is deleted (`workspace_deleted`); an ended license takes no seat and no write. Nothing
 * is ever deleted.
 */

import {LICENSE_ENDED_REASONS, LICENSE_OWNER_TYPES} from "@mentra/workspace-contract"
import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const LicenseOwnerSchema = new Schema(
  {
    type: {type: String, enum: LICENSE_OWNER_TYPES, required: true},
    /** The workspace that holds the license. */
    workspaceId: {type: String},
  },
  {_id: false},
)

/** A feature the license unlocks and the packages it is for (none for a service's feature). */
const LicenseFeatureSchema = new Schema(
  {
    key: {type: String, required: true},
    packages: {type: [String], default: []},
  },
  {_id: false},
)

const LicenseSchema = new Schema(
  {
    /** Billing's license id, a ULID. */
    _id: {type: String, required: true},
    owner: {type: LicenseOwnerSchema, required: true},
    product: {type: String, required: true},
    features: {type: [LicenseFeatureSchema], default: []},
    quantity: {type: Number, required: true},
    seatsUsed: {type: Number, required: true, default: 0},
    validFrom: {type: Date, required: true},
    paidThrough: {type: Date, required: true},
    revision: {type: Number, required: true},
    endedAt: {type: Date, default: null},
    endedReason: {type: String, enum: [...LICENSE_ENDED_REASONS, null], default: null},
  },
  {timestamps: true, collection: "licenses"},
)

// The licenses a workspace holds: its portal page, billing's list, and ending them with it.
LicenseSchema.index({"owner.type": 1, "owner.workspaceId": 1})

export type LicenseRow = InferSchemaType<typeof LicenseSchema> & {_id: string}
export const LicenseModel = registerModel("License", LicenseSchema)
