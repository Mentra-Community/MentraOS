import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const MINIAPP_STATUSES = ["active", "archived", "suspended"] as const;

const MiniAppSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    packageName: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    status: { type: String, enum: MINIAPP_STATUSES, default: "active", index: true },
    activeReleaseId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "miniapps" },
);

MiniAppSchema.index({ orgId: 1, packageName: 1 }, { unique: true });

export type MiniApp = InferSchemaType<typeof MiniAppSchema>;
export const MiniAppModel = registerModel("MiniApp", MiniAppSchema);
