import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const SupportDeviceSchema = new Schema(
  {
    deviceKey: {type: String, required: true},
    model: {type: String, default: null},
    androidVersion: {type: String, default: null},
    firmwareVersion: {type: String, default: null},
    mtkFirmwareVersion: {type: String, default: null},
    besFirmwareVersion: {type: String, default: null},
    appVersion: {type: String, default: null},
    buildNumber: {type: String, default: null},
    firstSeenAt: {type: Date, required: true},
    lastSeenAt: {type: Date, required: true},
    lastConnectedAt: {type: Date, default: null},
    observedAt: {type: Date, required: true},
  },
  {_id: false},
)

const SupportHostSchema = new Schema(
  {
    appVersion: {type: String, default: null},
    appBuild: {type: String, default: null},
    engineVersion: {type: String, default: null},
    bluetoothSdkVersion: {type: String, default: null},
    phonePlatform: {type: String, enum: ["ios", "android", "unknown"], required: true},
    phoneModel: {type: String, default: null},
    phoneOsVersion: {type: String, default: null},
    connectionState: {
      type: String,
      enum: ["disconnected", "scanning", "connecting", "bonding", "connected"],
      required: true,
    },
    failureCode: {type: String, default: null},
    failureStage: {type: String, default: null},
    observedAt: {type: Date, required: true},
    receivedAt: {type: Date, required: true},
  },
  {_id: false},
)

const SupportProfileSchema = new Schema(
  {
    mentraUserId: {type: String, required: true, unique: true},
    tenantId: {type: String, required: true},
    host: {type: SupportHostSchema, required: true},
    devices: {type: [SupportDeviceSchema], default: []},
    currentDeviceKey: {type: String, default: null},
    lastFingerprint: {type: String, required: true},
    lastAcceptedAt: {type: Date, required: true},
  },
  {timestamps: true, collection: "support_profiles"},
)

export type SupportProfile = InferSchemaType<typeof SupportProfileSchema>
export const SupportProfileModel = registerModel("SupportProfile", SupportProfileSchema)
