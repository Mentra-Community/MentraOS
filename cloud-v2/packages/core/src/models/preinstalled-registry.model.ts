import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const PREINSTALLED_REGISTRY_ENVIRONMENTS = ["debug", "dev", "staging", "prod"] as const;
export const PREINSTALLED_REGISTRY_STATUSES = ["draft", "active", "archived"] as const;

const PreinstalledRegistrySchema = new Schema(
  {
    name: { type: String, required: true },
    environment: { type: String, enum: PREINSTALLED_REGISTRY_ENVIRONMENTS, required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    status: { type: String, enum: PREINSTALLED_REGISTRY_STATUSES, default: "draft", index: true },
    activeRevisionId: { type: String, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: "preinstalled_registries" },
);

PreinstalledRegistrySchema.index(
  { environment: 1, tenantId: 1, name: 1 },
  { unique: true },
);

export type PreinstalledRegistry = InferSchemaType<typeof PreinstalledRegistrySchema>;
export const PreinstalledRegistryModel = registerModel("PreinstalledRegistry", PreinstalledRegistrySchema);
