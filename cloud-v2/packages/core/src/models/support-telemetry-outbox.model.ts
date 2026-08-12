import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const SupportTelemetryOutboxSchema = new Schema(
  {
    mentraUserId: {type: String, required: true, index: true},
    event: {type: String, required: true},
    properties: {type: Schema.Types.Mixed, required: true},
    attempts: {type: Number, required: true, default: 0},
    availableAt: {type: Date, required: true, default: Date.now, index: true},
    leasedUntil: {type: Date, default: null},
    expiresAt: {type: Date, required: true},
  },
  {timestamps: {createdAt: true, updatedAt: false}, collection: "support_telemetry_outbox"},
)

SupportTelemetryOutboxSchema.index({expiresAt: 1}, {expireAfterSeconds: 0})
SupportTelemetryOutboxSchema.index({availableAt: 1, leasedUntil: 1})

export type SupportTelemetryOutbox = InferSchemaType<typeof SupportTelemetryOutboxSchema>
export const SupportTelemetryOutboxModel = registerModel("SupportTelemetryOutbox", SupportTelemetryOutboxSchema)
