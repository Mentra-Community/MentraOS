import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const ENTERPRISE_ORG_STATUSES = ["active", "disabled"] as const;
export type EnterpriseOrgStatus = (typeof ENTERPRISE_ORG_STATUSES)[number];

const EnterpriseOrgSchema = new Schema(
  {
    enterpriseOrgId: { type: String, required: true, unique: true },
    /** The Core user (`mentraUserId`) who owns the org in the enterprise portal. */
    ownerUserId: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    status: { type: String, enum: ENTERPRISE_ORG_STATUSES, default: "active", index: true },
  },
  { timestamps: true, collection: "enterprise_orgs" },
);

EnterpriseOrgSchema.index({ ownerUserId: 1, createdAt: 1 });

export type EnterpriseOrg = InferSchemaType<typeof EnterpriseOrgSchema>;
export const EnterpriseOrgModel = registerModel("EnterpriseOrg", EnterpriseOrgSchema);
