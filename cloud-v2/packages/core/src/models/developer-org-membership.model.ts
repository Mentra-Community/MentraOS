import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Roles a developer-org member can hold, stored and owned entirely in our DB.
 *
 * `owner` is intentionally NOT in this list: ownership is the single
 * `ownerUserId` field on `DeveloperOrg` and stays the source of truth for the
 * one owner. This collection only records the admin/member overlay for
 * everyone else. A user with no row here resolves to `member` by default.
 *
 * WorkOS is not consulted for roles — it remains identity/login + the member
 * roster only. The permission tier is a Mentra console concept.
 */
export const DEVELOPER_ORG_ROLES = ["admin", "member"] as const;
export type DeveloperOrgRole = (typeof DEVELOPER_ORG_ROLES)[number];

const DeveloperOrgMembershipSchema = new Schema(
  {
    // DeveloperOrg.orgId (e.g. `dorg_...`), not the WorkOS org id.
    orgId: { type: String, required: true, index: true },
    // Lowercased email is the canonical key: it is known at invite time
    // (before the user exists) and again at login, so it bridges both.
    email: { type: String, required: true },
    // WorkOS user id, backfilled the first time the member is resolved by email.
    userId: { type: String, default: null, index: true },
    role: { type: String, enum: DEVELOPER_ORG_ROLES, required: true, default: "member" },
  },
  { timestamps: true, collection: "developer_org_memberships" },
);

DeveloperOrgMembershipSchema.index({ orgId: 1, email: 1 }, { unique: true });

export type DeveloperOrgMembership = InferSchemaType<typeof DeveloperOrgMembershipSchema>;
export const DeveloperOrgMembershipModel = model(
  "DeveloperOrgMembership",
  DeveloperOrgMembershipSchema,
);
