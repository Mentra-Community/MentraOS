import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const ENTERPRISE_ORG_STATUSES = ["active", "disabled"] as const;
export type EnterpriseOrgStatus = (typeof ENTERPRISE_ORG_STATUSES)[number];

const EnterpriseOrgSchema = new Schema(
  {
    enterpriseOrgId: { type: String, required: true, unique: true },
    ownerUserId: { type: String, required: true, index: true },
    workosOrgId: { type: String, default: null },
    tenantId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    status: { type: String, enum: ENTERPRISE_ORG_STATUSES, default: "active", index: true },
  },
  { timestamps: true, collection: "enterprise_orgs" },
);

EnterpriseOrgSchema.index({ ownerUserId: 1, createdAt: 1 });
// Partial (not sparse): `workosOrgId` defaults to null until WorkOS provisioning,
// and a sparse unique index skips only omitted fields, so a second unprovisioned
// org would collide on the explicit null. Constrain uniqueness to real string ids.
EnterpriseOrgSchema.index(
  { workosOrgId: 1 },
  { unique: true, partialFilterExpression: { workosOrgId: { $type: "string" } } },
);

export type EnterpriseOrg = InferSchemaType<typeof EnterpriseOrgSchema>;
export const EnterpriseOrgModel = registerModel("EnterpriseOrg", EnterpriseOrgSchema);
