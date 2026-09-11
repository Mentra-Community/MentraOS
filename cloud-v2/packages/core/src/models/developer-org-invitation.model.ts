import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

export const DEVELOPER_ORG_INVITATION_ROLES = ["admin", "member"] as const;
export const DEVELOPER_ORG_INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;

/**
 * A pending invite to join a developer org, owned in our DB. The invite link
 * carries a random token; we store only its sha256 hash (like an API key). On
 * accept, a membership row is created and the invite is marked accepted.
 */
const DeveloperOrgInvitationSchema = new Schema(
  {
    invitationId: { type: String, required: true, unique: true },
    orgId: { type: String, required: true, index: true },
    email: { type: String, required: true }, // lowercased
    role: { type: String, enum: DEVELOPER_ORG_INVITATION_ROLES, required: true, default: "member" },
    tokenHash: { type: String, required: true, index: true },
    status: { type: String, enum: DEVELOPER_ORG_INVITATION_STATUSES, required: true, default: "pending" },
    invitedByUserId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "developer_org_invitations" },
);

// At most one pending invite per (org, email) — the DB backs the supersede logic.
DeveloperOrgInvitationSchema.index(
  { orgId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

export type DeveloperOrgInvitation = InferSchemaType<typeof DeveloperOrgInvitationSchema>;
export const DeveloperOrgInvitationModel = registerModel(
  "DeveloperOrgInvitation",
  DeveloperOrgInvitationSchema,
);
