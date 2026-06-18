import { Schema, model, type InferSchemaType } from "mongoose";

export const ENTERPRISE_ORG_STATUSES = ["active", "disabled"] as const;
export type EnterpriseOrgStatus = (typeof ENTERPRISE_ORG_STATUSES)[number];

const EnterpriseOrgSchema = new Schema(
  {
    enterpriseOrgId: { type: String, required: true, unique: true },
    ownerUserId: { type: String, required: true, index: true },
    workosOrgId: { type: String, default: null },
    oemId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    status: { type: String, enum: ENTERPRISE_ORG_STATUSES, default: "active", index: true },
  },
  { timestamps: true, collection: "enterprise_orgs" },
);

EnterpriseOrgSchema.index({ ownerUserId: 1, createdAt: 1 });
EnterpriseOrgSchema.index({ workosOrgId: 1 }, { unique: true, sparse: true });

export type EnterpriseOrg = InferSchemaType<typeof EnterpriseOrgSchema>;
export const EnterpriseOrgModel = model("EnterpriseOrg", EnterpriseOrgSchema);
