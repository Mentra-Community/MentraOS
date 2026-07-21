import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const PREINSTALLED_INSTALL_POLICIES = ["install_once", "keep_updated", "mandatory"] as const;
export const PREINSTALLED_REVISION_STATUSES = ["draft", "active", "archived"] as const;

const PreinstalledRegistryEntrySchema = new Schema(
  {
    miniAppId: { type: String, required: true },
    releaseId: { type: String, required: true },
    required: { type: Boolean, default: false },
    installPolicy: { type: String, enum: PREINSTALLED_INSTALL_POLICIES, default: "install_once" },
    minMobileVersion: { type: String, default: null },
    maxMobileVersion: { type: String, default: null },
    priority: { type: Number, default: 0 },
  },
  { _id: true },
);

const PreinstalledRegistryRevisionSchema = new Schema(
  {
    registryId: { type: String, required: true, index: true },
    status: { type: String, enum: PREINSTALLED_REVISION_STATUSES, default: "draft", index: true },
    reason: { type: String, default: null },
    entries: { type: [PreinstalledRegistryEntrySchema], default: [] },
    createdBy: { type: String, required: true },
    promotedBy: { type: String, default: null },
    promotedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "preinstalled_registry_revisions" },
);

// At most one active revision per registry (activeRevisionId is a singular pointer;
// promoteRevision archives all others). Partial to "active" so draft/archived rows
// are unconstrained and concurrent promotions can't leave two active revisions.
PreinstalledRegistryRevisionSchema.index(
  { registryId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);

export type PreinstalledRegistryRevision = InferSchemaType<typeof PreinstalledRegistryRevisionSchema>;
export const PreinstalledRegistryRevisionModel = registerModel(
  "PreinstalledRegistryRevision",
  PreinstalledRegistryRevisionSchema,
);
