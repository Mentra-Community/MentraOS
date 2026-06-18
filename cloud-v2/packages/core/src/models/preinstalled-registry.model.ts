import { Schema, model, type InferSchemaType } from "mongoose";

export const PREINSTALLED_REGISTRY_ENVIRONMENTS = ["debug", "dev", "staging", "prod"] as const;
export const PREINSTALLED_REGISTRY_STATUSES = ["draft", "active", "archived"] as const;

const PreinstalledRegistrySchema = new Schema(
  {
    name: { type: String, required: true },
    environment: { type: String, enum: PREINSTALLED_REGISTRY_ENVIRONMENTS, required: true, index: true },
    oemId: { type: String, default: null, index: true },
    status: { type: String, enum: PREINSTALLED_REGISTRY_STATUSES, default: "draft", index: true },
    activeRevisionId: { type: String, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: "preinstalled_registries" },
);

PreinstalledRegistrySchema.index(
  { environment: 1, oemId: 1, name: 1 },
  { unique: true },
);

export type PreinstalledRegistry = InferSchemaType<typeof PreinstalledRegistrySchema>;
export const PreinstalledRegistryModel = model("PreinstalledRegistry", PreinstalledRegistrySchema);
