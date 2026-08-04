import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const DEVELOPER_SIGNING_KEY_STATUSES = ["active", "revoked"] as const;

const DeveloperSigningKeySchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    workosUserId: { type: String, required: true, index: true },
    publicKeyJwk: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: DEVELOPER_SIGNING_KEY_STATUSES, default: "active", index: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "developer_signing_keys" },
);

DeveloperSigningKeySchema.index({ orgId: 1, workosUserId: 1, status: 1 });

export type DeveloperSigningKey = InferSchemaType<typeof DeveloperSigningKeySchema>;
export const DeveloperSigningKeyModel = registerModel("DeveloperSigningKey", DeveloperSigningKeySchema);

