import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { DeveloperOrgInvitationModel } from "../../models/developer-org-invitation.model";

export type InvitationRole = "admin" | "member";

export interface InvitationRecord {
  id: string;
  email: string;
  role: string;
  state: string; // pending | accepted | revoked (the console filters on this)
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Org invitations owned in our DB (copy-link + emailed). */
export class DeveloperOrgInvitationService {
  /** Create a pending invite (superseding any prior pending one for the email). */
  async create(
    orgId: string,
    email: string,
    role: InvitationRole,
    invitedByUserId: string,
  ): Promise<{ record: InvitationRecord; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const token = randomBytes(32).toString("base64url");
    await DeveloperOrgInvitationModel.updateMany(
      { orgId, email: normalizedEmail, status: "pending" },
      { $set: { status: "revoked" } },
    );
    const doc = await DeveloperOrgInvitationModel.create({
      invitationId: `dinv_${ulid()}`,
      orgId,
      email: normalizedEmail,
      role,
      tokenHash: sha256Hex(token),
      status: "pending",
      invitedByUserId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    return { record: serialize(doc.toObject()), token };
  }

  async listPending(orgId: string): Promise<InvitationRecord[]> {
    const rows = await DeveloperOrgInvitationModel.find({ orgId, status: "pending" })
      .sort({ createdAt: -1 })
      .lean<RawInvitation[]>();
    return rows.map(serialize);
  }

  async revoke(orgId: string, invitationId: string): Promise<boolean> {
    const result = await DeveloperOrgInvitationModel.updateOne(
      { orgId, invitationId, status: "pending" },
      { $set: { status: "revoked" } },
    );
    return result.matchedCount > 0;
  }

  /** Validate + consume a pending invite by its raw token. Null if invalid/expired. */
  async consume(token: string): Promise<{ orgId: string; email: string; role: InvitationRole } | null> {
    if (!token) return null;
    const row = await DeveloperOrgInvitationModel.findOne({ tokenHash: sha256Hex(token), status: "pending" });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      row.status = "revoked";
      await row.save();
      return null;
    }
    row.status = "accepted";
    await row.save();
    return { orgId: row.orgId, email: row.email, role: row.role as InvitationRole };
  }
}

type RawInvitation = {
  invitationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

function serialize(row: RawInvitation): InvitationRecord {
  return {
    id: row.invitationId,
    email: row.email,
    role: row.role,
    state: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}
