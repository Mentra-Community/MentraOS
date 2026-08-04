import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const DEVELOPER_ORG_PREFIX_STATUSES = ["unverified", "verified", "rejected"] as const;
export type DeveloperOrgPrefixStatus = (typeof DEVELOPER_ORG_PREFIX_STATUSES)[number];

const DeveloperOrgSchema = new Schema(
  {
    orgId: { type: String, required: true, unique: true },
    ownerUserId: { type: String, required: true, index: true },
    workosOrgId: { type: String },
    displayName: { type: String, required: true },
    packagePrefix: { type: String, required: true, unique: true },
    packagePrefixStatus: {
      type: String,
      enum: DEVELOPER_ORG_PREFIX_STATUSES,
      default: "unverified",
      index: true,
    },
  },
  { timestamps: true, collection: "developer_orgs" },
);

DeveloperOrgSchema.index({ ownerUserId: 1, createdAt: 1 });
DeveloperOrgSchema.index({ workosOrgId: 1 }, { unique: true, sparse: true });

export type DeveloperOrg = InferSchemaType<typeof DeveloperOrgSchema>;
export const DeveloperOrgModel = registerModel("DeveloperOrg", DeveloperOrgSchema);
