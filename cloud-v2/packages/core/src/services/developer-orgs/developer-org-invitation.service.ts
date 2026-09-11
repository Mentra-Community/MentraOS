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
    const rows = await DeveloperOrgInvitationModel.find({
      orgId,
      status: "pending",
      expiresAt: { $gt: new Date() },
    })
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

  /** Validate a pending invite by its raw token WITHOUT consuming it. */
  async peek(
    token: string,
  ): Promise<{ invitationId: string; orgId: string; email: string; role: InvitationRole } | null> {
    if (!token) return null;
    const row = await DeveloperOrgInvitationModel.findOne({
      tokenHash: sha256Hex(token),
      status: "pending",
    }).lean<{ invitationId: string; orgId: string; email: string; role: string; expiresAt: Date } | null>();
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      // Retire the expired invite so it stops showing as pending. Best-effort —
      // never let a transient write failure turn a clean expired-null into a 5xx.
      await DeveloperOrgInvitationModel.updateOne(
        { invitationId: row.invitationId, status: "pending" },
        { $set: { status: "revoked" } },
      ).catch(() => {});
      return null;
    }
    return { invitationId: row.invitationId, orgId: row.orgId, email: row.email, role: row.role as InvitationRole };
  }

  /**
   * Atomically claim a pending invite (single-use). Returns false if another
   * request already claimed it — the `{ status: "pending" }` filter + Mongo's
   * atomic updateOne mean only one concurrent accept wins.
   */
  async claim(invitationId: string): Promise<boolean> {
    const result = await DeveloperOrgInvitationModel.updateOne(
      { invitationId, status: "pending" },
      { $set: { status: "accepted" } },
    );
    return result.matchedCount === 1;
  }

  /** Revert a claim (back to pending) if the post-claim membership write failed. */
  async unclaim(invitationId: string): Promise<void> {
    await DeveloperOrgInvitationModel.updateOne(
      { invitationId, status: "accepted" },
      { $set: { status: "pending" } },
    );
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
